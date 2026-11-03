// Runs inside a scratch app (see run.mjs). Usage: node laminar-first.cjs <line>
// `Laminar.initialize()` runs BEFORE the app sets up its own OTel. The app's
// tracing is unrelated to Laminar, and it must keep working: Laminar writes
// the process-wide OTel registry first (its context manager, diag logger), and
// if lmnr resolved a different `@opentelemetry/api` copy than the app, the
// registry is stamped with lmnr's version and the app's api refuses it, so
// the app's provider never registers and its spans silently go nowhere.
// Separate process from host-check.cjs because the registry is per process.
const assert = require("node:assert/strict");
const { context, trace } = require("@opentelemetry/api");
const {
  AsyncLocalStorageContextManager,
} = require("@opentelemetry/context-async-hooks");
const { Laminar } = require("@lmnr-ai/lmnr");

const line = process.argv[2];
const sdk = require(
  line === "v3" ? "@opentelemetry/sdk-trace" : "@opentelemetry/sdk-trace-base",
);
const simple = (exporter) =>
  line === "v3"
    ? new sdk.SimpleSpanProcessor({ exporter })
    : new sdk.SimpleSpanProcessor(exporter);
const Provider = sdk.TracerProvider ?? sdk.BasicTracerProvider;
const parentOf = (s) => s.parentSpanContext?.spanId ?? s.parentSpanId;

Laminar.initialize({
  projectApiKey: "x",
  baseUrl: "http://127.0.0.1",
  grpcPort: 1,
  writeTrajectory: false,
});

// The app's own setup, after Laminar. Its context manager registration is a
// normal duplicate (Laminar's is already there), which is fine.
const cm = new AsyncLocalStorageContextManager();
cm.enable();
context.setGlobalContextManager(cm);
const exporter = new sdk.InMemorySpanExporter();
const provider = new Provider({ spanProcessors: [simple(exporter)] });
assert.equal(
  trace.setGlobalTracerProvider(provider),
  true,
  "app can register its tracer provider after Laminar",
);

const tracer = trace.getTracer("app");
tracer.startActiveSpan("app-parent", (parent) => {
  assert.ok(parent.isRecording(), "app's span is recording");
  tracer.startSpan("app-child").end();
  parent.end();
});
const byName = Object.fromEntries(
  exporter.getFinishedSpans().map((s) => [s.name, s]),
);
assert.deepEqual(Object.keys(byName).sort(), ["app-child", "app-parent"]);
assert.equal(
  parentOf(byName["app-child"]),
  byName["app-parent"].spanContext().spanId,
  "app's child span is parented to its own parent",
);
console.log(`${line}: laminar-first ok`);
process.exit(0);
