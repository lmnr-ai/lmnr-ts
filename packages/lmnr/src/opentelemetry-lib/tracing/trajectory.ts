/**
 * Collect spans into an lmnr-atif trajectory file (`LMNR_TRAJECTORY_PATH`).
 *
 * `LaminarSpanProcessor` feeds every span it would export to a
 * `TrajectoryCollector`, which keeps a `SpanRecord` per finished span and
 * rewrites the file:
 *
 * - on `forceFlush` / `shutdown` (so `Laminar.flush()` and
 *   `Laminar.shutdown()` leave a final file),
 * - on process `exit`, since nothing else flushes spans when a script just
 *   ends, and
 * - as a snapshot, at most every `snapshotIntervalMs` while spans keep
 *   ending, so an agent killed on a timeout still leaves a recent file. A
 *   file written while spans were open has `complete: false`.
 *
 * Every write is synchronous (see `trajectory/writer.ts`). Port of the Python
 * SDK's `opentelemetry_lib/tracing/trajectory.py`, without its threads, locks
 * and fork handling.
 */

import { hasOwn } from "@lmnr-ai/types";
import { HrTime } from "@opentelemetry/api";
import { hrTime, otperformance } from "@opentelemetry/core";
import type { ReadableSpan, Span } from "@opentelemetry/sdk-trace-base";

import {
  BuildOptions,
  formatTime,
  SpanError,
  SpanRecord,
} from "../../trajectory/builder";
import { or, pyStr, truthy } from "../../trajectory/py";
import { writeTrajectories } from "../../trajectory/writer";
import {
  initializeLogger,
  otelSpanIdToUUID,
  otelTraceIdToUUID,
} from "../../utils";
import { SPAN_INPUT, SPAN_OUTPUT, SPAN_TYPE } from "./attributes";
import { getParentSpanId } from "./compat";

const logger = initializeLogger();

export const DEFAULT_SNAPSHOT_INTERVAL_MS = 2000;

const SESSION_ID = "lmnr.association.properties.session_id";
const RELEASE = "lmnr.span.release";
// Legacy indexed prompt attributes: only the system prompt is read (the OpenAI
// Responses API records `instructions` nowhere else).
const LEGACY_SYSTEM = ["gen_ai.prompt.0.role", "gen_ai.prompt.0.content"];
// The AI SDK's TOOL span attributes the builder matches tool calls by.
const AI_SDK_TOOL_CALL = ["ai.toolCall.id", "ai.toolCall.name"];

// app-server's `SpanType` enum (`db/spans.rs`).
const SPAN_TYPES = new Set([
  "DEFAULT",
  "LLM",
  "PIPELINE",
  "EXECUTOR",
  "EVALUATOR",
  "HUMAN_EVALUATOR",
  "EVALUATION",
  "TOOL",
  "CACHED",
]);
const OPENROUTER_SPAN_TYPE = "span.type";
const OPENROUTER_METADATA_PREFIX = "trace.metadata.openrouter.";

type Attributes = Record<string, unknown>;

/**
 * The span's type as app-server sees it (`traces/spans.rs`), so the file and
 * the Laminar UI agree on what is an LLM or tool call: `span_type()`, plus the
 * two rules applied after it, `is_ai_sdk_tool_call_span` (TOOL) and the
 * cached-LLM case of `is_llm_span` (a debug-replay hit is still an LLM call).
 */
export const spanType = (attributes: Attributes, name: string = ""): string => {
  if (
    name === "ai.toolCall" ||
    AI_SDK_TOOL_CALL.some((key) => hasOwn(attributes, key))
  ) {
    return "TOOL";
  }
  const kind = baseSpanType(attributes);
  if (kind === "CACHED" && attributes["lmnr.span.original_type"] === "LLM") {
    return "LLM";
  }
  return kind;
};

