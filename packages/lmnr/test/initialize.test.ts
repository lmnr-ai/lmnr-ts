import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";

import { getRuntime } from "../src/debug";
import { Laminar } from "../src/index";

void describe("initialize", () => {
  const originalEnv = process.env;
  void beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.LMNR_PROJECT_API_KEY;
    delete process.env.LMNR_BASE_URL;
    delete process.env.OTEL_ENDPOINT;
    delete process.env.OTEL_HEADERS;
    delete process.env.OTEL_PROTOCOL;
    delete process.env.OTEL_EXPORTER;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS;
  });
  void afterEach(async () => {
    process.env = originalEnv;
    await Laminar.shutdown();
  });

  void it("initializes", () => {
    Laminar.initialize({
      projectApiKey: "test",
    });

    assert.strictEqual(Laminar.initialized(), true);
  });

  void it("throws an error if projectApiKey is not provided", () => {
    assert.throws(() => Laminar.initialize({}), Error);
  });

  void it("records the LMNR_SPAN_CONTEXT trace id on the debug runtime", () => {
    // A debug run attached via LMNR_SPAN_CONTEXT never opens a root span, so the
    // run pointer would emit an empty trace_id unless the inherited trace id is
    // recorded at env-attach time. Replay is left disabled (no replay trace id),
    // so no source-trace fetch happens.
    process.env.LMNR_DEBUG = "true";
    process.env.LMNR_DEBUG_SESSION_ID = "session-1";
    delete process.env.LMNR_DEBUG_REPLAY_TRACE_ID;
    delete process.env.LMNR_DEBUG_CACHE_UNTIL;
    process.env.LMNR_SPAN_CONTEXT = JSON.stringify({
      traceId: "01234567-89ab-cdef-0123-456789abcdef",
      spanId: "00000000-0000-0000-0123-456789abcdef",
      isRemote: false,
      spanPath: ["parent"],
      spanIdsPath: ["00000000-0000-0000-0123-456789abcdef"],
    });

    Laminar.initialize({ projectApiKey: "test" });

    const lines: string[] = [];
    const originalLog = console.log.bind(console);
    console.log = (...args: unknown[]) => {
      lines.push(args.join(" "));
    };
    try {
      getRuntime()?.emitPointer();
    } finally {
      console.log = originalLog;
    }

    const pointerLine = lines.find((l) => l.startsWith("LMNR_DEBUG_RUN "));
    assert.ok(pointerLine !== undefined);
    const payload = JSON.parse(pointerLine.slice("LMNR_DEBUG_RUN ".length));
    assert.strictEqual(payload.trace_id, "01234567-89ab-cdef-0123-456789abcdef");
  });

  void it("does not leak exit listeners across init/shutdown cycles", async () => {
    // Each debug-mode initialize() registers a process `exit` hook to emit the
    // run pointer. `process.once` only auto-detaches after exit fires, so the
    // hook must be removed on shutdown — otherwise repeated cycles accumulate
    // listeners and trip Node's MaxListenersExceededWarning (~10 cycles).
    process.env.LMNR_DEBUG = "true";
    process.env.LMNR_DEBUG_SESSION_ID = "session-leak";
    delete process.env.LMNR_DEBUG_REPLAY_TRACE_ID;
    delete process.env.LMNR_DEBUG_CACHE_UNTIL;

    const before = process.listenerCount("exit");
    for (let i = 0; i < 12; i++) {
      Laminar.initialize({ projectApiKey: "test" });
      await Laminar.shutdown();
    }
    assert.strictEqual(process.listenerCount("exit"), before);
  });
});
