import { SpanStatusCode } from "@opentelemetry/api";

import { LaminarSpan } from "../../tracing/span";

const safeSetAttribute = (
  span: LaminarSpan,
  key: string,
  value: unknown,
): void => {
  if (value === null || value === undefined) return;
  if (typeof value === "string" && value.length === 0) return;
  span.setAttribute(key, value as any);
};

export const recordError = (span: LaminarSpan, error: unknown): void => {
  span.setAttribute(
    "error.type",
    (error as Error)?.constructor?.name ?? "Error",
  );
  span.recordException(error as Error);
  span.setStatus({ code: SpanStatusCode.ERROR });
};

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
    const content = typeof state === "string" ? state : JSON.stringify(state);
    safeSetAttribute(
      span,
      "gen_ai.input.messages",
      JSON.stringify([{ role: "user", content }]),
    );
  }
  const questions = request?.questions;
  if (questions && Object.keys(questions).length > 0) {
    safeSetAttribute(
      span,
      "gen_ai.request.structured_output_schema",
      JSON.stringify(questions),
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
      "gen_ai.output.messages",
      JSON.stringify([
        { role: "assistant", content: JSON.stringify(body.answers) },
      ]),
    );
  }
};
