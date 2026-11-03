/**
 * The `TelemetryContext` adapter handed to `Harness.open({ telemetry })`, and
 * the Laminar spans it emits.
 *
 * Pi's own spans (`pi.durable.submit`, `pi.durable.phase`, `pi.ai.*`) are
 * never exported. Each one is a `PiSpan` that only carries the RUN it belongs
 * to: an input's `pi.durable.submit` starts a run with a fresh trace id and a
 * pre-chosen root span id, children inherit it, and the injected carrier is
 * that run (W3C `traceparent` plus the run's start time). Pi stores the
 * carrier on submissions and tasks, so phases resumed after a restart, in a
 * new process, extract the same run and continue the same trace.
 *
 * The visible spans are synthesized when their work ends, with explicit start
 * times: LLM and TOOL spans by the hooks (`index.ts`), the run root when Pi
 * settles the run's input. The root is created last, with the span id every
 * child already names as its parent. Whichever process sees the run settle
 * exports it, so a resumed run still has exactly one root.
 */
import { randomBytes } from "node:crypto";

import { errorMessage } from "@lmnr-ai/types";
import {
  context as otelContext,
  ROOT_CONTEXT,
  type Span,
  TraceFlags,
  type Tracer,
  type TracerProvider,
  trace,
} from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";

import { version as SDK_VERSION } from "../../../../package.json";
import {
  initializeLogger,
  metadataToAttributes,
  otelSpanIdToUUID,
  toJson,
  toJsonOrString,
} from "../../../utils";
import {
  GEN_AI_INPUT_MESSAGES,
  GEN_AI_OUTPUT_MESSAGES,
  GEN_AI_TOOL_DEFINITIONS,
  PARENT_SPAN_IDS_PATH,
  PARENT_SPAN_PATH,
  SESSION_ID,
  SPAN_IDS_PATH,
  SPAN_INPUT,
  SPAN_OUTPUT,
  SPAN_PATH,
  SPAN_TYPE,
  USER_ID,
} from "../../tracing/attributes";
import { getSpanProcessor, getTracerProvider } from "../../tracing/index";
import type { LaminarSpanProcessor } from "../../tracing/processor";
import { instrumentationScopeAttributes } from "../shared/base";
import { recordSpanError, safely, safeSetAttribute } from "../shared/utils";
import {
  buildInputMessages,
  buildOutputMessage,
  buildToolDefinitions,
  contentText,
  contentToBlocks,
  costAttributes,
  currentTools,
  inferVendor,
  usageAttributes,
} from "./messages";
import type {
  PiAssistantMessage,
  PiContext,
  PiHookApi,
  PiMessage,
  PiSpanAttributes,
  PiSpanOptions,
  PiSpanStatus,
  PiTelemetryCarrier,
  PiTelemetryContext,
  PiTelemetryPropagation,
  PiTelemetrySpan,
  PiToolExecutionResult,
  PiToolHookCall,
} from "./types";

const logger = initializeLogger();

export const PI_DURABLE = "@earendil-works/pi-durable";

const TRACEPARENT = "traceparent";
/** Carrier key holding the run's start, epoch ms, for a root exported elsewhere. */
const RUN_START = "lmnr-pi-run-start";
const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;

/** Runs tracked at once. An abandoned run is dropped, unexported, past this. */
const MAX_RUNS = 1000;
/** Ended runs remembered, so a late settlement never exports a second root. */
const MAX_ENDED = 1000;

/** `pi.provider`: the conversation's persisted provider session id (UUIDv7). */
const PROVIDER_DOC = {
  definition: {
    kind: "pi.provider",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "initial",
  },
};

export interface PiDurableConversationInfo {
  /** Pi's conversation id; unique within one storage only. */
  conversationId: number;
  /**
   * Pi's per-conversation provider session id (a UUIDv7 stored in
   * `pi.provider`). It survives restarts, so it is the default session id.
   */
  providerSessionId?: string;
}

export interface PiDurableSpanNames {
  /** Root span of a run. Defaults to `"pi.run"`. */
  run?: string;
  /** LLM span of a model request. Defaults to `"pi.chat"`. */
  llm?: string | ((model: { provider?: string; model?: string }) => string);
  /** TOOL span of a tool call. Defaults to the tool name. */
  tool?: string | ((toolName: string) => string);
}

