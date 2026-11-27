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
 * A mocked call's answer always comes back as a Promise. Nothing is checked
 * up front: a function that isn't declared `async` is still mocked, with a
 * warning, since its callers get a Promise where they may expect a value.
 *
 * The key set loads asynchronously on the first observed call. An `async`
 * function waits for it. Any other function called before it has loaded runs
 * as usual (it can't wait without changing what it returns); if its key turns
 * out to be mocked, a warning says so once the keys arrive.
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
  const callReal = () => fn.apply(thisArg, args);
  const decide = (keys: Set<string>): Promise<unknown> | undefined => {
    if (!keys.has(key)) {
      return undefined;
    }
    if (kind.endsWith("GeneratorFunction]")) {
      throw new MockedError(
        MOCK_FAILURE,
        `${key}: generators can't be mocked yet`,
      );
    }
    if (kind !== "[object AsyncFunction]") {
      warnOnce(
        `${key} isn't declared async: its mocked calls return a Promise`,
      );
    }
    return run(client, key, span, args, callReal);
  };

  const keys = client.loadedKeys();
  if (keys !== undefined) {
    return decide(keys);
  }
  if (kind === "[object AsyncFunction]") {
    return client.mockedKeys().then((loaded) => decide(loaded) ?? callReal());
  }
  // Throws while the server is unreachable: fail closed.
  client.startLoading();
  void client.mockedKeys().then(
    (loaded) => {
      if (loaded.has(key)) {
        warnOnce(
          `${key} ran unmocked: it was called before the mock keys loaded`,
        );
      }
    },
    () => {
      // An unreachable server fails the next call (`startLoading`).
    },
  );
  return undefined;
};

// Exported for tests.
export const warned = new Set<string>();

const warnOnce = (message: string) => {
  if (!warned.has(message)) {
    warned.add(message);
    logger.warn(`observe, mock ${message}`);
  }
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
