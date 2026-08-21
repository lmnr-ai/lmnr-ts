import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { TraceFlags } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  type ReadableSpan,
  SimpleSpanProcessor,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";

import {
  approximateSpanSize,
  DEFAULT_MAX_EXPORT_BATCH_SIZE_BYTES,
  SizeLimitedBatchSpanProcessor,
  utf8Size,
} from "../src/opentelemetry-lib/tracing/batch-processor";
import { LaminarSpanProcessor } from "../src/opentelemetry-lib/tracing/processor";

// Long enough that the schedule-delay trigger can never fire during a test.
const NEVER_MILLIS = 600_000;
const BYTE_LIMIT = 100_000;
const SPAN_BYTES = 4000;

class RecordingExporter implements SpanExporter {
  public batches: ReadableSpan[][] = [];
  /** Stands in for network time, so tests can observe async export behavior. */
  public exportDelayMs = 0;

  public export(
    spans: ReadableSpan[],
    resultCallback: (result: { code: number; error?: Error }) => void,
  ): void {
    this.batches.push([...spans]);
    if (this.exportDelayMs) {
      setTimeout(() => resultCallback({ code: 0 }), this.exportDelayMs);
    } else {
      resultCallback({ code: 0 });
    }
  }

  public shutdown(): Promise<void> {
    return Promise.resolve();
  }

  public forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  public get batchSizes(): number[] {
    return this.batches.map((batch) => batch.length);
  }

  public get spanCount(): number {
    return this.batches.reduce((total, batch) => total + batch.length, 0);
  }
}

const makeProcessor = ({
  maxExportBatchSizeBytes = BYTE_LIMIT,
  maxExportBatchSize = 1000,
  scheduledDelayMillis = NEVER_MILLIS,
}: {
  maxExportBatchSizeBytes?: number;
  maxExportBatchSize?: number;
  scheduledDelayMillis?: number;
} = {}) => {
  const exporter = new RecordingExporter();
  const processor = new SizeLimitedBatchSpanProcessor(exporter, {
    maxExportBatchSize,
    maxQueueSize: 4096,
    scheduledDelayMillis,
    maxExportBatchSizeBytes,
  });
  const provider = new BasicTracerProvider({ spanProcessors: [processor] });
  return { exporter, processor, tracer: provider.getTracer("test") };
};

const emit = (
  tracer: ReturnType<BasicTracerProvider["getTracer"]>,
  name: string,
  payloadSize = 0,
) => {
  const span = tracer.startSpan(name);
  if (payloadSize) {
    span.setAttribute("gen_ai.input.messages", "x".repeat(payloadSize));
  }
  span.end();
};

