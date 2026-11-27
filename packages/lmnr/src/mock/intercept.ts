/**
 * What `observe` does with a mocked call: decide whether to ask the server,
 * ask it, apply the outcome, and mark the span. Line-comparable with
 * lmnr-python's `sdk/mock/intercept.py`.
 */
import { isSpanContextValid, type Span } from "@opentelemetry/api";

import {
  MOCK_KEY,
  MOCK_OUTCOME,
  SPAN_MOCKED,
} from "../opentelemetry-lib/tracing/attributes";
import { initializeLogger } from "../utils";
import { getMockClient, type MockClient } from "./client";
import { MOCK_FAILURE, MockedError } from "./errors";
import { type Outcome, requestBody } from "./protocol";

const logger = initializeLogger();

/**
 * What to return instead of running `fn` (`{ result }`), or `undefined` to
 * run it as usual. With `LMNR_MOCK_URL` unset this is one cached check.
 *
 * An `async` function's mocked call is a Promise, made without blocking. Any
 * other function gets its answer synchronously, like in Python: the keys and
 * the call block this thread until the server answers (`*Sync` in
 * `client.ts`). So a function that isn't declared `async` but returns a
 * Promise gets the mocked value itself (`await` still works on it).
 */
export const mockCall = (
  key: string | undefined,
  fn: (...args: any[]) => unknown,
  thisArg: unknown,
  args: unknown[],
  span: Span,
): { result: unknown } | undefined => {
  if (key === undefined) {
    return undefined;
  }
  const client = getMockClient();
  if (client === undefined) {
    return undefined;
  }
  const kind = Object.prototype.toString.call(fn);
  const isAsync = kind === "[object AsyncFunction]";
  const callReal = () => fn.apply(thisArg, args);
  const loaded = client.loadedKeys();
  if (loaded === undefined && isAsync) {
    return {
      result: client
        .mockedKeys()
        .then((keys) =>
          keys.has(key) ? run(client, key, span, args, callReal) : callReal(),
        ),
    };
  }
  // Throws while the server is unreachable: fail closed.
  if (!(loaded ?? client.mockedKeysSync()).has(key)) {
    return undefined;
  }
  if (kind.endsWith("GeneratorFunction]")) {
    throw new MockedError(
      MOCK_FAILURE,
      `${key}: generators can't be mocked yet`,
    );
  }
  return {
    result: isAsync
      ? run(client, key, span, args, callReal)
      : runSync(client, key, span, args, callReal),
  };
};

const run = async (
  client: MockClient,
  key: string,
  span: Span,
  args: unknown[],
  callReal: () => unknown,
): Promise<unknown> => {
  let outcome;
  try {
    outcome = await client.call(key, body(span, args));
  } catch (e) {
    mark(span, key, "error");
    throw e;
  }
  return await settle(span, key, outcome, callReal);
};

const runSync = (
  client: MockClient,
  key: string,
  span: Span,
  args: unknown[],
  callReal: () => unknown,
): unknown => {
  let outcome;
  try {
    outcome = client.callSync(key, body(span, args));
  } catch (e) {
    mark(span, key, "error");
    throw e;
  }
  return settle(span, key, outcome, callReal);
};

const body = (span: Span, args: unknown[]): string => {
  const context = span.spanContext();
  const valid = isSpanContextValid(context);
  return requestBody(
    args,
    valid ? context.traceId : null,
    valid ? context.spanId : null,
  );
};

const settle = (
  span: Span,
  key: string,
  outcome: Outcome,
  callReal: () => unknown,
): unknown => {
  if (outcome.action === "passthrough") {
    mark(span, key, "passthrough");
    return callReal();
  }
  if (outcome.action === "raise") {
    mark(span, key, "raise", true);
    throw outcome.error;
  }
  mark(span, key, "respond", true);
  return outcome.value;
};

const mark = (span: Span, key: string, outcome: string, mocked = false) => {
  try {
    span.setAttribute(MOCK_KEY, key);
    span.setAttribute(MOCK_OUTCOME, outcome);
    if (mocked) {
      span.setAttribute(SPAN_MOCKED, true);
    }
  } catch (e) {
    logger.debug(`Failed to set mock attributes: ${String(e)}`);
  }
};
