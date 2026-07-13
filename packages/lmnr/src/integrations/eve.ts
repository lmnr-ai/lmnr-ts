import { LaminarClient } from "@lmnr-ai/client";
import { errorMessage } from "@lmnr-ai/types";

import { initializeLogger } from "../utils";

const logger = initializeLogger();

const GATE_SCORE_PREFIX = "gate:";

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
}

/**
 * Maps each eve assertion onto a Laminar score. Gate assertions become binary
 * `gate:<name>` scores (so Laminar diffs gate regressions the same way it diffs
 * soft-score regressions), soft assertions keep their numeric score. Mirrors
 * eve's own Braintrust reporter, which prefixes gate scores the same way.
 */
const assertionsToScores = (
  assertions: readonly EveAssertionResult[],
): Record<string, number> => {
  const scores: Record<string, number> = {};
  for (const assertion of assertions) {
    if (!assertion.name || typeof assertion.score !== "number") {
      continue;
    }
    const key = assertion.severity === "gate"
      ? `${GATE_SCORE_PREFIX}${assertion.name}`
      : assertion.name;
    scores[key] = assertion.score;
  }
  return scores;
};

/** Surface failed assertions in metadata so a failing run is debuggable. */
const failedAssertionsMetadata = (
  assertions: readonly EveAssertionResult[],
): Record<string, any> => {
  const failed = assertions
    .filter((assertion) => assertion.passed === false)
    .map((assertion) => ({ name: assertion.name, message: assertion.message }));
  return failed.length > 0 ? { failedAssertions: failed } : {};
};

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
  private index = 0;

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
    this.index = 0;
    try {
      this.client = this.options.client ?? new LaminarClient({
        baseUrl: this.options.baseUrl,
        projectApiKey: this.options.projectApiKey,
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
    // Capture both in locals: `this.evalId` is cleared by onRunComplete and
    // replaced by a later onRunStart, so re-reading it after the await below
    // could pair this run's datapoint with another run's evaluation.
    const client = this.client;
    const evalId = this.evalId;
    if (!client || !evalId) {
      // onRunStart failed; nothing to attach this result to.
      return;
    }
    const index = this.index++;
    const task = result.result ?? {};
    const derived = task.derived ?? {};
    const assertions = result.assertions ?? [];
    try {
      const datapointId = await client.evals.createDatapoint({
        evalId,
        // eve drives the agent itself; the eval id is the closest thing to an
        // input the reporter is handed (the prompt lives inside `test(t)`).
        data: result.id ?? null,
        target: task.finalMessage ?? null,
        index,
        metadata: {
          name: result.id,
          verdict: result.verdict,
          status: task.status,
          sessionId: task.sessionId,
          skipReason: result.skipReason,
          error: result.error,
          toolCalls: (derived.toolCalls ?? [])
            .map((call) => call.name)
            .filter((name): name is string => typeof name === "string"),
          toolCallCount: derived.toolCallCount,
          parked: derived.parked,
          failureCode: derived.failureCode,
          modelId: task.runtimeIdentity?.modelId,
          ...failedAssertionsMetadata(assertions),
        },
      });

      await client.evals.updateDatapoint({
        evalId,
        datapointId,
        scores: assertionsToScores(assertions),
        executorOutput: task.output ?? task.finalMessage ?? null,
      });
    } catch (error) {
      logger.error(
        `Laminar eve reporter: failed to report eval ` +
        `"${result.id ?? index}": ${errorMessage(error)}`,
      );
    }
  }

  onRunComplete(): void {
    // Laminar derives average scores server-side from the datapoints, so there
    // is nothing to push here. Datapoint writes are awaited per-eval already.
    this.evalId = undefined;
  }
}
