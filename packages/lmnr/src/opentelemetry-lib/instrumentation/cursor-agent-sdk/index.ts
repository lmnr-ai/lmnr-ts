import { diag, Span } from "@opentelemetry/api";
import {
  InstrumentationBase,
  InstrumentationModuleDefinition,
  InstrumentationNodeModuleDefinition,
} from "@opentelemetry/instrumentation";

import { version as SDK_VERSION } from "../../../../package.json";
import { Laminar } from "../../../laminar";
import { initializeLogger } from "../../../utils";
import { LaminarSpan } from "../../tracing/span";
import {
  LaminarAttributes,
  SPAN_INPUT,
  SPAN_OUTPUT,
} from "../../tracing/attributes";

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

type InteractionUpdate =
  | { type: "turn-ended"; usage?: TurnUsage }
  | { type: "text-delta"; text?: string }
  | { type: "thinking-delta"; text?: string }
  | { type: "thinking-completed"; text?: string; thinkingDurationMs?: number }
  | { type: "tool-call-started"; toolCall?: unknown }
  | { type: "tool-call-completed"; toolCall?: unknown }
  | { type: "partial-tool-call"; [key: string]: unknown }
  | { type: "token-delta"; inputTokens?: number; outputTokens?: number }
  | { type: "step-started" | "step-completed"; step?: unknown }
  | {
      type: "user-message-appended" | "shell-output-delta";
      [key: string]: unknown;
    }
  | { type: string; [key: string]: unknown };

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

type RunState = {
  parent: Span;
  parentLaminar: LaminarSpan;
  agentId: string;
  runId?: string;
  model?: string;
  tools?: string[];
  assistantText: string[];
  thinkingChunks: string[];
  toolUses: Array<{
    call_id: string;
    name: string;
    args?: unknown;
    result?: unknown;
    status?: string;
    truncated?: { args?: boolean; result?: boolean };
  }>;
  usage?: TurnUsage;
  finishStatus?: string;
  toolSpans: Map<string, Span>;
};

