import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import { context, trace } from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";

import { Laminar } from "../src/index";
import { _resetConfiguration, initializeTracing } from "../src/opentelemetry-lib/configuration";
import { patchWorkflowClient } from "../src/opentelemetry-lib/instrumentation/temporal";
import { buildHeaders } from "../src/opentelemetry-lib/instrumentation/temporal/helpers";
import {
  ActivityInterceptorFactory,
} from "../src/opentelemetry-lib/instrumentation/temporal/interceptors";
import {
  SPAN_INPUT,
  SPAN_OUTPUT,
} from "../src/opentelemetry-lib/tracing/attributes";

/* eslint-disable
  @typescript-eslint/require-await,
  @typescript-eslint/no-unused-vars,
  @typescript-eslint/no-unnecessary-type-assertion
*/

// Produce a Temporal-style headers map carrying the active Laminar span context,
// the way the client-side WorkflowClientInterceptor would on workflow start.
const headersFromActiveSpan = (): Record<string, unknown> => {
  const span = Laminar.startActiveSpan({ name: "parent" });
  const headers = buildHeaders({});
  span.end();
  return headers;
};

// Run an activity through the inbound interceptor and return the finished
// activity span (if any). `next` resolves to the canned activity result.
const runActivity = async (
  exporter: InMemorySpanExporter,
  options: Record<string, unknown>,
  result: unknown = { done: true },
) => {
  const headers = headersFromActiveSpan();
  const factory = ActivityInterceptorFactory(options);
  const { inbound } = factory({ info: { activityType: "myActivity" } });
  const res = await inbound.execute(
    { headers, args: [42, "y"] },
    async () => result,
  );
  return {
    res,
    span: exporter
      .getFinishedSpans()
      .find((s) => s.name === "myActivity"),
  };
};

// A minimal fake of @temporalio/client's WorkflowClient: start() returns a
// handle whose result()/cancel()/terminate() resolve to canned values. This
// lets us exercise patchWorkflowClient without a running Temporal server.
const makeFakeClientModule = () => {
  class FakeHandle {
    async result() {
      return { ok: true };
    }
    async cancel() {
      return "cancelled";
    }
    async terminate() {
      return "terminated";
    }
  }
  class WorkflowClient {
    async start(_wf: unknown, _opts: unknown) {
      return new FakeHandle();
    }
    async signalWithStart(_wf: unknown, _opts: unknown) {
      return new FakeHandle();
    }
    async execute(_wf: unknown, _opts: unknown) {
      return { ok: true };
    }
  }
  return { WorkflowClient, Client: class {} };
};

const findSpan = (exporter: InMemorySpanExporter, name: string) =>
  exporter.getFinishedSpans().find((s) => s.name === name);

