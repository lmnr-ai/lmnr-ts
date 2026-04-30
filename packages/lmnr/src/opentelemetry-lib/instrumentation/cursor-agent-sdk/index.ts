import { diag, Span } from "@opentelemetry/api";
import {
  InstrumentationBase,
  InstrumentationModuleDefinition,
  InstrumentationNodeModuleDefinition,
} from "@opentelemetry/instrumentation";

import { version as SDK_VERSION } from "../../../../package.json";
import { Laminar } from "../../../laminar";
import { initializeLogger } from "../../../utils";
import {
  LaminarAttributes,
  SPAN_INPUT,
  SPAN_OUTPUT,
} from "../../tracing/attributes";
import { LaminarSpan } from "../../tracing/span";

const logger = initializeLogger();

// Minimal structural types for the slice of `@cursor/sdk` we consume. We do not
// depend on the package at build time — `any` at the module boundary and only
// the narrow shapes we read are asserted.
type TextBlock = { type: "text"; text: string };
type ToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
};

type SDKSystemMessage = {
  type: "system";
  agent_id: string;
  run_id: string;
  model?: { id: string; params?: Array<{ id: string; value: string }> };
  tools?: string[];
};

type SDKAssistantMessage = {
  type: "assistant";
  agent_id: string;
  run_id: string;
  message: { role: "assistant"; content: Array<TextBlock | ToolUseBlock> };
};

type SDKThinkingMessage = {
  type: "thinking";
  agent_id: string;
  run_id: string;
  text: string;
  thinking_duration_ms?: number;
};

type SDKToolUseMessage = {
  type: "tool_call";
  agent_id: string;
  run_id: string;
  call_id: string;
  name: string;
  status: "running" | "completed" | "error";
  args?: unknown;
  result?: unknown;
  truncated?: { args?: boolean; result?: boolean };
};

type SDKStatusMessage = {
  type: "status";
  agent_id: string;
  run_id: string;
  status:
    | "CREATING"
    | "RUNNING"
    | "FINISHED"
    | "ERROR"
    | "CANCELLED"
    | "EXPIRED";
  message?: string;
};

type SDKTaskMessage = {
  type: "task";
  agent_id: string;
  run_id: string;
  status?: string;
  text?: string;
};

type SDKMessage =
  | SDKSystemMessage
  | SDKAssistantMessage
  | SDKThinkingMessage
  | SDKToolUseMessage
  | SDKStatusMessage
  | SDKTaskMessage
  | { type: "user"; agent_id: string; run_id: string; message: unknown }
  | { type: "request"; agent_id: string; run_id: string; request_id: string };

/* eslint-disable @stylistic/indent */
type InteractionUpdate =
  | { type: "turn-ended"; usage?: TurnUsage }
  | { type: "text-delta"; text?: string }
  | { type: "thinking-delta"; text?: string }
  | { type: "thinking-completed"; text?: string; thinkingDurationMs?: number }
  | { type: "tool-call-started"; toolCall?: unknown }
  | { type: "tool-call-completed"; toolCall?: unknown }
  | { type: "partial-tool-call"; [key: string]: unknown }
  | {
      type: "token-delta";
      tokens?: number;
      inputTokens?: number;
      outputTokens?: number;
    }
  | { type: "step-started"; stepId?: number | string }
  | {
      type: "step-completed";
      stepId?: number | string;
      stepDurationMs?: number;
    }
  | {
      type: "user-message-appended" | "shell-output-delta";
      [key: string]: unknown;
    }
  | { type: string; [key: string]: unknown };
/* eslint-enable @stylistic/indent */

type TurnUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
};

type SendOptions = {
  model?: unknown;
  mcpServers?: unknown;
  onStep?: (args: { step: unknown }) => void | Promise<void>;
  onDelta?: (args: { update: InteractionUpdate }) => void | Promise<void>;
  local?: unknown;
};

type Run = {
  id: string;
  agentId: string;
  status: string;
  result?: string;
  model?: { id: string };
  durationMs?: number;
  stream: () => AsyncGenerator<SDKMessage, void>;
  wait: () => Promise<RunResult>;
  cancel?: () => Promise<void>;
  conversation?: () => Promise<unknown>;
  onDidChangeStatus?: (listener: (status: string) => void) => () => void;
};

type RunResult = {
  id: string;
  status: string;
  result?: string;
  model?: { id: string };
  durationMs?: number;
  usage?: TurnUsage;
};

type SDKAgent = {
  agentId: string;
  model?: { id: string };
  send: (message: unknown, options?: SendOptions) => Promise<Run>;
  [key: string]: unknown;
};

type AgentNamespace = {
  create?: (options: unknown) => Promise<SDKAgent>;
  resume?: (agentId: string, options?: unknown) => Promise<SDKAgent>;
  prompt?: (message: unknown, options?: unknown) => Promise<RunResult>;
  [key: string]: unknown;
};

type CursorSDKModule = {
  Agent?: AgentNamespace;
  [key: string]: unknown;
};

const GEN_AI_SYSTEM = "cursor";

const isLaminarActive = () =>
  Laminar.initialized() || !!process.env.LMNR_PROJECT_API_KEY;

// GC-triggered fallback: if the caller discards the Run without ever invoking
// stream() / wait() / cancel() (e.g. early return, exception in caller code,
// or `await agent.send(...)` used purely for its side effect of kicking off
// the run), the parent span would leak. We register each Run with a
// FinalizationRegistry whose callback ends the parent. The held value is an
// `endParent` closure — it MUST NOT close over the Run itself (that would
// pin the object and prevent GC from ever firing). `endParent` is idempotent
// via `parentEnded`, so this is a no-op when any of the three paths already
// closed the span.
const runFinalizationRegistry =
  typeof FinalizationRegistry !== "undefined"
    ? new FinalizationRegistry<() => void>((cleanup) => {
        try {
          cleanup();
        } catch {
          // ignore
        }
      })
    : undefined;