void describe("SizeLimitedBatchSpanProcessor", () => {
  void it("flushes on the byte limit before the count and time limits", async () => {
    const { exporter, processor, tracer } = makeProcessor();

    // 24 spans fit under the limit, the 25th trips it.
    for (let i = 0; i < 60; i++) {
      emit(tracer, `span-${i}`, SPAN_BYTES);
    }

    // Neither other trigger could have fired: the count limit is 1000 and the
    // schedule delay is 10 minutes.
    assert.ok(
      exporter.batches.length >= 2,
      `expected flushes, got ${exporter.batchSizes.join(",")}`,
    );
    await processor.forceFlush();
    assert.equal(exporter.spanCount, 60);
  });

  void it("does not block the thread that ended the span", async () => {
    // Unlike Python, forceFlush() moves the buffered spans out synchronously and
    // only awaits the network, so no inline export ever charges the producer.
    const { exporter, processor, tracer } = makeProcessor();
    exporter.exportDelayMs = 300;

    const latencies: number[] = [];
    for (let i = 0; i < 60; i++) {
      const span = tracer.startSpan(`span-${i}`);
      span.setAttribute("gen_ai.input.messages", "x".repeat(SPAN_BYTES));
      const started = performance.now();
      span.end();
      latencies.push(performance.now() - started);
    }

    const worst = Math.max(...latencies);
    assert.ok(exporter.batches.length >= 2, "byte limit never fired");
    assert.ok(worst < 50, `span.end() blocked for ${worst.toFixed(1)}ms`);
    await processor.forceFlush();
  });

  void it("keeps batches bounded when a producer emits in a tight loop", async () => {
    // The Python SDK needs an inline-export fallback here, because its handoff is
    // asynchronous and a tight loop outruns the flush thread. Here the buffer is
    // drained synchronously, so a tight loop stays bounded on its own.
    const { exporter, processor, tracer } = makeProcessor();
    exporter.exportDelayMs = 200;

    for (let i = 0; i < 100; i++) {
      emit(tracer, `span-${i}`, SPAN_BYTES);
    }

    await processor.forceFlush();
    // 25 spans/batch at 4 KB against a 100 KB limit; nothing should approach the
    // 1000-span count limit.
    assert.ok(
      Math.max(...exporter.batchSizes) <= 30,
      `batch grew past the byte limit: ${exporter.batchSizes.join(",")}`,
    );
    assert.equal(exporter.spanCount, 100);
  });

  void it("excludes the triggering span from the batch it caused", async () => {
    // Python cannot do this — its flush is asynchronous, so the triggering span
    // rides along and it needs a half-the-limit rule to bound the overshoot.
    // Here spans over half the limit still each go out alone, with no such rule.
    const { exporter, processor, tracer } = makeProcessor();
    const payload = Math.floor(BYTE_LIMIT * 0.6);

    for (let i = 0; i < 6; i++) {
      emit(tracer, `big-${i}`, payload);
    }

    await processor.forceFlush();
    assert.deepEqual(exporter.batchSizes, [1, 1, 1, 1, 1, 1]);
    assert.equal(exporter.spanCount, 6);
  });

  void it("exports a span larger than the whole limit on its own", async () => {
    const { exporter, processor, tracer } = makeProcessor({
      maxExportBatchSizeBytes: 1000,
    });

    for (let i = 0; i < 3; i++) {
      emit(tracer, `huge-${i}`, 50_000);
    }

    await processor.forceFlush();
    assert.deepEqual(exporter.batchSizes, [1, 1, 1]);
  });

  void it("never trips the byte limit on small spans", async () => {
    const { exporter, processor, tracer } = makeProcessor({
      maxExportBatchSizeBytes: DEFAULT_MAX_EXPORT_BATCH_SIZE_BYTES,
    });

    for (let i = 0; i < 200; i++) {
      emit(tracer, `span-${i}`, 5);
    }

    assert.deepEqual(exporter.batchSizes, []);
    await processor.forceFlush();
    assert.equal(exporter.spanCount, 200);
  });

  void it("loses no spans when upstream's count limit drains the buffer", async () => {
    // Upstream drains on its own count trigger without telling us, so our
    // running total goes stale. That can only cause an early flush, which is a
    // no-op on an already-drained buffer — so unlike Python we do not correct
    // it. What must hold either way is that no span is lost or duplicated.
    const { exporter, processor, tracer } = makeProcessor({
      maxExportBatchSizeBytes: 10_000,
      maxExportBatchSize: 3,
    });

    for (let i = 0; i < 3; i++) {
      emit(tracer, `span-${i}`, 3000);
    }
    assert.deepEqual(
      exporter.batchSizes,
      [3],
      "count limit should have flushed",
    );

    for (let i = 0; i < 4; i++) {
      emit(tracer, `after-${i}`, 2000);
    }

    await processor.forceFlush();
    assert.equal(exporter.spanCount, 7);
  });

  void it("loses no spans when an external forceFlush drains the buffer", async () => {
    const { exporter, processor, tracer } = makeProcessor({
      maxExportBatchSizeBytes: 10_000,
    });

    for (let i = 0; i < 3; i++) {
      emit(tracer, `before-${i}`, 3000);
    }
    await processor.forceFlush();

    for (let i = 0; i < 6; i++) {
      emit(tracer, `after-${i}`, 3000);
    }
    await processor.forceFlush();

    assert.equal(exporter.spanCount, 9);
  });

  void it("does not count unsampled spans", () => {
    const { exporter, processor } = makeProcessor({
      maxExportBatchSizeBytes: 1000,
    });

    const unsampled = {
      name: "unsampled",
      attributes: { "gen_ai.input.messages": "x".repeat(50_000) },
      events: [],
      links: [],
      spanContext: () => ({
        traceId: "0".repeat(32),
        spanId: "0".repeat(16),
        traceFlags: TraceFlags.NONE,
      }),
    } as unknown as ReadableSpan;

    processor.onEnd(unsampled);
    assert.deepEqual(exporter.batchSizes, []);
  });

  void it("survives an export failure without an unhandled rejection", async () => {
    // forceFlush() rejects when an export fails and nothing awaits it, so
    // without an explicit catch this becomes an unhandled rejection — fatal
    // under Node's default --unhandled-rejections=throw.
    const rejections: unknown[] = [];
    const onRejection = (error: unknown) => rejections.push(error);
    process.on("unhandledRejection", onRejection);

    try {
      const failing: SpanExporter = {
        export: (_spans, cb) =>
          cb({ code: 1, error: new Error("export boom") }),
        shutdown: () => Promise.resolve(),
      };
      const processor = new SizeLimitedBatchSpanProcessor(failing, {
        maxExportBatchSize: 1000,
        maxQueueSize: 4096,
        scheduledDelayMillis: NEVER_MILLIS,
        maxExportBatchSizeBytes: 10_000,
      });
      const tracer = new BasicTracerProvider({
        spanProcessors: [processor],
      }).getTracer("test");

      for (let i = 0; i < 6; i++) {
        emit(tracer, `span-${i}`, 6000);
      }
      // Let any rejection surface.
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.deepEqual(
        rejections,
        [],
        "export failure surfaced as an unhandled rejection",
      );
    } finally {
      process.removeListener("unhandledRejection", onRejection);
    }
  });
});

