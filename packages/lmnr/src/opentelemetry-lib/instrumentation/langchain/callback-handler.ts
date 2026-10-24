import type { HrTime } from "@opentelemetry/api";
import { Context, context, SpanStatusCode, trace } from "@opentelemetry/api";
import {
  hrTime,
  isTracingSuppressed,
  unsuppressTracing,
} from "@opentelemetry/core";

import { Laminar } from "../../../laminar";
import { initializeLogger } from "../../../utils";
import { LaminarContextManager } from "../../tracing/context";
import { LaminarSpan } from "../../tracing/span";
import { LLM_CALL_KEY, LlmCall } from "./llm-call";
import {
  retrieverOutput,
  sanitizeMetadata,
  setChatRequest,
  setCompletionRequest,
  setRequestAttributes,
  setResponseAttributes,
  toJson,
} from "./span-utils";
import { detectVendorFromClass } from "./vendor-detection";

const logger = initializeLogger();

export const HANDLER_NAME = "laminar_callback_handler";

type SpanType = "DEFAULT" | "LLM" | "TOOL";

type Run = {
  span: LaminarSpan;
  // Context with this run's span current; child runs parent from it
  context: Context;
  children: string[];
  requestModel?: string;
};

/**
 * Everything needed to record a handed-off LLM run's span after the fact, in
 * case no provider instrumentation recorded the call after all.
 */
type HandedOff = {
  context: Context;
  call: LlmCall;
  name: string;
  operation: "chat" | "text_completion";
  serialized: any;
  input: any[];
  extraParams?: Record<string, any>;
  tags?: string[];
  metadata?: Record<string, any>;
  startTime: HrTime;
};

/**
 * Callback handlers must never break the user's chain.
 */
const dontThrow = (fn: () => void): void => {
  try {
    fn();
  } catch (error) {
    logger.debug(`Failed to record LangChain run: ${String(error)}`);
  }
};

const className = (serialized: any): string => {
  const id = serialized?.id;
  if (Array.isArray(id) && id.length > 0) return String(id[id.length - 1]);
  return typeof id === "string" ? id : "";
};

// `runName` comes first: LangChain resolves it from `config.runName` (set by
// `withConfig({ runName })` or a graph) and falls back to `getName()` itself
const runNameOf = (serialized: any, runName?: string): string => {
  for (const name of [runName, serialized?.kwargs?.name, serialized?.name]) {
    if (typeof name === "string" && name) return name;
  }
  return className(serialized) || "unknown";
};

/**
 * LangGraph's `configurable.thread_id`, the conversation id.
 */
const threadIdOf = (
  metadata: Record<string, any> | undefined,
  extra: Record<string, any> | undefined,
): string | undefined => {
  const threadId =
    metadata?.thread_id ?? extra?.config?.configurable?.thread_id;
  return threadId === undefined || threadId === null
    ? undefined
    : String(threadId);
};

/**
 * Drop what only applies to the context a callback fired in (an open LLM
 * call's marker and its suppression) before parenting a new run from it.
 */
const cleanContext = (ctx: Context): Context =>
  unsuppressTracing(ctx).deleteValue(LLM_CALL_KEY);

/**
 * Records LangChain runs as Laminar spans.
 *
 * A single instance is injected into every LangChain `CallbackManager`, so all
 * state is keyed by LangChain's `runId`. Callbacks only start and end spans:
 * JavaScript callbacks cannot change the context of the code they observe, so
 * the instrumentation wrappers read `contextFor(runId)` to run user code (a
 * lambda, a tool, a graph node) and provider SDK calls under the right span.
 *
 * Duck-types LangChain's `BaseCallbackHandler` (`name`, `awaitHandlers`,
 * `copy`), as `@langchain/core` is not a runtime dependency of this package.
 */
export class LaminarCallbackHandler {
  public readonly name = HANDLER_NAME;
  // Run inline in the caller's async context, so callbacks see the context
  // the instrumentation wrappers set, and spans start before user code runs.
  public readonly awaitHandlers = true;
  public readonly raiseError = false;
  public readonly ignoreLLM = false;
  public readonly ignoreChain = false;
  public readonly ignoreAgent = false;
  public readonly ignoreRetriever = false;
  public readonly ignoreCustomEvent = true;
  public readonly lc_serializable = false;

  public traceContent: boolean;
  /**
   * Returns the LangGraph topology published for the graph run that is
   * starting, if any, and consumes it.
   */
  public takeTopology: () => Record<string, string> | undefined = () =>
    undefined;

