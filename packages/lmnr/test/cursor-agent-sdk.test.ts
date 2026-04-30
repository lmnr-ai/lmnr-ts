import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import { context, trace } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  ReadableSpan,
} from "@opentelemetry/sdk-trace-base";

import { Laminar } from "../src/laminar";
import {
  _resetConfiguration,
  initializeTracing,
} from "../src/opentelemetry-lib/configuration";
import { CursorAgentSDKInstrumentation } from "../src/opentelemetry-lib/instrumentation/cursor-agent-sdk";
import { SPAN_TYPE } from "../src/opentelemetry-lib/tracing/attributes";

// Build a fake @cursor/sdk module whose Agent.create returns a SDKAgent with
// a mocked send() that hands back a Run whose stream() emits a scripted
// sequence of SDKMessage + InteractionUpdate events. This exercises the
// instrumentation end-to-end (outer DEFAULT span + per-turn LLM spans + TOOL
// spans) without any network access.
type OnDelta = (args: { update: any }) => void | Promise<void>;
type SendOptions = { onDelta?: OnDelta };

type ScriptedEvent =
  | { kind: "message"; message: any }
  | { kind: "update"; update: any };

const buildMockModule = (script: ScriptedEvent[]) => {
  const make = (agentId: string) => ({
    agentId,
    model: { id: "composer-2" },
    send: async (_message: unknown, options?: SendOptions) => {
      const onDelta = options?.onDelta;
      const run = {
        id: "run-1",
        model: { id: "composer-2" },
        stream: () =>
          (async function* () {
            // Interleave: updates fire via onDelta in-place, messages are yielded.
            for (const ev of script) {
              if (ev.kind === "update") {
                await onDelta?.({ update: ev.update });
              } else {
                yield ev.message;
              }
            }
          })(),
        wait: async () => ({
          status: "finished",
          result: "done",
          model: { id: "composer-2" },
          usage: { inputTokens: 10, outputTokens: 20 },
        }),
        cancel: async () => {},
      };
      return run;
    },
  });

  return {
    Agent: {
      create: async (_opts: unknown) => make("agent-1"),
      resume: async (agentId: string, _opts?: unknown) => make(agentId),
      prompt: async (_message: unknown, _opts?: unknown) => ({
        status: "finished",
        result: "done",
        model: { id: "composer-2" },
        usage: { inputTokens: 0, outputTokens: 0 },
      }),
      archive: async (_agentId: string, _opts?: unknown) => {},
    },
  } as any;
};

const spanByName = (spans: ReadableSpan[], name: string): ReadableSpan => {
  const s = spans.find((x) => x.name === name);
  assert.ok(
    s,
    `span '${name}' missing; got [${spans.map((x) => x.name).join(", ")}]`,
  );
  return s!;
};

const childrenOf = (spans: ReadableSpan[], parentSpanId: string) =>
  spans.filter((s) => s.parentSpanContext?.spanId === parentSpanId);

