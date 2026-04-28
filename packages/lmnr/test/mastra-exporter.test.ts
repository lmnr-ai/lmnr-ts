import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import { context, trace } from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";

import { Laminar, observe } from "../src";
import {
  _resetConfiguration,
  initializeTracing,
} from "../src/opentelemetry-lib/configuration";
import { MastraExporter } from "../src/opentelemetry-lib/instrumentation/mastra/exporter";
import {
  SPAN_IDS_PATH,
  SPAN_PATH,
} from "../src/opentelemetry-lib/tracing/attributes";
import { getParentSpanId } from "../src/opentelemetry-lib/tracing/compat";

// Minimal Mastra span shape — matches the narrow interface inside exporter.ts.
const makeMastraSpan = (overrides: Record<string, unknown>) => ({
  id: "0000000000000001",
  traceId: "00000000000000000000000000000001",
  name: "agent run",
  type: "agent_run",
  startTime: new Date(Date.now() - 10),
  endTime: new Date(),
  isEvent: false,
  isRootSpan: true,
  ...overrides,
});

/**
 * Tests share the in-memory exporter with the outer `observe()` /
 * `Laminar.startActiveSpan()` wrapper spans they create. Strip those so the
 * assertions only see the spans the Mastra exporter produced.
 */
const onlyMastraSpans = (exporter: InMemorySpanExporter) =>
  exporter
    .getFinishedSpans()
    .filter((s) => s.name !== "outer" && s.name !== "manual outer");