void describe("utf8Size", () => {
  const cases: [string, string][] = [
    ["ascii", "Hello, how can I help you today? ".repeat(40)],
    ["latin1", "Café naïve façade Zürich ".repeat(50)],
    ["cyrillic", "Привет, как я могу помочь? ".repeat(50)],
    ["arabic", "مرحبا كيف يمكنني مساعدتك ".repeat(50)],
    ["cjk", "你好，我今天能为您做些什么？".repeat(90)],
    ["emoji", "Nice 👍🏽 great 🎉 done ✅ ".repeat(50)],
    ["mixed", '{"role":"user","content":"分析 and почему"}'.repeat(40)],
    // gen_ai.input.messages opens with ASCII JSON scaffolding before any
    // non-ASCII content — the layout that defeats prefix sampling.
    ["ascii-prefix", '[{"role":"system","content":"' + "你好".repeat(5000)],
  ];

  for (const [name, text] of cases) {
    void it(`is exact for ${name}`, () => {
      // Python samples long strings and tolerates ~2% error; Buffer.byteLength
      // is exact and cheaper, so TS has no reason to approximate.
      assert.equal(utf8Size(text), Buffer.byteLength(text, "utf8"));
    });
  }

  void it("counts multibyte text above its code-unit length", () => {
    const cjk = "你好".repeat(2000);
    // .length would report 4000; the real UTF-8 weight is 12000.
    assert.equal(cjk.length, 4000);
    assert.equal(utf8Size(cjk), 12_000);
  });

  void it("handles lone surrogates without throwing", () => {
    // Bad JSON decoding upstream can put lone surrogates in an attribute value.
    for (const text of ["hello \ud800 world", "\ud800".repeat(20)]) {
      assert.ok(utf8Size(text) > 0);
    }
  });

  void it("is exact for the empty string", () => {
    assert.equal(utf8Size(""), 0);
  });
});

void describe("approximateSpanSize", () => {
  void it("counts attribute keys and values", () => {
    const span = {
      name: "named",
      attributes: { k: "v".repeat(100), count: 7, tags: ["ab", "cd"] },
      events: [],
      links: [],
    } as unknown as ReadableSpan;

    // "named"(5) + "k"(1) + 100 + "count"(5) + 8 + "tags"(4) + 4
    assert.equal(approximateSpanSize(span), 127);
  });

  void it("counts events, links and the status message", () => {
    const span = {
      name: "s",
      attributes: {},
      events: [{ name: "boom", attributes: { detail: "d".repeat(50) } }],
      links: [],
      status: { code: 2, message: "went wrong" },
    } as unknown as ReadableSpan;

    // "s"(1) + "boom"(4) + "detail"(6) + 50 + "went wrong"(10)
    assert.equal(approximateSpanSize(span), 71);
  });

  void it("measures multibyte attribute values in bytes", () => {
    const span = {
      name: "s",
      attributes: { "gen_ai.input.messages": "你好".repeat(2000) },
      events: [],
      links: [],
    } as unknown as ReadableSpan;

    // Counting code units would report ~4000 and let the batch grow to ~3x the
    // configured limit.
    assert.ok(approximateSpanSize(span) > 11_000);
  });
});

void describe("LaminarSpanProcessor transport selection", () => {
  const instanceOf = (processor: LaminarSpanProcessor) =>
    (processor as unknown as { instance: unknown }).instance;

  void it("defaults to the plain upstream BatchSpanProcessor", () => {
    const processor = new LaminarSpanProcessor({
      exporter: new RecordingExporter(),
    });
    const instance = instanceOf(processor);

    assert.ok(instance instanceof BatchSpanProcessor);
    assert.ok(!(instance instanceof SizeLimitedBatchSpanProcessor));
  });

  void it("opts into the size-limited processor with flushBySize", () => {
    const processor = new LaminarSpanProcessor({
      exporter: new RecordingExporter(),
      flushBySize: true,
    });

    assert.ok(instanceOf(processor) instanceof SizeLimitedBatchSpanProcessor);
  });

  void it("ignores maxExportBatchSizeBytes without the flag", () => {
    // Passing a byte limit alone must not silently switch transports.
    const processor = new LaminarSpanProcessor({
      exporter: new RecordingExporter(),
      maxExportBatchSizeBytes: 1234,
    });

    assert.ok(
      !(instanceOf(processor) instanceof SizeLimitedBatchSpanProcessor),
    );
  });

  void it("still uses SimpleSpanProcessor when disableBatch is set", () => {
    const processor = new LaminarSpanProcessor({
      exporter: new RecordingExporter(),
      disableBatch: true,
    });

    assert.ok(instanceOf(processor) instanceof SimpleSpanProcessor);
  });

  void it("lets disableBatch win over flushBySize", () => {
    const processor = new LaminarSpanProcessor({
      exporter: new RecordingExporter(),
      disableBatch: true,
      flushBySize: true,
    });

    assert.ok(instanceOf(processor) instanceof SimpleSpanProcessor);
  });
});