void describe("cursor-agent-sdk instrumentation", () => {
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

  void it("emits TOOL spans as siblings of LLM turn spans under the outer DEFAULT span", async () => {
    // Scripted run:
    //   step-started(0) -> assistant text -> tool_call running ls -> tool_call completed ls ->
    //   step-completed(0, duration=42) -> step-started(1) -> assistant text ->
    //   step-completed(1) -> (stream drains, wait() resolves)
    const script: ScriptedEvent[] = [
      { kind: "update", update: { type: "step-started", stepId: 0 } },
      {
        kind: "message",
        message: {
          type: "assistant",
          agent_id: "agent-1",
          run_id: "run-1",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "I'll list the directory." }],
          },
        },
      },
      {
        kind: "message",
        message: {
          type: "tool_call",
          agent_id: "agent-1",
          run_id: "run-1",
          call_id: "call-1",
          name: "ls",
          status: "running",
          args: { path: "." },
        },
      },
      {
        kind: "message",
        message: {
          type: "tool_call",
          agent_id: "agent-1",
          run_id: "run-1",
          call_id: "call-1",
          name: "ls",
          status: "completed",
          args: { path: "." },
          result: { files: ["a.md", "b.md"] },
        },
      },
      {
        kind: "update",
        update: { type: "step-completed", stepId: 0, stepDurationMs: 42 },
      },
      { kind: "update", update: { type: "step-started", stepId: 1 } },
      {
        kind: "message",
        message: {
          type: "assistant",
          agent_id: "agent-1",
          run_id: "run-1",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Listed 2 files." }],
          },
        },
      },
      { kind: "update", update: { type: "step-completed", stepId: 1 } },
    ];

    const cursor = buildMockModule(script);
    const instr = new CursorAgentSDKInstrumentation();
    instr.manuallyInstrument(cursor);

    const agent = await cursor.Agent.create({ apiKey: "fake" });
    const run = await agent.send("prompt");
    // Drain the stream fully.
    for await (const _ of run.stream()) {
      // noop
    }
    await run.wait();

    const spans = exporter.getFinishedSpans();
    const parent = spanByName(spans, "cursor.agent.send");
    const turn0 = spanByName(spans, "cursor.llm.turn.0");
    const turn1 = spanByName(spans, "cursor.llm.turn.1");
    const toolSpan = spanByName(spans, "ls");

    // Parent span has DEFAULT type (no SPAN_TYPE attr set = DEFAULT).
    // LLM turns and tool are all children of parent.
    assert.equal(
      turn0.parentSpanContext?.spanId,
      parent.spanContext().spanId,
      "turn.0 must be child of cursor.agent.send",
    );
    assert.equal(
      turn1.parentSpanContext?.spanId,
      parent.spanContext().spanId,
      "turn.1 must be child of cursor.agent.send",
    );
    // The critical assertion for this fix: tool span is a SIBLING of the LLM
    // turn, not a child of it.
    assert.equal(
      toolSpan.parentSpanContext?.spanId,
      parent.spanContext().spanId,
      "tool span must be a SIBLING of LLM turn (child of cursor.agent.send), not a child of the LLM turn",
    );
    assert.notEqual(
      toolSpan.parentSpanContext?.spanId,
      turn0.spanContext().spanId,
      "tool span must NOT be nested under its owning LLM turn",
    );

    // Span types.
    assert.equal(turn0.attributes[SPAN_TYPE], "LLM");
    assert.equal(turn1.attributes[SPAN_TYPE], "LLM");
    assert.equal(toolSpan.attributes[SPAN_TYPE], "TOOL");

    // Outer DEFAULT span has 3 children (turn0, tool, turn1).
    const children = childrenOf(spans, parent.spanContext().spanId);
    assert.equal(
      children.length,
      3,
      `expected 3 children of parent, got ${children.length}: [${children.map((c) => c.name).join(", ")}]`,
    );

    // RunResult.usage must be applied even when the caller drains stream()
    // BEFORE calling wait() — the stream's finally path awaits the same
    // wait() promise so the authoritative totals reach the outer span.
    assert.equal(parent.attributes["cursor.usage.input_tokens"], 10);
    assert.equal(parent.attributes["cursor.usage.output_tokens"], 20);
    assert.equal(parent.attributes["cursor.run.status"], "finished");
  });

  void it("expands task tool into nested LLM + TOOL subagent spans", async () => {
    // Scripted run: a `task` tool_call whose completed result carries
    // conversationSteps — should expand into task.llm.turn.{0,1} + a
    // subagent-tool sibling under the `task` TOOL span.
    const subagentResult = {
      conversationSteps: [
        {
          type: "thinking",
          thinkingText: "Let me think about the comparison…",
        },
        {
          type: "assistantMessage",
          assistantText: "I'll write the comparison file.",
        },
        {
          type: "toolCall",
          call_id: "sub-call-1",
          name: "write",
          args: { path: "comparison.md", content: "…" },
          status: "completed",
          result: { ok: true },
        },
        {
          type: "assistantMessage",
          assistantText: "Done, saved comparison.md.",
        },
      ],
    };
    const script: ScriptedEvent[] = [
      { kind: "update", update: { type: "step-started", stepId: 0 } },
      {
        kind: "message",
        message: {
          type: "assistant",
          agent_id: "agent-1",
          run_id: "run-1",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Delegating to subagent." }],
          },
        },
      },
      {
        kind: "message",
        message: {
          type: "tool_call",
          agent_id: "agent-1",
          run_id: "run-1",
          call_id: "task-1",
          name: "task",
          status: "running",
          args: { prompt: "Write a comparison file" },
        },
      },
      {
        kind: "message",
        message: {
          type: "tool_call",
          agent_id: "agent-1",
          run_id: "run-1",
          call_id: "task-1",
          name: "task",
          status: "completed",
          args: { prompt: "Write a comparison file" },
          result: subagentResult,
        },
      },
      {
        kind: "update",
        update: { type: "step-completed", stepId: 0, stepDurationMs: 120 },
      },
    ];

    const cursor = buildMockModule(script);
    const instr = new CursorAgentSDKInstrumentation();
    instr.manuallyInstrument(cursor);

    const agent = await cursor.Agent.create({ apiKey: "fake" });
    const run = await agent.send("please delegate");
    for await (const _ of run.stream()) {
      // noop
    }
    await run.wait();

    const spans = exporter.getFinishedSpans();
    const parent = spanByName(spans, "cursor.agent.send");
    const turn0 = spanByName(spans, "cursor.llm.turn.0");
    const taskSpan = spanByName(spans, "task");
    const subTurn0 = spanByName(spans, "task.llm.turn.0");
    const subTurn1 = spanByName(spans, "task.llm.turn.1");
    const subTool = spans.find((s) => s.name === "write");
    assert.ok(subTool, "subagent 'write' tool span should exist");

    // task tool is a sibling of the outer LLM turn.
    assert.equal(
      taskSpan.parentSpanContext?.spanId,
      parent.spanContext().spanId,
      "task tool span must be a child of cursor.agent.send (sibling of LLM turns)",
    );
    assert.equal(turn0.parentSpanContext?.spanId, parent.spanContext().spanId);

    // Nested subagent spans must be children of the `task` tool span.
    assert.equal(
      subTurn0.parentSpanContext?.spanId,
      taskSpan.spanContext().spanId,
      "task.llm.turn.0 must be nested under the task tool span",
    );
    assert.equal(
      subTurn1.parentSpanContext?.spanId,
      taskSpan.spanContext().spanId,
      "task.llm.turn.1 must be nested under the task tool span",
    );
    assert.equal(
      subTool!.parentSpanContext?.spanId,
      taskSpan.spanContext().spanId,
      "subagent tool span must be nested under the task tool span",
    );

    // Span types.
    assert.equal(taskSpan.attributes[SPAN_TYPE], "TOOL");
    assert.equal(subTurn0.attributes[SPAN_TYPE], "LLM");
    assert.equal(subTurn1.attributes[SPAN_TYPE], "LLM");
    assert.equal(subTool!.attributes[SPAN_TYPE], "TOOL");

    // Subagent marker attribute on nested turns/tools.
    assert.equal(subTurn0.attributes["cursor.subagent"], true);
    assert.equal(subTool!.attributes["cursor.subagent"], true);
  });

  void it("prefers RunResult.usage over accumulated deltas to avoid double-count", async () => {
    // Older SDKs may emit BOTH token-delta AND a turn-ended with usage — if we
    // summed both into state.totalUsage and then Math.max'd against the final
    // RunResult.usage, we'd double-count. RunResult.usage is authoritative.
    const script: ScriptedEvent[] = [
      { kind: "update", update: { type: "step-started", stepId: 0 } },
      { kind: "update", update: { type: "token-delta", tokens: 20 } },
      {
        kind: "update",
        update: { type: "turn-ended", usage: { outputTokens: 20 } },
      },
      {
        kind: "update",
        update: { type: "step-completed", stepId: 0, stepDurationMs: 10 },
      },
    ];

    const cursor = buildMockModule(script);
    const instr = new CursorAgentSDKInstrumentation();
    instr.manuallyInstrument(cursor);

    const agent = await cursor.Agent.create({ apiKey: "fake" });
    const run = await agent.send("x");
    for await (const _ of run.stream()) {
      // noop
    }
    await run.wait();

    const spans = exporter.getFinishedSpans();
    const parent = spanByName(spans, "cursor.agent.send");
    // RunResult.usage.outputTokens=20 must win over the 40 we'd get from
    // token-delta (20) + turn-ended (20) accumulated locally.
    assert.equal(parent.attributes["cursor.usage.output_tokens"], 20);
    assert.equal(parent.attributes["cursor.usage.input_tokens"], 10);
  });
});