void describe("MastraExporter — OTel context linking", () => {
  // Each test reinitializes Laminar against a fresh in-memory exporter so
  // `MastraExporter` (which now relies entirely on Laminar's tracer provider)
  // routes every Mastra span through this exporter.
  let initExporter: InMemorySpanExporter;

  /** Build a MastraExporter wired into the current Laminar tracer provider. */
  const makeTestExporter = (opts: { linkToActiveContext?: boolean } = {}) => {
    const mastra = new MastraExporter({
      realtime: true,
      linkToActiveContext: opts.linkToActiveContext,
    });
    mastra.init({ config: { serviceName: "test" } });
    return { mastra, inMemory: initExporter };
  };

  void beforeEach(() => {
    _resetConfiguration();
    initExporter = new InMemorySpanExporter();
    initializeTracing({ exporter: initExporter, disableBatch: true });
  });

  void afterEach(async () => {
    await initExporter.shutdown();
  });

  void after(() => {
    trace.disable();
    context.disable();
  });

  void it("reparents Mastra spans under the active observe() span", async () => {
    const { mastra, inMemory } = makeTestExporter();

    let parentTraceId: string | undefined;
    let parentSpanId: string | undefined;

    await observe({ name: "outer" }, async () => {
      const active = trace.getActiveSpan();
      const ctx = active?.spanContext();
      parentTraceId = ctx?.traceId;
      parentSpanId = ctx?.spanId;

      // Simulate Mastra firing a root span_started + span_ended event inside
      // the active observe() context.
      await mastra.exportTracingEvent({
        type: "span_started",
        exportedSpan: makeMastraSpan({
          id: "1111111111111111",
          traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          parentSpanId: undefined,
          type: "agent_run",
        }),
      });
      await mastra.exportTracingEvent({
        type: "span_ended",
        exportedSpan: makeMastraSpan({
          id: "1111111111111111",
          traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          parentSpanId: undefined,
          type: "agent_run",
        }),
      });
    });

    const spans = onlyMastraSpans(inMemory);
    assert.strictEqual(spans.length, 1, "expected exactly one Mastra span");
    const s = spans[0];
    assert.strictEqual(
      s.spanContext().traceId,
      parentTraceId,
      "Mastra span should adopt the observe() trace id",
    );
    assert.strictEqual(
      getParentSpanId(s),
      parentSpanId,
      "Mastra root should be parented to the observe() span",
    );
  });

  void it("descendant Mastra spans stay on the rewritten trace id", async () => {
    const { mastra, inMemory } = makeTestExporter();

    let parentTraceId: string | undefined;
    let parentSpanId: string | undefined;

    await observe({ name: "outer" }, async () => {
      const ctx = trace.getActiveSpan()?.spanContext();
      parentTraceId = ctx?.traceId;
      parentSpanId = ctx?.spanId;

      await mastra.exportTracingEvent({
        type: "span_started",
        exportedSpan: makeMastraSpan({
          id: "1111111111111111",
          traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          parentSpanId: undefined,
          type: "agent_run",
        }),
      });
      await mastra.exportTracingEvent({
        type: "span_started",
        exportedSpan: makeMastraSpan({
          id: "2222222222222222",
          traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          parentSpanId: "1111111111111111",
          type: "model_generation",
          name: "llm: 'gpt-4o-mini'",
        }),
      });
      await mastra.exportTracingEvent({
        type: "span_ended",
        exportedSpan: makeMastraSpan({
          id: "2222222222222222",
          traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          parentSpanId: "1111111111111111",
          type: "model_generation",
          name: "llm: 'gpt-4o-mini'",
        }),
      });
      await mastra.exportTracingEvent({
        type: "span_ended",
        exportedSpan: makeMastraSpan({
          id: "1111111111111111",
          traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          parentSpanId: undefined,
          type: "agent_run",
        }),
      });
    });

    const spans = onlyMastraSpans(inMemory);
    assert.strictEqual(spans.length, 2);
    const traceIds = [...new Set(spans.map((s) => s.spanContext().traceId))];
    assert.strictEqual(traceIds.length, 1, "all Mastra spans share one trace");
    assert.strictEqual(traceIds[0], parentTraceId);

    const root = spans.find((s) => s.name === "agent run")!;
    const child = spans.find((s) => s.name === "llm: 'gpt-4o-mini'")!;
    assert.strictEqual(getParentSpanId(root), parentSpanId);
    // Child's parent must still resolve to the root's span id (in normalized
    // 16-char lowercase hex form emitted by the exporter).
    assert.strictEqual(getParentSpanId(child), root.spanContext().spanId);
  });

  void it("reparents Mastra spans under a Laminar.startActiveSpan() span", async () => {
    // `Laminar.startActiveSpan()` activates the span on Laminar's own
    // AsyncLocalStorage, NOT on OTel's standard context manager. The exporter
    // must consult `LaminarContextManager.getContext()` first so manually
    // started spans get the same reparenting treatment as `observe()` ones.
    const { mastra, inMemory } = makeTestExporter();

    const outer = Laminar.startActiveSpan({ name: "manual outer" });
    const outerCtx = outer.spanContext();
    try {
      await mastra.exportTracingEvent({
        type: "span_started",
        exportedSpan: makeMastraSpan({
          id: "4444444444444444",
          traceId: "cccccccccccccccccccccccccccccccc",
          parentSpanId: undefined,
          type: "agent_run",
        }),
      });
      await mastra.exportTracingEvent({
        type: "span_ended",
        exportedSpan: makeMastraSpan({
          id: "4444444444444444",
          traceId: "cccccccccccccccccccccccccccccccc",
          parentSpanId: undefined,
          type: "agent_run",
        }),
      });
    } finally {
      outer.end();
    }

    const spans = onlyMastraSpans(inMemory);
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(
      spans[0].spanContext().traceId,
      outerCtx.traceId,
      "Mastra span should adopt the manual outer span's trace id",
    );
    assert.strictEqual(
      getParentSpanId(spans[0]),
      outerCtx.spanId,
      "Mastra root should be parented to the manual outer span",
    );
  });

  void it("does not reparent when linkToActiveContext is false", async () => {
    const { mastra, inMemory } = makeTestExporter({
      linkToActiveContext: false,
    });

    await observe({ name: "outer" }, async () => {
      await mastra.exportTracingEvent({
        type: "span_started",
        exportedSpan: makeMastraSpan({
          id: "3333333333333333",
          traceId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          parentSpanId: undefined,
          type: "agent_run",
        }),
      });
      await mastra.exportTracingEvent({
        type: "span_ended",
        exportedSpan: makeMastraSpan({
          id: "3333333333333333",
          traceId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          parentSpanId: undefined,
          type: "agent_run",
        }),
      });
    });

    const spans = onlyMastraSpans(inMemory);
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(
      spans[0].spanContext().traceId,
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "trace id should be preserved when linking is disabled",
    );
    assert.strictEqual(getParentSpanId(spans[0]), undefined);
  });

  void it("prepends the outer observe() span path/ids_path to Mastra spans", async () => {
    const { mastra, inMemory } = makeTestExporter();

    let outerSpanPath: string[] | undefined;
    let outerIdsPath: string[] | undefined;

    await observe({ name: "outer" }, async () => {
      const active = trace.getActiveSpan() as unknown as {
        attributes?: Record<string, unknown>;
      };
      outerSpanPath = active.attributes?.[SPAN_PATH] as string[] | undefined;
      outerIdsPath = active.attributes?.[SPAN_IDS_PATH] as string[] | undefined;

      await mastra.exportTracingEvent({
        type: "span_started",
        exportedSpan: makeMastraSpan({
          id: "aaaaaaaaaaaaaaa1",
          traceId: "dddddddddddddddddddddddddddddddd",
          parentSpanId: undefined,
          name: "agent run",
          type: "agent_run",
        }),
      });
      await mastra.exportTracingEvent({
        type: "span_started",
        exportedSpan: makeMastraSpan({
          id: "aaaaaaaaaaaaaaa2",
          traceId: "dddddddddddddddddddddddddddddddd",
          parentSpanId: "aaaaaaaaaaaaaaa1",
          name: "llm: 'gpt-4o'",
          type: "model_generation",
        }),
      });
      await mastra.exportTracingEvent({
        type: "span_ended",
        exportedSpan: makeMastraSpan({
          id: "aaaaaaaaaaaaaaa2",
          traceId: "dddddddddddddddddddddddddddddddd",
          parentSpanId: "aaaaaaaaaaaaaaa1",
          name: "llm: 'gpt-4o'",
          type: "model_generation",
        }),
      });
      await mastra.exportTracingEvent({
        type: "span_ended",
        exportedSpan: makeMastraSpan({
          id: "aaaaaaaaaaaaaaa1",
          traceId: "dddddddddddddddddddddddddddddddd",
          parentSpanId: undefined,
          name: "agent run",
          type: "agent_run",
        }),
      });
    });

    assert.ok(outerSpanPath, "outer span must expose SPAN_PATH attribute");
    assert.ok(outerIdsPath, "outer span must expose SPAN_IDS_PATH attribute");

    const spans = onlyMastraSpans(inMemory);
    assert.strictEqual(spans.length, 2);

    const root = spans.find((s) => s.name === "agent run")!;
    const child = spans.find((s) => s.name === "llm: 'gpt-4o'")!;

    const rootPath = root.attributes[SPAN_PATH] as string[];
    const rootIds = root.attributes[SPAN_IDS_PATH] as string[];
    const childPath = child.attributes[SPAN_PATH] as string[];
    const childIds = child.attributes[SPAN_IDS_PATH] as string[];

    // Root Mastra span's path/ids_path start with the outer span's.
    assert.deepStrictEqual(
      rootPath.slice(0, outerSpanPath.length),
      outerSpanPath,
    );
    assert.deepStrictEqual(rootIds.slice(0, outerIdsPath.length), outerIdsPath);
    assert.strictEqual(rootPath[rootPath.length - 1], "agent run");

    // Descendants inherit the prepended prefix automatically.
    assert.deepStrictEqual(
      childPath.slice(0, outerSpanPath.length),
      outerSpanPath,
    );
    assert.deepStrictEqual(
      childIds.slice(0, outerIdsPath.length),
      outerIdsPath,
    );
    assert.strictEqual(childPath[childPath.length - 1], "llm: 'gpt-4o'");
    // The child's full path must equal outer prefix + root + itself.
    assert.strictEqual(childPath.length, outerSpanPath.length + 2);
    assert.strictEqual(childIds.length, outerIdsPath.length + 2);
  });

  void it("does not prepend outer path when linkToActiveContext is false", async () => {
    const { mastra, inMemory } = makeTestExporter({
      linkToActiveContext: false,
    });

    await observe({ name: "outer" }, async () => {
      await mastra.exportTracingEvent({
        type: "span_started",
        exportedSpan: makeMastraSpan({
          id: "bbbbbbbbbbbbbbb1",
          traceId: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
          parentSpanId: undefined,
          name: "agent run",
          type: "agent_run",
        }),
      });
      await mastra.exportTracingEvent({
        type: "span_ended",
        exportedSpan: makeMastraSpan({
          id: "bbbbbbbbbbbbbbb1",
          traceId: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
          parentSpanId: undefined,
          name: "agent run",
          type: "agent_run",
        }),
      });
    });

    const spans = onlyMastraSpans(inMemory);
    assert.strictEqual(spans.length, 1);
    const path = spans[0].attributes[SPAN_PATH] as string[];
    const ids = spans[0].attributes[SPAN_IDS_PATH] as string[];
    assert.deepStrictEqual(path, ["agent run"]);
    assert.strictEqual(ids.length, 1);
  });

  void it("keeps the original trace id when no observe() is active", async () => {
    const { mastra, inMemory } = makeTestExporter();

    await mastra.exportTracingEvent({
      type: "span_started",
      exportedSpan: makeMastraSpan({
        id: "4444444444444444",
        traceId: "cccccccccccccccccccccccccccccccc",
        parentSpanId: undefined,
        type: "agent_run",
      }),
    });
    await mastra.exportTracingEvent({
      type: "span_ended",
      exportedSpan: makeMastraSpan({
        id: "4444444444444444",
        traceId: "cccccccccccccccccccccccccccccccc",
        parentSpanId: undefined,
        type: "agent_run",
      }),
    });

    const spans = onlyMastraSpans(inMemory);
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(
      spans[0].spanContext().traceId,
      "cccccccccccccccccccccccccccccccc",
    );
    assert.strictEqual(getParentSpanId(spans[0]), undefined);
  });

  void it(
    "accumulates reasoning from MODEL_CHUNK children onto the step's " +
      "gen_ai.output.messages without echoing it into the next step's prompt",
    async () => {
      const { mastra, inMemory } = makeTestExporter();
      const traceId = "88888888888888888888888888888888";

      // Generation root
      await mastra.exportTracingEvent({
        type: "span_started",
        exportedSpan: makeMastraSpan({
          id: "gen1gen1gen1gen1",
          traceId,
          parentSpanId: undefined,
          name: "llm: 'gpt-5'",
          type: "model_generation",
          attributes: { model: "gpt-5", provider: "openai.chat" },
          input: {
            messages: [{ role: "user", content: "riddle me this" }],
          },
        }),
      });

      // Step 0
      await mastra.exportTracingEvent({
        type: "span_started",
        exportedSpan: makeMastraSpan({
          id: "step000000000001",
          traceId,
          parentSpanId: "gen1gen1gen1gen1",
          name: "step 'llm call'",
          type: "model_step",
          attributes: { stepIndex: 0 },
        }),
      });
      // Two reasoning chunks for step 0, simulating reasoning-start/end
      // firing twice inside a single step.
      await mastra.exportTracingEvent({
        type: "span_ended",
        exportedSpan: makeMastraSpan({
          id: "chunkreasoning01",
          traceId,
          parentSpanId: "step000000000001",
          name: "chunk: 'reasoning'",
          type: "model_chunk",
          attributes: { chunkType: "reasoning", sequenceNumber: 0 },
          output: { text: "**Thinking hard**\n" },
        }),
      });
      await mastra.exportTracingEvent({
        type: "span_ended",
        exportedSpan: makeMastraSpan({
          id: "chunkreasoning02",
          traceId,
          parentSpanId: "step000000000001",
          name: "chunk: 'reasoning'",
          type: "model_chunk",
          attributes: { chunkType: "reasoning", sequenceNumber: 1 },
          output: { text: "still thinking." },
        }),
      });
      await mastra.exportTracingEvent({
        type: "span_ended",
        exportedSpan: makeMastraSpan({
          id: "step000000000001",
          traceId,
          parentSpanId: "gen1gen1gen1gen1",
          name: "step 'llm call'",
          type: "model_step",
          attributes: { stepIndex: 0 },
          output: { text: "final answer: 9" },
        }),
      });

      // Step 1 — no reasoning chunks; used to verify downstream step's prompt
      // does NOT contain step 0's reasoning text on the cached assistant turn.
      await mastra.exportTracingEvent({
        type: "span_started",
        exportedSpan: makeMastraSpan({
          id: "step000000000002",
          traceId,
          parentSpanId: "gen1gen1gen1gen1",
          name: "step 'llm call'",
          type: "model_step",
          attributes: { stepIndex: 1 },
        }),
      });
      await mastra.exportTracingEvent({
        type: "span_ended",
        exportedSpan: makeMastraSpan({
          id: "step000000000002",
          traceId,
          parentSpanId: "gen1gen1gen1gen1",
          name: "step 'llm call'",
          type: "model_step",
          attributes: { stepIndex: 1 },
          output: { text: "follow-up" },
        }),
      });

      await mastra.exportTracingEvent({
        type: "span_ended",
        exportedSpan: makeMastraSpan({
          id: "gen1gen1gen1gen1",
          traceId,
          parentSpanId: undefined,
          name: "llm: 'gpt-5'",
          type: "model_generation",
          attributes: { model: "gpt-5", provider: "openai.chat" },
        }),
      });

      const spans = onlyMastraSpans(inMemory);
      // No chunk spans should be emitted.
      assert.ok(
        !spans.some((s) => s.name.startsWith("chunk: ")),
        "MODEL_CHUNK spans must not be emitted as OTel spans",
      );

      const step0 = spans.find(
        (s) =>
          s.attributes["lmnr.span.type"] === "LLM" &&
          (s.attributes["ai.response.text"] as string) === "final answer: 9",
      );
      const step1 = spans.find(
        (s) =>
          s.attributes["lmnr.span.type"] === "LLM" &&
          (s.attributes["ai.response.text"] as string) === "follow-up",
      );
      assert.ok(step0, "step 0 LLM span not found");
      assert.ok(step1, "step 1 LLM span not found");

      // Step 0 carries `gen_ai.output.messages` with a thinking part built
      // from the concatenated chunk texts.
      const step0GenAi = step0.attributes["gen_ai.output.messages"];
      assert.ok(
        typeof step0GenAi === "string",
        "gen_ai.output.messages missing on step 0",
      );
      const step0Parsed = JSON.parse(step0GenAi) as Array<{
        role: string;
        parts: Array<{ type: string; content?: string }>;
      }>;
      assert.strictEqual(step0Parsed[0].role, "assistant");
      const thinking = step0Parsed[0].parts.find((p) => p.type === "thinking");
      assert.ok(thinking, "thinking part missing");
      assert.strictEqual(
        thinking.content,
        "**Thinking hard**\nstill thinking.",
        "thinking content should be the concatenation of both reasoning chunks",
      );

      // Step 1 has no reasoning → no gen_ai.output.messages.
      assert.strictEqual(
        step1.attributes["gen_ai.output.messages"],
        undefined,
        "step 1 has no reasoning so gen_ai.output.messages must be absent",
      );

      // Step 1's `ai.prompt.messages` must NOT contain a reasoning content
      // part on step 0's cached assistant turn. The actual LLM call for
      // step 1 doesn't receive reasoning text in any common provider
      // (OpenAI tracks it via `previous_response_id`, Anthropic preserves a
      // signed `thinking` block, Gemini manages it server-side), so echoing
      // the plain text here would misrepresent what was sent.
      const step1Prompt = step1.attributes["ai.prompt.messages"];
      assert.ok(
        typeof step1Prompt === "string",
        "ai.prompt.messages missing on step 1",
      );
      const step1Msgs = JSON.parse(step1Prompt) as Array<{
        role: string;
        content: unknown;
      }>;
      const assistantTurn = step1Msgs.find((m) => m.role === "assistant");
      assert.ok(assistantTurn, "assistant turn missing from step 1 prompt");
      assert.ok(
        Array.isArray(assistantTurn.content),
        "assistant content should be parts",
      );
      const reasoningPart = (
        assistantTurn.content as Array<{ type: string; text?: string }>
      ).find((p) => p.type === "reasoning");
      assert.strictEqual(
        reasoningPart,
        undefined,
        "reasoning text must not leak into the next step's prompt history",
      );
      // The assistant message text from step 0 should still be present.
      const textPart = (
        assistantTurn.content as Array<{ type: string; text?: string }>
      ).find((p) => p.type === "text");
      assert.ok(textPart, "assistant text part missing from step 0 turn");
    },
  );

  void it("omits gen_ai.output.messages when a step produced no reasoning chunks", async () => {
    const { mastra, inMemory } = makeTestExporter();
    const traceId = "99999999999999999999999999999999";

    await mastra.exportTracingEvent({
      type: "span_started",
      exportedSpan: makeMastraSpan({
        id: "gen2gen2gen2gen2",
        traceId,
        parentSpanId: undefined,
        name: "llm: 'gpt-4o'",
        type: "model_generation",
        attributes: { model: "gpt-4o", provider: "openai.chat" },
      }),
    });
    await mastra.exportTracingEvent({
      type: "span_started",
      exportedSpan: makeMastraSpan({
        id: "step000000000003",
        traceId,
        parentSpanId: "gen2gen2gen2gen2",
        name: "step 'llm call'",
        type: "model_step",
        attributes: { stepIndex: 0 },
      }),
    });
    await mastra.exportTracingEvent({
      type: "span_ended",
      exportedSpan: makeMastraSpan({
        id: "step000000000003",
        traceId,
        parentSpanId: "gen2gen2gen2gen2",
        name: "step 'llm call'",
        type: "model_step",
        attributes: { stepIndex: 0 },
        output: { text: "hi back" },
      }),
    });
    await mastra.exportTracingEvent({
      type: "span_ended",
      exportedSpan: makeMastraSpan({
        id: "gen2gen2gen2gen2",
        traceId,
        parentSpanId: undefined,
        name: "llm: 'gpt-4o'",
        type: "model_generation",
        attributes: { model: "gpt-4o", provider: "openai.chat" },
      }),
    });

    const spans = onlyMastraSpans(inMemory);
    const step = spans.find((s) => s.attributes["lmnr.span.type"] === "LLM");
    assert.ok(step);
    assert.strictEqual(step.attributes["gen_ai.output.messages"], undefined);
    assert.strictEqual(step.attributes["ai.response.text"], "hi back");
  });

  void it(
    "emits gen_ai.usage.reasoning_tokens from usage.outputDetails.reasoning",
    async () => {
      const { mastra, inMemory } = makeTestExporter();
      const traceId = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

      await mastra.exportTracingEvent({
        type: "span_started",
        exportedSpan: makeMastraSpan({
          id: "gen4gen4gen4gen4",
          traceId,
          parentSpanId: undefined,
          name: "llm: 'o1'",
          type: "model_generation",
          attributes: { model: "o1", provider: "openai.chat" },
        }),
      });
      await mastra.exportTracingEvent({
        type: "span_started",
        exportedSpan: makeMastraSpan({
          id: "step4step4step400",
          traceId,
          parentSpanId: "gen4gen4gen4gen4",
          name: "step 'llm call'",
          type: "model_step",
          attributes: { stepIndex: 0 },
        }),
      });
      await mastra.exportTracingEvent({
        type: "span_ended",
        exportedSpan: makeMastraSpan({
          id: "step4step4step400",
          traceId,
          parentSpanId: "gen4gen4gen4gen4",
          name: "step 'llm call'",
          type: "model_step",
          attributes: {
            stepIndex: 0,
            usage: {
              inputTokens: 100,
              // Mastra contract: outputTokens already includes reasoning
              outputTokens: 250,
              outputDetails: { reasoning: 200 },
              inputDetails: { cacheRead: 40, cacheWrite: 10 },
            },
          },
          output: { text: "thought a lot" },
        }),
      });
      await mastra.exportTracingEvent({
        type: "span_ended",
        exportedSpan: makeMastraSpan({
          id: "gen4gen4gen4gen4",
          traceId,
          parentSpanId: undefined,
          name: "llm: 'o1'",
          type: "model_generation",
          attributes: { model: "o1", provider: "openai.chat" },
        }),
      });

      const spans = onlyMastraSpans(inMemory);
      const step = spans.find(
        (s) => s.attributes["lmnr.span.type"] === "LLM",
      );
      assert.ok(step, "LLM step span not found");
      assert.strictEqual(step.attributes["gen_ai.usage.input_tokens"], 100);
      assert.strictEqual(step.attributes["gen_ai.usage.output_tokens"], 250);
      assert.strictEqual(step.attributes["llm.usage.total_tokens"], 350);
      assert.strictEqual(
        step.attributes["gen_ai.usage.reasoning_tokens"],
        200,
        "reasoning tokens must be surfaced as a standalone metric",
      );
      assert.strictEqual(
        step.attributes["gen_ai.usage.cache_read_input_tokens"],
        40,
      );
      assert.strictEqual(
        step.attributes["gen_ai.usage.cache_creation_input_tokens"],
        10,
      );
    },
  );

  void it(
    "omits gen_ai.usage.reasoning_tokens when usage has no outputDetails.reasoning",
    async () => {
      const { mastra, inMemory } = makeTestExporter();
      const traceId = "cccccccccccccccccccccccccccccccc";

      await mastra.exportTracingEvent({
        type: "span_started",
        exportedSpan: makeMastraSpan({
          id: "gen5gen5gen5gen5",
          traceId,
          parentSpanId: undefined,
          name: "llm: 'gpt-4o'",
          type: "model_generation",
          attributes: { model: "gpt-4o", provider: "openai.chat" },
        }),
      });
      await mastra.exportTracingEvent({
        type: "span_started",
        exportedSpan: makeMastraSpan({
          id: "step5step5step500",
          traceId,
          parentSpanId: "gen5gen5gen5gen5",
          name: "step 'llm call'",
          type: "model_step",
          attributes: { stepIndex: 0 },
        }),
      });
      await mastra.exportTracingEvent({
        type: "span_ended",
        exportedSpan: makeMastraSpan({
          id: "step5step5step500",
          traceId,
          parentSpanId: "gen5gen5gen5gen5",
          name: "step 'llm call'",
          type: "model_step",
          attributes: {
            stepIndex: 0,
            usage: { inputTokens: 50, outputTokens: 75 },
          },
          output: { text: "ok" },
        }),
      });
      await mastra.exportTracingEvent({
        type: "span_ended",
        exportedSpan: makeMastraSpan({
          id: "gen5gen5gen5gen5",
          traceId,
          parentSpanId: undefined,
          name: "llm: 'gpt-4o'",
          type: "model_generation",
          attributes: { model: "gpt-4o", provider: "openai.chat" },
        }),
      });

      const spans = onlyMastraSpans(inMemory);
      const step = spans.find(
        (s) => s.attributes["lmnr.span.type"] === "LLM",
      );
      assert.ok(step);
      assert.strictEqual(step.attributes["gen_ai.usage.input_tokens"], 50);
      assert.strictEqual(step.attributes["gen_ai.usage.output_tokens"], 75);
      assert.strictEqual(
        step.attributes["gen_ai.usage.reasoning_tokens"],
        undefined,
      );
    },
  );
});