  private runs = new Map<string, Run>();
  // LLM runs left to the provider SDK instrumentation (no LangChain span)
  private handedOff = new Map<string, HandedOff>();

  constructor(traceContent: boolean) {
    this.traceContent = traceContent;
  }

  public copy(): this {
    return this;
  }

  /**
   * Context of an open run (or of a handed-off LLM run's parent), for code
   * that runs under it.
   */
  public contextFor(runId?: string): Context | undefined {
    if (!runId) return undefined;
    return this.runs.get(runId)?.context ?? this.handedOff.get(runId)?.context;
  }

  public handleChainStart(
    chain: any,
    inputs: any,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, any>,
    _runType?: string,
    runName?: string,
    extra?: Record<string, any>,
  ): void {
    dontThrow(() => {
      const name = runNameOf(chain, runName);
      const isRoot =
        !parentRunId ||
        (!this.runs.has(parentRunId) && !this.handedOff.has(parentRunId));
      const attributes: Record<string, string> = {};
      let spanName: string;
      if (isRoot) {
        spanName = `${name}.workflow`;
        attributes["gen_ai.operation.name"] = "invoke_agent";
        attributes["gen_ai.agent.name"] = name;
        attributes["gen_ai.agent.id"] = String(runId);
      } else {
        spanName = `execute_task ${name}`;
        attributes["gen_ai.operation.name"] = "execute_task";
      }
      const threadId = threadIdOf(metadata, extra);
      if (threadId) {
        attributes["gen_ai.conversation.id"] = threadId;
      }

      // Pregel publishes the graph topology for the first chain run it
      // starts, which is the graph's own run. Consume it either way, so it
      // does not land on a nested run, but only record it on a root span:
      // that is where the trace view reads it from.
      const topology = this.takeTopology();
      if (topology && isRoot) {
        for (const [key, value] of Object.entries(topology)) {
          attributes[`lmnr.association.properties.${key}`] = value;
        }
      }

      const span = this.startRun(runId, parentRunId, spanName, {
        attributes,
        tags,
        metadata,
      });
      if (span && this.traceContent) {
        span.setInput(toJson(inputs));
      }
    });
  }

  public handleChainEnd(outputs: any, runId: string): void {
    dontThrow(() => {
      try {
        this.setOutput(runId, outputs);
      } finally {
        this.endRun(runId);
      }
    });
  }

  public handleChainError(error: any, runId: string): void {
    dontThrow(() => this.handleError(error, runId));
  }

  public handleChatModelStart(
    llm: any,
    messages: any[][],
    runId: string,
    parentRunId?: string,
    extraParams?: Record<string, any>,
    tags?: string[],
    metadata?: Record<string, any>,
    runName?: string,
  ): void {
    dontThrow(() =>
      this.startLlm(llm, messages, "chat", runId, parentRunId, {
        extraParams,
        tags,
        metadata,
        runName,
      }),
    );
  }

  public handleLLMStart(
    llm: any,
    prompts: string[],
    runId: string,
    parentRunId?: string,
    extraParams?: Record<string, any>,
    tags?: string[],
    metadata?: Record<string, any>,
    runName?: string,
  ): void {
    dontThrow(() =>
      this.startLlm(llm, prompts, "text_completion", runId, parentRunId, {
        extraParams,
        tags,
        metadata,
        runName,
      }),
    );
  }

  public handleLLMEnd(output: any, runId: string): void {
    dontThrow(() => {
      // End the run even if recording the response fails
      try {
        const run = this.runs.get(runId);
        if (run) {
          setResponseAttributes(
            run.span,
            output,
            run.requestModel,
            this.traceContent,
          );
        } else {
          this.recordUnrecordedHandoff(runId, (span, requestModel) =>
            setResponseAttributes(
              span,
              output,
              requestModel,
              this.traceContent,
            ),
          );
        }
      } finally {
        this.endRun(runId);
      }
    });
  }

  public handleLLMError(error: any, runId: string): void {
    dontThrow(() => this.handleError(error, runId));
  }

  public handleToolStart(
    tool: any,
    input: string,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, any>,
    runName?: string,
    toolCallId?: string,
  ): void {
    dontThrow(() => {
      const name = runNameOf(tool, runName);
      const attributes: Record<string, string> = {
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": name,
        "gen_ai.tool.type": "function",
      };
      const description = tool?.description ?? tool?.kwargs?.description;
      if (typeof description === "string" && description) {
        attributes["gen_ai.tool.description"] = description;
      }
      if (typeof toolCallId === "string" && toolCallId) {
        attributes["gen_ai.tool.call.id"] = toolCallId;
      }
      const span = this.startRun(runId, parentRunId, `execute_tool ${name}`, {
        spanType: "TOOL",
        attributes,
        tags,
        metadata,
      });
      if (span && this.traceContent) {
        // LangChain hands tools their input JSON-encoded unless it is a string
        span.setInput(toJson(parseJsonObject(input)));
      }
    });
  }

