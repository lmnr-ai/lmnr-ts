import { Context, HrTime, SpanStatusCode } from "@opentelemetry/api";

import { Laminar } from "../../../laminar";
import { LaminarSpan } from "../../tracing/span";
import { safeSetAttribute } from "../google-genai/utils";
import {
  INPUT_MESSAGES,
  OUTPUT_MESSAGES,
  setClientAttributes,
  TOOL_DEFINITIONS,
  toJson,
} from "./utils";

export const RESPONSE_SPAN_NAME = "openai.response";

// Statuses after which a response can no longer change (or be streamed again).
const TERMINAL_STATUSES = new Set([
  "completed",
  "incomplete",
  "failed",
  "cancelled",
]);

/**
 * Everything recorded on an `openai.response` span. The span is created only
 * once the response is final, so a background response (`background: true`)
 * keeps its request data here until `retrieve` / `cancel` sees it finish.
 */
type TracedData = {
  startTime: HrTime;
  responseId: string;
  input?: unknown;
  instructions?: unknown;
  tools?: unknown[];
  outputBlocks: Record<string, unknown>;
  outputText?: string;
  usage?: any;
  requestModel?: string;
  responseModel?: string;
  requestReasoningSummary?: string;
  requestReasoningEffort?: string;
  requestServiceTier?: string;
  responseServiceTier?: string;
};

// Request data of background responses that are not final yet, by id.
const pendingResponses = new Map<string, TracedData>();

// Ids of final responses that already have a span, oldest first, so a later
// `retrieve` of the same response doesn't record the LLM call twice.
const recordedResponses = new Set<string>();
const MAX_RECORDED_RESPONSES = 1000;

const markRecorded = (responseId: string): void => {
  if (!responseId) return;
  recordedResponses.delete(responseId);
  recordedResponses.add(responseId);
  if (recordedResponses.size > MAX_RECORDED_RESPONSES) {
    const [oldest] = recordedResponses;
    recordedResponses.delete(oldest);
  }
};

export type StreamState = {
  outputText: string;
  outputBlocks: Record<string, unknown>;
  errorMessage?: string;
  // Latest full response carried by a `response.*` lifecycle event.
  snapshot?: any;
};

export const createStreamState = (): StreamState => ({
  outputText: "",
  outputBlocks: {},
});

const getFunctionTools = (params: any): unknown[] =>
  Array.isArray(params?.tools)
    ? params.tools.filter((tool: any) => tool?.type === "function")
    : [];

const outputBlocksOf = (response: any): Record<string, unknown> => {
  const blocks: Record<string, unknown> = {};
  if (!Array.isArray(response?.output)) return blocks;
  response.output.forEach((block: any, index: number) => {
    blocks[block?.id ?? `output_${index}`] = block;
  });
  return blocks;
};

/**
 * Data for a call that produced no response to read from (a request error,
 * or a stream that ended before any snapshot), merged with anything stashed
 * under `params.response_id`.
 */
const tracedDataFromRequest = (startTime: HrTime, params: any): TracedData => {
  const responseId: string = params?.response_id ?? "";
  const existing = pendingResponses.get(responseId);
  const tools = getFunctionTools(params);
  return {
    startTime: existing?.startTime ?? startTime,
    responseId,
    input: params?.input ?? existing?.input,
    instructions: params?.instructions ?? existing?.instructions,
    tools: tools.length ? tools : existing?.tools,
    outputBlocks: { ...existing?.outputBlocks },
    outputText: existing?.outputText,
    usage: existing?.usage,
    requestModel: params?.model ?? existing?.requestModel,
    responseModel: existing?.responseModel,
    requestReasoningSummary:
      params?.reasoning?.summary ?? existing?.requestReasoningSummary,
    requestReasoningEffort:
      params?.reasoning?.effort ?? existing?.requestReasoningEffort,
    requestServiceTier: params?.service_tier ?? existing?.requestServiceTier,
  };
};

/**
 * Merge a response into the data stashed under its id: request fields prefer
 * the stash (a `retrieve` carries no request body), response fields and
 * output blocks prefer the new response.
 */