export interface PiDurableTracerOptions {
  /**
   * Laminar session id of every span. Defaults to Pi's per-conversation
   * provider session id, so a conversation's runs form one session.
   */
  sessionId?:
    | string
    | ((info: PiDurableConversationInfo) => string | undefined);
  /** Laminar user id of every span. */
  userId?: string | ((info: PiDurableConversationInfo) => string | undefined);
  /** Laminar metadata of every span. */
  metadata?: Record<string, unknown>;
  spanNames?: PiDurableSpanNames;
  /**
   * The system prompt reported on LLM spans. By default it is replayed from
   * the request's `role: "system"` messages, which carry Pi's sections and
   * tool changes; pass this when the host wants to report another text.
   */
  systemPrompt?: (info: PiDurableConversationInfo) => string | undefined;
  /**
   * Where spans go. Defaults to the provider of `Laminar.initialize()`,
   * resolved when each span is created.
   */
  tracerProvider?: TracerProvider;
  /**
   * The processor of `tracerProvider` when it is a `LaminarSpanProcessor`,
   * so a root's path cache entry can be dropped. Internal.
   */
  spanProcessor?: LaminarSpanProcessor;
}

interface RunAnchor {
  readonly traceId: string;
  readonly spanId: string;
  /** Epoch ms of the input's submission. */
  readonly startTime: number;
}

interface RunState {
  readonly anchor: RunAnchor;
  conversationId?: number;
  /** Submission ids of the run's inputs, when this process saw them. */
  readonly inputs: Set<number>;
  input?: string;
  output?: string;
  /** The newest model error; cleared by a later successful response. */
  modelError?: string;
  providerSessionId?: string;
  sessionResolved?: boolean;
}

interface PendingLlm {
  readonly startTime: number;
  readonly messages: readonly PiMessage[];
}

interface PendingTool {
  readonly startTime: number;
}

const randomHex = (bytes: number): string => {
  let hex = "";
  // An all-zero id is invalid in W3C trace context.
  while (!/[1-9a-f]/.test(hex)) hex = randomBytes(bytes).toString("hex");
  return hex;
};

/**
 * One of Pi's spans: never exported, it carries the run it belongs to and the
 * hook state of one phase invocation.
 */
export class PiSpan implements PiTelemetrySpan {
  readonly startTime = Date.now();
  readonly attributes: PiSpanAttributes = {};
  status?: PiSpanStatus;
  settled = false;
  /** A model request started by `beforeRequest` in this phase. */
  llm?: PendingLlm;
  /** Tool calls started by `beforeTool` in this phase, by call id. */
  readonly tools = new Map<string, PendingTool>();

  constructor(
    readonly owner: PiDurableTracer,
    readonly name: string,
    attributes: PiSpanAttributes | undefined,
    readonly anchor: RunAnchor | undefined,
  ) {
    Object.assign(this.attributes, attributes);
  }

  get propagation(): PiTelemetryPropagation {
    return this.owner.propagation;
  }

  startSpan<T>(
    options: PiSpanOptions,
    callback: (span: PiTelemetrySpan) => T | Promise<T>,
  ): Promise<T> {
    return this.owner.runSpan(options, this.anchor, callback);
  }

  addLink(): void {
    // Links point at other runs' submissions; Laminar has no span links.
  }

  addEvent(name: string, attributes?: PiSpanAttributes): void {
    if (this.settled || name !== "pi.durable.submission") return;
    safely(() => this.owner.onSettlement(this, attributes ?? {}));
  }

  setAttributes(attributes: PiSpanAttributes): void {
    if (this.settled) return;
    for (const [key, value] of Object.entries(attributes)) {
      if (value !== undefined) this.attributes[key] = value;
    }
    const id = attributes["submission.id"];
    if (this.name === "pi.durable.submit" && typeof id === "number") {
      safely(() => this.owner.runFor(this)?.inputs.add(id));
    }
  }

  setStatus(status: PiSpanStatus): void {
    if (!this.settled) this.status = status;
  }
}

const valueFor = (
  option:
    | string
    | ((info: PiDurableConversationInfo) => string | undefined)
    | undefined,
  info: PiDurableConversationInfo,
): string | undefined =>
  typeof option === "function"
    ? safely(() => option(info))
    : (option ?? undefined);

/**
 * The adapter and its span pipeline. One instance serves any number of
 * Harnesses; runs are keyed by their trace id.
 */
export class PiDurableTracer implements PiTelemetryContext {
  readonly propagation: PiTelemetryPropagation;
  private readonly runs = new Map<string, RunState>();
  private readonly ended = new Set<string>();
  private warnedNotRecording = false;

  constructor(readonly options: PiDurableTracerOptions = {}) {
    this.propagation = {
      inject: (context) => safely(() => this.inject(context)),
      extract: (carrier) => safely(() => this.extract(carrier)) ?? this,
    };
  }

