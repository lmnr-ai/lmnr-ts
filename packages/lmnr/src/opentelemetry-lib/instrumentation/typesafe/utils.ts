import { toJson } from "../../../utils";
import {
  GEN_AI_INPUT_MESSAGES,
  GEN_AI_OUTPUT_MESSAGES,
} from "../../tracing/attributes";
import { LaminarSpan } from "../../tracing/span";
import { safeSetAttribute } from "../shared/utils";

export const setRequestAttributes = (
  span: LaminarSpan,
  request: any,
  defaultModel: string | undefined,
  traceContent: boolean,
): void => {
  safeSetAttribute(
    span,
    "gen_ai.request.model",
    request?.model ?? defaultModel,
  );
  if (!traceContent) return;

  const state = request?.state;
  if (state !== null && state !== undefined) {
    const content = typeof state === "string" ? state : toJson(state);
    safeSetAttribute(
      span,
      GEN_AI_INPUT_MESSAGES,
      toJson([{ role: "user", content }]),
    );
  }
  const questions = request?.questions;
  if (questions && Object.keys(questions).length > 0) {
    safeSetAttribute(
      span,
      "gen_ai.request.structured_output_schema",
      toJson(questions),
    );
  }
};

/** `body` is the raw `/v1/systemone` JSON: `{ model, usage, answers }`. */
export const setResponseAttributes = (
  span: LaminarSpan,
  body: any,
  traceContent: boolean,
): void => {
  if (!body) return;
  safeSetAttribute(span, "gen_ai.response.model", body.model);
  safeSetAttribute(span, "gen_ai.usage.input_tokens", body.usage?.input_tokens);
  safeSetAttribute(
    span,
    "gen_ai.usage.output_tokens",
    body.usage?.output_tokens,
  );
  if (body.answers && traceContent) {
    safeSetAttribute(
      span,
      GEN_AI_OUTPUT_MESSAGES,
      toJson([{ role: "assistant", content: toJson(body.answers) }]),
    );
  }
};