const tracedDataFromResponse = (
  startTime: HrTime,
  response: any,
  params: any,
): TracedData | undefined => {
  const responseId = response?.id;
  if (!responseId) return undefined;
  const existing = pendingResponses.get(responseId);
  const tools = [...(existing?.tools ?? []), ...getFunctionTools(params)];
  return {
    startTime: existing?.startTime ?? startTime,
    responseId,
    input: existing?.input ?? params?.input,
    instructions: existing?.instructions ?? params?.instructions,
    tools: tools.length ? tools : undefined,
    outputBlocks: { ...existing?.outputBlocks, ...outputBlocksOf(response) },
    outputText: response.output_text || existing?.outputText,
    usage: response.usage ?? existing?.usage,
    requestModel: existing?.requestModel ?? params?.model,
    responseModel: response.model ?? existing?.responseModel,
    requestReasoningSummary:
      existing?.requestReasoningSummary ?? params?.reasoning?.summary,
    requestReasoningEffort:
      existing?.requestReasoningEffort ?? params?.reasoning?.effort,
    requestServiceTier: existing?.requestServiceTier ?? params?.service_tier,
    responseServiceTier: response.service_tier ?? existing?.responseServiceTier,
  };
};

const buildInputMessages = (data: TracedData): unknown[] | undefined => {
  const messages: unknown[] = [];
  if (typeof data.instructions === "string" && data.instructions) {
    messages.push({ role: "system", content: data.instructions });
  }
  if (typeof data.input === "string") {
    messages.push({ role: "user", content: data.input });
  } else if (Array.isArray(data.input)) {
    for (const item of data.input) {
      // The API infers `type: "message"` for message-shaped items, but the
      // type is required on the message types.
      messages.push(
        item && typeof item === "object" && !("type" in item)
          ? { ...item, type: "message" }
          : item,
      );
    }
  }
  return messages.length ? messages : undefined;
};

const buildOutputMessages = (data: TracedData): unknown[] => {
  const blocks = Object.values(data.outputBlocks).filter(Boolean);
  if (!blocks.length && data.outputText) {
    // A stream that stopped before any output item finished.
    return [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: data.outputText }],
      },
    ];
  }
  return blocks;
};

const setDataAttributes = (
  span: LaminarSpan,
  data: TracedData,
  instance: any,
  traceContent: boolean,
): void => {
  setClientAttributes(span, instance);
  safeSetAttribute(span, "gen_ai.request.model", data.requestModel);
  safeSetAttribute(span, "gen_ai.response.id", data.responseId);
  safeSetAttribute(span, "gen_ai.response.model", data.responseModel);

  const usage = data.usage;
  if (usage && typeof usage === "object") {
    safeSetAttribute(span, "gen_ai.usage.input_tokens", usage.input_tokens);
    safeSetAttribute(span, "gen_ai.usage.output_tokens", usage.output_tokens);
    safeSetAttribute(span, "llm.usage.total_tokens", usage.total_tokens);
    safeSetAttribute(
      span,
      "gen_ai.usage.cache_read_input_tokens",
      usage.input_tokens_details?.cached_tokens,
    );
    span.setAttribute(
      "gen_ai.usage.reasoning_tokens",
      usage.output_tokens_details?.reasoning_tokens ?? 0,
    );
  }

  safeSetAttribute(
    span,
    "gen_ai.request.reasoning_summary",
    data.requestReasoningSummary,
  );
  safeSetAttribute(
    span,
    "gen_ai.request.reasoning_effort",
    data.requestReasoningEffort,
  );
  safeSetAttribute(
    span,
    "openai.request.service_tier",
    data.requestServiceTier,
  );
  safeSetAttribute(
    span,
    "openai.response.service_tier",
    data.responseServiceTier,
  );

  if (traceContent) {
    safeSetAttribute(span, INPUT_MESSAGES, toJson(buildInputMessages(data)));
    safeSetAttribute(span, OUTPUT_MESSAGES, toJson(buildOutputMessages(data)));
    safeSetAttribute(span, TOOL_DEFINITIONS, toJson(data.tools));
  }
};

export type SpanOptions = {
  instance: any;
  traceContent: boolean;
  // Laminar context active when the call was made, so the span created
  // after the fact still gets the caller's parent.
  parentContext: Context;
  // A `retrieve` only re-reads a response, so it emits nothing for one that
  // already has a span.
  isRetrieve?: boolean;
};

const isDuplicate = (responseId: string, options: SpanOptions): boolean =>
  Boolean(options.isRetrieve) && recordedResponses.has(responseId);

const startResponseSpan = (
  data: TracedData,
  options: SpanOptions,
): LaminarSpan => {
  const span = Laminar.startSpan({
    name: RESPONSE_SPAN_NAME,
    spanType: "LLM",
    startTime: data.startTime,
    context: options.parentContext,
  }) as LaminarSpan;
  setDataAttributes(span, data, options.instance, options.traceContent);
  return span;
};

// `setStatus(ERROR)` alone doesn't mark a span failed in Laminar; the
// `exception` event does.
const markFailed = (span: LaminarSpan, message: string): void => {
  span.recordException(new Error(message));
  span.setStatus({ code: SpanStatusCode.ERROR, message });
};

