import { LaminarClient } from "@lmnr-ai/client";
import { errorMessage } from "@lmnr-ai/types";
import { type Span, trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";

import { LaminarSpanProcessor } from "../opentelemetry-lib";
import { initializeLogger, otelTraceIdToUUID } from "../utils";

const logger = initializeLogger();

const EVE_REPORTER_TRACER_NAME = "@lmnr-ai/lmnr/eve-reporter";
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
   */
  traceLookupAttempts?: number;
  /** Delay between trace lookup attempts, in milliseconds. */
  traceLookupDelayMs?: number;
}

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
  | { traceId: string; source: "eve-session"; attempt: number }
  | { traceId: string; source: "reporter-fallback"; attempt: number; span: Span };

/**
 * A Laminar reporter for eve evals. Register it globally in `evals.config.ts`
 * or per-eval via the `reporters` field — eve runs and grades each eval, then
 * hands the graded result here, and this reporter ships it to Laminar as an
 * evaluation run with one datapoint per eval.
 *
 * Trace correlation: eve exports its own AI SDK OTel spans (configured in the
 * agent's `instrumentation.ts`). Those spans carry the eve session id as
 * `eve.session.id`; this reporter stores the same id on each datapoint's
 * `sessionId` metadata, so an eval datapoint can be matched back to the trace
 * eve produced for that session.
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
      traceResolution.source === "reporter-fallback" &&
        traceResolution.span.recordException(error as Error);
      logger.error(
        `Laminar eve reporter: failed to report eval ` +
        `"${result.id ?? index}": ${errorMessage(error)}`,
      );
    } finally {
      if (traceResolution.source === "reporter-fallback") {
        traceResolution.span.end();
      }
      await tracerProvider?.forceFlush();
      if (reported && evalDescription) {
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
    await this.shutdownTracerProvider();
    this.evalId = undefined;
    this.evalsById.clear();
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

    if (sessionId) {
      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          const rows = await client.sql.query(
            "SELECT trace_id, count() AS span_count " +
            "FROM spans " +
            "WHERE span_type != 'EVALUATION' " +
            "AND (" +
            "simpleJSONExtractString(attributes, 'workflow.run.id') = {session_id:String} " +
            "OR simpleJSONExtractString(attributes, 'lmnr.eve.session.id') = {session_id:String} " +
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
