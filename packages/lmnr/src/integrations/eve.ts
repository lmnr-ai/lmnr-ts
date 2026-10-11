import { LaminarClient } from "@lmnr-ai/client";
import { errorMessage, type StringUUID } from "@lmnr-ai/types";
import {
  ROOT_CONTEXT,
  type Span,
  type SpanContext,
  type Tracer,
  trace,
} from "@opentelemetry/api";
import { type SpanProcessor } from "@opentelemetry/sdk-trace-base";

import { Laminar } from "../laminar";
import { getConfiguredApiKey, getTracer } from "../opentelemetry-lib/tracing";
import {
  SPAN_INPUT,
  SPAN_OUTPUT,
  SPAN_TYPE,
  TRACE_TYPE,
} from "../opentelemetry-lib/tracing/attributes";
import {
  getFrontendUrl,
  initializeLogger,
  metadataToAttributes,
  otelTraceIdToUUID,
} from "../utils";

const logger = initializeLogger();

const EVE_REPORTER_TRACER_NAME = "@lmnr-ai/lmnr/eve-reporter";
const OTEL_TRACE_ID_RE = /^[0-9a-f]{32}$/iu;
const OTEL_SPAN_ID_RE = /^[0-9a-f]{16}$/iu;
const ZERO_TRACE_ID = "0".repeat(32);
const ZERO_SPAN_ID = "0".repeat(16);

/**
 * Narrow local mirrors of eve's `eve/evals` types. We intentionally do not
 * import from `eve`, so the SDK carries no peer dependency on it. Every field
 * the reporter reads is optional so shape drift degrades to a fallback trace
 * instead of breaking the eval run.
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

/** Portable W3C trace coordinates emitted by eve 0.35 and later. */
export interface EveRuntimeTraceContext {
  traceId?: string;
  spanId?: string;
  traceFlags?: number;
}

/** One trace observed for one session involved in an eval. */
export interface EveEvalTraceContext extends EveRuntimeTraceContext {
  primary?: boolean;
  sessionId?: string;
}

export interface EveEvalStartEvent {
  evaluation?: EveEval;
  startedAt?: string;
  target?: EveEvalTarget;
}

export interface EveEvalSessionStartEvent extends EveEvalStartEvent {
  primary?: boolean;
  sessionId?: string;
  traceContext?: EveRuntimeTraceContext;
}

