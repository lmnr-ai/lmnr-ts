// LAM-2568: `Laminar.flush()` must not resolve while an export that the batch
// processor already started on its own is still on the wire. On Lambda that
// send gets frozen mid-flight once the handler returns.
//
// Upstream `BatchSpanProcessorBase.forceFlush()` -> `_flushAll()` only exports
// and awaits what is still in `_finishedSpans`. A batch already handed to the
// exporter by the schedule-delay timer or the `maxExportBatchSize` trigger
// (both go through the `flush()` closure in `_maybeStartTimer`), or by our
// `flushBySize` trigger, is untracked there. `LaminarSpanProcessor.forceFlush()`
// therefore also awaits the exporter's `forceFlush()`, which awaits every send
// the OTLP exporter started (`OTLPExportDelegate._promiseQueue.awaitAll()`).
//
// Runs the real pipeline: `Laminar.initialize` -> `LaminarSpanProcessor` ->
// batch processor -> real OTLP/HTTP exporter -> a local server whose response
// time grows with the payload, like an upload does.

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, describe, it } from "node:test";

import {
  type ReadableSpan,
  type SpanExporter,
  TracerProvider,
} from "@opentelemetry/sdk-trace";

import { Laminar } from "../src/laminar";
import { LaminarSpanExporter } from "../src/opentelemetry-lib/tracing/exporter";
import { LaminarSpanProcessor } from "../src/opentelemetry-lib/tracing/processor";

// Upload time: a big batch takes much longer to send than a small one.
const BIG_BODY_BYTES = 50_000;
const BIG_EXPORT_MS = 1500;
const SMALL_EXPORT_MS = 100;
const BYTE_LIMIT = 100_000;

type TraceServer = {
  server: Server;
  port: number;
  received: () => number;
  inFlight: () => number;
  drain: () => Promise<void>;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Polls instead of sleeping a fixed time: how long the first export takes to
// reach the server depends on how loaded the machine is.
const waitFor = async (cond: () => boolean, what: string, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) {
      assert.fail(`timed out waiting for ${what}`);
    }
    await sleep(10);
  }
};

const startTraceServer = async (): Promise<TraceServer> => {
  let received = 0;
  let responded = 0;
  const server = createServer((req, res) => {
    if (!req.url?.startsWith("/v1/traces")) {
      res.writeHead(404).end();
      return;
    }
    received += 1;
    let bytes = 0;
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
    });
    req.on("end", () => {
      const delay = bytes > BIG_BODY_BYTES ? BIG_EXPORT_MS : SMALL_EXPORT_MS;
      setTimeout(() => {
        responded += 1;
        res.writeHead(200, { "content-type": "application/x-protobuf" });
        res.end();
      }, delay);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    server,
    port: (server.address() as AddressInfo).port,
    received: () => received,
    inFlight: () => received - responded,
    drain: async () => {
      const deadline = Date.now() + 10_000;
      while (received !== responded && Date.now() < deadline) {
        await sleep(50);
      }
    },
  };
};

// A GenAI-sized span: one big string attribute.
const endSpan = (name: string, bytes: number) => {
  const span = Laminar.startSpan({ name });
  span.setAttribute("gen_ai.input.messages", "x".repeat(bytes));
  span.end();
};

describe("Laminar.flush() awaits exports already in flight (LAM-2568)", () => {
  let ts: TraceServer;

  before(async () => {
    ts = await startTraceServer();
  });

  afterEach(async () => {
    await Laminar.shutdown();
    await ts.drain();
  });

  after(async () => {
    await new Promise<void>((resolve) => ts.server.close(() => resolve()));
  });

  const init = (extra: Parameters<typeof Laminar.initialize>[0] = {}) =>
    Laminar.initialize({
      projectApiKey: "test-key",
      baseUrl: "http://127.0.0.1",
      httpPort: ts.port,
      forceHttp: true,
      instrumentModules: {},
      ...extra,
    });

  it("waits for a batch the default processor started on its own", async () => {
    // A batch size of 1 starts the export as soon as the span ends, through
    // the same `flush()` closure the 5s schedule-delay timer uses.
    init({ maxExportBatchSize: 1 });
    const start = ts.received();

    endSpan("llm", 60_000);
    await waitFor(
      () => ts.received() - start === 1,
      "the processor to start the export",
    );

    // The buffer is empty, so upstream's forceFlush() alone resolves at once.
    // Asserted on server state, not wall-clock time, so CI load can't skew it.
    assert.equal(ts.inFlight(), 1, "the export is still on the wire");
    await Laminar.flush();
    assert.equal(ts.inFlight(), 0);
  });

  it("waits for a batch the flushBySize trigger started", async () => {
    init({ flushBySize: true, maxExportBatchSizeBytes: BYTE_LIMIT });
    const start = ts.received();

    // The root span ending pushes the total past the limit, so the size trigger
    // sends the big LLM batch (#1, slow) and the root span opens the next one.
    endSpan("llm", 90_000);
    endSpan("root", 20_000);
    await waitFor(
      () => ts.received() - start === 1,
      "size trigger to start export #1",
    );
    assert.equal(ts.inFlight(), 1, "export #1 is still on the wire");

    // flush() sends [root] (#2, fast); before the fix it awaited only #2.
    await Laminar.flush();
    assert.equal(ts.received() - start, 2);
    assert.equal(ts.inFlight(), 0);
  });

  it("waits with a user-supplied exporter in a LaminarSpanProcessor", async () => {
    // The customer's setup: a LaminarSpanProcessor built around an exporter
    // they own, passed in as `spanProcessor`.
    init({
      spanProcessor: new LaminarSpanProcessor({
        exporter: new LaminarSpanExporter({
          baseUrl: "http://127.0.0.1",
          port: ts.port,
          apiKey: "test-key",
          forceHttp: true,
        }),
        flushBySize: true,
        maxExportBatchSizeBytes: BYTE_LIMIT,
      }),
    });

    const start = ts.received();
    endSpan("llm", 90_000);
    endSpan("root", 20_000);
    await waitFor(() => ts.received() > start, "the first export to start");

    await Laminar.flush();
    assert.equal(ts.inFlight(), 0);
  });

  it("shutdown() waits too", async () => {
    init({ flushBySize: true, maxExportBatchSizeBytes: BYTE_LIMIT });

    const start = ts.received();
    endSpan("llm", 90_000);
    endSpan("root", 20_000);
    await waitFor(() => ts.received() > start, "the first export to start");

    await Laminar.shutdown();
    assert.equal(ts.inFlight(), 0);
  });
});

describe("LaminarSpanProcessor.forceFlush()", () => {
  class FailingExporter implements SpanExporter {
    public forceFlushCalls = 0;

    public export(
      _spans: ReadableSpan[],
      resultCallback: (result: { code: number; error?: Error }) => void,
    ): void {
      resultCallback({ code: 1, error: new Error("export failed") });
    }

    public shutdown(): Promise<void> {
      return Promise.resolve();
    }

    public forceFlush(): Promise<void> {
      this.forceFlushCalls += 1;
      return Promise.resolve();
    }
  }

  it("awaits the exporter even when the batch export fails, then rethrows", async () => {
    const exporter = new FailingExporter();
    const processor = new LaminarSpanProcessor({ exporter });
    const provider = new TracerProvider({ spanProcessors: [processor] });
    provider.getTracer("test").startSpan("span").end();

    await assert.rejects(() => processor.forceFlush(), /export failed/);
    assert.equal(exporter.forceFlushCalls, 1);
  });
});
