import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import { context, trace } from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";

import { Laminar, observe } from "../src";
import {
  _resetConfiguration,
  initializeTracing,
} from "../src/opentelemetry-lib/configuration";
import {
  _resetBraintrustBridgeForTests,
  installBraintrustBridge,
} from "../src/opentelemetry-lib/instrumentation/braintrust";
import {
  LaminarAttributes,
  SPAN_BRIDGE_NAME,
  SPAN_BRIDGE_VERSION,
  SPAN_IDS_PATH,
  SPAN_INPUT,
  SPAN_OUTPUT,
  SPAN_PATH,
  SPAN_TYPE,
} from "../src/opentelemetry-lib/tracing/attributes";
import { getParentSpanId } from "../src/opentelemetry-lib/tracing/compat";

/**
 * Minimal reimplementation of Braintrust's `SpanImpl` contract — the parts
 * the bridge hooks into. Each test builds its own fresh class (via
 * `makeFakeSpanImpl`) so the bridge's prototype patch targets a clean
 * prototype and tests don't leak across each other.
 *
 * Mirrors the real Braintrust flow from `braintrust/dist/index.mjs`:
 *  - constructor calls `logInternal({ event, internalData })` with
 *    `internalData.metrics.start` and `internalData.span_attributes`
 *  - `span.log({...})` → `logInternal({ event })`
 *  - `span.end({endTime})` → `logInternal({ internalData: { metrics: { end } } })`
 */
interface FakeSpanConfig {
  name: string;
  type?: string;
  parent?: FakeSpan;
  rootSpanId?: string;
  initialEvent?: Record<string, unknown>;
  spanId?: string;
}

class FakeSpan {
  kind = "span" as const;
  id: string;
  spanId: string;
  rootSpanId: string;
  spanParents: string[];
  private loggedEndTime: number | undefined;
  // Captured by the bridge's patched logInternal; kept here for the
  // original-method call to stay harmless.
  events: Array<{
    event?: Record<string, unknown>;
    internalData?: Record<string, unknown>;
  }> = [];

  constructor(cfg: FakeSpanConfig) {
    this.id = cfg.spanId ?? randomId();
    this.spanId = this.id;
    this.rootSpanId = cfg.parent?.rootSpanId ?? cfg.rootSpanId ?? this.id;
    this.spanParents = cfg.parent ? [cfg.parent.spanId] : [];

    const start = Date.now() / 1000;
    this.logInternal({
      event: cfg.initialEvent ?? {},
      internalData: {
        metrics: { start },
        span_attributes: { name: cfg.name, type: cfg.type },
      },
    });
  }

  log(event: Record<string, unknown>): void {
    this.logInternal({ event });
  }

  end(args?: { endTime?: number }): number {
    const end = args?.endTime ?? Date.now() / 1000;
    if (!this.loggedEndTime) {
      this.loggedEndTime = end;
      this.logInternal({ internalData: { metrics: { end } } });
    }
    return end;
  }

  close(args?: { endTime?: number }): number {
    return this.end(args);
  }

  // Captures every call — the patched version will wrap this. The original
  // version must remain `function` (prototype-addressable) so the patch can
  // `.call(this, args)` the pre-patch implementation.
  logInternal(args: {
    event?: Record<string, unknown>;
    internalData?: Record<string, unknown>;
  }): void {
    this.events.push(args);
  }
}

const randomId = (): string =>
  Math.random().toString(36).slice(2, 14).padEnd(12, "0");

// Per-test fresh SpanImpl class. The bridge patches SpanImpl.prototype in
// place; using a fresh subclass lets each test start from an un-patched
// prototype without global clean-up.
const makeFakeSpanImpl = () => {
  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
  class FreshSpanImpl extends FakeSpan {}
  return FreshSpanImpl;
};

// Keep only the spans the bridge actually emitted (exclude `observe` /
// `manual outer` wrapper spans created by the tests themselves).
const onlyBraintrustSpans = (exporter: InMemorySpanExporter) =>
  exporter
    .getFinishedSpans()
    .filter((s) => s.name !== "outer" && s.name !== "manual outer");