type ToolSpanEntry = {
  span: Span;
  laminarSpan: LaminarSpan;
  startedAt: number;
};

type LlmTurnState = {
  index: number;
  stepId?: number | string;
  span: Span;
  laminarSpan: LaminarSpan;
  assistantText: string[];
  thinkingChunks: string[];
  toolUses: Array<{
    call_id: string;
    name: string;
    args?: unknown;
    truncated?: { args?: boolean };
  }>;
  // Per-turn token counters — Cursor v1.0.10 only emits `token-delta`
  // (output tokens incrementally) between step-started and step-completed.
  // Input tokens are not exposed per step; they come via `RunResult.usage`
  // as a run-wide total, so we only track per-turn output tokens here.
  outputTokens: number;
  durationMs?: number;
};

type RunState = {
  parent: Span;
  parentLaminar: LaminarSpan;
  agentId: string;
  runId?: string;
  model?: string;
  tools?: string[];
  // Totals accumulated across all turns for outer DEFAULT span.
  totalUsage: TurnUsage;
  assistantTextAll: string[];
  thinkingAll: string[];
  toolUsesAll: Array<{
    call_id: string;
    name: string;
    args?: unknown;
    result?: unknown;
    status?: string;
    truncated?: { args?: boolean; result?: boolean };
  }>;
  finishStatus?: string;
  toolSpans: Map<string, ToolSpanEntry>;
  // Per-turn state — current active LLM turn span (if any).
  currentTurn: LlmTurnState | null;
  turnCount: number;
  // True once we've observed at least one step-started or step-completed
  // event. Cursor v1.0.10 uses those as the authoritative turn boundary;
  // older SDKs only emit `turn-ended`. We use this flag to suppress the
  // defensive `turn-ended` close when step-events are in play — otherwise
  // `turn-ended` would null `currentTurn` BEFORE `step-completed` fires,
  // and the authoritative `stepDurationMs` would silently get dropped.
  sawStepBoundary: boolean;
};