  public handleToolEnd(output: any, runId: string): void {
    dontThrow(() => {
      try {
        this.setOutput(runId, output);
      } finally {
        this.endRun(runId);
      }
    });
  }

  public handleToolError(error: any, runId: string): void {
    dontThrow(() => this.handleError(error, runId));
  }

  public handleRetrieverStart(
    retriever: any,
    query: string,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, any>,
    runName?: string,
  ): void {
    dontThrow(() => {
      const name = runNameOf(retriever, runName);
      const span = this.startRun(
        runId,
        parentRunId,
        `vector_db_retrieve ${name}`,
        {
          attributes: { "gen_ai.operation.name": "vector_db_retrieve" },
          tags,
          metadata,
        },
      );
      if (span && this.traceContent) {
        span.setInput(toJson(query));
      }
    });
  }

  public handleRetrieverEnd(documents: any, runId: string): void {
    dontThrow(() => {
      try {
        this.setOutput(runId, retrieverOutput(documents));
      } finally {
        this.endRun(runId);
      }
    });
  }

  public handleRetrieverError(error: any, runId: string): void {
    dontThrow(() => this.handleError(error, runId));
  }

  private parentContext(parentRunId?: string): Context {
    return cleanContext(
      this.contextFor(parentRunId) ?? LaminarContextManager.getContext(),
    );
  }

  private startRun(
    runId: string,
    parentRunId: string | undefined,
    name: string,
    {
      spanType = "DEFAULT",
      attributes,
      tags,
      metadata,
      startTime,
    }: {
      spanType?: SpanType;
      attributes?: Record<string, string>;
      tags?: string[];
      metadata?: Record<string, any>;
      startTime?: HrTime;
    },
  ): LaminarSpan | undefined {
    const active = context.active();
    // An open LLM run's own suppression is aimed at provider SDK
    // instrumentations; LangChain runs started under it (a tool the model
    // invokes, code iterating the model's stream) are still recorded.
    if (
      isTracingSuppressed(active) &&
      (active.getValue(LLM_CALL_KEY) as LlmCall | undefined)?.mode !== "own"
    ) {
      return undefined;
    }

    const parentContext = this.parentContext(parentRunId);
    const span = this.startSpan(name, spanType, parentContext, {
      attributes,
      tags,
      metadata,
      startTime,
    });
    const run: Run = {
      span,
      context: trace.setSpan(
        LaminarContextManager.setAssociationProperties(span, parentContext),
        span,
      ),
      children: [],
    };
    if (parentRunId) {
      this.runs.get(parentRunId)?.children.push(runId);
    }
    // A previous run with the same id (should not happen) would leak its span
    const stale = this.runs.get(runId);
    if (stale) {
      this.runs.delete(runId);
      stale.span.end();
    }
    this.runs.set(runId, run);
    return span;
  }

  private startSpan(
    name: string,
    spanType: SpanType,
    parentContext: Context,
    {
      attributes,
      tags,
      metadata,
      startTime,
    }: {
      attributes?: Record<string, string>;
      tags?: string[];
      metadata?: Record<string, any>;
      startTime?: HrTime;
    },
  ): LaminarSpan {
    const span = Laminar.startSpan({
      name,
      spanType,
      context: parentContext,
      startTime,
    }) as LaminarSpan;
    if (attributes) {
      span.setAttributes(attributes);
    }
    if (tags && tags.length > 0) {
      span.setAttribute("langchain.tags", tags);
    }
    const sanitized = sanitizeMetadata(metadata);
    if (Object.keys(sanitized).length > 0) {
      span.setAttribute("langchain.metadata", toJson(sanitized));
    }
    return span;
  }