/** `span_type()` in app-server's `traces/spans.rs`. */
const baseSpanType = (attributes: Attributes): string => {
  if (hasOwn(attributes, SPAN_TYPE)) {
    const explicit = attributes[SPAN_TYPE];
    return typeof explicit === "string" && SPAN_TYPES.has(explicit)
      ? explicit
      : "DEFAULT";
  }
  // OpenRouter Broadcast types its own spans.
  const openrouterType = attributes[OPENROUTER_SPAN_TYPE];
  if (
    typeof openrouterType === "string" &&
    openrouterType !== "generation" &&
    Object.keys(attributes).some((k) =>
      k.startsWith(OPENROUTER_METADATA_PREFIX),
    )
  ) {
    return "DEFAULT";
  }
  const operation = attributes["gen_ai.operation.name"];
  if (
    ["chat", "text_completion", "embeddings", "generate_content"].includes(
      operation as string,
    )
  ) {
    return "LLM";
  }
  if (operation === "execute_tool") {
    return "TOOL";
  }
  if (operation === "invoke_agent") {
    return "DEFAULT";
  }
  if (
    hasOwn(attributes, "gen_ai.tool.call.arguments") ||
    hasOwn(attributes, "gen_ai.tool.call.result")
  ) {
    return "TOOL";
  }
  if (
    ["gen_ai.system", "gen_ai.request.model", "gen_ai.response.model"].some(
      (k) => hasOwn(attributes, k),
    )
  ) {
    return "LLM";
  }
  return "DEFAULT";
};

/** Whether the builder reads this attribute. Records live as long as the
 * process, so whole prompts are not kept twice. */
const keep = (key: string, attributes: Attributes, kind: string): boolean => {
  if (
    key.startsWith("gen_ai.prompt.") ||
    key.startsWith("gen_ai.completion.")
  ) {
    return LEGACY_SYSTEM.includes(key);
  }
  if (key.startsWith("gen_ai.")) {
    return true;
  }
  if (key === SPAN_INPUT) {
    return !(kind === "LLM" && hasOwn(attributes, "gen_ai.input.messages"));
  }
  if (key === SPAN_OUTPUT) {
    return !(kind === "LLM" && hasOwn(attributes, "gen_ai.output.messages"));
  }
  return [SESSION_ID, RELEASE, SPAN_TYPE, ...AI_SDK_TOOL_CALL].includes(key);
};

// OTel arrays are copied: the record outlives the span.
const value = (v: unknown): unknown => (Array.isArray(v) ? [...v] : v);

/** `{type, message[, stacktrace]}` from the span's last `exception` event.
 * Like app-server, a span without one didn't fail. */
const spanError = (span: ReadableSpan): SpanError | null => {
  const events = span.events ?? [];
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].name !== "exception") {
      continue;
    }
    const attributes = (events[i].attributes ?? {}) as Attributes;
    const error: SpanError = {
      type: pyStr(or(attributes["exception.type"], "Error")),
      message: pyStr(or(attributes["exception.message"], "")),
    };
    if (truthy(attributes["exception.stacktrace"])) {
      error.stacktrace = pyStr(attributes["exception.stacktrace"]);
    }
    return error;
  }
  return null;
};

/** Microseconds (since the epoch, for a time). Nanoseconds don't fit in a
 * Number. */
const toMicros = (time: HrTime): number =>
  time[0] * 1_000_000 + Math.floor(time[1] / 1000);

const isEnded = (span: ReadableSpan): boolean =>
  (span as Partial<Span>).ended ?? toMicros(span.endTime) > 0;

/**
 * When the span started, in µs, to the microsecond.
 *
 * OTel JS takes a start time from `Date.now()`, whole milliseconds, and only
 * the duration is precise. So the spans of fast calls (a tool, the next LLM
 * call) share a start, their end times disagree across spans by up to 1ms,
 * and the builder, which orders by these times, misreads them (Python's are
 * nanoseconds). The SDK span also keeps the precise `performance.now()` its
 * duration is measured from; use it unless the caller passed a start time.
 * Undefined (use the span's own times) on an SDK without those fields.
 */
const preciseStart = (span: ReadableSpan): number | undefined => {
  const sdk = span as unknown as {
    _performanceStartTime?: unknown;
    _startTimeProvided?: unknown;
  };
  if (
    sdk._startTimeProvided !== false ||
    typeof sdk._performanceStartTime !== "number"
  ) {
    return undefined;
  }
  return Math.floor(
    (otperformance.timeOrigin + sdk._performanceStartTime) * 1000,
  );
};

/** The builder's view of a span. `endTimeUs` stands in for the end of a span
 * that is still open. Null if the span can't be read. */