const safeStringify = (v: unknown): string => {
  try {
    if (typeof v === "string") return v;
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
};

const openLlmTurnIfNeeded = (
  state: RunState,
  stepId?: number | string,
): LlmTurnState | null => {
  if (state.currentTurn) return state.currentTurn;
  try {
    const parentCtx = state.parentLaminar.getLaminarSpanContext();
    const turnIndex = state.turnCount;
    const span = Laminar.startSpan({
      name: `cursor.llm.turn.${turnIndex}`,
      spanType: "LLM",
      parentSpanContext: JSON.stringify(parentCtx),
      input: state.model ? { model: state.model } : undefined,
    });
    try {
      span.setAttribute(LaminarAttributes.PROVIDER, GEN_AI_SYSTEM);
      if (state.model) {
        span.setAttribute(LaminarAttributes.REQUEST_MODEL, state.model);
      }
      span.setAttribute("cursor.turn.index", turnIndex);
      if (stepId !== undefined) {
        span.setAttribute("cursor.step.id", String(stepId));
      }
      if (state.runId) span.setAttribute("cursor.run.id", state.runId);
      span.setAttribute("cursor.agent.id", state.agentId);
    } catch {
      // ignore
    }
    const turn: LlmTurnState = {
      index: turnIndex,
      stepId,
      span,
      laminarSpan: span as LaminarSpan,
      assistantText: [],
      thinkingChunks: [],
      toolUses: [],
      outputTokens: 0,
    };
    state.currentTurn = turn;
    state.turnCount += 1;
    return turn;
  } catch (e) {
    logger.debug(
      "cursor-agent-sdk: failed to open LLM turn span: " + String(e),
    );
    return null;
  }
};

// Apply a resolved model name to shared state, the outer DEFAULT span, and any
// currently-open LLM turn span. The Cursor cloud runtime does NOT emit the
// `system` SDKMessage that older local-runtime docs describe, so the model
// has to be read off `Run.model` / `Agent.model` / `RunResult.model` objects
// directly — we funnel all of those through this helper so the downstream
// attribute surface stays consistent.
const applyResolvedModel = (state: RunState, model: string | undefined) => {
  if (!model) return;
  state.model = model;
  try {
    state.parent.setAttribute("cursor.agent.model", model);
  } catch {
    // ignore
  }
  if (state.currentTurn) {
    try {
      state.currentTurn.span.setAttribute(
        LaminarAttributes.REQUEST_MODEL,
        model,
      );
    } catch {
      // ignore
    }
  }
};

const closeLlmTurn = (
  state: RunState,
  opts?: {
    durationMs?: number;
    finishReason?: string;
  },
) => {
  const turn = state.currentTurn;
  if (!turn) return;
  state.currentTurn = null;

  if (opts?.durationMs !== undefined) turn.durationMs = opts.durationMs;

  try {
    // Emit gen_ai.output.messages for THIS turn only (thinking + text + tool_call).
    const parts: Array<Record<string, unknown>> = [];
    if (turn.thinkingChunks.length > 0) {
      parts.push({ type: "thinking", content: turn.thinkingChunks.join("") });
    }
    const assistantText = turn.assistantText.join("");
    if (assistantText.length > 0) {
      parts.push({ type: "text", content: assistantText });
    }
    for (const tu of turn.toolUses) {
      parts.push({
        type: "tool_call",
        id: tu.call_id,
        name: tu.name,
        arguments: tu.args,
      });
    }
    if (parts.length > 0) {
      turn.span.setAttribute(
        "gen_ai.output.messages",
        JSON.stringify([{ role: "assistant", parts }]),
      );
    }

    // SPAN_OUTPUT mirrors the main assistant payload (text + tool_calls).
    const outputObj: Record<string, unknown> = {};
    if (turn.thinkingChunks.length > 0) {
      outputObj.thinking = turn.thinkingChunks.join("");
    }
    if (assistantText.length > 0) outputObj.text = assistantText;
    if (turn.toolUses.length > 0) {
      outputObj.tool_calls = turn.toolUses.map((tu) => ({
        id: tu.call_id,
        name: tu.name,
        arguments: tu.args,
      }));
    }
    if (Object.keys(outputObj).length > 0) {
      turn.span.setAttribute(SPAN_OUTPUT, JSON.stringify(outputObj));
    }

    if (state.model) {
      turn.span.setAttribute(LaminarAttributes.RESPONSE_MODEL, state.model);
    }

    if (turn.outputTokens > 0) {
      turn.span.setAttribute(
        LaminarAttributes.OUTPUT_TOKEN_COUNT,
        turn.outputTokens,
      );
      // Cursor v1.0.10 does not emit per-turn input tokens; set total == output
      // so the downstream UI still shows a per-turn token pill.
      turn.span.setAttribute(
        LaminarAttributes.TOTAL_TOKEN_COUNT,
        turn.outputTokens,
      );
    }

    if (turn.durationMs !== undefined) {
      turn.span.setAttribute("cursor.turn.duration_ms", turn.durationMs);
    }
    if (opts?.finishReason) {
      turn.span.setAttribute(
        "gen_ai.response.finish_reason",
        opts.finishReason,
      );
    }
  } catch (e) {
    logger.debug(
      "cursor-agent-sdk: failed to populate LLM turn output: " + String(e),
    );
  }

  try {
    turn.span.end();
  } catch {
    // ignore
  }
};

const recordParentOutputsAndEnd = (state: RunState, result?: RunResult) => {
  try {
    if (state.runId) {
      state.parent.setAttribute("cursor.run.id", state.runId);
    }
    state.parent.setAttribute("cursor.agent.id", state.agentId);
    if (state.model) {
      state.parent.setAttribute("cursor.agent.model", state.model);
    }
    if (state.tools && state.tools.length > 0) {
      state.parent.setAttribute("cursor.tools", JSON.stringify(state.tools));
    }
    state.parent.setAttribute("cursor.run.turn_count", state.turnCount);

    // Aggregate usage. RunResult.usage is a run-wide total computed server-side
    // and is the authoritative source when present — the per-turn deltas we
    // accumulate (from token-delta + turn-ended) can double-count on older
    // SDKs that emit BOTH incremental deltas AND a final turn-ended total. So
    // prefer each RunResult.usage field when it's a positive number; only fall
    // back to the accumulated value when the authoritative field is missing.
    const pickUsage = (authoritative?: number, accumulated?: number) => {
      if (typeof authoritative === "number" && authoritative > 0) {
        return authoritative;
      }
      return accumulated ?? 0;
    };
    const agg: TurnUsage = {
      inputTokens: pickUsage(
        result?.usage?.inputTokens,
        state.totalUsage.inputTokens,
      ),
      outputTokens: pickUsage(
        result?.usage?.outputTokens,
        state.totalUsage.outputTokens,
      ),
      cacheRead: pickUsage(
        result?.usage?.cacheRead,
        state.totalUsage.cacheRead,
      ),
      cacheWrite: pickUsage(
        result?.usage?.cacheWrite,
        state.totalUsage.cacheWrite,
      ),
    };
    if ((agg.inputTokens ?? 0) > 0) {
      state.parent.setAttribute("cursor.usage.input_tokens", agg.inputTokens!);
    }
    if ((agg.outputTokens ?? 0) > 0) {
      state.parent.setAttribute(
        "cursor.usage.output_tokens",
        agg.outputTokens!,
      );
    }
    if ((agg.cacheRead ?? 0) > 0) {
      state.parent.setAttribute("cursor.usage.cache_read", agg.cacheRead!);
    }
    if ((agg.cacheWrite ?? 0) > 0) {
      state.parent.setAttribute("cursor.usage.cache_write", agg.cacheWrite!);
    }

    const finishStatus = result?.status ?? state.finishStatus;
    if (finishStatus) {
      state.parent.setAttribute("cursor.run.status", finishStatus);
    }
    if (typeof result?.durationMs === "number") {
      state.parent.setAttribute("cursor.run.duration_ms", result.durationMs);
    }

    // SPAN_OUTPUT on the outer DEFAULT span carries the final run result so
    // the Laminar UI shows a summary at the top of the trace.
    const assistantText = state.assistantTextAll.join("");
    const outputObj: Record<string, unknown> = {};
    if (result?.result !== undefined) {
      outputObj.result = result.result;
    } else if (assistantText.length > 0) {
      outputObj.result = assistantText;
    }
    if (state.turnCount > 0) outputObj.turns = state.turnCount;
    if (state.toolUsesAll.length > 0) {
      outputObj.tool_calls = state.toolUsesAll.map((tu) => ({
        name: tu.name,
        args: tu.args,
        result: tu.result,
        status: tu.status,
      }));
    }
    if (Object.keys(outputObj).length > 0) {
      state.parent.setAttribute(SPAN_OUTPUT, JSON.stringify(outputObj));
    }
  } catch (e) {
    logger.debug(
      "cursor-agent-sdk: failed to record parent outputs: " + String(e),
    );
  }
};

const closeOrphanToolSpans = (state: RunState) => {
  for (const [, entry] of state.toolSpans) {
    try {
      entry.span.setAttribute("cursor.tool_call.status", "incomplete");
      entry.span.end();
    } catch {
      // ignore
    }
  }
  state.toolSpans.clear();
};

// When a tool_call.name === "task", Cursor spawns a subagent that executes
// its own thinking / assistant / toolCall steps server-side and returns them
// as a `conversationSteps` array on the tool's result. We expand those steps
// into proper child spans so the tree renders:
//   task (TOOL span)
//     ├─ task.llm.turn.0  (LLM — subagent turn 0: thinking + text + declared tool_calls)
//     ├─ <tool_name>       (TOOL — invoked by the subagent)
//     ├─ task.llm.turn.1  (LLM — subagent turn 1)
//     └─ …
// Each step carries {type: "thinking"|"assistant"|"toolCall", ...}; turn
// boundaries are inferred by grouping consecutive thinking+assistant steps
// then the toolCalls that follow them. Cursor does not expose subagent-level
// token usage in the conversationSteps payload.
const expandTaskSubagent = (
  parentSpan: LaminarSpan,
  agentId: string,
  result: unknown,
) => {
  try {
    if (!result || typeof result !== "object") return;
    const steps = (result as { conversationSteps?: unknown }).conversationSteps;
    if (!Array.isArray(steps) || steps.length === 0) return;

    const parentCtx = JSON.stringify(parentSpan.getLaminarSpanContext());

    type SubTurn = {
      span: Span;
      laminarSpan: LaminarSpan;
      thinking: string[];
      assistant: string[];
      declared: Array<{ call_id: string; name: string; args?: unknown }>;
    };

    let turn: SubTurn | null = null;
    let turnIndex = 0;

    const openTurn = (): SubTurn => {
      const span = Laminar.startSpan({
        name: `task.llm.turn.${turnIndex}`,
        spanType: "LLM",
        parentSpanContext: parentCtx,
      });
      try {
        span.setAttribute(LaminarAttributes.PROVIDER, GEN_AI_SYSTEM);
        span.setAttribute("cursor.turn.index", turnIndex);
        span.setAttribute("cursor.agent.id", agentId);
        span.setAttribute("cursor.subagent", true);
      } catch {
        // ignore
      }
      const t: SubTurn = {
        span,
        laminarSpan: span as LaminarSpan,
        thinking: [],
        assistant: [],
        declared: [],
      };
      turnIndex += 1;
      return t;
    };

    const closeTurn = (t: SubTurn) => {
      try {
        const parts: Array<Record<string, unknown>> = [];
        if (t.thinking.length > 0) {
          parts.push({ type: "thinking", content: t.thinking.join("") });
        }
        const assistant = t.assistant.join("");
        if (assistant.length > 0)
          parts.push({ type: "text", content: assistant });
        for (const tc of t.declared) {
          parts.push({
            type: "tool_call",
            id: tc.call_id,
            name: tc.name,
            arguments: tc.args,
          });
        }
        if (parts.length > 0) {
          t.span.setAttribute(
            "gen_ai.output.messages",
            JSON.stringify([{ role: "assistant", parts }]),
          );
        }
        const outputObj: Record<string, unknown> = {};
        if (t.thinking.length > 0) outputObj.thinking = t.thinking.join("");
        if (assistant.length > 0) outputObj.text = assistant;
        if (t.declared.length > 0) outputObj.tool_calls = t.declared;
        if (Object.keys(outputObj).length > 0) {
          t.span.setAttribute(SPAN_OUTPUT, JSON.stringify(outputObj));
        }
      } catch {
        // ignore
      }
      try {
        t.span.end();
      } catch {
        // ignore
      }
    };

    const emitToolSpan = (tc: Record<string, unknown>) => {
      try {
        const name = typeof tc.name === "string" ? tc.name : "tool_call";
        const callId = typeof tc.call_id === "string" ? tc.call_id : undefined;
        const span = Laminar.startSpan({
          name,
          spanType: "TOOL",
          parentSpanContext: parentCtx,
          input: tc.args,
        });
        if (callId) span.setAttribute("cursor.tool_call.id", callId);
        span.setAttribute("cursor.tool_call.name", name);
        span.setAttribute("cursor.subagent", true);
        const status = typeof tc.status === "string" ? tc.status : "completed";
        span.setAttribute("cursor.tool_call.status", status);
        if (tc.result !== undefined) {
          span.setAttribute(SPAN_OUTPUT, safeStringify(tc.result));
        }
        span.end();
      } catch (e) {
        logger.debug(
          "cursor-agent-sdk: failed to emit subagent tool span: " + String(e),
        );
      }
    };

    // The LLM may declare multiple parallel tool calls in a single response,
    // so consecutive `toolCall` steps all belong on the SAME turn's declared
    // list. We only close the turn when a subsequent thinking/assistant step
    // starts a new LLM response.
    let lastStepWasToolCall = false;

    for (const step of steps) {
      if (!step || typeof step !== "object") continue;
      const s = step as Record<string, unknown>;
      const type = typeof s.type === "string" ? s.type : "";

      if (type === "thinking") {
        if (lastStepWasToolCall && turn) {
          closeTurn(turn);
          turn = null;
        }
        turn ??= openTurn();
        const text =
          typeof s.thinkingText === "string"
            ? s.thinkingText
            : typeof s.text === "string"
              ? s.text
              : "";
        if (text) turn.thinking.push(text);
        lastStepWasToolCall = false;
      } else if (type === "assistantMessage" || type === "assistant") {
        if (lastStepWasToolCall && turn) {
          closeTurn(turn);
          turn = null;
        }
        turn ??= openTurn();
        const text =
          typeof s.assistantText === "string"
            ? s.assistantText
            : typeof s.text === "string"
              ? s.text
              : "";
        if (text) turn.assistant.push(text);
        lastStepWasToolCall = false;
      } else if (type === "toolCall") {
        // Record the declared tool_call on the current turn (if one is open)
        // and emit the TOOL span as a sibling. Do NOT close the turn here —
        // parallel tool_calls from the same LLM response arrive as consecutive
        // steps and must all land on the same turn's declared list.
        if (turn) {
          turn.declared.push({
            call_id:
              typeof s.call_id === "string"
                ? s.call_id
                : typeof s.id === "string"
                  ? s.id
                  : "",
            name: typeof s.name === "string" ? s.name : "tool_call",
            args: s.args,
          });
        }
        emitToolSpan(s);
        lastStepWasToolCall = true;
      }
    }
    if (turn) closeTurn(turn);
  } catch (e) {
    logger.debug(
      "cursor-agent-sdk: failed to expand task subagent steps: " + String(e),
    );
  }
};

const handleToolCallMessage = (state: RunState, msg: SDKToolUseMessage) => {
  const existing = state.toolSpans.get(msg.call_id);

  if (msg.status === "running" && !existing) {
    // Capture the declared tool_use on the current turn's output messages
    // (so the LLM span's gen_ai.output.messages shows what it produced),
    // but parent the TOOL span itself on the OUTER DEFAULT span — tool calls
    // are siblings of LLM turns in the run timeline, not children of them.
    if (state.currentTurn) {
      state.currentTurn.toolUses.push({
        call_id: msg.call_id,
        name: msg.name,
        args: msg.args,
        truncated: msg.truncated,
      });
    }

    let toolSpan: Span | undefined;
    let laminarToolSpan: LaminarSpan | undefined;
    try {
      const parentCtx = state.parentLaminar.getLaminarSpanContext();
      toolSpan = Laminar.startSpan({
        name: msg.name || "tool_call",
        spanType: "TOOL",
        parentSpanContext: JSON.stringify(parentCtx),
        input: msg.args,
      });
      laminarToolSpan = toolSpan instanceof LaminarSpan ? toolSpan : undefined;
    } catch (e) {
      logger.debug("cursor-agent-sdk: failed to start tool span: " + String(e));
    }
    if (toolSpan) {
      try {
        toolSpan.setAttribute("cursor.tool_call.id", msg.call_id);
        toolSpan.setAttribute("cursor.tool_call.name", msg.name);
        toolSpan.setAttribute("cursor.tool_call.status", "running");
        if (msg.truncated?.args) {
          toolSpan.setAttribute("cursor.tool_call.args_truncated", true);
        }
      } catch {
        // ignore
      }
      state.toolSpans.set(msg.call_id, {
        span: toolSpan,
        laminarSpan: laminarToolSpan ?? (toolSpan as LaminarSpan),
        startedAt: Date.now(),
      });
    }

    state.toolUsesAll.push({
      call_id: msg.call_id,
      name: msg.name,
      args: msg.args,
      status: "running",
      truncated: msg.truncated,
    });
    return;
  }

  if (msg.status === "completed" || msg.status === "error") {
    const entry = state.toolSpans.get(msg.call_id) ?? existing;
    if (entry) {
      try {
        entry.span.setAttribute("cursor.tool_call.status", msg.status);
        if (msg.truncated?.result) {
          entry.span.setAttribute("cursor.tool_call.result_truncated", true);
        }
        if (msg.result !== undefined) {
          entry.span.setAttribute(SPAN_OUTPUT, safeStringify(msg.result));
        }
        // If this is the `task` subagent tool, expand its conversationSteps
        // into nested LLM turn / TOOL spans under it BEFORE ending the span —
        // children must start while the parent is still open for their
        // parentSpanContext to resolve to a live span.
        if (msg.name === "task" && msg.status === "completed") {
          expandTaskSubagent(entry.laminarSpan, state.agentId, msg.result);
        }
        entry.span.end();
      } catch {
        // ignore
      }
      state.toolSpans.delete(msg.call_id);
    } else {
      // No start seen (shouldn't happen per SDK docs); create and close a
      // TOOL span synchronously so we still capture the call.
      try {
        const parentCtx = state.parentLaminar.getLaminarSpanContext();
        const span = Laminar.startSpan({
          name: msg.name || "tool_call",
          spanType: "TOOL",
          parentSpanContext: JSON.stringify(parentCtx),
          input: msg.args,
        });
        span.setAttribute("cursor.tool_call.id", msg.call_id);
        span.setAttribute("cursor.tool_call.name", msg.name);
        span.setAttribute("cursor.tool_call.status", msg.status);
        if (msg.result !== undefined) {
          span.setAttribute(SPAN_OUTPUT, safeStringify(msg.result));
        }
        if (msg.name === "task" && msg.status === "completed") {
          expandTaskSubagent(span as LaminarSpan, state.agentId, msg.result);
        }
        span.end();
      } catch (e) {
        logger.debug(
          "cursor-agent-sdk: failed to emit synthetic tool span: " + String(e),
        );
      }
    }

    // Update the aggregate toolUsesAll entry with the result.
    const use = state.toolUsesAll.find((t) => t.call_id === msg.call_id);
    if (use) {
      use.result = msg.result;
      use.status = msg.status;
      if (msg.truncated) use.truncated = msg.truncated;
    } else {
      state.toolUsesAll.push({
        call_id: msg.call_id,
        name: msg.name,
        args: msg.args,
        result: msg.result,
        status: msg.status,
        truncated: msg.truncated,
      });
    }
  }
};

const handleSdkMessage = (state: RunState, msg: SDKMessage) => {
  if (!state.runId && "run_id" in msg && typeof msg.run_id === "string") {
    state.runId = msg.run_id;
  }

  switch (msg.type) {
    case "system":
      // Only local-runtime SDKs emit the `system` message; cloud runtime never
      // does. When it IS present, it may arrive after the first turn has
      // already opened, so route through applyResolvedModel to backfill the
      // outer span + any open LLM turn span.
      applyResolvedModel(state, msg.model?.id);
      if (Array.isArray(msg.tools)) state.tools = msg.tools;
      return;
    case "assistant": {
      const turn = openLlmTurnIfNeeded(state);
      for (const block of msg.message.content) {
        if (block.type === "text") {
          state.assistantTextAll.push(block.text);
          if (turn) turn.assistantText.push(block.text);
        }
        // tool_use blocks here represent a declared tool call; the canonical
        // path is the `tool_call` message, which carries start/end lifecycle.
      }
      return;
    }
    case "thinking": {
      const turn = openLlmTurnIfNeeded(state);
      if (msg.text) {
        state.thinkingAll.push(msg.text);
        if (turn) turn.thinkingChunks.push(msg.text);
      }
      return;
    }
    case "tool_call":
      // Opening a tool span implies some turn content is in-flight; ensure a
      // turn exists so the tool_call declaration is captured on it.
      if (msg.status === "running") openLlmTurnIfNeeded(state);
      handleToolCallMessage(state, msg);
      return;
    case "status":
      state.finishStatus = msg.status;
      return;
    case "task":
      // We currently don't surface task messages as spans; the content is
      // already carried through assistant / thinking / tool_call messages.
      return;
    default:
      return;
  }
};

const handleInteractionUpdate = (
  state: RunState,
  update: InteractionUpdate,
) => {
  if (!update || typeof update !== "object") return;
  switch (update.type) {
    case "step-started": {
      // Each `step` corresponds to one LLM call/turn. Close the previous turn
      // (in case we didn't see a matching step-completed) and open a new one.
      state.sawStepBoundary = true;
      const stepId = (update as { stepId?: number | string }).stepId;
      if (state.currentTurn) closeLlmTurn(state);
      openLlmTurnIfNeeded(state, stepId);
      return;
    }
    case "step-completed": {
      state.sawStepBoundary = true;
      const stepDurationMs = (update as { stepDurationMs?: number })
        .stepDurationMs;
      closeLlmTurn(state, { durationMs: stepDurationMs });
      return;
    }
    case "token-delta": {
      const tokens = (update as { tokens?: number }).tokens;
      if (typeof tokens === "number") {
        if (state.currentTurn) {
          state.currentTurn.outputTokens += tokens;
        }
        state.totalUsage.outputTokens =
          (state.totalUsage.outputTokens ?? 0) + tokens;
      }
      return;
    }
    case "turn-ended": {
      // Older SDK versions carry usage on turn-ended; v1.0.10 sends an empty
      // object. Prefer step-completed for boundary + token-delta for usage,
      // but still fold any usage present on this event into the run total.
      const turnUsage = (update as { usage?: TurnUsage }).usage;
      if (turnUsage) {
        state.totalUsage = {
          inputTokens:
            (state.totalUsage.inputTokens ?? 0) + (turnUsage.inputTokens ?? 0),
          outputTokens:
            (state.totalUsage.outputTokens ?? 0) +
            (turnUsage.outputTokens ?? 0),
          cacheRead:
            (state.totalUsage.cacheRead ?? 0) + (turnUsage.cacheRead ?? 0),
          cacheWrite:
            (state.totalUsage.cacheWrite ?? 0) + (turnUsage.cacheWrite ?? 0),
        };
      }
      // Defensive flush only for legacy SDKs that never emit step-completed.
      // When step boundaries ARE in play, closing here would null currentTurn
      // before the authoritative `step-completed` handler can apply
      // `stepDurationMs` — silently dropping the turn duration.
      if (!state.sawStepBoundary && state.currentTurn) closeLlmTurn(state);
      return;
    }
    default:
      return;
  }
};

const wrapSend = (
  originalSend: (message: unknown, options?: SendOptions) => Promise<Run>,
  agent: SDKAgent,
) =>
  async function patchedSend(
    this: unknown,
    message: unknown,
    options?: SendOptions,
  ): Promise<Run> {
    if (!isLaminarActive()) {
      return originalSend.call(this, message, options);
    }

    const promptSummary =
      typeof message === "string"
        ? message
        : safeStringify((message as { text?: string })?.text ?? message);

    // Outer span is DEFAULT — it encapsulates the whole agent.send() run.
    // Per-turn LLM spans + TOOL spans are emitted as children.
    const parent = Laminar.startSpan({
      name: "cursor.agent.send",
      input: {
        prompt: promptSummary,
        agentId: agent.agentId,
        model: agent.model?.id,
      },
    });
    const parentLaminar = parent as LaminarSpan;
    try {
      parent.setAttribute(SPAN_INPUT, safeStringify({ prompt: promptSummary }));
      parent.setAttribute("cursor.agent.id", agent.agentId);
      if (agent.model?.id) {
        parent.setAttribute("cursor.agent.model", agent.model.id);
      }
    } catch {
      // ignore
    }

    const state: RunState = {
      parent,
      parentLaminar,
      agentId: agent.agentId,
      model: agent.model?.id,
      totalUsage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      assistantTextAll: [],
      thinkingAll: [],
      toolUsesAll: [],
      toolSpans: new Map(),
      currentTurn: null,
      turnCount: 0,
      sawStepBoundary: false,
    };

    // Wrap onDelta to also tap into turn-ended / usage events while forwarding
    // to the caller-provided callback.
    const userOnDelta = options?.onDelta;
    const wrappedOnDelta = async (args: { update: InteractionUpdate }) => {
      try {
        handleInteractionUpdate(state, args.update);
      } catch (e) {
        logger.debug("cursor-agent-sdk: error in onDelta tap: " + String(e));
      }
      if (userOnDelta) {
        // Preserve caller semantics — do not swallow their errors.
        await userOnDelta(args);
      }
    };

    const patchedOptions: SendOptions = {
      ...(options ?? {}),
      onDelta: wrappedOnDelta,
    };

    let run: Run;
    try {
      run = await originalSend.call(this, message, patchedOptions);
    } catch (e) {
      try {
        parent.recordException(e as Error);
        parent.setAttribute("cursor.run.status", "ERROR");
      } catch {
        // ignore
      }
      try {
        parent.end();
      } catch {
        // ignore
      }
      throw e;
    }

    // Cloud runtime never emits the `system` SDKMessage, so `Run.model` (and
    // the `Agent.model` fallback already captured in state) is the only way
    // to know which model the run is using before the first turn opens.
    applyResolvedModel(state, run.model?.id ?? state.model);
    if (run.id) state.runId = run.id;

    let parentEnded = false;
    const endParent = (result?: RunResult) => {
      if (parentEnded) return;
      parentEnded = true;
      // Ensure any still-open LLM turn is flushed.
      if (state.currentTurn) {
        closeLlmTurn(state, { finishReason: state.finishStatus });
      }
      try {
        recordParentOutputsAndEnd(state, result);
      } catch {
        // ignore
      }
      closeOrphanToolSpans(state);
      try {
        parent.end();
      } catch {
        // ignore
      }
    };

    // Memoize originalWait so both the stream's finally block and the caller's
    // own run.wait() share a single underlying promise. This is what lets the
    // stream drain path end the parent WITH the authoritative RunResult (its
    // usage / durationMs / result.status are the only source of run-wide input
    // tokens per the cloud-runtime docs) instead of ending empty-handed and
    // leaving wait()'s endParent(result) as a no-op.
    const originalWait = run.wait.bind(run);
    let waitPromise: Promise<RunResult> | null = null;
    const waitOnce = () => {
      waitPromise ??= originalWait();
      return waitPromise;
    };

    // Wrap run.stream so we observe every message. Cursor SDK exposes both
    // stream() and wait() — callers may use either or both. If wait() is not
    // called, we still need to close the parent when the stream drains, AND
    // we still want the RunResult's authoritative usage/result/status on the
    // outer span — so resolve waitOnce() inside the finally before ending.
    const originalStream = run.stream.bind(run);
    run.stream = (() =>
      async function* patchedStream() {
        let drainError: unknown = undefined;
        try {
          for await (const message of originalStream()) {
            try {
              handleSdkMessage(state, message);
            } catch (e) {
              logger.debug(
                "cursor-agent-sdk: error in stream tap: " + String(e),
              );
            }
            yield message;
          }
        } catch (e) {
          drainError = e;
          try {
            parent.recordException(e as Error);
          } catch {
            // ignore
          }
          state.finishStatus = "ERROR";
          throw e;
        } finally {
          if (!parentEnded) {
            if (drainError !== undefined) {
              endParent();
            } else {
              try {
                const result = await waitOnce();
                applyResolvedModel(state, result?.model?.id ?? state.model);
                endParent(result);
              } catch {
                // originalWait failed — still end the parent so the span closes.
                endParent();
              }
            }
          }
        }
      })() as unknown as typeof run.stream;

    // Wrap run.wait so we close the parent span with the final result.
    run.wait = async () => {
      try {
        const result = await waitOnce();
        // Final authoritative model id — covers the case where Run.model was
        // not set but RunResult.model is (some cloud flows only populate it
        // after the run finishes).
        applyResolvedModel(state, result?.model?.id ?? state.model);
        endParent(result);
        return result;
      } catch (e) {
        try {
          parent.recordException(e as Error);
        } catch {
          // ignore
        }
        state.finishStatus = "ERROR";
        endParent();
        throw e;
      }
    };

    // Wrap run.cancel so we end the span cleanly on user-initiated cancel.
    if (typeof run.cancel === "function") {
      const originalCancel = run.cancel.bind(run);
      run.cancel = async () => {
        try {
          await originalCancel();
        } finally {
          state.finishStatus = "CANCELLED";
          endParent();
        }
      };
    }

    // GC fallback for the "caller discards the Run" case — see registry decl.
    // Pass `endParent` directly (no closure over `run`) so the registry holds
    // nothing that keeps the Run alive.
    runFinalizationRegistry?.register(run, endParent);

    return run;
  };

const wrapAgentHandle = (agent: SDKAgent): SDKAgent => {
  if (!agent || typeof agent.send !== "function") return agent;
  const original = agent.send.bind(agent);
  // Replace agent.send on the instance so subsequent calls go through us.
  try {
    Object.defineProperty(agent, "send", {
      configurable: true,
      enumerable: true,
      writable: true,
      value: wrapSend(original, agent),
    });
  } catch (e) {
    logger.debug("cursor-agent-sdk: unable to patch agent.send: " + String(e));
  }
  return agent;
};

const wrapAgentNamespace = (agentNamespace: AgentNamespace): void => {
  if (!agentNamespace) return;

  if (typeof agentNamespace.create === "function") {
    const original = agentNamespace.create.bind(agentNamespace);
    agentNamespace.create = async (opts: unknown) => {
      const agent = await original(opts);
      return wrapAgentHandle(agent);
    };
  }

  if (typeof agentNamespace.resume === "function") {
    const original = agentNamespace.resume.bind(agentNamespace);
    agentNamespace.resume = async (agentId: string, opts?: unknown) => {
      const agent = await original(agentId, opts);
      return wrapAgentHandle(agent);
    };
  }

  if (typeof agentNamespace.prompt === "function") {
    const originalPrompt = agentNamespace.prompt.bind(agentNamespace);
    agentNamespace.prompt = async (message: unknown, opts?: unknown) => {
      if (!isLaminarActive()) {
        return originalPrompt(message, opts);
      }
      const promptSummary =
        typeof message === "string" ? message : safeStringify(message);
      // Agent.prompt is a one-shot convenience that doesn't expose the message
      // stream, so we keep it as a single LLM span (there is no turn boundary
      // signal to split on).
      const parent = Laminar.startSpan({
        name: "cursor.agent.prompt",
        spanType: "LLM",
        input: { prompt: promptSummary },
      });
      try {
        parent.setAttribute(
          SPAN_INPUT,
          safeStringify({ prompt: promptSummary }),
        );
        parent.setAttribute(LaminarAttributes.PROVIDER, GEN_AI_SYSTEM);
      } catch {
        // ignore
      }
      try {
        const result = await originalPrompt(message, opts);
        try {
          if (result?.result !== undefined) {
            parent.setAttribute(SPAN_OUTPUT, safeStringify(result.result));
          }
          if (result?.status) {
            parent.setAttribute("gen_ai.response.finish_reason", result.status);
          }
          if (result?.model?.id) {
            parent.setAttribute(
              LaminarAttributes.RESPONSE_MODEL,
              result.model.id,
            );
            parent.setAttribute(
              LaminarAttributes.REQUEST_MODEL,
              result.model.id,
            );
          }
          if (typeof result?.durationMs === "number") {
            parent.setAttribute("cursor.run.duration_ms", result.durationMs);
          }
          if (result?.usage) {
            if (typeof result.usage.inputTokens === "number") {
              parent.setAttribute(
                LaminarAttributes.INPUT_TOKEN_COUNT,
                result.usage.inputTokens,
              );
            }
            if (typeof result.usage.outputTokens === "number") {
              parent.setAttribute(
                LaminarAttributes.OUTPUT_TOKEN_COUNT,
                result.usage.outputTokens,
              );
            }
            const total =
              (result.usage.inputTokens ?? 0) +
              (result.usage.outputTokens ?? 0);
            if (total > 0) {
              parent.setAttribute(LaminarAttributes.TOTAL_TOKEN_COUNT, total);
            }
          }
        } catch {
          // ignore
        }
        return result;
      } catch (e) {
        try {
          parent.recordException(e as Error);
          parent.setAttribute("gen_ai.response.finish_reason", "error");
        } catch {
          // ignore
        }
        throw e;
      } finally {
        try {
          parent.end();
        } catch {
          // ignore
        }
      }
    };
  }
};

/**
 * Laminar instrumentation for `@cursor/sdk`. Wraps `Agent.create` /
 * `Agent.resume` / `Agent.prompt` so we can intercept each `SDKAgent.send()`
 * call and synthesize Laminar spans from the SDK's streamed `SDKMessage` +
 * `InteractionUpdate` events.
 *
 * Produced trace shape (per `agent.send()` call):
 *
 *   cursor.agent.send         (DEFAULT — whole run, prompt in / result out)
 *   ├─ cursor.llm.turn.0      (LLM — turn 0: thinking + text + declared tool_calls,
 *   │                           per-turn token usage + model)
 *   ├─ <tool_name>            (TOOL — invoked after turn 0, sibling of the LLM span)
 *   ├─ cursor.llm.turn.1      (LLM — turn 1 continuation after the tool result)
 *   ├─ task                   (TOOL — Task subagent call with nested children:)
 *   │   ├─ task.llm.turn.0    (LLM — subagent turn 0)
 *   │   ├─ <tool_name>        (TOOL — invoked by the subagent)
 *   │   └─ …
 *   └─ …
 *
 * Turn boundaries come from `step-started` / `step-completed` InteractionUpdate
 * events. Per-turn output tokens come from `token-delta`. Tool span lifecycle
 * comes from the `tool_call` SDKMessage with status running/completed/error.
 * Tool spans are siblings of LLM turns (parented to the outer DEFAULT), not
 * children — the LLM turn captures what the assistant declared, the TOOL span
 * captures the actual invocation + result.
 *
 * Cursor's SDK talks ConnectRPC to `api2.cursor.sh` — the actual LLM call
 * happens server-side, so raw provider request/response is not available to
 * the client. We capture everything the SDK does surface.
 */
export class CursorAgentSDKInstrumentation extends InstrumentationBase {
  constructor() {
    super("lmnr-cursor-agent-sdk-instrumentation", SDK_VERSION, {
      enabled: true,
    });
  }

  protected init(): InstrumentationModuleDefinition {
    return new InstrumentationNodeModuleDefinition(
      "@cursor/sdk",
      [">=1.0.0 <2"],
      this.patch.bind(this),
      this.unpatch.bind(this),
    );
  }

  public manuallyInstrument(cursorModule: CursorSDKModule): void {
    diag.debug("Manually instrumenting @cursor/sdk");
    this.patch(cursorModule);
  }

  private patch(moduleExports: CursorSDKModule): CursorSDKModule {
    try {
      if (moduleExports.Agent) {
        wrapAgentNamespace(moduleExports.Agent);
      } else {
        diag.warn(
          "@cursor/sdk: Agent namespace not found on module exports — skipping",
        );
      }
    } catch (e) {
      diag.warn(
        "@cursor/sdk: error during patch — " +
          (e instanceof Error ? e.message : String(e)),
      );
    }
    return moduleExports;
  }

  private unpatch(): void {
    // Replacements are assigned directly to the namespace methods — there is
    // no shimmer stack to unwrap. For now, leave the patched methods in place;
    // callers who need true unpatch should re-import the module.
    diag.debug("@cursor/sdk: unpatch is a no-op (methods replaced in place)");
  }
}