export interface EveEvalCompleteContext {
  evaluation?: EveEval;
  target?: EveEvalTarget;
  traceContexts?: readonly EveEvalTraceContext[];
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
  /** Distinct native traces observed across every session in the eval. */
  traceContexts?: readonly EveEvalTraceContext[];
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

/** Mirrors `EvalReporter` from `eve/evals/reporters` in eve 0.35+. */
export interface EvalReporter {
  onRunStart(
    evaluations: readonly EveEval[],
    target: EveEvalTarget,
  ): void | Promise<void>;
  onEvalStart?(event: EveEvalStartEvent): void | Promise<void>;
  onSessionStart?(event: EveEvalSessionStartEvent): void | Promise<void>;
  onEvalComplete(
    result: EveEvalResult,
    context?: EveEvalCompleteContext,
  ): void | Promise<void>;
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
   * Span processor for the tracing this reporter initializes. Intended for
   * tests; production defaults to Laminar's. Ignored when something already
   * called `Laminar.initialize()`.
   */
  spanProcessor?: SpanProcessor;
  /**
   * @deprecated Eve 0.35+ exposes native trace contexts to reporters. This
   * option is ignored and remains only for source compatibility.
   */
  propagateTraceContext?: boolean;
}

const didAssertionPass = (assertion: EveAssertionResult): boolean => {
  if (typeof assertion.passed === "boolean") {
    return assertion.passed;
  }
  if (typeof assertion.score === "number") {
    if (typeof assertion.threshold === "number") {
      return assertion.score >= assertion.threshold;
    }
    if (assertion.severity === "gate") {
      return assertion.score > 0;
    }
  }
  return true;
};

/** Keep Laminar's score columns stable across heterogeneous eve evals. */
const resultToScores = (result: EveEvalResult): Record<string, number> => {
  const assertions = result.assertions ?? [];
  const gateAssertions = assertions.filter(
    (assertion) => assertion.severity === "gate",
  );
  const thresholdedSoftAssertions = assertions.filter(
    (assertion) =>
      assertion.severity === "soft" && typeof assertion.threshold === "number",
  );

  return {
    "eve.verdict.passed": result.verdict === "passed" ? 1 : 0,
    "eve.gates.passed": gateAssertions.every(didAssertionPass) ? 1 : 0,
    "eve.soft_thresholds.passed": thresholdedSoftAssertions.every(
      didAssertionPass,
    )
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

const failedAssertionsMetadata = (
  assertions: readonly EveAssertionResult[],
): Record<string, any> => {
  const failed = assertions
    .filter((assertion) => !didAssertionPass(assertion))
    .map((assertion) => ({ name: assertion.name, message: assertion.message }));
  return failed.length > 0 ? { failedAssertions: failed } : {};
};

interface ValidEveTraceContext {
  traceId: string;
  spanId: string;
  traceFlags: number;
  primary?: boolean;
  sessionId?: string;
}

const validTraceContext = (
  context: EveEvalTraceContext,
): context is ValidEveTraceContext =>
  typeof context.traceId === "string" &&
  OTEL_TRACE_ID_RE.test(context.traceId) &&
  context.traceId !== ZERO_TRACE_ID &&
  typeof context.spanId === "string" &&
  OTEL_SPAN_ID_RE.test(context.spanId) &&
  context.spanId !== ZERO_SPAN_ID &&
  Number.isInteger(context.traceFlags);

const normalizeTraceContexts = (
  contexts: readonly EveEvalTraceContext[],
): ValidEveTraceContext[] => contexts.filter(validTraceContext);

const selectTraceContext = (
  contexts: readonly ValidEveTraceContext[],
): ValidEveTraceContext | undefined =>
  contexts.find((context) => context.primary === true) ?? contexts[0];

const traceContextMetadata = (contexts: readonly ValidEveTraceContext[]) =>
  contexts.map((context) => ({
    traceId: context.traceId,
    spanId: context.spanId,
    traceFlags: context.traceFlags,
    primary: context.primary,
    sessionId: context.sessionId,
  }));

interface GradeTrace {
  traceId: StringUUID;
  source: "eve-native" | "reporter-fallback";
  span: Span;
  tracer: Tracer;
  selected?: ValidEveTraceContext;
  contexts: readonly ValidEveTraceContext[];
}

/**
 * Reports eve eval results to Laminar.
 *
 * Eve 0.35+ gives reporters every native trace context observed during an eval.
 * The reporter links the datapoint to the first primary trace (or the first
 * trace when there is no primary), records every context in metadata, and adds
 * a small EVALUATION span to the selected native trace for the grade. When eve
 * reports no usable context, a reporter-owned fallback trace preserves the
 * result without pretending it contains agent work.
 *
 * The agent must export its native OpenTelemetry spans to the same Laminar
 * project. In the eve agent, declare a destination like:
 *
 * ```ts
 * import { LaminarSpanProcessor } from "@lmnr-ai/lmnr";
 * import { otelIntegration } from "eve/instrumentation/otel";
 *
 * export default otelIntegration({
 *   spanProcessors: [new LaminarSpanProcessor()],
 * });
 * ```
 */
export class LaminarReporter implements EvalReporter {
  private readonly options: LaminarReporterOptions;
  private client?: LaminarClient;
  private evalId?: string;
  private evalsById = new Map<string, EveEval>();
  private evalIndexById = new Map<string, number>();
  private nextFallbackIndex = 0;

  constructor(options: LaminarReporterOptions = {}) {
    this.options = options;
  }

  async onRunStart(
    evaluations: readonly EveEval[],
    target: EveEvalTarget,
  ): Promise<void> {
    this.evalId = undefined;
    const identifiedEvaluations = evaluations
      .map((evaluation, index) => ({ evaluation, index }))
      .filter(
        (
          item,
        ): item is { evaluation: EveEval & { id: string }; index: number } =>
          typeof item.evaluation.id === "string",
      );
    this.evalsById = new Map(
      identifiedEvaluations.map(({ evaluation }) => [
        evaluation.id,
        evaluation,
      ]),
    );
    this.evalIndexById = new Map(
      identifiedEvaluations.map(({ evaluation, index }) => [
        evaluation.id,
        index,
      ]),
    );
    this.nextFallbackIndex = evaluations.length;
    try {
      this.client =
        this.options.client ??
        new LaminarClient({
          baseUrl: this.options.baseUrl,
          projectApiKey: this.options.projectApiKey,
        });
      this.ensureTracing();
      const evaluation = await this.client.evals.init(
        this.options.name,
        this.options.groupName,
        {
          ...(this.options.metadata ?? {}),
          source: "eve",
          targetKind: target?.kind,
          targetUrl: target?.url,
          evalCount: evaluations.length,
        },
      );
      this.evalId = evaluation.id;
      const url =
        getFrontendUrl(this.client.configuredBaseUrl ?? this.options.baseUrl) +
        `/project/${evaluation.projectId}/evaluations/${evaluation.id}`;
      process.stdout.write(`\nLaminar: check eve eval results at ${url}\n`);
    } catch (error) {
      logger.error(
        `Laminar eve reporter: failed to start run: ${errorMessage(error)}`,
      );
      if (!this.evalId) {
        this.client = undefined;
      }
    }
  }

  async onEvalComplete(
    result: EveEvalResult,
    context?: EveEvalCompleteContext,
  ): Promise<void> {
    const client = this.client;
    const evalId = this.evalId;
    if (!client || !evalId) {
      return;
    }

    const index =
      typeof result.id === "string"
        ? (this.evalIndexById.get(result.id) ?? this.nextFallbackIndex++)
        : this.nextFallbackIndex++;
    const task = result.result ?? {};
    const derived = task.derived ?? {};
    const assertions = result.assertions ?? [];
    const evalDefinition =
      typeof result.id === "string" ? this.evalsById.get(result.id) : undefined;
    const evalDescription =
      context?.evaluation?.description ?? evalDefinition?.description;
    const contexts = normalizeTraceContexts(
      context?.traceContexts ?? task.traceContexts ?? [],
    );
    const gradeTrace = this.openGradeTrace({
      contexts,
      description: evalDescription,
      evalId: result.id ?? String(index),
      verdict: result.verdict,
    });

    try {
      const datapointId = await client.evals.createDatapoint({
        evalId,
        data: result.id ?? null,
        target: task.finalMessage ?? null,
        index,
        traceId: gradeTrace.traceId,
        metadata: {
          name: result.id,
          verdict: result.verdict,
          status: task.status,
          description: evalDescription,
          sessionId: task.sessionId,
          traceResolution: gradeTrace.source,
          selectedTraceContext: gradeTrace.selected
            ? traceContextMetadata([gradeTrace.selected])[0]
            : undefined,
          traceContexts: traceContextMetadata(gradeTrace.contexts),
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

      await client.evals.updateDatapoint({
        evalId,
        datapointId,
        scores: resultToScores(result),
        executorOutput: task.output ?? task.finalMessage ?? null,
      });
    } catch (error) {
      gradeTrace.span.recordException(error as Error);
      logger.error(
        `Laminar eve reporter: failed to report eval ` +
          `"${result.id ?? index}": ${errorMessage(error)}`,
      );
    } finally {
      this.finishGradeTrace(gradeTrace, {
        assertions,
        output: task.output ?? task.finalMessage ?? null,
        status: task.status,
      });
      await this.flush();
    }
  }

  async onRunComplete(_summary?: EveEvalRunSummary): Promise<void> {
    await this.flush();
    this.evalId = undefined;
    this.evalsById.clear();
    this.evalIndexById.clear();
  }

  private ensureTracing(): void {
    if (Laminar.initialized()) {
      const ourKey = this.client?.apiKey ?? this.options.projectApiKey;
      const tracingKey = getConfiguredApiKey();
      if (ourKey && tracingKey && ourKey !== tracingKey) {
        logger.warn(
          "Laminar eve reporter: Laminar is already initialized with a different " +
            "project API key. eve eval spans go to that project while datapoints go " +
            "to the reporter's, so datapoint trace ids will not resolve. Point both " +
            "at the same project.",
        );
      }
      return;
    }
    Laminar.initialize({
      projectApiKey: this.client?.apiKey ?? this.options.projectApiKey,
      baseUrl: this.client?.configuredBaseUrl ?? this.options.baseUrl,
      spanProcessor: this.options.spanProcessor,
      instrumentModules: {},
      disableBatch: true,
    });
  }

  private async flush(): Promise<void> {
    try {
      await Laminar.flush();
    } catch (error) {
      logger.warn(
        `Laminar eve reporter: failed to flush spans: ${errorMessage(error)}`,
      );
    }
  }

  private openGradeTrace({
    contexts,
    description,
    evalId,
    verdict,
  }: {
    contexts: readonly ValidEveTraceContext[];
    description?: string;
    evalId: string;
    verdict?: EveEvalVerdict;
  }): GradeTrace {
    const selected = selectTraceContext(contexts);
    const tracer = getTracer();
    const parentContext = selected
      ? trace.setSpanContext(ROOT_CONTEXT, this.toSpanContext(selected))
      : ROOT_CONTEXT;
    const source = selected ? "eve-native" : "reporter-fallback";
    const span = tracer.startSpan(
      `eve eval ${evalId}`,
      {
        attributes: {
          [SPAN_TYPE]: "EVALUATION",
          [TRACE_TYPE]: "EVALUATION",
          "lmnr.eve.reporter": EVE_REPORTER_TRACER_NAME,
          "lmnr.eve.eval.id": evalId,
          "lmnr.eve.eval.verdict": verdict ?? "",
          "lmnr.eve.trace_resolution": source,
          ...metadataToAttributes({
            source: "eve",
            eveEvalId: evalId,
            eveEvalDescription: description ?? "",
            eveEvalVerdict: verdict ?? "",
            eveSessionId: selected?.sessionId ?? "",
            eveTraceCount: contexts.length,
          }),
          [SPAN_INPUT]: JSON.stringify({ evalId, description }),
        },
      },
      parentContext,
    );

    return {
      traceId: otelTraceIdToUUID(span.spanContext().traceId),
      source,
      span,
      tracer,
      selected,
      contexts,
    };
  }

  private toSpanContext(context: ValidEveTraceContext): SpanContext {
    return {
      traceId: context.traceId.toLowerCase(),
      spanId: context.spanId.toLowerCase(),
      traceFlags: context.traceFlags,
      isRemote: true,
    };
  }

  private finishGradeTrace(
    gradeTrace: GradeTrace,
    grade: {
      assertions: readonly EveAssertionResult[];
      output: any;
      status?: string;
    },
  ): void {
    try {
      gradeTrace.span.setAttributes({
        "lmnr.eve.eval.status": grade.status ?? "",
        [SPAN_OUTPUT]: JSON.stringify(grade.output ?? null),
      });
      const parentContext = trace.setSpan(ROOT_CONTEXT, gradeTrace.span);
      for (const assertion of grade.assertions) {
        gradeTrace.tracer
          .startSpan(
            assertion.name ?? "assertion",
            {
              attributes: {
                [SPAN_TYPE]: "EVALUATOR",
                [TRACE_TYPE]: "EVALUATION",
                [SPAN_OUTPUT]: JSON.stringify({
                  score: assertion.score ?? null,
                  passed: didAssertionPass(assertion),
                  severity: assertion.severity,
                  threshold: assertion.threshold,
                  message: assertion.message,
                }),
              },
            },
            parentContext,
          )
          .end();
      }
      gradeTrace.span.end();
    } catch (error) {
      logger.warn(
        `Laminar eve reporter: failed to finish the grade trace: ${errorMessage(error)}`,
      );
    }
  }
}