  private startLlm(
    llm: any,
    input: any[],
    operation: "chat" | "text_completion",
    runId: string,
    parentRunId: string | undefined,
    {
      extraParams,
      tags,
      metadata,
      runName,
    }: {
      extraParams?: Record<string, any>;
      tags?: string[];
      metadata?: Record<string, any>;
      runName?: string;
    },
  ): void {
    const name = runNameOf(llm, runName);
    const call = context.active().getValue(LLM_CALL_KEY) as LlmCall | undefined;
    if (call?.mode === "handoff") {
      // The provider SDK instrumentation records this call, with its
      // provider-specific attributes, as the LLM span. Keep what is needed to
      // record it here instead if it turns out it did not.
      this.handedOff.set(runId, {
        context: this.parentContext(parentRunId),
        call,
        name,
        operation,
        serialized: llm,
        input,
        extraParams,
        tags,
        metadata,
        startTime: hrTime(),
      });
      if (parentRunId) {
        this.runs.get(parentRunId)?.children.push(runId);
      }
      return;
    }

    const span = this.startRun(
      runId,
      parentRunId,
      llmSpanName(name, operation),
      {
        spanType: "LLM",
        attributes: llmAttributes(llm, operation),
        tags,
        metadata,
      },
    );
    if (!span) return;
    const run = this.runs.get(runId)!;
    run.requestModel = this.setLlmRequest(span, {
      serialized: llm,
      input,
      operation,
      extraParams,
      metadata,
    });
  }

  private setLlmRequest(
    span: LaminarSpan,
    {
      serialized,
      input,
      operation,
      extraParams,
      metadata,
    }: {
      serialized: any;
      input: any[];
      operation: "chat" | "text_completion";
      extraParams?: Record<string, any>;
      metadata?: Record<string, any>;
    },
  ): string | undefined {
    const requestModel = setRequestAttributes(
      span,
      serialized,
      metadata,
      extraParams,
      this.traceContent,
    );
    if (operation === "chat") {
      setChatRequest(span, input, this.traceContent);
    } else {
      setCompletionRequest(span, input, this.traceContent);
    }
    return requestModel;
  }

  /**
   * A handed-off LLM run whose provider instrumentation did not record the
   * call (it is disabled, or the integration bundles its own copy of the
   * provider SDK) gets its LangChain span after all, spanning the run.
   */
  private recordUnrecordedHandoff(
    runId: string,
    finish: (span: LaminarSpan, requestModel: string | undefined) => void,
  ): void {
    const pending = this.handedOff.get(runId);
    if (!pending || pending.call.recorded) return;
    const span = this.startSpan(
      llmSpanName(pending.name, pending.operation),
      "LLM",
      pending.context,
      {
        attributes: llmAttributes(pending.serialized, pending.operation),
        tags: pending.tags,
        metadata: pending.metadata,
        startTime: pending.startTime,
      },
    );
    try {
      const requestModel = this.setLlmRequest(span, pending);
      finish(span, requestModel);
    } finally {
      span.end();
    }
  }

  private setOutput(runId: string, output: any): void {
    const run = this.runs.get(runId);
    if (run && this.traceContent) {
      run.span.setOutput(toJson(output));
    }
  }

  private handleError(error: any, runId: string): void {
    const run = this.runs.get(runId);
    if (!run) {
      // A handed-off LLM run has no span (the provider span records the
      // error), but its entry must still go: a failed root call has no parent
      // `endRun` to clear it.
      try {
        this.recordUnrecordedHandoff(runId, (span) => markError(span, error));
      } finally {
        this.handedOff.delete(runId);
      }
      return;
    }
    try {
      markError(run.span, error);
    } finally {
      this.endRun(runId);
    }
  }

  private endRun(runId: string): void {
    this.handedOff.delete(runId);
    const run = this.runs.get(runId);
    if (!run) return;
    this.runs.delete(runId);
    // Children still open when their parent finishes (e.g. a stream that was
    // abandoned) would otherwise never be exported
    for (const childId of run.children) {
      this.endRun(childId);
    }
    run.span.end();
  }
}

const llmSpanName = (
  name: string,
  operation: "chat" | "text_completion",
): string => `${name}.${operation === "chat" ? "chat" : "completion"}`;

const llmAttributes = (
  serialized: any,
  operation: "chat" | "text_completion",
): Record<string, string> => {
  const vendor = detectVendorFromClass(className(serialized));
  return {
    "gen_ai.operation.name": operation,
    "gen_ai.system": vendor,
    "gen_ai.provider.name": vendor,
  };
};

const markError = (span: LaminarSpan, error: any): void => {
  span.setAttribute("error.type", error?.constructor?.name ?? "Error");
  span.recordException(error);
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: error?.message ?? String(error),
  });
};

const parseJsonObject = (input: unknown): unknown => {
  if (typeof input !== "string") return input;
  try {
    const parsed = JSON.parse(input);
    return parsed !== null && typeof parsed === "object" ? parsed : input;
  } catch {
    return input;
  }
};
