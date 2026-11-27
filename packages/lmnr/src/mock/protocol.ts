/**
 * The SDK side of lmnr-mock v1 (`spec/lmnr-mock/lmnr-mock.md`): request
 * bodies and what each response means. No I/O here. Line-comparable with
 * lmnr-python's `sdk/mock/protocol.py`.
 */
import { toJson } from "../utils";
import { MOCK_FAILURE, MockedError } from "./errors";

const MAX_BODY_CHARS = 500;

export type Outcome =
  | { action: "respond"; value: unknown }
  | { action: "raise"; error: MockedError }
  | { action: "passthrough" };

/** `/fn/{key}`, the key percent-encoded as one path segment. */
export const fnPath = (key: string): string => "/fn/" + encodeURIComponent(key);

/**
 * Args go through `toJson`, like span input: the argument array, as the
 * function got it.
 */
export const requestBody = (
  args: unknown[],
  traceId: string | null,
  spanId: string | null,
): string =>
  toJson({
    args,
    lang: "typescript",
    trace_id: traceId,
    span_id: spanId,
  }) ?? "{}";

/** `GET /keys`; throws an `Error` saying what was wrong. */
export const parseKeys = (status: number, body: string): Set<string> => {
  const keys = status === 200 ? object(body).keys : undefined;
  const valid =
    Array.isArray(keys) && keys.every((key) => typeof key === "string");
  if (!valid) {
    throw new Error(`GET /keys answered ${describe(status, body)}`);
  }
  return new Set(keys as string[]);
};

/**
 * `POST /fn/{key}`. Anything but the three 200 actions throws
 * `MockedError(MOCK_FAILURE)`: a mocked call never falls back to the real
 * function.
 */
export const parseOutcome = (
  key: string,
  status: number,
  body: string,
): Outcome => {
  const payload = object(body);
  const action = payload.action;
  const error = parseError(payload);
  if (status === 200) {
    if (action === "respond" && "value" in payload) {
      return { action: "respond", value: payload.value };
    }
    if (action === "passthrough") {
      return { action: "passthrough" };
    }
    if (action === "raise" && error !== undefined) {
      return { action: "raise", error: new MockedError(...error) };
    }
  }
  let reason: string;
  if (status === 500 && action === "handler_error" && error !== undefined) {
    reason = `the mock handler raised ${error[0]}: ${error[1]}`;
  } else if (status !== 200 && error !== undefined) {
    reason = `the mock server answered ${status} ${error[0]}: ${error[1]}`;
  } else {
    reason = `unexpected mock server response ${describe(status, body)}`;
  }
  throw new MockedError(MOCK_FAILURE, `${key}: ${reason}`);
};

/** The body as a JSON object; `{}` when it is anything else. */
const object = (body: string): Record<string, unknown> => {
  try {
    const payload: unknown = JSON.parse(body);
    return typeof payload === "object" &&
      payload !== null &&
      !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

const parseError = (
  payload: Record<string, unknown>,
): [string, string] | undefined => {
  const error = payload.error as Record<string, unknown> | undefined;
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const { type, message } = error;
  if (typeof type !== "string" || typeof message !== "string") {
    return undefined;
  }
  return [type, message];
};

const describe = (status: number, body: string): string => {
  let text = body.trim() || "<empty body>";
  if (text.length > MAX_BODY_CHARS) {
    text = text.slice(0, MAX_BODY_CHARS) + "... (truncated)";
  }
  return `[${status}] ${text}`;
};