  startSpan<T>(
    options: PiSpanOptions,
    callback: (span: PiTelemetrySpan) => T | Promise<T>,
  ): Promise<T> {
    const type = options.attributes?.["submission.type"];
    const startsRun =
      options.name === "pi.durable.submit" &&
      (type === "input" || type === "continue");
    return this.runSpan(
      options,
      startsRun ? this.newAnchor() : undefined,
      callback,
    );
  }

  /**
   * The callback runs synchronously, exactly once, and its value or
   * rejection is returned as is.
   *
   * Generation phases run with tracing suppressed: pi-ai calls the OpenAI /
   * Anthropic / Google SDKs inside them, and Laminar's instrumentations of
   * those SDKs would add a second LLM span per request. It has to be the
   * phase: pi-ai's own `pi.ai.request` callback only awaits a promise, while
   * the SDK call runs outside it. Our spans take explicit parent contexts, so
   * the suppression doesn't touch them.
   */
  runSpan<T>(
    options: PiSpanOptions,
    anchor: RunAnchor | undefined,
    callback: (span: PiTelemetrySpan) => T | Promise<T>,
  ): Promise<T> {
    const span = new PiSpan(this, options.name, options.attributes, anchor);
    let result: T | Promise<T>;
    try {
      const suppress =
        options.name === "pi.durable.phase" &&
        options.attributes?.["task.name"] === "pi.generation";
      result = suppress
        ? otelContext.with(suppressTracing(otelContext.active()), () =>
            callback(span),
          )
        : callback(span);
    } catch (error) {
      result = Promise.reject(error);
    }
    return Promise.resolve(result).finally(() => {
      span.settled = true;
    });
  }

  private newAnchor(): RunAnchor {
    return {
      traceId: randomHex(16),
      spanId: randomHex(8),
      startTime: Date.now(),
    };
  }

  private inject(context: PiTelemetryContext): PiTelemetryCarrier | undefined {
    const anchor = context instanceof PiSpan ? context.anchor : undefined;
    if (!anchor) return undefined;
    return {
      [TRACEPARENT]: `00-${anchor.traceId}-${anchor.spanId}-01`,
      [RUN_START]: String(anchor.startTime),
    };
  }

  private extract(
    carrier: PiTelemetryCarrier | undefined,
  ): PiTelemetryContext | undefined {
    const match = TRACEPARENT_RE.exec(carrier?.[TRACEPARENT] ?? "");
    if (!match) return undefined;
    const startTime = Number(carrier?.[RUN_START]);
    const anchor: RunAnchor = {
      traceId: match[1],
      spanId: match[2],
      startTime: Number.isFinite(startTime) ? startTime : Date.now(),
    };
    return new PiSpan(this, "extracted", undefined, anchor);
  }

  /** The state of `span`'s run, created on first use; none once it ended. */
  runFor(span: PiSpan): RunState | undefined {
    const anchor = span.anchor;
    if (!anchor || this.ended.has(anchor.traceId)) return undefined;
    let run = this.runs.get(anchor.traceId);
    if (!run) {
      if (this.runs.size >= MAX_RUNS) {
        this.runs.delete(this.runs.keys().next().value!);
      }
      run = { anchor, inputs: new Set() };
      const conversationId = span.attributes["conversation.id"];
      if (typeof conversationId === "number") {
        run.conversationId = conversationId;
      }
      this.runs.set(anchor.traceId, run);
    }
    return run;
  }

  /**
   * `pi.durable.submission` on a generation phase (or on a continue's submit
   * span, which can end a run without a request). An input's settlement ends
   * its run right away: `Submission.wait()` resolves at this commit, and a
   * host that flushes then must already find the root. Writes placed at a
   * boundary settle `done` without an answer, and are ignored.
   */
  onSettlement(span: PiSpan, attributes: PiSpanAttributes): void {
    const isGeneration =
      span.name === "pi.durable.phase"
        ? span.attributes["task.name"] === "pi.generation"
        : span.name === "pi.durable.submit";
    if (!isGeneration) return;
    const status = attributes.status;
    if (status !== "unanswered" && attributes["answer.entry_id"] === undefined)
      return;
    const run = this.runFor(span);
    if (!run) return;
    const id = attributes["submission.id"];
    if (run.inputs.size > 0 && typeof id === "number" && !run.inputs.has(id))
      return;
    this.endRun(run, status === "unanswered");
  }

