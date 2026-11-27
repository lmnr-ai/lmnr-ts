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
import { requestBody } from "./protocol";

const logger = initializeLogger();

/**
 * The Promise to return instead of running `fn`, or `undefined` to run it as
 * usual. With `LMNR_MOCK_URL` unset this is one cached check.
 *
 * Mocked functions must be `async`: a mocked answer is always a Promise, and
 * turning a sync function's return value into one would break its callers.
 * "Async" means declared `async` (`AsyncFunction`), the only check that
 * holds before the function runs; a plain function that returns a Promise
 * gets a `MockedError` telling the user to declare it `async`.
 */
export const mockCall = (
  key: string | undefined,
  fn: (...args: any[]) => unknown,
  thisArg: unknown,
  args: unknown[],
  span: Span,
): Promise<unknown> | undefined => {
  if (key === undefined) {
    return undefined;
  }
  const client = getMockClient();
  if (client === undefined) {
    return undefined;
  }
  const kind = Object.prototype.toString.call(fn);
  const isAsync = kind === "[object AsyncFunction]";
  // A sync function throws; an async one returns a rejected Promise, like any
  // error it would raise itself.
  const fail = (error: unknown) => {
    if (isAsync) {
      return Promise.reject(error);
    }
    throw error;
  };
  let keys: Set<string>;
  try {
    keys = client.mockedKeys();
  } catch (e) {
    return fail(e);
  }
  if (!keys.has(key)) {
    return undefined;
  }
  if (kind.endsWith("GeneratorFunction]")) {
    return fail(
      new MockedError(MOCK_FAILURE, `${key}: generators can't be mocked yet`),
    );
  }
  if (!isAsync) {
    return fail(
      new MockedError(
        MOCK_FAILURE,
        `${key}: mocked TypeScript functions must return a Promise ` +
          "(declare the function async)",
      ),
    );
  }
  return run(client, key, span, args, () => fn.apply(thisArg, args));
};

const run = async (
  client: MockClient,
  key: string,
  span: Span,
  args: unknown[],
  callReal: () => unknown,
): Promise<unknown> => {
  const context = span.spanContext();
  const valid = isSpanContextValid(context);
  const body = requestBody(
    args,
    valid ? context.traceId : null,
    valid ? context.spanId : null,
  );
  let outcome;
  try {
    outcome = await client.call(key, body);
  } catch (e) {
    mark(span, key, "error");
    throw e;
  }
  if (outcome.action === "passthrough") {
    mark(span, key, "passthrough");
    return await callReal();
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
