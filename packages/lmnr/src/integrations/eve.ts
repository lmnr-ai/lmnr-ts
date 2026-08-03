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
  PARENT_SPAN_IDS_PATH,
  PARENT_SPAN_PATH,
  SPAN_INPUT,
  SPAN_OUTPUT,
  SPAN_PATH,
  SPAN_TYPE,
  TRACE_TYPE,
} from "../opentelemetry-lib/tracing/attributes";
import {
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
 * Placeholder root span name. `ClientSession.send` runs before any reporter
 * hook that knows which eval is in flight, so the root span is renamed to
 * `eve eval <id>` once `onEvalComplete` supplies the id.
 */
const ROOT_SPAN_NAME = "eve eval";
const EXECUTOR_SPAN_NAME = "executor";
const DEFAULT_TRACE_LOOKUP_ATTEMPTS = 8;
const DEFAULT_TRACE_LOOKUP_DELAY_MS = 1_000;

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
   * How many times to query Laminar for eve's agent trace before falling back to
   * a reporter-created trace. Eve hands reporters the result only after the
   * session finishes, but OTel ingest can still lag the datapoint write.
   * Only used when trace-context propagation did not resolve the trace.
   */
  traceLookupAttempts?: number;
  /** Delay between trace lookup attempts, in milliseconds. */
  traceLookupDelayMs?: number;
  /**
   * Mint the trace in the runner and push it to the agent as a `traceparent`
   * header (see {@link patchEveClientSession}). Defaults to `true`. Set `false`
   * to force the session-id lookup path.
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
 * Build the propagation headers for one span. Plain HTTP strings — eve forwards
 * `SendTurnPayload.headers` verbatim to `fetch`.
 */
const buildTraceHeaders = (span: Span): Record<string, string> => {
  const spanContext = span.spanContext();
  const laminarContext: LaminarSpanContext = {
    traceId: otelTraceIdToUUID(spanContext.traceId),
    spanId: otelSpanIdToUUID(spanContext.spanId) as StringUUID,
    isRemote: true,
    // `spanPath` / `spanIdsPath` are deliberately omitted: the root span is
    // renamed once the eval id is known, so a path captured here would be
    // stale by the time a downstream reader used it.
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

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const traceIdFromSpan = (span: Span) =>
  otelTraceIdToUUID(span.spanContext().traceId);

type TraceResolution =
  | {
    traceId: string;
    source: "propagated";
    attempt: number;
    sessionTrace: EveSessionTrace;
  }
  | { traceId: string; source: "eve-session"; attempt: number }
  | { traceId: string; source: "reporter-fallback"; attempt: number; span: Span };

/**
 * A Laminar reporter for eve evals. Register it globally in `evals.config.ts`
 * or per-eval via the `reporters` field — eve runs and grades each eval, then
 * hands the graded result here, and this reporter ships it to Laminar as an
 * evaluation run with one datapoint per eval.
 *
 * Trace correlation happens in one of three ways, best first:
 *
 * 1. `"propagated"` — the reporter patches eve's `ClientSession.send` and mints
 *    the trace itself, pushing it to the agent as a `traceparent` header. The
 *    agent adopts it only when `agent/instrumentation.ts` sets
 *    `traceChannelRequests: true`.
 * 2. `"eve-session"` — a Laminar query matches eve's own spans by their
 *    `eve.session.id` / `workflow.run.id` attribute. Used when propagation was
 *    disabled, eve is absent, or the agent never saw the header.
 * 3. `"reporter-fallback"` — a reporter-owned trace, so the datapoint still
 *    links somewhere debuggable.
 *
 * The resolved path is recorded on `metadata.traceResolution`.
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
      this.evalId = await this.client.evals.init(
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
      ).then((response) => response.id);
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
    const traceResolution = await this.resolveDatapointTrace({
      client,
      tracerProvider,
      evalId: result.id ?? String(index),
      verdict: result.verdict,
      sessionId: task.sessionId,
    });
    let reported = false;
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
          traceResolutionAttempt: traceResolution.attempt,
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
      reported = true;
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
      await tracerProvider?.forceFlush();
      // The propagated path stamps the same facts as span metadata on the root
      // it owns. Pushing them over HTTP as well would race the trace's own
      // ingest — the spans are only flushed on the line above, so the trace does
      // not exist server-side yet ("Trace ... not found").
      if (reported && evalDescription && traceResolution.source !== "propagated") {
        await this.pushEvalTraceMetadata({
          client,
          traceId: traceResolution.traceId,
          description: evalDescription,
          evalId: result.id,
          verdict: result.verdict,
          sessionId: task.sessionId,
        });
      }
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
      headers: buildTraceHeaders(executorSpan),
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
      const rootName = grade.evalId
        ? `${ROOT_SPAN_NAME} ${grade.evalId}`
        : ROOT_SPAN_NAME;
      // The span processor stamped `lmnr.span.path` from the placeholder name at
      // start time; rewrite it on both of our still-open spans so the Laminar
      // path tree matches the final root name.
      sessionTrace.rootSpan.updateName(rootName);
      sessionTrace.rootSpan.setAttribute(SPAN_PATH, [rootName]);
      sessionTrace.executorSpan.setAttribute(
        SPAN_PATH,
        [rootName, EXECUTOR_SPAN_NAME],
      );
      sessionTrace.rootSpan.setAttributes({
        "lmnr.eve.eval.id": grade.evalId ?? "",
        "lmnr.eve.eval.verdict": grade.verdict ?? "",
        "lmnr.eve.eval.status": grade.status ?? "",
        [SPAN_INPUT]: JSON.stringify({
          evalId: grade.evalId,
          description: grade.description,
        }),
        [SPAN_OUTPUT]: JSON.stringify(grade.output ?? null),
        // Same facts `pushEvalTraceMetadata` posts on the lookup paths. Stamping
        // them here keeps trace metadata off the HTTP path, which would race the
        // ingest of the very spans that create this trace.
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
      this.recordEvaluatorSpans(sessionTrace, rootName, grade.assertions ?? []);
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
   * One EVALUATOR span per eve assertion. They are created at grade time (the
   * assertions only exist then) as short children of the still-open root, and
   * carry an explicit parent path so the processor rebuilds the renamed root's
   * path rather than the cached placeholder one.
   */
  private recordEvaluatorSpans(
    sessionTrace: EveSessionTrace,
    rootName: string,
    assertions: readonly EveAssertionResult[],
  ): void {
    const rootContext = trace.setSpan(ROOT_CONTEXT, sessionTrace.rootSpan);
    const rootIdsPath = [
      otelSpanIdToUUID(sessionTrace.rootSpan.spanContext().spanId),
    ];
    for (const assertion of assertions) {
      const name = assertion.name ?? "assertion";
      sessionTrace.tracer.startSpan(name, {
        attributes: {
          [SPAN_TYPE]: "EVALUATOR",
          [PARENT_SPAN_PATH]: [rootName],
          [PARENT_SPAN_IDS_PATH]: rootIdsPath,
          [SPAN_OUTPUT]: JSON.stringify({
            score: assertion.score ?? null,
            passed: didAssertionPass(assertion),
            severity: assertion.severity,
            threshold: assertion.threshold,
            message: assertion.message,
          }),
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

  private async pushEvalTraceMetadata({
    client,
    traceId,
    description,
    evalId,
    verdict,
    sessionId,
  }: {
    client: LaminarClient;
    traceId: string;
    description: string;
    evalId?: string;
    verdict?: EveEvalVerdict;
    sessionId?: string;
  }): Promise<void> {
    try {
      await client.traces.pushMetadata(traceId, {
        source: "eve",
        eveEvalId: evalId,
        eveEvalDescription: description,
        eveEvalVerdict: verdict,
        eveSessionId: sessionId,
      });
    } catch (error) {
      logger.warn(
        `Laminar eve reporter: failed to attach eval metadata to trace ` +
        `"${traceId}": ${errorMessage(error)}`,
      );
    }
  }

  private async resolveDatapointTrace({
    client,
    tracerProvider,
    evalId,
    verdict,
    sessionId,
  }: {
    client: LaminarClient;
    tracerProvider?: BasicTracerProvider;
    evalId: string;
    verdict?: EveEvalVerdict;
    sessionId?: string;
  }): Promise<TraceResolution> {
    const attempts = this.options.traceLookupAttempts ??
      DEFAULT_TRACE_LOOKUP_ATTEMPTS;
    const delayMs = this.options.traceLookupDelayMs ??
      DEFAULT_TRACE_LOOKUP_DELAY_MS;

    // Best path: the runner already minted this session's trace and pushed it
    // to the agent, so there is nothing to look up and no ingest to race.
    const sessionTrace = sessionId
      ? traceByEveSessionId.get(sessionId)
      : undefined;
    if (sessionTrace) {
      return {
        traceId: sessionTrace.traceId,
        source: "propagated",
        attempt: 0,
        sessionTrace,
      };
    }

    if (sessionId) {
      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          // `eve.session.id` is what eve's own AI SDK spans carry;
          // `workflow.run.id` is the same id under Vercel Workflow's own
          // attribute (an eve session id IS a `wrun_…` workflow run id).
          const rows = await client.sql.query(
            "SELECT trace_id, count() AS span_count " +
            "FROM spans " +
            "WHERE span_type != 'EVALUATION' " +
            "AND (" +
            "simpleJSONExtractString(attributes, 'workflow.run.id') = {session_id:String} " +
            "OR simpleJSONExtractString(attributes, 'eve.session.id') = {session_id:String}" +
            ") " +
            "GROUP BY trace_id " +
            "ORDER BY span_count DESC " +
            "LIMIT 1",
            { session_id: sessionId },
          );
          const traceId = rows[0]?.trace_id;
          if (typeof traceId === "string" && traceId.length > 0) {
            return { traceId, source: "eve-session", attempt };
          }
        } catch (error) {
          logger.warn(
            `Laminar eve reporter: trace lookup failed for session ` +
            `"${sessionId}" on attempt ${attempt}: ${errorMessage(error)}`,
          );
        }
        if (attempt < attempts) {
          await sleep(delayMs);
        }
      }
    }

    const tracer = tracerProvider?.getTracer(EVE_REPORTER_TRACER_NAME) ??
      trace.getTracer(EVE_REPORTER_TRACER_NAME);
    const span = tracer.startSpan(
      `eve eval ${evalId}`,
      {
        attributes: {
          "lmnr.span.type": "EVALUATION",
          "lmnr.eve.reporter": EVE_REPORTER_TRACER_NAME,
          "lmnr.eve.eval.id": evalId,
          "lmnr.eve.eval.verdict": verdict ?? "",
          ...(sessionId ? { "lmnr.eve.session.id": sessionId } : {}),
          "lmnr.eve.trace_resolution": "reporter-fallback",
        },
      },
    );
    return {
      traceId: traceIdFromSpan(span),
      source: "reporter-fallback",
      attempt: attempts,
      span,
    };
  }
}