  private endRun(run: RunState, unanswered: boolean): void {
    const { traceId, spanId, startTime } = run.anchor;
    if (this.ended.has(traceId)) return;
    this.runs.delete(traceId);
    this.ended.add(traceId);
    if (this.ended.size > MAX_ENDED) {
      this.ended.delete(this.ended.values().next().value!);
    }

    const root = this.tracer().startSpan(
      this.runName,
      { startTime, root: true },
      ROOT_CONTEXT,
    );
    if (!root.isRecording()) {
      this.warnNotRecording();
      return;
    }
    // Stamp the run's pre-chosen ids over the SDK's, as the Mastra exporter
    // does: every child already names this span as its parent. `spanContext()`
    // returns the object the SDK exports from.
    const generated = root.spanContext().spanId;
    Object.assign(root.spanContext(), { traceId, spanId });
    if (generated !== spanId) this.processor()?.dropPathInfo(generated);
    root.setAttributes({
      [SPAN_PATH]: [this.runName],
      [SPAN_IDS_PATH]: [otelSpanIdToUUID(spanId)],
      [SPAN_TYPE]: "DEFAULT",
      ...this.commonAttributes(run),
    });
    if (run.conversationId !== undefined) {
      root.setAttribute("pi.conversation.id", run.conversationId);
    }
    safeSetAttribute(root, SPAN_INPUT, run.input);
    if (unanswered) {
      recordSpanError(root, run.modelError ?? "Run ended without an answer");
    } else {
      safeSetAttribute(root, SPAN_OUTPUT, run.output);
    }
    root.end();
  }

  /** Read the conversation's provider session id once per run, if needed. */
  async resolveConversation(
    run: RunState,
    api: PiHookApi,
    context: PiContext,
  ): Promise<void> {
    run.conversationId ??= api.conversationId;
    if (run.sessionResolved) return;
    run.sessionResolved = true;
    const { sessionId, userId } = this.options;
    if (typeof sessionId === "string" && typeof userId !== "function") return;
    try {
      const doc = (await api.snapshot(
        PROVIDER_DOC,
        api.conversationId,
        context,
      )) as { sessionId?: unknown } | undefined;
      if (typeof doc?.sessionId === "string" && doc.sessionId) {
        run.providerSessionId = doc.sessionId;
      }
    } catch (error) {
      logger.debug(
        `Failed to read Pi's provider session id: ${errorMessage(error)}`,
      );
    }
  }

  private info(run: RunState): PiDurableConversationInfo {
    return {
      conversationId: run.conversationId ?? 0,
      providerSessionId: run.providerSessionId,
    };
  }

  private commonAttributes(run: RunState): Record<string, any> {
    const info = this.info(run);
    const sessionId =
      this.options.sessionId === undefined
        ? run.providerSessionId
        : valueFor(this.options.sessionId, info);
    const userId = valueFor(this.options.userId, info);
    return {
      ...instrumentationScopeAttributes(PI_DURABLE),
      ...(this.options.metadata
        ? metadataToAttributes(this.options.metadata)
        : {}),
      ...(sessionId ? { [SESSION_ID]: sessionId } : {}),
      ...(userId ? { [USER_ID]: userId } : {}),
    };
  }

  private get runName(): string {
    return this.options.spanNames?.run ?? "pi.run";
  }

  /** A child of the run root, started at `startTime`. */
  private startChild(
    run: RunState,
    name: string,
    startTime: number,
    spanType: "LLM" | "TOOL",
  ): Span | undefined {
    const { traceId, spanId } = run.anchor;
    const parent = trace.setSpanContext(ROOT_CONTEXT, {
      traceId,
      spanId,
      traceFlags: TraceFlags.SAMPLED,
      isRemote: true,
    });
    const span = this.tracer().startSpan(
      name,
      {
        startTime,
        // Read by LaminarSpanProcessor.onStart: the root is not a live span
        // in this process, so its path can't come from the processor's cache.
        attributes: {
          [PARENT_SPAN_PATH]: [this.runName],
          [PARENT_SPAN_IDS_PATH]: [otelSpanIdToUUID(spanId)],
        },
      },
      parent,
    );
    if (!span.isRecording()) {
      this.warnNotRecording();
      return undefined;
    }
    // After start: these win over association properties the processor
    // copies from whatever context is active.
    span.setAttributes({
      [SPAN_TYPE]: spanType,
      ...this.commonAttributes(run),
    });
    return span;
  }

