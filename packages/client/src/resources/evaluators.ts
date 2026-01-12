import { StringUUID } from "@lmnr-ai/types";

import { isStringUUID, otelSpanIdToUUID, otelTraceIdToUUID } from "../utils";
import { BaseResource } from ".";

enum EvaluatorScoreSourceType {
  Evaluator = "Evaluator",
  Code = "Code",
}

interface CreateEvaluatorScoreBase {
  name: string;
  metadata?: Record<string, any>;
  score: number;
  source: EvaluatorScoreSourceType;
}

interface CreateEvaluatorScoreRequestWithTraceId extends CreateEvaluatorScoreBase {
  traceId: string;
}

interface CreateEvaluatorScoreRequestWithSpanId extends CreateEvaluatorScoreBase {
  spanId: string;
}

type ScoreOptions =
  | { name: string; metadata?: Record<string, any>; score: number; traceId: string; }
  | { name: string; metadata?: Record<string, any>; score: number; spanId: string; };

/**
 * Resource for creating evaluator scores
 */
export class EvaluatorsResource extends BaseResource {
  constructor(baseHttpUrl: string, projectApiKey: string) {
    super(baseHttpUrl, projectApiKey);
  }

  /**
   * Create a score for a span or trace
   *
   * @param {ScoreOptions} options - Score creation options
   * @param {string} options.name - Name of the score
   * @param {string} [options.traceId] - The trace ID to score (will be attached to top-level span)
   * @param {string} [options.spanId] - The span ID to score
   * @param {Record<string, any>} [options.metadata] - Additional metadata
   * @param {number} options.score - The score value (float)
   * @returns {Promise<void>}
   *
   * @example
   * // Score by trace ID (will attach to root span)
   * await evaluators.score({
   *   name: "quality",
   *   traceId: "trace-id-here",
   *   score: 0.95,
   *   metadata: { model: "gpt-4" }
   * });
   *
   * @example
   * // Score by span ID
   * await evaluators.score({
   *   name: "relevance",
   *   spanId: "span-id-here",
   *   score: 0.87
   * });
   */
  public async score(options: ScoreOptions): Promise<void> {
    const { name, metadata, score } = options;

    let payload: CreateEvaluatorScoreRequestWithTraceId | CreateEvaluatorScoreRequestWithSpanId;

    if ('traceId' in options && options.traceId) {
      const formattedTraceId = isStringUUID(options.traceId)
        ? options.traceId
        : otelTraceIdToUUID(options.traceId);

      payload = {
        name,
        metadata,
        score,
        source: EvaluatorScoreSourceType.Code,
        traceId: formattedTraceId,
      };
    } else if ('spanId' in options && options.spanId) {
      const formattedSpanId = isStringUUID(options.spanId)
        ? options.spanId
        : otelSpanIdToUUID(options.spanId) as StringUUID;

      payload = {
        name,
        metadata,
        score,
        source: EvaluatorScoreSourceType.Code,
        spanId: formattedSpanId,
      };
    } else {
      throw new Error("Either 'traceId' or 'spanId' must be provided.");
    }

    const response = await fetch(this.baseHttpUrl + "/v1/evaluators/score", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      await this.handleError(response);
    }
  }
}
