// Runs inside a scratch app that has the packed `@lmnr-ai/lmnr` plus ONE host
// OTel SDK line installed (see run.mjs). Usage: node host-check.cjs <line>
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const { context, trace } = require("@opentelemetry/api");
const {
  AsyncLocalStorageContextManager,
} = require("@opentelemetry/context-async-hooks");
const { Laminar, LaminarSpanProcessor, observe } = require("@lmnr-ai/lmnr");

const line = process.argv[2];
// v1 / v2 hosts use `sdk-trace-base` (positional processors, BasicTracerProvider);
// a v3 host has `sdk-trace` (options-object processors, TracerProvider).
const sdk = require(
  line === "v3" ? "@opentelemetry/sdk-trace" : "@opentelemetry/sdk-trace-base",
);
const simple = (exporter) =>
  line === "v3"
    ? new sdk.SimpleSpanProcessor({ exporter })
    : new sdk.SimpleSpanProcessor(exporter);
const Provider = sdk.TracerProvider ?? sdk.BasicTracerProvider;
const short = (id) => id && id.slice(0, 4);
const parentOf = (s) => s.parentSpanContext?.spanId ?? s.parentSpanId;
const describe = (exp) =>
  exp
    .getFinishedSpans()
    .map((s) => `${s.name}<-${short(parentOf(s))}`)
    .sort();

(async () => {
  // 0. lmnr must resolve the app's `@opentelemetry/api`, not a nested copy:
  // a second copy splits the process-wide OTel registry (see laminar-first.cjs).
  const lmnrDir = path.dirname(require.resolve("@lmnr-ai/lmnr"));
  assert.equal(
    require.resolve("@opentelemetry/api", { paths: [lmnrDir] }),
    require.resolve("@opentelemetry/api"),
    "lmnr shares the app's @opentelemetry/api",
  );

  // 1. Host owns the global provider; Laminar runs next to it.
  const hostExp = new sdk.InMemorySpanExporter();
  const cm = new AsyncLocalStorageContextManager();
  cm.enable();
  context.setGlobalContextManager(cm);
  const hostProvider = new Provider({ spanProcessors: [simple(hostExp)] });
  trace.setGlobalTracerProvider(hostProvider);

  const lmnrExp = new sdk.InMemorySpanExporter();
  Laminar.initialize({
    projectApiKey: "x",
    spanProcessor: new LaminarSpanProcessor({
      apiKey: "x",
      exporter: lmnrExp,
      disableBatch: true,
    }),
  });
  await observe({ name: "outer" }, async () => {
    await observe({ name: "inner" }, async () => {
      trace.getTracer("host").startSpan("host-span").end();
    });
  });
  await Laminar.flush();
  await hostProvider.forceFlush();

  const byName = Object.fromEntries(
    lmnrExp.getFinishedSpans().map((s) => [s.name, s]),
  );
  assert.deepEqual(Object.keys(byName).sort(), ["inner", "outer"]);
  assert.equal(parentOf(byName.outer), undefined);
  assert.equal(
    parentOf(byName.inner),
    byName.outer.spanContext().spanId,
    "inner is parented to outer",
  );
  const hostSpans = hostExp.getFinishedSpans();
  assert.deepEqual(
    hostSpans.map((s) => s.name),
    ["host-span"],
    "host exporter only sees the host span",
  );
  assert.equal(
    parentOf(hostSpans[0]),
    byName.inner.spanContext().spanId,
    "host span is parented to Laminar's inner span",
  );

  // 2. LaminarSpanProcessor inside a host-owned provider.
  const exp2 = new sdk.InMemorySpanExporter();
  const p2 = new Provider({
    spanProcessors: [
      new LaminarSpanProcessor({
        apiKey: "x",
        exporter: exp2,
        disableBatch: true,
      }),
    ],
  });
  const t = p2.getTracer("x");
  const a = t.startSpan("a");
  context.with(trace.setSpan(context.active(), a), () =>
    t.startSpan("b").end(),
  );
  a.end();
  await p2.forceFlush();
  const spans2 = Object.fromEntries(
    exp2.getFinishedSpans().map((s) => [s.name, s]),
  );
  assert.equal(parentOf(spans2.b), spans2.a.spanContext().spanId);

  // 3. Host spans through the REAL Laminar exporter and OTLP transformer.
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      received.push(Buffer.concat(chunks));
      res.writeHead(200, { "content-type": "application/x-protobuf" });
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const p3 = new Provider({
    spanProcessors: [
      new LaminarSpanProcessor({
        apiKey: "x",
        baseUrl: "http://127.0.0.1",
        port: server.address().port,
        forceHttp: true,
        disableBatch: true,
      }),
    ],
  });
  p3.getTracer("x").startSpan("otlp-host-span").end();
  await p3.forceFlush();
  await new Promise((r) => setTimeout(r, 200));
  server.close();
  assert.ok(received.length > 0, "OTLP export reached the server");
  assert.ok(
    received.some((b) => b.includes("otlp-host-span")),
    "exported payload contains the host span",
  );

  console.log(`${line}: ok`, describe(lmnrExp));
  process.exit(0);
})().catch((e) => {
  console.error(`${line}: FAIL`, e);
  process.exit(1);
});
