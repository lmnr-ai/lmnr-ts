import { toJson } from "../../../utils";
import {
  GEN_AI_INPUT_MESSAGES,
  GEN_AI_OUTPUT_MESSAGES,
} from "../../tracing/attributes";
import { LaminarSpan } from "../../tracing/span";
import { safeSetAttribute } from "../shared/utils";

export const VERTEX_AI_SYSTEM = "vertex_ai";

const VALUE_KINDS = [
  "stringValue",
  "numberValue",
  "boolValue",
  "structValue",
  "listValue",
  "nullValue",
] as const;

/**
 * Decode a `google.protobuf.Value` (either a protobufjs message instance or
 * a plain object, e.g. produced by `aiplatform.helpers.toValue`) into a plain
 * JS value. Unset oneof members on protobufjs messages default to `null`, so
 * we prefer the `kind` virtual field when it is available.
 */
export const fromValue = (value: any): unknown => {
  if (value === null || value === undefined || typeof value !== "object") {
    return value;
  }
  const kind =
    typeof value.kind === "string"
      ? value.kind
      : VALUE_KINDS.find((k) => value[k] !== undefined && value[k] !== null);

  switch (kind) {
    case "stringValue":
    case "numberValue":
    case "boolValue":
      return value[kind];
    case "structValue":
      return Object.fromEntries(
        Object.entries(value.structValue?.fields ?? {}).map(([k, v]) => [
          k,
          fromValue(v),
        ]),
      );
    case "listValue":
      return (value.listValue?.values ?? []).map(fromValue);
    case "nullValue":
      return null;
    default:
      return undefined;
  }
};

const asRecord = (value: unknown): Record<string, any> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : undefined;

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && !Number.isNaN(value) ? value : undefined;

/**
 * Strip resource prefixes, e.g.
 * `projects/p/locations/l/publishers/google/models/text-bison` -> `text-bison`.
 */
export const lastPathSegment = (value: unknown): string | undefined => {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.split("/").pop() || undefined;
};

const toInputMessages = (instance: Record<string, any>): unknown[] => {
  const messages: unknown[] = [];
  if (typeof instance.context === "string" && instance.context.length > 0) {
    messages.push({ role: "system", content: instance.context });
  }
  if (typeof instance.prompt === "string") {
    messages.push({ role: "user", content: instance.prompt });
  }
  if (Array.isArray(instance.messages)) {
    for (const message of instance.messages) {
      const record = asRecord(message);
      if (!record) continue;
      const author = typeof record.author === "string" ? record.author : "user";
      messages.push({
        role: author === "bot" ? "assistant" : author,
        content: record.content,
      });
    }
  }
  return messages;
};

/**
 * Set request attributes on a span from a `PredictionServiceClient.predict`
 * request (PaLM-style text / chat models served through Vertex AI).
 */
export const setPredictRequestAttributes = (
  span: LaminarSpan,
  request: any,
  traceContent: boolean,
): void => {
  safeSetAttribute(span, "gen_ai.system", VERTEX_AI_SYSTEM);
  safeSetAttribute(
    span,
    "gen_ai.request.model",
    lastPathSegment(request?.endpoint),
  );

  const parameters = asRecord(fromValue(request?.parameters));
  if (parameters) {
    safeSetAttribute(
      span,
      "gen_ai.request.max_tokens",
      asNumber(parameters.maxOutputTokens),
    );
    safeSetAttribute(
      span,
      "gen_ai.request.temperature",
      asNumber(parameters.temperature),
    );
    safeSetAttribute(span, "gen_ai.request.top_p", asNumber(parameters.topP));
    safeSetAttribute(span, "gen_ai.request.top_k", asNumber(parameters.topK));
  }

  if (!traceContent || !Array.isArray(request?.instances)) return;

  const messages = request.instances.flatMap((instance: unknown) => {
    const record = asRecord(fromValue(instance));
    return record ? toInputMessages(record) : [];
  });
  if (messages.length > 0) {
    safeSetAttribute(span, GEN_AI_INPUT_MESSAGES, toJson(messages));
  }
};

const predictionContent = (prediction: unknown): string | undefined => {
  const record = asRecord(fromValue(prediction));
  if (!record) return undefined;
  if (typeof record.content === "string") return record.content;
  const firstCandidate = Array.isArray(record.candidates)
    ? asRecord(record.candidates[0])
    : undefined;
  if (typeof firstCandidate?.content === "string") {
    return firstCandidate.content;
  }
  return undefined;
};

/**
 * Set response attributes on a span from a `PredictResponse`.
 */
export const setPredictResponseAttributes = (
  span: LaminarSpan,
  response: any,
  traceContent: boolean,
): void => {
  if (!response) return;

  safeSetAttribute(
    span,
    "gen_ai.response.model",
    lastPathSegment(response.model),
  );

  const metadata = asRecord(fromValue(response.metadata));
  const tokenMetadata = asRecord(metadata?.tokenMetadata);
  const inputTokens = asNumber(
    asRecord(tokenMetadata?.inputTokenCount)?.totalTokens,
  );
  const outputTokens = asNumber(
    asRecord(tokenMetadata?.outputTokenCount)?.totalTokens,
  );
  safeSetAttribute(span, "gen_ai.usage.input_tokens", inputTokens);
  safeSetAttribute(span, "gen_ai.usage.output_tokens", outputTokens);
  if (inputTokens !== undefined && outputTokens !== undefined) {
    safeSetAttribute(
      span,
      "llm.usage.total_tokens",
      inputTokens + outputTokens,
    );
  }

  if (!traceContent || !Array.isArray(response.predictions)) return;

  const outputMessages = response.predictions
    .map(predictionContent)
    .filter((content: string | undefined) => content !== undefined)
    .map((content: string) => ({ role: "assistant", content }));
  if (outputMessages.length > 0) {
    safeSetAttribute(span, GEN_AI_OUTPUT_MESSAGES, toJson(outputMessages));
  }
};

/**
 * Reshape a Vertex AI `GenerativeModel` request into the
 * `{model, contents, config}` form the google-genai helpers understand.
 * Request-level `generationConfig`, `systemInstruction`, and `tools` fully
 * override the model-level ones, mirroring the Vertex AI SDK.
 */
export const toGenAiParams = (model: any, request: any) => {
  const isStringRequest = typeof request === "string";
  const req = isStringRequest ? {} : (request ?? {});
  return {
    model: lastPathSegment(model?.model),
    contents: isStringRequest ? request : req.contents,
    config: {
      ...(req.generationConfig ?? model?.generationConfig ?? {}),
      systemInstruction: req.systemInstruction ?? model?.systemInstruction,
      tools: req.tools ?? model?.tools,
    },
  };
};