void describe("Braintrust bridge", () => {
  let exporter: InMemorySpanExporter;

  void beforeEach(() => {
    _resetConfiguration();
    _resetBraintrustBridgeForTests();
    exporter = new InMemorySpanExporter();
    initializeTracing({ exporter, disableBatch: true });
    Object.defineProperty(Laminar, "isInitialized", {
      value: true,
      writable: true,
    });
  });

  void afterEach(async () => {
    await exporter.shutdown();
  });

  void after(() => {
    trace.disable();
    context.disable();
  });

  void it("exports a single Braintrust span as an OTel span", () => {
    const SpanImpl = makeFakeSpanImpl();
    installBraintrustBridge({ SpanImpl });

    const span = new SpanImpl({ name: "traced_fn", type: "function" });
    span.log({ input: { prompt: "hi" }, output: { text: "hello" } });
    span.end();

    const spans = onlyBraintrustSpans(exporter);
    assert.strictEqual(spans.length, 1);
    const [s] = spans;
    assert.strictEqual(s.name, "traced_fn");
    assert.strictEqual(s.attributes[SPAN_TYPE], "DEFAULT");
    assert.ok(s.attributes[SPAN_INPUT]);
    assert.ok(s.attributes[SPAN_OUTPUT]);
    assert.deepStrictEqual(JSON.parse(s.attributes[SPAN_INPUT] as string), {
      prompt: "hi",
    });
  });

  void it("maps LLM spans with gen_ai.* attributes and token metrics", () => {
    const SpanImpl = makeFakeSpanImpl();
    installBraintrustBridge({ SpanImpl });

    const span = new SpanImpl({ name: "Chat Completion", type: "llm" });
    span.log({
      input: [
        { role: "user", content: "ping" },
      ],
      metadata: { provider: "openai", model: "gpt-4o-mini" },
    });
    span.log({
      output: [
        {
          index: 0,
          message: { role: "assistant", content: "pong" },
          finish_reason: "stop",
        },
      ],
      metrics: {
        prompt_tokens: 7,
        completion_tokens: 3,
        tokens: 10,
        time_to_first_token: 0.25,
      },
    });
    span.end();

    const spans = onlyBraintrustSpans(exporter);
    assert.strictEqual(spans.length, 1);
    const s = spans[0];
    assert.strictEqual(s.attributes[SPAN_TYPE], "LLM");
    assert.strictEqual(s.attributes[LaminarAttributes.PROVIDER], "openai");
    assert.strictEqual(
      s.attributes[LaminarAttributes.REQUEST_MODEL],
      "gpt-4o-mini",
    );
    assert.strictEqual(s.attributes[LaminarAttributes.INPUT_TOKEN_COUNT], 7);
    assert.strictEqual(s.attributes[LaminarAttributes.OUTPUT_TOKEN_COUNT], 3);
    assert.strictEqual(s.attributes[LaminarAttributes.TOTAL_TOKEN_COUNT], 10);

    // Input/output follow OTel GenAI semconv: `{role, parts: [{type, ...}]}`.
    const input = JSON.parse(s.attributes["gen_ai.input.messages"] as string);
    assert.strictEqual(input.length, 1);
    assert.strictEqual(input[0].role, "user");
    assert.deepStrictEqual(input[0].parts, [
      { type: "text", content: "ping" },
    ]);

    const output = JSON.parse(s.attributes["gen_ai.output.messages"] as string);
    assert.strictEqual(output.length, 1);
    assert.strictEqual(output[0].role, "assistant");
    assert.strictEqual(output[0].finish_reason, "stop");
    assert.deepStrictEqual(output[0].parts, [
      { type: "text", content: "pong" },
    ]);
  });

  void it("emits tool_call parts in gen_ai.output.messages", () => {
    const SpanImpl = makeFakeSpanImpl();
    installBraintrustBridge({ SpanImpl });

    const span = new SpanImpl({ name: "Chat Completion", type: "llm" });
    span.log({
      input: [{ role: "user", content: "what's the weather?" }],
      metadata: { provider: "openai", model: "gpt-4o-mini" },
    });
    span.log({
      output: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_abc",
                type: "function",
                function: {
                  name: "get_weather",
                  arguments: '{"city":"NYC"}',
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      metrics: { prompt_tokens: 5, completion_tokens: 4 },
    });
    span.end();

    const spans = onlyBraintrustSpans(exporter);
    assert.strictEqual(spans.length, 1);
    const output = JSON.parse(
      spans[0].attributes["gen_ai.output.messages"] as string,
    );
    assert.strictEqual(output.length, 1);
    assert.strictEqual(output[0].role, "assistant");
    assert.strictEqual(output[0].finish_reason, "tool_calls");
    const toolCallPart = output[0].parts.find(
      (p: { type: string }) => p.type === "tool_call",
    );
    assert.ok(toolCallPart);
    assert.strictEqual(toolCallPart.id, "call_abc");
    assert.strictEqual(toolCallPart.name, "get_weather");
    // Arguments should be JSON-parsed into a structured object.
    assert.deepStrictEqual(toolCallPart.arguments, { city: "NYC" });
  });

  void it("passes through output already in {role, parts} GenAI shape", () => {
    const SpanImpl = makeFakeSpanImpl();
    installBraintrustBridge({ SpanImpl });

    // User / plugin already emits output in GenAI semconv — we should not
    // re-wrap the parts, just thread them through verbatim.
    const span = new SpanImpl({ name: "Chat Completion", type: "llm" });
    span.log({
      input: [{ role: "user", content: "hi" }],
      metadata: { provider: "openai", model: "gpt-4o-mini" },
    });
    span.log({
      output: [
        {
          role: "assistant",
          parts: [
            { type: "thinking", content: "pondering..." },
            { type: "text", content: "hello!" },
          ],
          finish_reason: "stop",
        },
      ],
    });
    span.end();

    const spans = onlyBraintrustSpans(exporter);
    const output = JSON.parse(
      spans[0].attributes["gen_ai.output.messages"] as string,
    );
    assert.deepStrictEqual(output, [
      {
        role: "assistant",
        parts: [
          { type: "thinking", content: "pondering..." },
          { type: "text", content: "hello!" },
        ],
        finish_reason: "stop",
      },
    ]);
  });

  void it("maps type='tool' to TOOL span with ai.toolCall.name", () => {
    const SpanImpl = makeFakeSpanImpl();
    installBraintrustBridge({ SpanImpl });

    const span = new SpanImpl({ name: "get_weather", type: "tool" });
    span.log({ input: { city: "NYC" }, output: { tempF: 72 } });
    span.end();

    const spans = onlyBraintrustSpans(exporter);
    assert.strictEqual(spans.length, 1);
    const s = spans[0];
    assert.strictEqual(s.attributes[SPAN_TYPE], "TOOL");
    assert.strictEqual(s.attributes["ai.toolCall.name"], "get_weather");
  });

  void it("nests child spans under parent using Braintrust spanParents", () => {
    const SpanImpl = makeFakeSpanImpl();
    installBraintrustBridge({ SpanImpl });

    const root = new SpanImpl({ name: "agent_run", type: "function" });
    const child = new SpanImpl({
      name: "Chat Completion",
      type: "llm",
      parent: root,
    });
    child.log({
      input: [{ role: "user", content: "hi" }],
      metadata: { provider: "openai", model: "gpt-4o-mini" },
    });
    child.log({ output: [{ message: { role: "assistant", content: "hi!" } }] });
    child.end();
    root.end();

    const spans = onlyBraintrustSpans(exporter);
    assert.strictEqual(spans.length, 2);
    const rootOtel = spans.find((s) => s.name === "agent_run");
    const childOtel = spans.find((s) => s.name === "Chat Completion");
    assert.ok(rootOtel);
    assert.ok(childOtel);
    assert.strictEqual(
      childOtel.spanContext().traceId,
      rootOtel.spanContext().traceId,
      "parent and child share a trace",
    );
    assert.strictEqual(
      getParentSpanId(childOtel),
      rootOtel.spanContext().spanId,
      "child's parent is the root span",
    );

    const childIdsPath = childOtel.attributes[SPAN_IDS_PATH] as string[];
    const rootIdsPath = rootOtel.attributes[SPAN_IDS_PATH] as string[];
    assert.strictEqual(
      childIdsPath.length,
      rootIdsPath.length + 1,
      "child's ids_path extends root's by one",
    );
    assert.deepStrictEqual(
      childIdsPath.slice(0, rootIdsPath.length),
      rootIdsPath,
      "child's ids_path starts with root's",
    );
  });

  void it("reparents a root Braintrust span under an outer observe() span", () => {
    const SpanImpl = makeFakeSpanImpl();
    installBraintrustBridge({ SpanImpl });

    let outerTraceId: string | undefined;
    let outerSpanId: string | undefined;
    let outerIdsPath: string[] | undefined;

    observe({ name: "outer" }, () => {
      const active = trace.getActiveSpan();
      const ctx = active?.spanContext();
      outerTraceId = ctx?.traceId;
      outerSpanId = ctx?.spanId;
      outerIdsPath = (
        active as unknown as {
          attributes?: Record<string, unknown>;
        }
      ).attributes?.[SPAN_IDS_PATH] as string[] | undefined;

      const span = new SpanImpl({ name: "traced_fn", type: "function" });
      span.log({ input: "hi", output: "bye" });
      span.end();
    });

    const spans = onlyBraintrustSpans(exporter);
    assert.strictEqual(spans.length, 1);
    const bt = spans[0];
    assert.strictEqual(bt.spanContext().traceId, outerTraceId);
    assert.strictEqual(getParentSpanId(bt), outerSpanId);

    const btIdsPath = bt.attributes[SPAN_IDS_PATH] as string[];
    assert.ok(outerIdsPath);
    assert.deepStrictEqual(
      btIdsPath.slice(0, outerIdsPath.length),
      outerIdsPath,
      "BT ids_path starts with the outer observe() path",
    );
    const btPath = bt.attributes[SPAN_PATH] as string[];
    assert.strictEqual(btPath[0], "outer");
  });

  void it("records error on span.log({ error })", () => {
    const SpanImpl = makeFakeSpanImpl();
    installBraintrustBridge({ SpanImpl });

    const span = new SpanImpl({ name: "traced_fn", type: "function" });
    span.log({ error: "nope" });
    span.end();

    const spans = onlyBraintrustSpans(exporter);
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].status.code, 2 /* ERROR */);
    assert.strictEqual(spans[0].status.message, "nope");
  });

  void it("is idempotent — second install does not double-wrap logInternal", () => {
    const SpanImpl = makeFakeSpanImpl();
    installBraintrustBridge({ SpanImpl });
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const afterFirst = SpanImpl.prototype.logInternal;
    installBraintrustBridge({ SpanImpl });
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const afterSecond = SpanImpl.prototype.logInternal;
    assert.strictEqual(afterFirst, afterSecond);

    // And the bridge still produces exactly one span per Braintrust span.
    const span = new SpanImpl({ name: "traced_fn", type: "function" });
    span.end();
    const spans = onlyBraintrustSpans(exporter);
    assert.strictEqual(spans.length, 1);
  });

  void it("idempotent install preserves options from the first call", () => {
    const SpanImpl = makeFakeSpanImpl();

    // First install disables linkToActiveContext — root BT spans must NOT
    // reparent onto the outer observe() span.
    installBraintrustBridge({ SpanImpl }, { linkToActiveContext: false });
    // Second install with the opposite setting must be a no-op, NOT flip
    // the active configuration.
    installBraintrustBridge({ SpanImpl }, { linkToActiveContext: true });

    observe({ name: "outer" }, () => {
      const span = new SpanImpl({ name: "traced_fn", type: "function" });
      span.log({ input: "hi", output: "bye" });
      span.end();
    });

    const spans = onlyBraintrustSpans(exporter);
    assert.strictEqual(spans.length, 1);
    // No parent — the first install's `linkToActiveContext: false` held.
    assert.strictEqual(getParentSpanId(spans[0]), undefined);
  });

  void it("surfaces metadata as association properties on non-LLM spans", () => {
    const SpanImpl = makeFakeSpanImpl();
    installBraintrustBridge({ SpanImpl });

    const span = new SpanImpl({ name: "traced_fn", type: "function" });
    span.log({
      metadata: { userId: "u_1", sessionId: "s_1", env: "prod" },
    });
    span.end();

    const spans = onlyBraintrustSpans(exporter);
    assert.strictEqual(spans.length, 1);
    const s = spans[0];
    assert.strictEqual(
      s.attributes["lmnr.association.properties.user_id"],
      "u_1",
    );
    assert.strictEqual(
      s.attributes["lmnr.association.properties.session_id"],
      "s_1",
    );
    assert.strictEqual(
      s.attributes["lmnr.association.properties.metadata.env"],
      "prod",
    );
  });

  void it("finalizes on an event-side metrics.end marker", () => {
    const SpanImpl = makeFakeSpanImpl();
    installBraintrustBridge({ SpanImpl });

    const span = new SpanImpl({ name: "traced_fn", type: "function" });
    // User-style end marker — Braintrust routes span.log payloads through
    // args.event (NOT args.internalData), so the bridge must still finalize.
    span.log({ output: "ok", metrics: { end: Date.now() / 1000 } });

    const spans = onlyBraintrustSpans(exporter);
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].attributes[SPAN_OUTPUT], "ok");
  });

  void it("deep-merges event + internalData when both carry metadata", () => {
    const SpanImpl = makeFakeSpanImpl();
    installBraintrustBridge({ SpanImpl });

    // Simulate Braintrust firing a logInternal call where BOTH event and
    // internalData carry a `metadata` map — e.g. a plugin stamps
    // internal-only `metadata.provider` while the user passes
    // `metadata.env` on the same call. A shallow spread would drop one side.
    const span = new SpanImpl({ name: "traced_fn", type: "function" });
    span.logInternal({
      event: { metadata: { env: "prod", userId: "u_1" } },
      internalData: { metadata: { provider: "openai" } },
    });
    span.end();

    const spans = onlyBraintrustSpans(exporter);
    assert.strictEqual(spans.length, 1);
    const s = spans[0];
    // Both sides survived the merge.
    assert.strictEqual(
      s.attributes["lmnr.association.properties.metadata.env"],
      "prod",
    );
    assert.strictEqual(
      s.attributes["lmnr.association.properties.metadata.provider"],
      "openai",
    );
    assert.strictEqual(
      s.attributes["lmnr.association.properties.user_id"],
      "u_1",
    );
  });

  void it("stamps lmnr.span.bridge.name and version from a supplied braintrust module", () => {
    const SpanImpl = makeFakeSpanImpl();
    // Simulate the user passing the whole braintrust module (incl. an explicit
    // `version` field) instead of the installed braintrust/package.json —
    // useful in edge / bundled runtimes where require.resolve doesn't work.
    installBraintrustBridge({
      SpanImpl,
      braintrust: { SpanImpl, version: "9.9.9-test" },
    });

    const span = new SpanImpl({ name: "traced_fn", type: "function" });
    span.end();

    const spans = onlyBraintrustSpans(exporter);
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].attributes[SPAN_BRIDGE_NAME], "braintrust");
    assert.strictEqual(
      spans[0].attributes[SPAN_BRIDGE_VERSION],
      "9.9.9-test",
    );
  });

  void it("stamps lmnr.span.bridge.name even when no version source is available", () => {
    const SpanImpl = makeFakeSpanImpl();
    // No braintrust / SpanImpl version field; require("braintrust/package.json")
    // may or may not resolve depending on the test environment — but the name
    // attribute MUST be set unconditionally so consumers can always identify
    // bridged spans.
    installBraintrustBridge({ SpanImpl });

    const span = new SpanImpl({ name: "traced_fn", type: "function" });
    span.end();

    const spans = onlyBraintrustSpans(exporter);
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].attributes[SPAN_BRIDGE_NAME], "braintrust");
  });
});