export const spanRecord = (
  span: ReadableSpan,
  endTimeUs?: number,
): SpanRecord | null => {
  const context = span.spanContext();
  const precise = preciseStart(span);
  const start =
    precise ?? (span.startTime ? toMicros(span.startTime) : undefined);
  let end = endTimeUs;
  if (isEnded(span)) {
    end =
      precise !== undefined
        ? precise + toMicros(span.duration)
        : toMicros(span.endTime);
  }
  if (!context || start === undefined || end === undefined) {
    return null;
  }
  const attributes = { ...(span.attributes ?? {}) } as Attributes;
  const kind = spanType(attributes, span.name);
  const parent = getParentSpanId(span as any);
  return {
    trace_id: otelTraceIdToUUID(context.traceId),
    span_id: otelSpanIdToUUID(context.spanId),
    parent_span_id: parent ? otelSpanIdToUUID(parent) : null,
    name: span.name,
    span_type: kind,
    start_time: formatTime(start),
    end_time: formatTime(Math.max(end, start)),
    attributes: Object.fromEntries(
      Object.entries(attributes)
        .filter(([k]) => keep(k, attributes, kind))
        .map(([k, v]) => [k, value(v)]),
    ),
    error: spanError(span),
  };
};

/**
 * Turns the spans of this process into lmnr-atif trajectory files.
 *
 * `path` may contain `{trace_id}` (one file per trace) and `{pid}`. Without
 * `{trace_id}`, every trace of the process goes into one file.
 */
export class TrajectoryCollector {
  // One record per finished span, by Laminar span id.
  private records = new Map<string, SpanRecord>();
  // Spans started and not yet ended, by OTel span id.
  private open = new Map<string, ReadableSpan>();
  dirty = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private warned = false;
  private exitHook: (() => void) | undefined;

  constructor(
    readonly path: string,
    readonly exported: boolean,
    readonly release?: string,
    public snapshotIntervalMs: number = DEFAULT_SNAPSHOT_INTERVAL_MS,
  ) {
    // Nothing flushes spans when a script simply ends, so write the final
    // file on `exit` (not `beforeExit`, which doesn't fire on
    // `process.exit()`). Removed in `shutdown()` so that init/shutdown loops
    // don't pile up listeners.
    if (typeof process !== "undefined" && typeof process.once === "function") {
      this.exitHook = () => {
        this.write();
      };
      process.once("exit", this.exitHook);
    }
  }

  onStart(span: ReadableSpan): void {
    this.open.set(span.spanContext().spanId, span);
  }

  onEnd(span: ReadableSpan): void {
    const record = spanRecord(span);
    this.open.delete(span.spanContext().spanId);
    if (record === null) {
      return;
    }
    this.records.set(record.span_id, record);
    this.dirty = true;
    if (
      this.timer === undefined &&
      !this.stopped &&
      this.snapshotIntervalMs > 0
    ) {
      this.timer = setInterval(() => {
        if (this.dirty) {
          this.write();
        }
      }, this.snapshotIntervalMs);
      // Snapshots must never keep the process alive.
      this.timer.unref?.();
    }
  }

  /** Rebuild and write the file(s) now. Never throws. */
  write(): boolean {
    const now = toMicros(hrTime());
    this.dirty = false;
    const records = [...this.records.values()];
    // Open spans keep the structure of a snapshot (the root's name, the agent
    // a call belongs to); an open LLM call has no output yet.
    const openTraceIds = new Set<string>();
    for (const span of this.open.values()) {
      openTraceIds.add(otelTraceIdToUUID(span.spanContext().traceId));
      let record: SpanRecord | null = null;
      try {
        record = spanRecord(span, now);
      } catch {
        continue;
      }
      if (record !== null && record.span_type !== "LLM") {
        records.push(record);
      }
    }
    return this.writeRecords(records, openTraceIds, true);
  }

  /** Write `records`. Never throws. */
  private writeRecords(
    records: SpanRecord[],
    openTraceIds: Set<string>,
    retry: boolean,
  ): boolean {
    const options: BuildOptions = {
      release: this.release,
      exported: this.exported,
    };
    try {
      writeTrajectories(records, this.path, options, openTraceIds);
    } catch (error) {
      if (retry) {
        // Retry at the next snapshot even if no other span ends: the last
        // snapshot is what a killed agent leaves behind.
        this.dirty = true;
      }
      if (!this.warned) {
        this.warned = true;
        logger.warn(
          `Could not write the trajectory to ${this.path}: ${String(error)}`,
        );
      } else {
        logger.debug(`Could not write the trajectory: ${String(error)}`);
      }
      return false;
    }
    return true;
  }

  /** Stop snapshots and the exit hook, then write the final file. Safe to
   * call more than once. */
  shutdown(): boolean {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.exitHook !== undefined) {
      process.removeListener("exit", this.exitHook);
      this.exitHook = undefined;
    }
    return this.write();
  }
}