  /** `afterResponse`: one LLM span per terminal provider message. */
  emitLlm(phase: PiSpan, run: RunState, message: PiAssistantMessage): void {
    const pending = phase.llm;
    phase.llm = undefined;

    const stop = message.stopReason;
    if (stop === "error") {
      run.modelError = message.errorMessage ?? "Model request failed";
    } else if (stop !== "aborted") {
      run.modelError = undefined;
      if (stop !== "toolUse") run.output = contentText(message.content);
    }

    const llmName = this.options.spanNames?.llm;
    const name =
      typeof llmName === "function"
        ? (safely(() =>
            llmName({ provider: message.provider, model: message.model }),
          ) ?? "pi.chat")
        : (llmName ?? "pi.chat");
    const span = this.startChild(
      run,
      name,
      pending?.startTime ?? phase.startTime,
      "LLM",
    );
    if (!span) return;

    span.setAttributes({
      "gen_ai.system": inferVendor(message.model, message.provider),
      ...usageAttributes(message.usage),
      ...costAttributes(message.usage),
    });
    safeSetAttribute(span, "gen_ai.provider.name", message.provider);
    safeSetAttribute(span, "gen_ai.request.model", message.model);
    safeSetAttribute(
      span,
      "gen_ai.response.model",
      message.responseModel ?? message.model,
    );
    safeSetAttribute(span, "gen_ai.response.id", message.responseId);
    if (stop) span.setAttribute("gen_ai.response.finish_reasons", [stop]);

    if (pending) {
      const systemPrompt = this.options.systemPrompt
        ? safely(() => this.options.systemPrompt!(this.info(run)))
        : undefined;
      safeSetAttribute(
        span,
        GEN_AI_INPUT_MESSAGES,
        toJson(buildInputMessages(pending.messages, systemPrompt)),
      );
      const tools = currentTools(pending.messages);
      if (tools.length > 0) {
        safeSetAttribute(
          span,
          GEN_AI_TOOL_DEFINITIONS,
          toJson(buildToolDefinitions(tools)),
        );
      }
    }
    safeSetAttribute(
      span,
      GEN_AI_OUTPUT_MESSAGES,
      toJson([buildOutputMessage(message)]),
    );

    if (stop === "error") {
      recordSpanError(span, message.errorMessage ?? "Model request failed");
    } else if (stop === "aborted") {
      recordSpanError(span, message.errorMessage ?? "Model request aborted");
    }
    span.end();
  }

  /**
   * `afterTool`: one TOOL span per result. A tool resumed after a restart
   * skips `beforeTool`, so the span then starts with the resumed phase.
   */
  emitTool(
    phase: PiSpan,
    run: RunState,
    call: PiToolHookCall,
    result: PiToolExecutionResult,
  ): void {
    const pending = phase.tools.get(call.id);
    phase.tools.delete(call.id);
    const toolName = this.options.spanNames?.tool;
    const name =
      typeof toolName === "function"
        ? (safely(() => toolName(call.name)) ?? call.name)
        : (toolName ?? call.name);
    const span = this.startChild(
      run,
      name,
      pending?.startTime ?? phase.startTime,
      "TOOL",
    );
    if (!span) return;
    safeSetAttribute(span, "gen_ai.tool.name", call.name);
    safeSetAttribute(span, "gen_ai.tool.call.id", call.id);
    safeSetAttribute(span, SPAN_INPUT, toJson(call.arguments));

    const output = result.output ?? [];
    const text = output.every((block) => block?.type === "text")
      ? contentText(output)
      : undefined;
    safeSetAttribute(
      span,
      SPAN_OUTPUT,
      text ??
        toJsonOrString(contentToBlocks(output)) ??
        toJsonOrString(result.structuredOutput),
    );
    if (result.isError) {
      const diagnostic = result.diagnostics?.find((d) => d?.message)?.message;
      recordSpanError(span, diagnostic || text || "Tool call failed");
    }
    span.end();
  }

  private tracer(): Tracer {
    const provider = this.options.tracerProvider ?? getTracerProvider();
    return provider.getTracer("@lmnr-ai/lmnr", SDK_VERSION);
  }

  private processor(): LaminarSpanProcessor | undefined {
    if (this.options.tracerProvider) return this.options.spanProcessor;
    return getSpanProcessor();
  }

  private warnNotRecording(): void {
    if (this.warnedNotRecording) return;
    this.warnedNotRecording = true;
    logger.warn(
      "Laminar pi-durable spans are not recorded. Call Laminar.initialize() " +
        "or pass `projectApiKey` / `tracerProvider` to laminarPiDurable().",
    );
  }
}

export const isPiSpanWithRun = (value: unknown): value is PiSpan =>
  value instanceof PiSpan && value.anchor !== undefined;
