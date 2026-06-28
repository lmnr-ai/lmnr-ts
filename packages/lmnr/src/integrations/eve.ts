import { LaminarClient } from "@lmnr-ai/client";
import { errorMessage } from "@lmnr-ai/types";

import { initializeLogger } from "../utils";

const logger = initializeLogger();

const GATE_SCORE_PREFIX = "gate:";

/**
 * Narrow local mirrors of eve's `eve/evals/reporters` types. We intentionally
 * do NOT import from `eve` so the SDK carries no peer dependency on it (same
 * pattern as the Mastra exporter). The fields are a superset of what the eve
 * docs document, and every field a reporter reads is optional so a shape change
 * on eve's side degrades gracefully instead of throwing.
 */
export interface EveEval {
  /** Path-derived stable id of the eval, e.g. "brooklyn-forecast". */
  id?: string;
  name?: string;
  metadata?: Record<string, any>;
}

export interface EveEvalTarget {
  name?: string;
  [key: string]: any;
}

/** A single check / assertion eve ran against an eval's output. */
export interface EveEvalCheck {
  name?: string;
  /** Soft score in [0, 1]; present for graded checks. */
  score?: number;
  /** Pass/fail flag; present for gate assertions. */
  passed?: boolean;
  /** Whether this check is a hard gate (vs. a soft score). */
  gate?: boolean;
}

export type EveEvalStatus = "passed" | "failed" | "skipped" | "errored";

export interface EveEvalResult {
  /** Stable id of the eval that produced this result. */
  id?: string;
  name?: string;
  /** What was sent to the target. */
  input?: any;
  /** What the target produced. */
  output?: any;
  /** Expected / reference value, if the eval declared one. */
  target?: any;
  /** Pre-aggregated scores, when eve hands them over directly. */
  scores?: Record<string, number>;
  /** Individual checks; gates and soft scores both arrive here. */
  checks?: EveEvalCheck[];
  status?: EveEvalStatus;
  /** Overall verdict; true when the eval passed all gates. */
  passed?: boolean;
  /** Reason supplied to `t.skip(reason)`. */
  skipReason?: string;
  /** Execution error message, when the eval threw. */
  error?: string;
  metadata?: Record<string, any>;
  /** OTel trace id (32-char hex) if eve traced the run. */
  traceId?: string;
}

export interface EveEvalRunSummary {
  total?: number;
  passed?: number;
  failed?: number;
  skipped?: number;
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
 * Maps each individual eve check onto a Laminar score. Gate assertions become
 * binary `gate:<name>` scores (so Laminar diffs gate regressions the same way
 * it diffs soft-score regressions), graded checks keep their numeric score.
 */
const checksToScores = (checks: EveEvalCheck[]): Record<string, number> => {
  const scores: Record<string, number> = {};
  for (const check of checks) {
    if (!check.name) {
      continue;
    }
    if (check.gate || typeof check.score !== "number") {
      scores[`${GATE_SCORE_PREFIX}${check.name}`] = check.passed ? 1 : 0;
    } else {
      scores[check.name] = check.score;
    }
  }
  return scores;
};

/** Collapses an eve result into the flat `Record<string, number>` Laminar stores. */
const resultToScores = (result: EveEvalResult): Record<string, number> => {
  const scores: Record<string, number> = { ...(result.scores ?? {}) };
  if (result.checks?.length) {
    Object.assign(scores, checksToScores(result.checks));
  }
  return scores;
};

/**
 * A Laminar reporter for eve evals. Register it globally in `evals.config.ts`
 * or per-eval via the `reporters` field — eve runs and grades each eval, then
 * hands the graded result here, and this reporter ships it to Laminar as an
 * evaluation run with one datapoint per eval.
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
          source: "eve",
          targetName: target?.name,
          evalCount: evaluations.length,
          ...(this.options.metadata ?? {}),
        },
      ).then((response) => response.id);
    } catch (error) {
      logger.error(`Laminar eve reporter: failed to start run: ${errorMessage(error)}`);
    }
  }

  async onEvalComplete(result: EveEvalResult): Promise<void> {
    if (!this.client || !this.evalId) {
      // onRunStart failed; nothing to attach this result to.
      return;
    }
    const index = this.index++;
    try {
      const datapointId = await this.client.evals.createDatapoint({
        evalId: this.evalId,
        data: result.input ?? null,
        target: result.target,
        index,
        traceId: result.traceId,
        metadata: {
          name: result.name ?? result.id,
          status: result.status,
          passed: result.passed,
          skipReason: result.skipReason,
          error: result.error,
          ...(result.metadata ?? {}),
        },
      });

      await this.client.evals.updateDatapoint({
        evalId: this.evalId,
        datapointId,
        scores: resultToScores(result),
        executorOutput: result.output,
      });
    } catch (error) {
      logger.error(
        `Laminar eve reporter: failed to report eval ` +
        `"${result.name ?? result.id ?? index}": ${errorMessage(error)}`,
      );
    }
  }

  onRunComplete(): void {
    // Laminar derives average scores server-side from the datapoints, so there
    // is nothing to push here. Datapoint writes are awaited per-eval already.
    this.evalId = undefined;
  }
}