const failureMessage = (response: any): string | undefined => {
  switch (response?.status) {
    case "failed":
      return response.error?.message ?? "Response failed";
    case "cancelled":
      return "Response cancelled";
    default:
      return undefined;
  }
};

/**
 * A `create` / `retrieve` that returned a response object. The span is
 * emitted once the response is final; until then (background mode) its
 * request data waits in the stash.
 */
export const processResponse = (
  startTime: HrTime,
  response: any,
  params: any,
  options: SpanOptions,
): void => {
  const data = tracedDataFromResponse(startTime, response, params);
  if (!data) return;
  const status = response?.status;
  if (status && !TERMINAL_STATUSES.has(status)) {
    pendingResponses.set(data.responseId, data);
    return;
  }
  pendingResponses.delete(data.responseId);
  if (isDuplicate(data.responseId, options)) return;
  markRecorded(data.responseId);

  const span = startResponseSpan(data, options);
  const failure = failureMessage(response);
  if (failure !== undefined) {
    markFailed(span, failure);
  } else {
    span.setStatus({ code: SpanStatusCode.OK });
  }
  span.end();
};

/**
 * Start the span of a call that failed before returning a response; the
 * caller records the error and ends it.
 */
export const processRequestError = (
  startTime: HrTime,
  params: any,
  options: SpanOptions,
): LaminarSpan => {
  const data = tracedDataFromRequest(startTime, params);
  pendingResponses.delete(data.responseId);
  return startResponseSpan(data, options);
};

/**
 * `cancel` of a background response we were tracking: emit its span.
 */
export const processCancel = (response: any, options: SpanOptions): void => {
  const responseId = response?.id;
  const existing = responseId ? pendingResponses.get(responseId) : undefined;
  if (!existing) return;
  pendingResponses.delete(responseId);
  markRecorded(responseId);
  const data =
    tracedDataFromResponse(existing.startTime, response, {}) ?? existing;
  const span = startResponseSpan(data, options);
  markFailed(span, "Response cancelled");
  span.end();
};

/**
 * Fold one `ResponseStreamEvent` into the stream state.
 */
export const processStreamEvent = (state: StreamState, event: any): void => {
  switch (event?.type) {
    case "response.output_text.delta":
      state.outputText += event.delta ?? "";
      break;
    case "response.output_item.done":
      if (event.item) {
        state.outputBlocks[event.item.id ?? `output_${event.output_index}`] =
          event.item;
      }
      break;
    case "error":
      state.errorMessage = event.message ?? "Response stream error";
      break;
  }
  // created / queued / in_progress / completed / incomplete / failed events
  // carry a snapshot of the whole response; keep the latest.
  if (event?.response && typeof event.response === "object") {
    state.snapshot = event.response;
  }
};

/**
 * Emit the span of a finished (or abandoned) stream. Returns the span so the
 * caller can record a thrown iteration error before ending it, or undefined
 * when no span is due: the stream re-read a response that already has one,
 * or it left a background response unfinished, which is stashed for the
 * `retrieve` / `cancel` that sees it finish.
 */
export const finishStream = (
  startTime: HrTime,
  state: StreamState,
  params: any,
  options: SpanOptions,
): LaminarSpan | undefined => {
  const snapshot = state.snapshot;
  if (isDuplicate(snapshot?.id ?? params?.response_id ?? "", options)) {
    return undefined;
  }
  let data =
    (snapshot && tracedDataFromResponse(startTime, snapshot, params)) ||
    tracedDataFromRequest(startTime, params);
  // The final snapshot is authoritative; accumulated items and text fill in
  // what an early exit never received a snapshot for.
  data = {
    ...data,
    outputBlocks: { ...state.outputBlocks, ...data.outputBlocks },
    outputText: data.outputText || state.outputText || undefined,
  };

  if (snapshot && data.responseId) {
    // An unfinished background response keeps running server-side: emitting
    // here would count it a second time once it is retrieved. A stream that
    // failed is reported now instead, since nothing may ever retrieve it.
    // Only background responses can be retrieved while still running.
    const unfinished =
      (params?.background || options.isRetrieve) &&
      !TERMINAL_STATUSES.has(snapshot.status) &&
      state.errorMessage === undefined;
    if (unfinished) {
      pendingResponses.set(data.responseId, data);
      return undefined;
    }
    pendingResponses.delete(data.responseId);
    markRecorded(data.responseId);
  }

  const span = startResponseSpan(data, options);
  const failure = state.errorMessage ?? failureMessage(snapshot);
  if (failure !== undefined) {
    markFailed(span, failure);
  } else {
    span.setStatus({ code: SpanStatusCode.OK });
  }
  return span;
};