const recordParentOutputsAndEnd = (state: RunState, result?: RunResult) => {
  try {
    const runId = result?.id ?? state.runId;
    if (runId) {
      state.parent.setAttribute("cursor.run.id", runId);
    }
    state.parent.setAttribute("cursor.agent.id", state.agentId);
    if (state.model) {
      state.parent.setAttribute(LaminarAttributes.REQUEST_MODEL, state.model);
      state.parent.setAttribute(LaminarAttributes.RESPONSE_MODEL, state.model);
    }
    state.parent.setAttribute(LaminarAttributes.PROVIDER, GEN_AI_SYSTEM);
    if (state.tools && state.tools.length > 0) {
      state.parent.setAttribute("cursor.tools", JSON.stringify(state.tools));
    }

    const finalUsage = result?.usage ?? state.usage;
    if (finalUsage) {
      if (typeof finalUsage.inputTokens === "number") {
        state.parent.setAttribute(
          LaminarAttributes.INPUT_TOKEN_COUNT,
          finalUsage.inputTokens,
        );
      }
      if (typeof finalUsage.outputTokens === "number") {
        state.parent.setAttribute(
          LaminarAttributes.OUTPUT_TOKEN_COUNT,
          finalUsage.outputTokens,
        );
      }
      const total =
        typeof finalUsage.totalTokens === "number"
          ? finalUsage.totalTokens
          : (finalUsage.inputTokens ?? 0) + (finalUsage.outputTokens ?? 0);
      if (total > 0) {
        state.parent.setAttribute(LaminarAttributes.TOTAL_TOKEN_COUNT, total);
      }
      if (typeof finalUsage.cacheRead === "number") {
        state.parent.setAttribute(
          "gen_ai.usage.cache_read_input_tokens",
          finalUsage.cacheRead,
        );
      }
      if (typeof finalUsage.cacheWrite === "number") {
        state.parent.setAttribute(
          "gen_ai.usage.cache_write_input_tokens",
          finalUsage.cacheWrite,
        );
      }
    }

    const finishStatus = result?.status ?? state.finishStatus;
    if (finishStatus) {
      state.parent.setAttribute("gen_ai.response.finish_reason", finishStatus);
    }
    if (typeof result?.durationMs === "number") {
      state.parent.setAttribute("cursor.run.duration_ms", result.durationMs);
    }

    // Emit gen_ai.output.messages with thinking + text + tool_call parts so the
    // Laminar UI renders the LLM output (incl. reasoning/"Thinking" label).
    const parts: Array<Record<string, unknown>> = [];
    if (state.thinkingChunks.length > 0) {
      parts.push({
        type: "thinking",
        content: state.thinkingChunks.join(""),
      });
    }
    const assistantText = state.assistantText.join("");
    if (assistantText.length > 0) {
      parts.push({ type: "text", content: assistantText });
    }
    for (const tu of state.toolUses) {
      parts.push({
        type: "tool_call",
        id: tu.call_id,
        name: tu.name,
        arguments: tu.args,
      });
    }
    if (parts.length > 0) {
      state.parent.setAttribute(
        "gen_ai.output.messages",
        JSON.stringify([{ role: "assistant", parts }]),
      );
    }

    // Also set SPAN_OUTPUT for the default text view in Laminar.
    const outputObj: Record<string, unknown> = {};
    if (result?.result !== undefined) {
      outputObj.result = result.result;
    } else if (assistantText.length > 0) {
      outputObj.result = assistantText;
    }
    if (state.thinkingChunks.length > 0) {
      outputObj.thinking = state.thinkingChunks.join("");
    }
    if (state.toolUses.length > 0) {
      outputObj.tool_calls = state.toolUses.map((tu) => ({
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
  for (const [, span] of state.toolSpans) {
    try {
      span.setAttribute("cursor.tool_call.status", "incomplete");
      span.end();
    } catch {
      // ignore
    }
  }
  state.toolSpans.clear();
};

const handleToolCallMessage = (state: RunState, msg: SDKToolUseMessage) => {
  const existing = state.toolSpans.get(msg.call_id);

  if (msg.status === "running" && !existing) {
    // Start a child TOOL span parented to the run's parent span.
    let toolSpan: Span | undefined;
    try {
      const parentCtx = state.parentLaminar.getLaminarSpanContext();
      toolSpan = Laminar.startSpan({
        name: msg.name || "tool_call",
        spanType: "TOOL",
        parentSpanContext: JSON.stringify(parentCtx),
        input: msg.args,
      });
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
      state.toolSpans.set(msg.call_id, toolSpan);
    }

    state.toolUses.push({
      call_id: msg.call_id,
      name: msg.name,
      args: msg.args,
      status: "running",
      truncated: msg.truncated,
    });
    return;
  }

  if (msg.status === "completed" || msg.status === "error") {
    const toolSpan = state.toolSpans.get(msg.call_id) ?? existing;
    if (toolSpan) {
      try {
        toolSpan.setAttribute("cursor.tool_call.status", msg.status);
        if (msg.truncated?.result) {
          toolSpan.setAttribute("cursor.tool_call.result_truncated", true);
        }
        if (msg.result !== undefined) {
          toolSpan.setAttribute(SPAN_OUTPUT, safeStringify(msg.result));
        }
        toolSpan.end();
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
        span.end();
      } catch (e) {
        logger.debug(
          "cursor-agent-sdk: failed to emit synthetic tool span: " + String(e),
        );
      }
    }

    // Update the toolUses entry (by call_id) with the result.
    const use = state.toolUses.find((t) => t.call_id === msg.call_id);
    if (use) {
      use.result = msg.result;
      use.status = msg.status;
      if (msg.truncated) use.truncated = msg.truncated;
    } else {
      state.toolUses.push({
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
      if (msg.model?.id) state.model = msg.model.id;
      if (Array.isArray(msg.tools)) state.tools = msg.tools;
      return;
    case "assistant": {
      for (const block of msg.message.content) {
        if (block.type === "text") {
          state.assistantText.push(block.text);
        }
        // tool_use blocks here represent a declared tool call; the canonical
        // path is the `tool_call` message, which carries start/end lifecycle.
      }
      return;
    }
    case "thinking":
      if (msg.text) state.thinkingChunks.push(msg.text);
      return;
    case "tool_call":
      handleToolCallMessage(state, msg);
      return;
    case "status":
      state.finishStatus = msg.status;
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
    case "turn-ended": {
      const maybeUsage = (update as { usage?: TurnUsage }).usage;
      if (maybeUsage) {
        const next: TurnUsage = {
          inputTokens:
            (state.usage?.inputTokens ?? 0) + (maybeUsage.inputTokens ?? 0),
          outputTokens:
            (state.usage?.outputTokens ?? 0) + (maybeUsage.outputTokens ?? 0),
          cacheRead:
            (state.usage?.cacheRead ?? 0) + (maybeUsage.cacheRead ?? 0),
          cacheWrite:
            (state.usage?.cacheWrite ?? 0) + (maybeUsage.cacheWrite ?? 0),
        };
        // Only accumulate totalTokens when at least one turn reports it;
        // otherwise leave undefined so recordParentOutputsAndEnd falls back
        // to input+output instead of a misleading 0.
        if (
          typeof maybeUsage.totalTokens === "number" ||
          typeof state.usage?.totalTokens === "number"
        ) {
          next.totalTokens =
            (state.usage?.totalTokens ?? 0) + (maybeUsage.totalTokens ?? 0);
        }
        state.usage = next;
      }
      return;
    }
    default:
      return;
  }
};

const safeStringify = (v: unknown): string => {
  try {
    if (typeof v === "string") return v;
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
};

const wrapSend = (
  originalSend: (message: unknown, options?: SendOptions) => Promise<Run>,
  agent: SDKAgent,
) => {
  return async function patchedSend(
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

    const parent = Laminar.startSpan({
      name: "cursor.agent.send",
      spanType: "LLM",
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
        parent.setAttribute(LaminarAttributes.REQUEST_MODEL, agent.model.id);
      }
    } catch {
      // ignore
    }

    const state: RunState = {
      parent,
      parentLaminar,
      agentId: agent.agentId,
      model: agent.model?.id,
      assistantText: [],
      thinkingChunks: [],
      toolUses: [],
      toolSpans: new Map(),
    };

    // Wrap onDelta to also tap into usage events while forwarding to the
    // caller-provided callback.
    const userOnDelta = options?.onDelta;
    const wrappedOnDelta = async (args: { update: InteractionUpdate }) => {
      try {
        handleInteractionUpdate(state, args.update);
      } catch (e) {
        logger.debug("cursor-agent-sdk: error in onDelta tap: " + String(e));
      }
      if (userOnDelta) {
        try {
          await userOnDelta(args);
        } catch (e) {
          // Preserve caller semantics — rethrow their error
          throw e;
        }
      }
    };

    const patchedOptions: SendOptions = {
      ...(options ?? {}),
      onDelta: wrappedOnDelta,
    };

    let run: Run;
    try {
      run = await originalSend.call(this, message, patchedOptions);
      if (run?.id) state.runId = run.id;
    } catch (e) {
      try {
        parent.recordException(e as Error);
        parent.setAttribute("gen_ai.response.finish_reason", "error");
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

    let parentEnded = false;
    const endParent = (result?: RunResult) => {
      if (parentEnded) return;
      parentEnded = true;
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

    // Wrap run.stream so we observe every message. Cursor SDK exposes both
    // stream() and wait() — callers may use either or both. If wait() is not
    // called, we still need to close the parent when the stream drains.
    const originalStream = run.stream.bind(run);
    run.stream = (() =>
      async function* patchedStream() {
        try {
          for await (const message of originalStream()) {
            try {
              handleSdkMessage(state, message as SDKMessage);
            } catch (e) {
              logger.debug(
                "cursor-agent-sdk: error in stream tap: " + String(e),
              );
            }
            yield message as SDKMessage;
          }
        } catch (e) {
          try {
            parent.recordException(e as Error);
          } catch {
            // ignore
          }
          state.finishStatus = "error";
          throw e;
        } finally {
          endParent();
        }
      })() as unknown as typeof run.stream;

    // Wrap run.wait so we close the parent span with the final result.
    const originalWait = run.wait.bind(run);
    run.wait = async () => {
      try {
        const result = await originalWait();
        endParent(result);
        return result;
      } catch (e) {
        try {
          parent.recordException(e as Error);
        } catch {
          // ignore
        }
        state.finishStatus = "error";
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
          state.finishStatus = "cancelled";
          endParent();
        }
      };
    }

    return run;
  };
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
 * Produced trace:
 * - parent LLM span `cursor.agent.send` per `agent.send()` call, carrying the
 *   prompt as input, full assistant text + accumulated thinking as
 *   `gen_ai.output.messages`, usage, finish reason, model, duration.
 * - child TOOL span per `tool_call` lifecycle (started on status="running",
 *   closed on status="completed"/"error"), with `args` as input and `result`
 *   as output.
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

  private unpatch(_moduleExports: CursorSDKModule): void {
    // Replacements are assigned directly to the namespace methods — there is
    // no shimmer stack to unwrap. For now, leave the patched methods in place;
    // callers who need true unpatch should re-import the module.
    diag.debug("@cursor/sdk: unpatch is a no-op (methods replaced in place)");
  }
}
