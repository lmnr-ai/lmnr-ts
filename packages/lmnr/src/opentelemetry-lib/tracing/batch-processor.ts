import { TraceFlags } from "@opentelemetry/api";
import {
  BatchSpanProcessor,
  type BufferConfig,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";

import { initializeLogger } from "../../utils";

const logger = initializeLogger();

/**
 * GenAI spans carry whole prompts and completions as string attributes, so a
 * batch of only a few dozen of them can be tens of megabytes. 32 MiB keeps a
 * single export comfortably under the ingest limits while still batching.
 */
export const DEFAULT_MAX_EXPORT_BATCH_SIZE_BYTES = 32 * 1024 * 1024;

/**
 * Non-string attribute values (numbers, booleans) are counted as a flat 8 bytes
 * instead of being measured — they never dominate a GenAI payload.
 */
const FIXED_ATTRIBUTE_VALUE_SIZE = 8;

const valueSize = (value: unknown): number => {
  if (typeof value === "string") {
    return utf8Size(value);
  }
  if (Array.isArray(value)) {
    return value.reduce<number>((total, item) => total + valueSize(item), 0);
  }
  return FIXED_ATTRIBUTE_VALUE_SIZE;
};

const attributesSize = (
  attributes: Record<string, unknown> | undefined,
): number => {
  if (!attributes) {
    return 0;
  }
  return Object.entries(attributes).reduce(
    (total, [key, value]) => total + utf8Size(key) + valueSize(value),
    0,
  );
};

/**
 * Byte length of `value` encoded as UTF-8.
 *
 * `.length` counts UTF-16 code units, which undercounts CJK by ~3x and
 * Cyrillic/Arabic/emoji by ~2x — on GenAI payloads that made a batch several
 * times the configured limit, the exact oversized-export case this limit exists
 * to prevent.
 *
 * Unlike the Python SDK, which samples a strided subset of long strings, this
 * measures exactly. `Buffer.byteLength` walks the string in native code without
 * allocating the encoded bytes, so it is both cheaper and more accurate than
 * sampling here: measured ~27us on a 20k-character CJK string, against ~16us for
 * a sampled estimate that was also *wrong* for emoji (+11.7%, because indexing a
 * string splits surrogate pairs and each half encodes as U+FFFD). Python has no
 * equivalent primitive — `len(s.encode())` allocates the whole encoded copy —
 * which is the only reason it samples.
 */
export const utf8Size = (value: string): number =>
  Buffer.byteLength(value, "utf8");

/**
 * Approximate the exported size of a span, in bytes.
 *
 * Deliberately an underestimate: protobuf framing, ids and timestamps are
 * ignored, and non-string values are counted flat. Underestimating small spans
 * is fine — the count and schedule-delay limits fire first for those. What
 * matters is that a span carrying a large prompt or completion is measured close
 * to its real weight.
 */
export const approximateSpanSize = (span: ReadableSpan): number => {
  let total = utf8Size(span.name ?? "");
  total += attributesSize(span.attributes);
  for (const event of span.events ?? []) {
    total += utf8Size(event.name ?? "") + attributesSize(event.attributes);
  }
  for (const link of span.links ?? []) {
    total += attributesSize(link.attributes);
  }
  if (span.status?.message) {
    total += utf8Size(span.status.message);
  }
  return total;
};

export type SizeLimitedBufferConfig = BufferConfig & {
  /**
   * Approximate maximum size, in bytes, of the spans buffered in one batch.
   * Defaults to {@link DEFAULT_MAX_EXPORT_BATCH_SIZE_BYTES}.
   */
  maxExportBatchSizeBytes?: number;
};

/**
 * `BatchSpanProcessor` with a third, size-based flush trigger.
 *
 * Opt-in via `Laminar.initialize({ flushBySize: true })`; the default transport
 * is the plain upstream `BatchSpanProcessor`.
 *
 * Upstream flushes on whichever comes first: `maxExportBatchSize` spans
 * buffered, or `scheduledDelayMillis` elapsed. Neither bounds the *payload*, so
 * a handful of large GenAI spans can produce an export big enough for the
 * backend to reject. This adds `maxExportBatchSizeBytes`: when the span being
 * ended would push the buffer past the limit, the buffer is flushed first and
 * the span then starts a fresh batch.
 *
 * The Python SDK needs considerably more machinery for this — a dedicated flush
 * thread, a lock around the running total, a fork handler, and an inline
 * fallback for backpressure — none of which is needed here, because the two
 * runtimes behave differently in three ways:
 *
 * 1. `forceFlush()` moves the buffered spans out synchronously and only *awaits*
 *    the network, so calling it from `onEnd` never blocks the caller (measured:
 *    0.34ms worst case against a 300ms export). Python's `force_flush` performs
 *    the export itself on the calling thread, which load testing measured at a
 *    p99 of ~664ms and is why it needs a background thread.
 * 2. Because the flush is synchronous with respect to the buffer, the batch stays
 *    bounded even when a producer emits in a tight loop, so no inline-fallback
 *    backpressure path is needed. Python's asynchronous handoff can be outrun.
 * 3. `onEnd` calls `super.onEnd(span)` *after* flushing, so the triggering span
 *    is genuinely excluded from the batch it caused. Python cannot do this — its
 *    flush is asynchronous, so the triggering span rides along, which is why it
 *    needs a separate "span is at least half the limit" rule to bound overshoot.
 *    Here a batch never exceeds the limit by more than the last span under it.
 *
 * Single-threaded event loop, so no lock guards the running total, and there is
 * no `fork` story to handle.
 */
export class SizeLimitedBatchSpanProcessor extends BatchSpanProcessor {
  private readonly maxExportBatchSizeBytes: number;
  private pendingSizeBytes = 0;

  constructor(
    exporter: ConstructorParameters<typeof BatchSpanProcessor>[0],
    config?: SizeLimitedBufferConfig,
  ) {
    super(exporter, config);
    this.maxExportBatchSizeBytes =
      config?.maxExportBatchSizeBytes ?? DEFAULT_MAX_EXPORT_BATCH_SIZE_BYTES;
  }

  public onEnd(span: ReadableSpan): void {
    // Upstream drops unsampled spans without buffering them, so they must not
    // count toward the running total either.
    if ((span.spanContext().traceFlags & TraceFlags.SAMPLED) === 0) {
      super.onEnd(span);
      return;
    }

    // The running total can go stale when upstream drains the buffer on its own
    // count or schedule-delay trigger. Deliberately NOT corrected here, unlike
    // Python, which resets the total whenever it observes an empty buffer: the
    // only consequence of a stale total is an early flush, and an early flush on
    // an already-drained buffer is a no-op in JS (upstream's `_flushOneBatch`
    // returns immediately on an empty buffer — no export, no wire traffic). In
    // Python the same spurious flush is a real blocking network round trip on a
    // user's thread, which is what makes the correction load-bearing there.
    // Reading upstream's private `_finishedSpans` to fix an unobservable
    // discrepancy is not worth the coupling.
    const size = approximateSpanSize(span);
    const shouldFlush =
      this.pendingSizeBytes > 0 &&
      this.pendingSizeBytes + size > this.maxExportBatchSizeBytes;
    this.pendingSizeBytes = shouldFlush ? size : this.pendingSizeBytes + size;

    if (shouldFlush) {
      // Flush BEFORE enqueueing this span, so the batch that goes out is
      // everything that preceded it and this span opens the next one.
      //
      // The `catch` is required, not defensive: `forceFlush()` rejects when an
      // export fails, and nothing awaits this promise, so without it a failed
      // export becomes an unhandled rejection — which crashes the process under
      // Node's default `--unhandled-rejections=throw`. Verified: three failing
      // exports produced three unhandled rejections.
      void this.forceFlush().catch((error: unknown) => {
        logger.debug(`Size-triggered span flush failed: ${String(error)}`);
      });
    }

    super.onEnd(span);
  }
}
