import { type Context, type Span, SpanStatusCode } from "@opentelemetry/api";

import { SPAN_OUTPUT } from "../../opentelemetry-lib/tracing/attributes";
import { initializeLogger, toJson, truncateSpanPayload } from "../../utils";
import {
  ERROR_TYPE,
  GEN_AI_TOOL_CALL_RESULT,
  INTERNAL_ERROR,
  INVALID_PARAMS,
  RPC_RESPONSE_STATUS_CODE,
  TOOL_ERROR,
} from "./attributes";
import { type ResolvedOptions } from "./options";
import { redact } from "./redact";
import { isPlainObject, nonEmptyString, turnTracker } from "./shared";
import { type Turn } from "./turns";

const logger = initializeLogger();

export interface ActiveSpan {
  span: Span;
  spanContext: Context;
  method: string;
  /** The session turn this call is in flight in, released when it ends. */
  turn?: Turn;
}

export const serialize = (value: unknown, kind: "input" | "output") => {
  const json = toJson(value);
  return json === undefined ? undefined : truncateSpanPayload(json, kind);
};

const firstText = (result: any): string | undefined => {
  if (!Array.isArray(result?.content)) {
    return undefined;
  }
  for (const block of result.content) {
    if (block?.type === "text" && typeof block.text === "string") {
      return block.text;
    }
  }
  return undefined;
};

// SDK-made `isError` results for invalid params: 1.x folds every McpError into
// "MCP error -32602: ..." text, 2.x folds argument validation into "Input
// validation error: ...". Unknown / disabled tools read "Tool x not found".
const isInvalidParamsText = (text: string | undefined): boolean =>
  text !== undefined &&
  (text.includes("-32602") ||
    /Input validation error/i.test(text) ||
    /Invalid arguments for tool/.test(text) ||
    /^Tool \S+ (not found|disabled)/.test(text));

const markError = (
  active: ActiveSpan,
  options: ResolvedOptions,
  errorType: string,
  message: string | undefined,
  fallbackMessage: string,
  rpcCode?: string,
  stack?: string,
) => {
  const { span } = active;
  const text =
    options.recordPayloads && message !== undefined ? message : fallbackMessage;
  span.setAttribute(ERROR_TYPE, errorType);
  if (rpcCode !== undefined) {
    span.setAttribute(RPC_RESPONSE_STATUS_CODE, rpcCode);
  }
  span.addEvent("exception", {
    "exception.type": errorType,
    "exception.message": text,
    ...(options.recordPayloads && stack
      ? { "exception.stacktrace": stack }
      : {}),
  });
  span.setStatus({ code: SpanStatusCode.ERROR, message: text });
};

const endSpan = (active: ActiveSpan) => {
  try {
    active.span.end();
  } finally {
    if (active.turn) {
      turnTracker.end(active.turn);
    }
  }
};

export const finishResult = (
  options: ResolvedOptions,
  active: ActiveSpan,
  result: any,
) => {
  try {
    const isTool = active.method === "tools/call";
    if (options.recordPayloads) {
      const json = serialize(redact(result, options.extraKeys), "output");
      if (json !== undefined) {
        active.span.setAttribute(
          isTool ? GEN_AI_TOOL_CALL_RESULT : SPAN_OUTPUT,
          json,
        );
      }
    }
    // The SDKs fold tool exceptions, validation failures and (1.x) unknown
    // tools into an `isError` result.
    if (isTool && isPlainObject(result) && result.isError === true) {
      const text = firstText(result);
      markError(
        active,
        options,
        isInvalidParamsText(text) ? INVALID_PARAMS : TOOL_ERROR,
        text,
        "Tool returned an error",
      );
    }
  } catch (e) {
    logger.debug(`Laminar MCP: failed to record the result: ${String(e)}`);
  } finally {
    endSpan(active);
  }
};

export const finishError = (
  options: ResolvedOptions,
  active: ActiveSpan,
  error: unknown,
) => {
  try {
    const code = (error as any)?.code;
    const rpcCode = Number.isSafeInteger(code) ? String(code) : undefined;
    const className = (error as any)?.constructor?.name;
    const message =
      typeof (error as any)?.message === "string"
        ? (error as any).message
        : String(error);
    markError(
      active,
      options,
      rpcCode ??
        (nonEmptyString(className) && className !== "Object"
          ? className
          : "_OTHER"),
      message,
      "Request failed",
      // What the SDK answers with: the error's own code, else Internal error.
      rpcCode ?? INTERNAL_ERROR,
      (error as any)?.stack,
    );
  } catch (e) {
    logger.debug(`Laminar MCP: failed to record the error: ${String(e)}`);
  } finally {
    endSpan(active);
  }
};

/** Run a `tools/call` / `prompts/get` / `resources/read` handler in its span. */