void describe("temporal workflow span", () => {
  const exporter = new InMemorySpanExporter();
  void beforeEach(() => {
    _resetConfiguration();
    initializeTracing({ exporter, disableBatch: true });
    Object.defineProperty(Laminar, "isInitialized", {
      value: true,
      writable: true,
    });
  });

  void afterEach(() => {
    exporter.reset();
  });

  void after(async () => {
    await exporter.shutdown();
    trace.disable();
    context.disable();
  });

  void it("activates the workflow span during the start RPC", async () => {
    const mod = makeFakeClientModule();
    // Capture the active Laminar span seen from inside start()'s body, which is
    // where WorkflowClientInterceptor.start runs and injects trace headers.
    let activeDuringStart: unknown;
    mod.WorkflowClient.prototype.start = async function () {
      activeDuringStart = Laminar.getCurrentSpan();
      return {
        async result() {
          return null;
        },
        async cancel() {
          return null;
        },
        async terminate() {
          return null;
        },
      };
    };
    patchWorkflowClient(mod);
    const client = new mod.WorkflowClient();

    const handle = await client.start("wfActive", { args: [] });
    assert.ok(activeDuringStart, "a Laminar span must be active during start()");
    await handle.result();
  });

  void it("records a workflow span with input on start + result", async () => {
    const mod = makeFakeClientModule();
    patchWorkflowClient(mod);
    const client = new mod.WorkflowClient();

    const handle = await client.start("myWorkflow", { args: [1, "x"] });
    // Span must stay open until result() resolves.
    assert.equal(findSpan(exporter, "myWorkflow"), undefined);

    const res = await handle.result();
    assert.deepEqual(res, { ok: true });

    const span = findSpan(exporter, "myWorkflow");
    assert.ok(span, "workflow span should be finished after result()");
    assert.equal(span!.attributes[SPAN_INPUT], JSON.stringify([1, "x"]));
    assert.equal(span!.attributes[SPAN_OUTPUT], JSON.stringify({ ok: true }));
  });

  void it("records a cancel child span and ends the workflow span", async () => {
    const mod = makeFakeClientModule();
    patchWorkflowClient(mod);
    const client = new mod.WorkflowClient();

    const handle = await client.start("wfCancel", { args: [] });
    await handle.cancel();

    const wfSpan = findSpan(exporter, "wfCancel");
    const cancelSpan = findSpan(exporter, "temporal.workflow.cancel");
    assert.ok(wfSpan, "workflow span should be ended after cancel()");
    assert.ok(cancelSpan, "a cancel child span should be recorded");
    // cancel child must be parented under the workflow span (same trace).
    assert.equal(
      cancelSpan!.spanContext().traceId,
      wfSpan!.spanContext().traceId,
    );
  });

  void it("does not double-end on cancel() then result()", async () => {
    const mod = makeFakeClientModule();
    patchWorkflowClient(mod);
    const client = new mod.WorkflowClient();

    const handle = await client.start("wfCancelResult", { args: [] });
    await handle.cancel();
    await handle.result();

    const wfSpans = exporter
      .getFinishedSpans()
      .filter((s) => s.name === "wfCancelResult");
    assert.equal(wfSpans.length, 1, "workflow span must end exactly once");
  });

  void it("records a terminate child span", async () => {
    const mod = makeFakeClientModule();
    patchWorkflowClient(mod);
    const client = new mod.WorkflowClient();

    const handle = await client.start("wfTerminate", { args: [] });
    await handle.terminate();

    assert.ok(findSpan(exporter, "wfTerminate"));
    assert.ok(findSpan(exporter, "temporal.workflow.terminate"));
  });

  void it("records output for execute()", async () => {
    const mod = makeFakeClientModule();
    patchWorkflowClient(mod);
    const client = new mod.WorkflowClient();

    const res = await client.execute("wfExec", { args: ["a"] });
    assert.deepEqual(res, { ok: true });

    const span = findSpan(exporter, "wfExec");
    assert.ok(span);
    assert.equal(span!.attributes[SPAN_INPUT], JSON.stringify(["a"]));
    assert.equal(span!.attributes[SPAN_OUTPUT], JSON.stringify({ ok: true }));
  });

  void it("records activity args and output by default", async () => {
    const { res, span } = await runActivity(exporter, {});
    assert.deepEqual(res, { done: true });
    assert.ok(span);
    assert.equal(span!.attributes[SPAN_INPUT], JSON.stringify([42, "y"]));
    assert.equal(span!.attributes[SPAN_OUTPUT], JSON.stringify({ done: true }));
  });

  void it("omits activity args when recordActivityArgs is false", async () => {
    const { span } = await runActivity(exporter, { recordActivityArgs: false });
    assert.ok(span);
    assert.equal(span!.attributes[SPAN_INPUT], undefined);
    assert.equal(span!.attributes[SPAN_OUTPUT], JSON.stringify({ done: true }));
  });

  void it("omits activity output when recordActivityOutput is false", async () => {
    const { span } = await runActivity(exporter, {
      recordActivityOutput: false,
    });
    assert.ok(span);
    assert.equal(span!.attributes[SPAN_INPUT], JSON.stringify([42, "y"]));
    assert.equal(span!.attributes[SPAN_OUTPUT], undefined);
  });

  void it("creates no activity span when createActivitySpan is false", async () => {
    const { res, span } = await runActivity(exporter, {
      createActivitySpan: false,
    });
    assert.deepEqual(res, { done: true });
    assert.equal(span, undefined);
  });

  void it("is idempotent — double patch does not double-wrap", async () => {
    const mod = makeFakeClientModule();
    patchWorkflowClient(mod);
    patchWorkflowClient(mod);
    const client = new mod.WorkflowClient();

    const handle = await client.start("wfIdem", { args: [] });
    await handle.result();

    const spans = exporter
      .getFinishedSpans()
      .filter((s) => s.name === "wfIdem");
    assert.equal(spans.length, 1);
  });
});
