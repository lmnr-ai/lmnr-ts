import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import { context, trace } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  ReadableSpan,
  SimpleSpanProcessor,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";

import { observe } from "../src";
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
 * Build a `MastraExporter` whose internal OTLP exporter is swapped for an
 * in-memory one, so we can assert what spans it emits without any network.
 */
const makeTestExporter = (opts: { linkToActiveContext?: boolean } = {}) => {
  const inMemory = new InMemorySpanExporter();
  const mastra = new MastraExporter({
    apiKey: "test-key",
    baseUrl: "http://127.0.0.1",
    disableBatch: true,
    realtime: true,
    linkToActiveContext: opts.linkToActiveContext,
  });
  mastra.init({ config: { serviceName: "test" } });
  // Replace the internal processor with one pointed at our in-memory exporter
  // as soon as the exporter finishes its first lazy setup.
  const privateMastra = mastra as unknown as {
    processor?: {
      onEnd(span: ReadableSpan): void;
      forceFlush(): Promise<void>;
      shutdown(): Promise<void>;
    };
    otlpExporter?: SpanExporter;
    isSetup: boolean;
  };
  privateMastra.processor = new SimpleSpanProcessor(inMemory);
  privateMastra.otlpExporter = inMemory;
  privateMastra.isSetup = true;
  return { mastra, inMemory };
};

