// LAM-2568 repro: `Laminar.flush()` resolves while an export that the batch
// processor already started on its own is still on the wire.
//
// Upstream `BatchSpanProcessorBase.forceFlush()` -> `_flushAll()` only exports
// what is still in `_finishedSpans` and awaits those exports. A batch that was
// already moved out of the buffer by the schedule-delay timer, the
// `maxExportBatchSize` trigger, or (with `flushBySize`) our size trigger is not
// tracked by the processor, so nothing awaits it. The OTLP exporter does track
// it: its `forceFlush()` awaits every pending send
// (`OTLPExportDelegate._promiseQueue.awaitAll()`), which is why calling
// `exporter.forceFlush()` after `Laminar.flush()` works around it.
//
// These cases pin the CURRENT behavior against the real pipeline:
// `Laminar.initialize` -> `LaminarSpanProcessor` -> batch processor -> real
// OTLP/HTTP exporter -> a local server whose response time grows with the
// payload, like an upload does. A fix should flip every
// `inFlightAfterFlush === 1` assertion below to `=== 0`.

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, describe, it } from "node:test";

import { Laminar } from "../src/laminar";
import { LaminarSpanExporter } from "../src/opentelemetry-lib/tracing/exporter";
import { LaminarSpanProcessor } from "../src/opentelemetry-lib/tracing/processor";

// Upload time: a big batch takes much longer to send than a small one.
const BIG_BODY_BYTES = 50_000;
const BIG_EXPORT_MS = 3000;
const SMALL_EXPORT_MS = 300;
// Upstream's default `scheduledDelayMillis`; Laminar does not override it.
const UPSTREAM_SCHEDULE_DELAY_MS = 5000;
const BYTE_LIMIT = 100_000;

type TraceServer = {
  server: Server;
  port: number;
  received: () => number;
  inFlight: () => number;
  drain: () => Promise<void>;
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
      const deadline = Date.now() + 15_000;
      while (received !== responded && Date.now() < deadline) {
        await sleep(50);
      }
    },
  };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A GenAI-sized span: one big string attribute.
const endSpan = (name: string, bytes: number) => {
  const span = Laminar.startSpan({ name });
  span.setAttribute("gen_ai.input.messages", "x".repeat(bytes));
  span.end();
};

describe("LAM-2568: Laminar.flush() vs an export already in flight", () => {
  let ts: TraceServer;

  before(async () => {
    ts = await startTraceServer();
  });

  afterEach(async () => {
    await Laminar.shutdown();
    // shutdown() has the same gap, so let the server finish before the next case.
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

  const flushAndMeasure = async (label: string, flush: () => Promise<void>) => {
    const t0 = Date.now();
    await flush();
    const flushMs = Date.now() - t0;
    const inFlightAfterFlush = ts.inFlight();
    console.log(
      `[${label}] flush took ${flushMs}ms; ` +
        `exports still in flight when it resolved: ${inFlightAfterFlush}`,
    );
    return { flushMs, inFlightAfterFlush };
  };

  it("default BatchSpanProcessor: a timer-started export is not awaited", async () => {
    init();
    const start = ts.received();

    // The LLM span ends, then the handler keeps working (tool calls, more
    // reasoning) for longer than the 5s schedule delay. The timer moves the
    // batch out of the buffer and starts sending it.
    endSpan("llm", 60_000);
    await sleep(UPSTREAM_SCHEDULE_DELAY_MS + 200);
    assert.equal(ts.received() - start, 1, "timer started the export");

    // End of the Lambda handler. The buffer is empty, so forceFlush() has
    // nothing to export and resolves at once.
    const { flushMs, inFlightAfterFlush } = await flushAndMeasure(
      "default, timer",
      () => Laminar.flush(),
    );
    assert.ok(flushMs < SMALL_EXPORT_MS, `flush took ${flushMs}ms`);
    assert.equal(inFlightAfterFlush, 1, "BUG: the timer's export is in flight");
  });

  it("flushBySize: a size-triggered export is not awaited", async () => {
    init({ flushBySize: true, maxExportBatchSizeBytes: BYTE_LIMIT });
    const start = ts.received();

    // A big LLM span is buffered; the root span ending pushes the total past
    // the limit, so the size trigger fires `void forceFlush()`: the big batch
    // goes out (#1, slow) and the root span opens the next batch.
    endSpan("llm", 90_000);
    endSpan("root", 20_000);
    await sleep(50);
    assert.equal(ts.received() - start, 1, "size trigger started export #1");

    // End of the Lambda handler. flush() exports [root] (#2, fast) and awaits
    // only #2. #1, the big one, is still uploading.
    const { flushMs, inFlightAfterFlush } = await flushAndMeasure(
      "flushBySize",
      () => Laminar.flush(),
    );
    assert.equal(ts.received() - start, 2);
    assert.ok(flushMs < BIG_EXPORT_MS, `flush took ${flushMs}ms`);
    assert.equal(
      inFlightAfterFlush,
      1,
      "BUG: the size-triggered export is in flight",
    );
  });

  it("customer workaround: exporter.forceFlush() after Laminar.flush() waits", async () => {
    // "Owning the exporter": a LaminarSpanProcessor built with our own exporter
    // instance, so we can call its forceFlush() ourselves.
    const exporter = new LaminarSpanExporter({
      baseUrl: "http://127.0.0.1",
      port: ts.port,
      apiKey: "test-key",
      forceHttp: true,
    });
    init({
      spanProcessor: new LaminarSpanProcessor({
        exporter,
        flushBySize: true,
        maxExportBatchSizeBytes: BYTE_LIMIT,
      }),
    });

    endSpan("llm", 90_000);
    endSpan("root", 20_000);
    await sleep(50);

    const { flushMs, inFlightAfterFlush } = await flushAndMeasure(
      "flushBySize + exporter.forceFlush()",
      async () => {
        await Laminar.flush();
        await exporter.forceFlush();
      },
    );
    assert.ok(flushMs >= BIG_EXPORT_MS - 200, `flush took ${flushMs}ms`);
    assert.equal(inFlightAfterFlush, 0);
  });

  it("control: disableBatch (SimpleSpanProcessor) awaits every pending export", async () => {
    init({ disableBatch: true });

    endSpan("llm", 90_000);
    endSpan("root", 20_000);
    await sleep(50);

    // SimpleSpanProcessor.forceFlush() awaits its `_pendingExports` and then
    // calls exporter.forceFlush(), so nothing is left on the wire.
    const { inFlightAfterFlush } = await flushAndMeasure("disableBatch", () =>
      Laminar.flush(),
    );
    assert.equal(inFlightAfterFlush, 0);
  });
});
