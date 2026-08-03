import { LaminarClient } from "@lmnr-ai/client";
import {
  errorMessage,
  type LaminarSpanContext,
  type StringUUID,
} from "@lmnr-ai/types";
import {
  ROOT_CONTEXT,
  type Span,
  trace,
  type Tracer,
} from "@opentelemetry/api";
import {
  BasicTracerProvider,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";

import { LaminarSpanProcessor } from "../opentelemetry-lib";
import {
  SPAN_INPUT,
  SPAN_OUTPUT,
  SPAN_TYPE,
  TRACE_TYPE,
} from "../opentelemetry-lib/tracing/attributes";
import { LaminarContextManager } from "../opentelemetry-lib/tracing/context";
import {
  getFrontendUrl,
  initializeLogger,
  metadataToAttributes,
  otelSpanIdToUUID,
  otelTraceIdToUUID,
} from "../utils";

const logger = initializeLogger();

const EVE_REPORTER_TRACER_NAME = "@lmnr-ai/lmnr/eve-reporter";
const EVE_CLIENT_MODULE = "eve/client";
const TRACEPARENT_HEADER = "traceparent";
const LAMINAR_SPAN_CONTEXT_HEADER = "laminar-span-context";
/**
 * Root span name for every propagated eval, and it never changes. eve calls
 * `ClientSession.send` before any hook that knows which eval is in flight, and
 * eve exposes no `onEvalStart`, so the id simply is not knowable here. Renaming
 * the span later would invalidate the `lmnr.span.path` the processor already
 * stamped on it and on every descendant, and would make the path we propagate
 * to the agent stale. The eval id rides on `lmnr.eve.eval.id`, on the trace
 * metadata, and on the datapoint instead.
 */
const ROOT_SPAN_NAME = "eve eval";
const EXECUTOR_SPAN_NAME = "executor";

/**
 * Narrow local mirrors of eve's `eve/evals` types. We intentionally do NOT
 * import from `eve` so the SDK carries no peer dependency on it (same pattern
 * as the Mastra exporter). The fields mirror eve 0.22.x; every field a reporter
 * reads is optional so a shape change on eve's side degrades gracefully instead
 * of throwing. Array fields must stay `readonly` — eve's own types are
 * readonly, and a mutable mirror is not assignable to them (TS2322 for users
 * registering the reporter).
 */
export interface EveEval {
  /** Path-derived stable id of the eval, e.g. "brooklyn-forecast". */
  id?: string;
  description?: string;
  metadata?: Record<string, any>;
}

export interface EveEvalTarget {
  /** "local" for a dev server the runner boots, "remote" for a deployment. */
  kind?: string;
  /** Base HTTP URL the eval client connects to. */
  url?: string;
  [key: string]: any;
}

/** How a failing assertion affects the verdict. */
export type EveAssertionSeverity = "gate" | "soft";

/** The recorded outcome of one assertion eve ran against an eval. */
export interface EveAssertionResult {
  name?: string;
  /** Score in [0, 1]; boolean assertions score exactly 0 or 1. */
  score?: number;
  /** "gate" (hard) or "soft" (tracked / thresholded). */
  severity?: EveAssertionSeverity;
  threshold?: number;
  passed?: boolean;
  /** Human-readable failure detail. */
  message?: string;
  metadata?: Record<string, any>;
}

/** One tool call eve extracted from the captured stream. */
export interface EveEvalToolCall {
  name?: string;
  [key: string]: any;
}

/** Execution facts eve derives from a completed session's stream. */
export interface EveEvalDerivedFacts {
  toolCalls?: readonly EveEvalToolCall[];
  toolCallCount?: number;
  subagentCallCount?: number;
  messageCount?: number;
  reasoningBlockCount?: number;
  parked?: boolean;
  failureCode?: string;
}

/** Runtime identity eve captures from the `session.started` stream event. */
export interface EveRuntimeIdentity {
  agentId?: string;
  agentName?: string;
  eveVersion?: string;
  modelId?: string;
}

/** Result of executing one eval against an eve agent. */
export interface EveEvalTaskResult {
  /** Final structured data, or the last assistant message when absent. */
  output?: any;
  /** The agent's last assistant message, or null when none was produced. */
  finalMessage?: string | null;
  /** eve session id after the first successful send. */
  sessionId?: string;
  /** How the run's final turn ended. */
  status?: "completed" | "failed" | "waiting";
  logs?: readonly string[];
  derived?: EveEvalDerivedFacts;
  runtimeIdentity?: EveRuntimeIdentity;
}

/** Per-eval verdict computed by the runner. */
export type EveEvalVerdict = "passed" | "failed" | "scored" | "skipped";

/** Result of executing and asserting one eval. eve hands this to reporters. */
export interface EveEvalResult {
  /** Path-derived eval id (e.g. "weather"). */
  id?: string;
  /** Execution result (output, session, derived facts). */
  result?: EveEvalTaskResult;
  /** Every assertion recorded by the eval's `test(t)`, in record order. */
  assertions?: readonly EveAssertionResult[];
  /** Per-eval verdict. */
  verdict?: EveEvalVerdict;
  /** Execution error message, when the eval threw. */
  error?: string;
  /** Reason supplied to `t.skip(reason)`. */
  skipReason?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface EveEvalRunSummary {
  total?: number;
  passed?: number;
  failed?: number;
  scored?: number;
  skipped?: number;
  errored?: number;
  [key: string]: any;
}

/**
 * The contract eve invokes. Mirrors `EvalReporter` from `eve/evals/reporters`.
 */
export interface EvalReporter {
  onRunStart(
    evaluations: readonly EveEval[],
    target: EveEvalTarget,
  ): void | Promise<void>;
  onEvalComplete(result: EveEvalResult): void | Promise<void>;
  onRunComplete(summary: EveEvalRunSummary): void | Promise<void>;
}

export interface LaminarReporterOptions {
  /** Name of the Laminar evaluation created for the run. */
  name?: string;
  /** Group name to chart regressions across runs of the same eval suite. */
  groupName?: string;
  /** Metadata attached to the Laminar evaluation. */
  metadata?: Record<string, any>;
  /** Project API key. Falls back to `LMNR_PROJECT_API_KEY`. */
  projectApiKey?: string;
  /** Override the Laminar API base URL (e.g. for self-hosted). */
  baseUrl?: string;
  /**
   * Provide a pre-constructed client (e.g. to share auth across reporters).
   * When set, `projectApiKey` / `baseUrl` are ignored.
   */
  client?: LaminarClient;
  /**
   * Override the reporter's span processor. Intended for tests; production
   * defaults to a Laminar span processor using the reporter credentials.
   */
  spanProcessor?: SpanProcessor;
  /**
   * Mint the trace in the runner and push it to the agent as a `traceparent`
   * header (see {@link patchEveClientSession}). Defaults to `true`. Set `false`
   * only to disable the patch — every datapoint then links to a reporter-owned
   * trace that holds the grade but none of the agent's work.
   */
  propagateTraceContext?: boolean;
}

// ─── Trace-context propagation ────────────────────────────────────────────────
// The runner MINTS the trace: before eve's client sends a turn, the reporter
// opens the eval's root Laminar span and injects its W3C `traceparent` into the
// request headers. eve's agent adopts it as the parent of the turn when
// `agent/instrumentation.ts` sets `traceChannelRequests: true`, so the datapoint
// needs no lookup at all.

/** The subset of eve's `MessageResponse` the patch reads. */
interface EveMessageResponse {
  readonly sessionId?: string;
}

/** The subset of eve's `SendTurnPayload` the patch rewrites. */
interface EveSendTurnPayload {
  headers?: Record<string, string>;
  [key: string]: unknown;
}

type EveSend = (this: object, input: unknown) => Promise<EveMessageResponse>;

/** The subset of eve's `ClientSession` class the patch needs. */
export interface EveClientSessionClass {
  prototype: object & { send?: EveSend };
}

/** One eve client session's Laminar trace, minted on its first `send`. */
interface EveSessionTrace {
  /** Laminar trace id every span and the datapoint share. */
  traceId: StringUUID;
  /** Root EVALUATION span; the Laminar trace's root. */
  rootSpan: Span;
  /** EXECUTOR child the agent's turn hangs off; the `traceparent` parent. */
  executorSpan: Span;
  /** Tracer used for the EVALUATOR children created at grade time. */
  tracer: Tracer;
  /** Headers merged into every `send` on this client session. */
  headers: Record<string, string>;
  /** eve session ids this client session reported. */
  sessionIds: Set<string>;
  ended: boolean;
}

/** Prototypes already patched — `send` must never be wrapped twice. */
const patchedSendPrototypes = new WeakSet<object>();
/**
 * Per-eve-client-session state. Keyed off the `ClientSession` instance rather
 * than an AsyncLocalStorage frame or a "current eval" global: eve runs up to
 * `maxConcurrency` evals at once, and each eval builds its own `ClientSession`
 * (`EvalSessionManager` calls `client.session()` per `EvalSessionDriver`), so
 * the instance is the only correct correlation key available inside `send`.
 */
const traceByClientSession = new WeakMap<object, EveSessionTrace>();
/** eve session id -> trace, read by `onEvalComplete` via `result.sessionId`. */
const traceByEveSessionId = new Map<string, EveSessionTrace>();
/** Set by the running reporter's `onRunStart`; cleared by `onRunComplete`. */
let activeSessionTraceFactory: (() => EveSessionTrace | undefined) | null = null;

/** Mirrors eve's own `normalizeSendTurnInput`, then merges the trace headers. */
const withTraceHeaders = (
  input: unknown,
  headers: Record<string, string>,
): EveSendTurnPayload => {
  const payload: EveSendTurnPayload = typeof input === "string"
    ? { message: input }
    : { ...(input as EveSendTurnPayload) };
  payload.headers = { ...(payload.headers ?? {}), ...headers };
  return payload;
};

const openSessionTrace = (
  clientSession: object,
): EveSessionTrace | undefined => {
  try {
    const existing = traceByClientSession.get(clientSession);
    if (existing) {
      return existing;
    }
    const minted = activeSessionTraceFactory?.();
    if (minted) {
      traceByClientSession.set(clientSession, minted);
    }
    return minted;
  } catch (error) {
    logger.warn(
      `Laminar eve reporter: failed to open a session trace: ` +
      errorMessage(error),
    );
    return undefined;
  }
};

/**
 * eve assigns the session id on the POST that `send` awaits, so the returned
 * `MessageResponse` is the earliest place the runner can bind the eve session
 * id to the trace it minted.
 */
const recordEveSessionId = (
  response: EveMessageResponse | undefined,
  sessionTrace: EveSessionTrace,
): void => {
  const sessionId = response?.sessionId;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return;
  }
  sessionTrace.sessionIds.add(sessionId);
  traceByEveSessionId.set(sessionId, sessionTrace);
};

/**
 * Build the propagation headers for the EXECUTOR span. Plain HTTP strings — eve
 * forwards `SendTurnPayload.headers` verbatim to `fetch`.
 *
 * The Laminar context carries the full path. Laminar nests spans by
 * `lmnr.span.ids_path`, not by OTel `parentSpanId`, so a receiver that adopts
 * only the ids lands its spans as a second root on our trace. The path is what
 * makes the agent's subtree render UNDER the executor. Both paths are constants
 * here — neither the root nor the executor span is ever renamed.
 */
const buildTraceHeaders = (
  rootSpan: Span,
  executorSpan: Span,
): Record<string, string> => {
  const spanContext = executorSpan.spanContext();
  const laminarContext: LaminarSpanContext = {
    traceId: otelTraceIdToUUID(spanContext.traceId),
    spanId: otelSpanIdToUUID(spanContext.spanId) as StringUUID,
    isRemote: true,
    spanPath: [ROOT_SPAN_NAME, EXECUTOR_SPAN_NAME],
    spanIdsPath: [
      otelSpanIdToUUID(rootSpan.spanContext().spanId) as StringUUID,
      otelSpanIdToUUID(spanContext.spanId) as StringUUID,
    ],
  };
  return {
    // eve reads ONLY `traceparent` (see its `traceChannelRequest`).
    [TRACEPARENT_HEADER]:
      `00-${spanContext.traceId}-${spanContext.spanId}-01`,
    // For Laminar-aware agents; eve ignores it.
    [LAMINAR_SPAN_CONTEXT_HEADER]: JSON.stringify(laminarContext),
  };
};

/**
 * Bind this session's ROOT span into the calling eval's async context, so work
 * the eval does in the RUNNER process after `send` resolves lands on this trace
 * instead of opening its own. The concrete case is `t.judge.autoevals.*`: eve
 * runs the judge's model call in the runner, and Laminar's AI SDK integration
 * parents it to `LaminarContextManager.getContext()`.
 *
 * The root — not a pre-opened judge span — is the binding target on purpose.
 * An eval may record any number of judge assertions, and each one runs its own
 * model call. Binding the root gives every judge its own child of the root; a
 * single pre-opened parent would collect all of them under whichever judge
 * happened to run first.
 *
 * `pushContext` uses `AsyncLocalStorage.enterWith`, so this MUST run
 * synchronously before `send`'s first `await` — at that point we are still
 * executing in the caller's async context, so the store we set is the one
 * `test(t)` continues with. Each eval's `test(t)` runs in its own async chain,
 * so concurrent evals never see each other's root span; do NOT replace this
 * with the process-global context stack, which would cross-attribute.
 *
 * Judge spans reach Laminar only when the runner opts in — `Laminar.initialize()`
 * plus a globally registered AI SDK telemetry integration. Without that the
 * binding is inert, never wrong.
 *
 * Never popped: the store dies with the eval's async chain.
 */
const bindEvalContext = (sessionTrace: EveSessionTrace): void => {
  try {
    LaminarContextManager.pushContext(
      trace.setSpan(ROOT_CONTEXT, sessionTrace.rootSpan),
    );
  } catch (error) {
    logger.warn(
      `Laminar eve reporter: failed to bind the eval context: ` +
      errorMessage(error),
    );
  }
};

/**
 * Wrap `ClientSession.prototype.send` so every eve turn carries the trace
 * context of a runner-minted Laminar span. Idempotent per prototype.
 *
 * @internal Exported for tests, which drive it with a stub class so the suite
 * keeps no dependency on eve.
 */
export const patchEveClientSession = (
  sessionClass: EveClientSessionClass | undefined,
): boolean => {
  const prototype = sessionClass?.prototype;
  const original = prototype?.send;
  if (!prototype || typeof original !== "function") {
    return false;
  }
  if (patchedSendPrototypes.has(prototype)) {
    return true;
  }
  // A prototype method needs a real `this`, so this cannot be an arrow.
  prototype.send = async function (this: object, input: unknown) {
    const sessionTrace = openSessionTrace(this);
    if (!sessionTrace) {
      return original.call(this, input);
    }
    bindEvalContext(sessionTrace);
    const response = await original.call(
      this,
      withTraceHeaders(input, sessionTrace.headers),
    );
    try {
      recordEveSessionId(response, sessionTrace);
    } catch (error) {
      logger.warn(
        `Laminar eve reporter: failed to record the eve session id: ` +
        errorMessage(error),
      );
    }
    return response;
  };
  patchedSendPrototypes.add(prototype);
  return true;
};

/**
 * Load eve's `ClientSession` without depending on eve. Mirrors the guarded
 * dynamic import in eve's own Braintrust reporter (`loadBraintrustSdk`), except
 * a missing eve degrades instead of throwing — the reporter must keep working
 * when it is registered outside an eve run.
 */
const loadEveClientSession = async (): Promise<
  EveClientSessionClass | undefined
> => {
  try {
    const module = await import(EVE_CLIENT_MODULE) as {
      ClientSession?: unknown;
    };
    const sessionClass = module.ClientSession;
    return typeof sessionClass === "function"
      ? sessionClass
      : undefined;
  } catch {
    return undefined;
  }
};

const didAssertionPass = (assertion: EveAssertionResult): boolean => {
  if (typeof assertion.passed === "boolean") {
    return assertion.passed;
  }
  // Degradation path: eve's real AssertionResult always carries `passed`, so
  // this only runs when eve's shape drifted. Infer from score semantics rather
  // than defaulting to passed — a failed gate must never read as a pass.
  if (typeof assertion.score === "number") {
    if (typeof assertion.threshold === "number") {
      return assertion.score >= assertion.threshold;
    }
    if (assertion.severity === "gate") {
      // Gates score exactly 0 or 1.
      return assertion.score > 0;
    }
  }
  return true;
};

/**
 * Keep Laminar's top-level score columns stable across heterogeneous eve evals.
 * Detailed assertion outcomes live in metadata; sparse per-assertion score keys
 * make Laminar's eval UI look incomplete when different eval files assert
 * different things.
 */
const resultToScores = (result: EveEvalResult): Record<string, number> => {
  const assertions = result.assertions ?? [];
  const gateAssertions = assertions.filter((assertion) =>
    assertion.severity === "gate",
  );
  const thresholdedSoftAssertions = assertions.filter((assertion) =>
    assertion.severity === "soft" &&
    typeof assertion.threshold === "number",
  );

  return {
    "eve.verdict.passed": result.verdict === "passed" ? 1 : 0,
    "eve.gates.passed": gateAssertions.every(didAssertionPass) ? 1 : 0,
    "eve.soft_thresholds.passed": thresholdedSoftAssertions.every(didAssertionPass)
      ? 1
      : 0,
  };
};

const assertionsMetadata = (
  assertions: readonly EveAssertionResult[],
): Array<Record<string, any>> =>
  assertions.map((assertion) => ({
    name: assertion.name,
    score: assertion.score,
    severity: assertion.severity,
    threshold: assertion.threshold,
    passed: assertion.passed,
    message: assertion.message,
    metadata: assertion.metadata,
  }));

/** Surface failed assertions in metadata so a failing run is debuggable. */
const failedAssertionsMetadata = (
  assertions: readonly EveAssertionResult[],
): Record<string, any> => {
  const failed = assertions
    .filter((assertion) => !didAssertionPass(assertion))
    .map((assertion) => ({ name: assertion.name, message: assertion.message }));
  return failed.length > 0 ? { failedAssertions: failed } : {};
};

const traceIdFromSpan = (span: Span) =>
  otelTraceIdToUUID(span.spanContext().traceId);

type TraceResolution =
  | { traceId: string; source: "propagated"; sessionTrace: EveSessionTrace }
  | { traceId: string; source: "reporter-fallback"; span: Span };

/**
 * A Laminar reporter for eve evals. Register it globally in `evals.config.ts`
 * or per-eval via the `reporters` field — eve runs and grades each eval, then
 * hands the graded result here, and this reporter ships it to Laminar as an
 * evaluation run with one datapoint per eval.
 *
 * The datapoint's trace id is never looked up — the reporter OWNS the trace.
 * `patchEveClientSession` wraps eve's `ClientSession.send` and mints the
 * EVALUATION root + EXECUTOR child on the first turn of each session, so the
 * runner already knows the trace id and pushes it to the agent as a
 * `traceparent` header. The eve session id is only the in-process key that ties
 * the send we instrumented to the graded result eve hands back later.
 *
 * Two outcomes, recorded on `metadata.traceResolution`:
 *
 * 1. `"propagated"` — the normal path, above. The agent joins the trace only
 *    when `agent/instrumentation.ts` sets `traceChannelRequests: true` and the
 *    agent process runs with `WORKFLOW_TRACE_MODE=continuous`.
 * 2. `"reporter-fallback"` — no session trace was minted (propagation disabled,
 *    or eve produced no session id). The reporter opens its own EVALUATION span
 *    so the grade still lands somewhere debuggable; it holds no agent work.
 *
 * `t.judge.autoevals.*` model calls run in the RUNNER process, and they reach
 * Laminar only when the runner registers an AI SDK telemetry integration. eve
 * imports `generateText` inside its own bundle, so `wrapAISDK` cannot reach it —
 * but AI SDK v7 reads registered integrations off `globalThis`, which does. One
 * line in `evals.config.ts` (the integration initializes Laminar itself):
 *
 * ```ts
 * registerTelemetry(new LaminarAiSdkTelemetry({
 *   // `disableBatch` matters: eve ends the command with `process.exit()`, and a
 *   // batch queue would never flush.
 *   laminarOptions: { projectApiKey, disableBatch: true },
 * }));
 * ```
 *
 * Each judge then gets its own span under the eval's root — see
 * {@link bindEvalContext}. Without those two lines the reporter still records
 * every assertion's score as an EVALUATOR span; only the model call is missing.
 *
 * @example
 * ```ts
 * import { defineEvalConfig } from "eve/evals";
 * import { LaminarReporter } from "@lmnr-ai/lmnr";
 *
 * export default defineEvalConfig({
 *   reporters: [new LaminarReporter({ name: "weather-agent" })],
 * });
 * ```
 */
export class LaminarReporter implements EvalReporter {
  private readonly options: LaminarReporterOptions;
  private client?: LaminarClient;
  private evalId?: string;
  private evalsById = new Map<string, EveEval>();
  private index = 0;
  private tracerProvider?: BasicTracerProvider;
  /** Session traces minted this run and not yet graded. */
  private openSessionTraces = new Set<EveSessionTrace>();
  /** Stable identity so `onRunComplete` only clears its own registration. */
  private readonly sessionTraceFactory = (): EveSessionTrace | undefined =>
    this.mintSessionTrace();

  constructor(options: LaminarReporterOptions = {}) {
    this.options = options;
  }

  async onRunStart(
    evaluations: readonly EveEval[],
    target: EveEvalTarget,
  ): Promise<void> {
    // Reset up front so a reused reporter whose start fails cannot attach this
    // run's results to a previous run's evaluation.
    this.evalId = undefined;
    this.evalsById = new Map(
      evaluations
        .filter((evaluation): evaluation is EveEval & { id: string } =>
          typeof evaluation.id === "string")
        .map((evaluation) => [evaluation.id, evaluation]),
    );
    this.index = 0;
    // A leftover provider means the previous run never reached onRunComplete
    // (eve crashed mid-run); release its exporter before replacing it.
    this.finishOpenSessionTraces();
    await this.shutdownTracerProvider();
    try {
      this.client = this.options.client ?? new LaminarClient({
        baseUrl: this.options.baseUrl,
        projectApiKey: this.options.projectApiKey,
      });
      this.tracerProvider = new BasicTracerProvider({
        spanProcessors: [
          this.options.spanProcessor ?? new LaminarSpanProcessor({
            // Derive from the client so a pre-constructed `client` option and
            // the fallback-trace exporter share auth and base URL.
            apiKey: this.client.apiKey ?? this.options.projectApiKey,
            baseUrl: this.client.configuredBaseUrl ?? this.options.baseUrl,
            disableBatch: true,
          }),
        ],
      });
      // Register the factory and patch eve BEFORE `evals.init` — eve awaits
      // `onRunStart` before the first eval, but the patch has to be in place
      // for the very first `send`, and a slow init must not shrink that margin.
      if (this.options.propagateTraceContext !== false) {
        activeSessionTraceFactory = this.sessionTraceFactory;
        patchEveClientSession(await loadEveClientSession());
      }
      const evaluation = await this.client.evals.init(
        this.options.name,
        this.options.groupName,
        {
          // User metadata first so the run facts below always win on key
          // collisions — `source: "eve"` etc. are used for attribution.
          ...(this.options.metadata ?? {}),
          source: "eve",
          targetKind: target?.kind,
          targetUrl: target?.url,
          evalCount: evaluations.length,
        },
      );
      this.evalId = evaluation.id;
      // Same line the native evaluator prints. Without it a run reports nothing
      // about where its results went, and eve's own output never mentions it.
      const url = getFrontendUrl(this.client.configuredBaseUrl ?? this.options.baseUrl) +
        `/project/${evaluation.projectId}/evaluations/${evaluation.id}`;
      process.stdout.write(`\nLaminar: check eve eval results at ${url}\n`);
    } catch (error) {
      logger.error(`Laminar eve reporter: failed to start run: ${errorMessage(error)}`);
    }
  }

  async onEvalComplete(result: EveEvalResult): Promise<void> {
    // Capture run state in locals: `this.evalId` and `this.tracerProvider`
    // are cleared by onRunComplete and replaced by a later onRunStart, so
    // re-reading them after an await could pair this run's datapoint with
    // another run's evaluation, or record fallback spans on a provider that
    // was already shut down.
    const client = this.client;
    const evalId = this.evalId;
    const tracerProvider = this.tracerProvider;
    if (!client || !evalId) {
      // onRunStart failed; nothing to attach this result to.
      return;
    }
    const index = this.index++;
    const task = result.result ?? {};
    const derived = task.derived ?? {};
    const assertions = result.assertions ?? [];
    const evalDefinition = typeof result.id === "string"
      ? this.evalsById.get(result.id)
      : undefined;
    const evalDescription = evalDefinition?.description;
    const traceResolution = this.resolveDatapointTrace({
      tracerProvider,
      evalId: result.id ?? String(index),
      description: evalDescription,
      verdict: result.verdict,
      sessionId: task.sessionId,
    });
    try {
      const datapointId = await client.evals.createDatapoint({
        evalId,
        // eve drives the agent itself; the eval id is the closest thing to an
        // input the reporter is handed (the prompt lives inside `test(t)`).
        data: result.id ?? null,
        target: task.finalMessage ?? null,
        index,
        traceId: traceResolution.traceId,
        metadata: {
          name: result.id,
          verdict: result.verdict,
          status: task.status,
          description: evalDescription,
          sessionId: task.sessionId,
          traceResolution: traceResolution.source,
          skipReason: result.skipReason,
          error: result.error,
          toolCalls: (derived.toolCalls ?? [])
            .map((call) => call.name)
            .filter((name): name is string => typeof name === "string"),
          toolCallCount: derived.toolCallCount,
          parked: derived.parked,
          failureCode: derived.failureCode,
          modelId: task.runtimeIdentity?.modelId,
          assertions: assertionsMetadata(assertions),
          ...failedAssertionsMetadata(assertions),
        },
      });

      const executorOutput = task.output ?? task.finalMessage ?? null;
      await client.evals.updateDatapoint({
        evalId,
        datapointId,
        scores: resultToScores(result),
        executorOutput,
      });
    } catch (error) {
      if (traceResolution.source === "reporter-fallback") {
        traceResolution.span.recordException(error as Error);
      }
      logger.error(
        `Laminar eve reporter: failed to report eval ` +
        `"${result.id ?? index}": ${errorMessage(error)}`,
      );
    } finally {
      if (traceResolution.source === "reporter-fallback") {
        traceResolution.span.end();
      }
      if (traceResolution.source === "propagated") {
        this.finishSessionTrace(traceResolution.sessionTrace, {
          evalId: result.id,
          description: evalDescription,
          verdict: result.verdict,
          status: task.status,
          output: task.output ?? task.finalMessage ?? null,
          assertions,
        });
      }
      // Both paths own their trace, so eval metadata is stamped as span
      // attributes before this flush. Pushing it over HTTP instead would race
      // the ingest of the very spans that create the trace.
      await tracerProvider?.forceFlush();
    }
  }

  async onRunComplete(): Promise<void> {
    // Laminar derives average scores server-side from the datapoints, so there
    // is nothing to push here. Datapoint writes are awaited per-eval already.
    // Secondary eve sessions (`t.sessions.newSession()`) and evals that threw
    // before producing a session id never reach onEvalComplete, so their spans
    // are closed here.
    this.finishOpenSessionTraces();
    if (activeSessionTraceFactory === this.sessionTraceFactory) {
      activeSessionTraceFactory = null;
    }
    await this.shutdownTracerProvider();
    this.evalId = undefined;
    this.evalsById.clear();
  }

  /**
   * Open the eval's Laminar spans for one eve client session: an EVALUATION
   * root plus the EXECUTOR child the agent's turn is parented to. Called from
   * the patched `send`, so it must never throw into the user's eval.
   */
  private mintSessionTrace(): EveSessionTrace | undefined {
    const tracerProvider = this.tracerProvider;
    if (!tracerProvider) {
      return undefined;
    }
    const tracer = tracerProvider.getTracer(EVE_REPORTER_TRACER_NAME);
    // ROOT_CONTEXT, not the active context: concurrent evals must not nest
    // inside whichever span happens to be active on the runner's stack.
    const rootSpan = tracer.startSpan(ROOT_SPAN_NAME, {
      attributes: {
        [SPAN_TYPE]: "EVALUATION",
        [TRACE_TYPE]: "EVALUATION",
        "lmnr.eve.reporter": EVE_REPORTER_TRACER_NAME,
      },
    }, ROOT_CONTEXT);
    const executorSpan = tracer.startSpan(EXECUTOR_SPAN_NAME, {
      attributes: { [SPAN_TYPE]: "EXECUTOR" },
    }, trace.setSpan(ROOT_CONTEXT, rootSpan));
    const sessionTrace: EveSessionTrace = {
      traceId: otelTraceIdToUUID(rootSpan.spanContext().traceId),
      rootSpan,
      executorSpan,
      tracer,
      headers: buildTraceHeaders(rootSpan, executorSpan),
      sessionIds: new Set(),
      ended: false,
    };
    this.openSessionTraces.add(sessionTrace);
    return sessionTrace;
  }

  /** Grade, close and release one session trace. Idempotent. */
  private finishSessionTrace(
    sessionTrace: EveSessionTrace,
    grade: {
      evalId?: string;
      description?: string;
      verdict?: EveEvalVerdict;
      status?: string;
      output?: any;
      assertions?: readonly EveAssertionResult[];
    },
  ): void {
    if (sessionTrace.ended) {
      return;
    }
    sessionTrace.ended = true;
    this.openSessionTraces.delete(sessionTrace);
    for (const sessionId of sessionTrace.sessionIds) {
      traceByEveSessionId.delete(sessionId);
    }
    try {
      sessionTrace.rootSpan.setAttributes({
        "lmnr.eve.eval.id": grade.evalId ?? "",
        "lmnr.eve.eval.verdict": grade.verdict ?? "",
        "lmnr.eve.eval.status": grade.status ?? "",
        [SPAN_INPUT]: JSON.stringify({
          evalId: grade.evalId,
          description: grade.description,
        }),
        [SPAN_OUTPUT]: JSON.stringify(grade.output ?? null),
        // Trace metadata is stamped as span attributes, never pushed over HTTP —
        // the spans that create this trace have not been flushed yet, so a
        // metadata POST would race its own ingest.
        ...metadataToAttributes({
          source: "eve",
          eveEvalId: grade.evalId ?? "",
          eveEvalDescription: grade.description ?? "",
          eveEvalVerdict: grade.verdict ?? "",
          eveSessionId: [...sessionTrace.sessionIds].join(","),
        }),
      });
      sessionTrace.executorSpan.setAttribute(
        SPAN_OUTPUT,
        JSON.stringify(grade.output ?? null),
      );
      this.recordEvaluatorSpans(sessionTrace, grade.assertions ?? []);
      sessionTrace.executorSpan.end();
      sessionTrace.rootSpan.end();
    } catch (error) {
      logger.warn(
        `Laminar eve reporter: failed to finish the session trace: ` +
        errorMessage(error),
      );
    }
  }

  /**
   * One EVALUATOR span per eve assertion, judge or not. They are created at
   * grade time (the assertions only exist then) as short children of the
   * still-open root. No explicit parent path is needed: the root keeps the name
   * it was minted with, so the processor's cached path for it is still correct.
   */
  private recordEvaluatorSpans(
    sessionTrace: EveSessionTrace,
    assertions: readonly EveAssertionResult[],
  ): void {
    const rootContext = trace.setSpan(ROOT_CONTEXT, sessionTrace.rootSpan);
    for (const assertion of assertions) {
      const name = assertion.name ?? "assertion";
      const output = JSON.stringify({
        score: assertion.score ?? null,
        passed: didAssertionPass(assertion),
        severity: assertion.severity,
        threshold: assertion.threshold,
        message: assertion.message,
      });
      sessionTrace.tracer.startSpan(name, {
        attributes: {
          [SPAN_TYPE]: "EVALUATOR",
          [SPAN_OUTPUT]: output,
        },
      }, rootContext).end();
    }
  }

  private finishOpenSessionTraces(): void {
    for (const sessionTrace of [...this.openSessionTraces]) {
      this.finishSessionTrace(sessionTrace, {});
    }
  }

  /**
   * Flush and release the run's tracer provider. shutdown() flushes
   * registered processors itself; without it the exporter (and its HTTP
   * resources) stays open when the same reporter instance is reused.
   */
  private async shutdownTracerProvider(): Promise<void> {
    const tracerProvider = this.tracerProvider;
    this.tracerProvider = undefined;
    try {
      await tracerProvider?.shutdown();
    } catch (error) {
      logger.error(
        `Laminar eve reporter: failed to shut down tracer provider: ` +
        errorMessage(error),
      );
    }
  }

  /**
   * Resolve the trace this datapoint links to. There is no lookup: either
   * `patchEveClientSession` already minted the session's trace (and we know its
   * id), or we open a reporter-owned EVALUATION span to hold the grade.
   */
  private resolveDatapointTrace({
    tracerProvider,
    evalId,
    description,
    verdict,
    sessionId,
  }: {
    tracerProvider?: BasicTracerProvider;
    evalId: string;
    description?: string;
    verdict?: EveEvalVerdict;
    sessionId?: string;
  }): TraceResolution {
    const sessionTrace = sessionId
      ? traceByEveSessionId.get(sessionId)
      : undefined;
    if (sessionTrace) {
      return { traceId: sessionTrace.traceId, source: "propagated", sessionTrace };
    }

    const tracer = tracerProvider?.getTracer(EVE_REPORTER_TRACER_NAME) ??
      trace.getTracer(EVE_REPORTER_TRACER_NAME);
    const span = tracer.startSpan(`eve eval ${evalId}`, {
      attributes: {
        "lmnr.span.type": "EVALUATION",
        "lmnr.eve.reporter": EVE_REPORTER_TRACER_NAME,
        "lmnr.eve.eval.id": evalId,
        "lmnr.eve.eval.verdict": verdict ?? "",
        ...(sessionId ? { "lmnr.eve.session.id": sessionId } : {}),
        "lmnr.eve.trace_resolution": "reporter-fallback",
        // Stamped as attributes rather than pushed over HTTP: this trace is
        // created by the span we are opening right now, so a metadata POST would
        // race its own ingest and fail with "Trace ... not found".
        ...metadataToAttributes({
          source: "eve",
          eveEvalId: evalId,
          eveEvalDescription: description ?? "",
          eveEvalVerdict: verdict ?? "",
          eveSessionId: sessionId ?? "",
        }),
      },
    });
    return { traceId: traceIdFromSpan(span), source: "reporter-fallback", span };
  }
}