void describe("MastraExporter — OTel context linking", () => {
  const initExporter = new InMemorySpanExporter();

  void beforeEach(() => {
    _resetConfiguration();
    initializeTracing({ exporter: initExporter, disableBatch: true });
  });

  void afterEach(() => {
    initExporter.reset();
  });

  void after(async () => {
    await initExporter.shutdown();
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

    const spans = inMemory.getFinishedSpans();
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

    const spans = inMemory.getFinishedSpans();
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

    const spans = inMemory.getFinishedSpans();
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

    const spans = inMemory.getFinishedSpans();
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

    const spans = inMemory.getFinishedSpans();
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

    const spans = inMemory.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(
      spans[0].spanContext().traceId,
      "cccccccccccccccccccccccccccccccc",
    );
    assert.strictEqual(getParentSpanId(spans[0]), undefined);
  });

  void it(
    "surfaces per-step reasoningText via gen_ai.output.messages and " +
      "threads it into the next step's prompt",
    async () => {
      const { mastra, inMemory } = makeTestExporter();

      // Two-step generation: step 0 thinks + calls a tool, step 1 thinks +
      // answers. reasoningText lives only on the parent generation's
      // `output.steps[i].reasoningText`, never on the step span itself.
      const generationId = "9999999999999991";
      const step0Id = "9999999999999992";
      const step1Id = "9999999999999993";
      const toolId = "9999999999999994";
      const traceId = "99999999999999999999999999999991";

      const startGeneration = () =>
        mastra.exportTracingEvent({
          type: "span_started",
          exportedSpan: makeMastraSpan({
            id: generationId,
            traceId,
            parentSpanId: undefined,
            type: "model_generation",
            name: "agent run",
            input: {
              messages: [{ role: "user", content: "hello" }],
            },
            attributes: {
              provider: "openai",
              model: "gpt-5",
            },
          }),
        });

      const startStep = (id: string, stepIndex: number, name: string) =>
        mastra.exportTracingEvent({
          type: "span_started",
          exportedSpan: makeMastraSpan({
            id,
            traceId,
            parentSpanId: generationId,
            type: "model_step",
            name,
            attributes: { stepIndex },
          }),
        });

      const endStep = (
        id: string,
        stepIndex: number,
        name: string,
        output: Record<string, unknown>,
      ) =>
        mastra.exportTracingEvent({
          type: "span_ended",
          exportedSpan: makeMastraSpan({
            id,
            traceId,
            parentSpanId: generationId,
            type: "model_step",
            name,
            attributes: { stepIndex },
            output,
          }),
        });

      await startGeneration();
      await startStep(step0Id, 0, "llm: 'gpt-5' step 0");

      // Tool call child of step 0 — ends before the step itself does.
      await mastra.exportTracingEvent({
        type: "span_started",
        exportedSpan: makeMastraSpan({
          id: toolId,
          traceId,
          parentSpanId: step0Id,
          type: "tool_call",
          name: "tool: 'lookup'",
          attributes: { toolCallId: "call_1" },
        }),
      });
      await mastra.exportTracingEvent({
        type: "span_ended",
        exportedSpan: makeMastraSpan({
          id: toolId,
          traceId,
          parentSpanId: step0Id,
          type: "tool_call",
          name: "tool: 'lookup'",
          attributes: { toolCallId: "call_1" },
          input: { toolCallId: "call_1" },
          output: "result!",
        }),
      });

      await endStep(step0Id, 0, "llm: 'gpt-5' step 0", {
        text: "",
        toolCalls: [
          {
            toolCallId: "call_1",
            toolName: "lookup",
            args: { q: "x" },
          },
        ],
      });

      await startStep(step1Id, 1, "llm: 'gpt-5' step 1");
      await endStep(step1Id, 1, "llm: 'gpt-5' step 1", {
        text: "final answer",
        toolCalls: [],
      });

      // Before the generation ends, nothing should be emitted for the step
      // spans — they're buffered.
      assert.strictEqual(
        inMemory.getFinishedSpans().filter((s) => s.name.startsWith("llm:"))
          .length,
        0,
        "step spans must not flush before the generation ends",
      );

      await mastra.exportTracingEvent({
        type: "span_ended",
        exportedSpan: makeMastraSpan({
          id: generationId,
          traceId,
          parentSpanId: undefined,
          type: "model_generation",
          name: "agent run",
          input: {
            messages: [{ role: "user", content: "hello" }],
          },
          output: {
            text: "final answer",
            steps: [
              {
                text: "",
                reasoningText: "Clarifying the meaning of hello…",
              },
              {
                text: "final answer",
                reasoningText: "Composing the final response…",
              },
            ],
          },
        }),
      });

      const spans = inMemory.getFinishedSpans();
      const step0 = spans.find((s) => s.name === "llm: 'gpt-5' step 0");
      const step1 = spans.find((s) => s.name === "llm: 'gpt-5' step 1");
      assert.ok(step0, "step 0 span should be emitted");
      assert.ok(step1, "step 1 span should be emitted");

      // Step 0's output should surface reasoning in GenAI semconv format.
      const step0Output = step0.attributes["gen_ai.output.messages"] as string;
      assert.ok(
        step0Output,
        "step 0 should expose gen_ai.output.messages when it has reasoning",
      );
      const step0Messages = JSON.parse(step0Output);
      assert.strictEqual(step0Messages[0].role, "assistant");
      const step0Parts = step0Messages[0].parts as Array<{
        type: string;
        content?: string;
        name?: string;
        id?: string;
      }>;
      const step0Thinking = step0Parts.find((p) => p.type === "thinking");
      assert.ok(step0Thinking, "thinking part expected");
      assert.strictEqual(
        step0Thinking?.content,
        "Clarifying the meaning of hello…",
      );
      const step0ToolCall = step0Parts.find((p) => p.type === "tool_call");
      assert.ok(step0ToolCall, "tool_call part expected");
      assert.strictEqual(step0ToolCall?.name, "lookup");

      // Step 1's output surfaces its own reasoning + text.
      const step1Output = step1.attributes["gen_ai.output.messages"] as string;
      const step1Messages = JSON.parse(step1Output);
      const step1Parts = step1Messages[0].parts as Array<{
        type: string;
        content?: string;
      }>;
      assert.strictEqual(
        step1Parts.find((p) => p.type === "thinking")?.content,
        "Composing the final response…",
      );
      assert.strictEqual(
        step1Parts.find((p) => p.type === "text")?.content,
        "final answer",
      );

      // Step 1's `ai.prompt.messages` must include step 0's reasoning as a
      // `reasoning` content part on the prior assistant turn, so the rendered
      // prompt history shows the prior thinking.
      const step1Prompt = step1.attributes["ai.prompt.messages"] as string;
      const promptMessages = JSON.parse(step1Prompt) as Array<{
        role: string;
        content: string | Array<{ type: string; text?: string }>;
      }>;
      const assistantTurn = promptMessages.find((m) => m.role === "assistant");
      assert.ok(
        assistantTurn,
        "step 1 prompt should contain an assistant turn",
      );
      const assistantParts = assistantTurn.content as Array<{
        type: string;
        text?: string;
      }>;
      const priorReasoning = assistantParts.find((p) => p.type === "reasoning");
      assert.ok(priorReasoning, "prior assistant turn should carry reasoning");
      assert.strictEqual(
        priorReasoning?.text,
        "Clarifying the meaning of hello…",
      );
    },
  );

  void it("omits gen_ai.output.messages when a step has no reasoning", async () => {
    const { mastra, inMemory } = makeTestExporter();

    const generationId = "8888888888888881";
    const stepId = "8888888888888882";
    const traceId = "88888888888888888888888888888881";

    await mastra.exportTracingEvent({
      type: "span_started",
      exportedSpan: makeMastraSpan({
        id: generationId,
        traceId,
        parentSpanId: undefined,
        type: "model_generation",
        name: "agent run",
        input: { messages: [{ role: "user", content: "hi" }] },
        attributes: { provider: "openai", model: "gpt-4o-mini" },
      }),
    });
    await mastra.exportTracingEvent({
      type: "span_started",
      exportedSpan: makeMastraSpan({
        id: stepId,
        traceId,
        parentSpanId: generationId,
        type: "model_step",
        name: "llm: 'gpt-4o-mini'",
        attributes: { stepIndex: 0 },
      }),
    });
    await mastra.exportTracingEvent({
      type: "span_ended",
      exportedSpan: makeMastraSpan({
        id: stepId,
        traceId,
        parentSpanId: generationId,
        type: "model_step",
        name: "llm: 'gpt-4o-mini'",
        attributes: { stepIndex: 0 },
        output: { text: "hi back", toolCalls: [] },
      }),
    });
    await mastra.exportTracingEvent({
      type: "span_ended",
      exportedSpan: makeMastraSpan({
        id: generationId,
        traceId,
        parentSpanId: undefined,
        type: "model_generation",
        name: "agent run",
        input: { messages: [{ role: "user", content: "hi" }] },
        output: {
          text: "hi back",
          steps: [{ text: "hi back", reasoningText: undefined }],
        },
      }),
    });

    const spans = inMemory.getFinishedSpans();
    const step = spans.find((s) => s.name === "llm: 'gpt-4o-mini'")!;
    assert.strictEqual(
      step.attributes["gen_ai.output.messages"],
      undefined,
      "no reasoning → no GenAI output override",
    );
    assert.strictEqual(step.attributes["ai.response.text"], "hi back");
  });
});
