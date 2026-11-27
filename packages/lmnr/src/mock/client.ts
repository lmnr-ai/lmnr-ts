/**
 * The connection to a trial's mock server: `LMNR_MOCK_URL`, the cached key
 * set (with retry and backoff while the server is unreachable), and the
 * calls. Line-comparable with lmnr-python's `sdk/mock/client.py`.
 *
 * The env var is read once, on the first observed call (`getMockClient`), so
 * an app without it pays one cached check per call and makes no request.
 *
 * Unlike Python, the keys are fetched synchronously, even for async
 * functions: `observe` must know whether a call is mocked before it runs the
 * function, and a sync function's result can't wait for a Promise. Node has
 * no sync HTTP, so a short-lived worker fetches them while this thread
 * blocks in `Atomics.wait` (once per process, or once per retry).
 */
import { request } from "node:http";
import {
  MessageChannel,
  receiveMessageOnPort,
  Worker,
} from "node:worker_threads";

import { MOCK_FAILURE, MockedError } from "./errors";
import { fnPath, type Outcome, parseKeys, parseOutcome } from "./protocol";

const MOCK_URL_ENV = "LMNR_MOCK_URL";
const MOCK_TIMEOUT_ENV = "LMNR_MOCK_TIMEOUT_MS";
const DEFAULT_TIMEOUT_MS = 30_000;
const KEYS_TIMEOUT_MS = 2_000;
// The worker's own startup on top of the request.
const KEYS_WAIT_MS = KEYS_TIMEOUT_MS + 3_000;
export const RETRY_BACKOFF_MS = 100;
const MAX_RETRY_BACKOFF_MS = 2_000;

type HttpResult = { status: number; body: string } | { error: string };

// Runs in the worker (CommonJS, `eval: true`). `node:http`, never `fetch`:
// the server is on loopback, never behind the app's proxy settings. Every
// failure, `request()` throwing on a bad URL included, is reported through
// `done` (once): an exception escaping the worker would reach the app as an
// `'error'` event, and the main thread would wait out `KEYS_WAIT_MS`.
const KEYS_WORKER = `
const { request } = require("node:http");
const { workerData } = require("node:worker_threads");
const { url, timeoutMs, port, flag } = workerData;
let sent = false;
const done = (message) => {
  if (sent) return;
  sent = true;
  try {
    port.postMessage(message);
  } finally {
    Atomics.store(flag, 0, 1);
    Atomics.notify(flag, 0);
  }
};
const fail = (e) => done({ error: e.name + ": " + e.message });
try {
  const req = request(url, (res) => {
    const chunks = [];
    res.on("data", (chunk) => chunks.push(chunk));
    res.on("end", () =>
      done({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    res.on("error", fail);
  });
  req.setTimeout(timeoutMs, () => req.destroy(new Error("timed out after " + timeoutMs + " ms")));
  req.on("error", fail);
  req.end();
} catch (e) {
  fail(e);
}
`;

export class MockClient {
  // Never log `url`: it holds the trial's token.
  readonly url: string;
  readonly timeoutMs: number;
  private keys: Set<string> | undefined;
  private retryAt = 0;
  private backoffMs = RETRY_BACKOFF_MS;
  private lastError = "";

  constructor(url: string, timeoutMs: number) {
    this.url = url.replace(/\/+$/, "");
    this.timeoutMs = timeoutMs;
  }

  // Keys

  mockedKeys(): Set<string> {
    if (this.keys !== undefined) {
      return this.keys;
    }
    this.checkBackoff();
    const result = getSync(`${this.url}/keys`, KEYS_TIMEOUT_MS, KEYS_WAIT_MS);
    if ("error" in result) {
      throw this.unreachable(result.error);
    }
    try {
      this.keys = parseKeys(result.status, result.body);
    } catch (e) {
      throw this.unreachable((e as Error).message);
    }
    return this.keys;
  }

  private checkBackoff(): void {
    if (Date.now() < this.retryAt) {
      throw new MockedError(
        MOCK_FAILURE,
        `mock server unreachable (${this.lastError})`,
      );
    }
  }

  /**
   * Fail closed: until `/keys` answers, every observed call throws, and the
   * next try waits for a growing backoff.
   */
  private unreachable(reason: string): MockedError {
    this.lastError = reason;
    this.retryAt = Date.now() + this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_RETRY_BACKOFF_MS);
    return new MockedError(MOCK_FAILURE, `mock server unreachable (${reason})`);
  }

  // Calls

  async call(key: string, body: string): Promise<Outcome> {
    const result = await post(this.url + fnPath(key), body, this.timeoutMs);
    if ("error" in result) {
      throw new MockedError(
        MOCK_FAILURE,
        `${key}: mock server unreachable (${result.error})`,
      );
    }
    return parseOutcome(key, result.status, result.body);
  }
}

const post = (url: string, body: string, timeoutMs: number) =>
  new Promise<HttpResult>((resolve) => {
    const req = request(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        res.on("error", (e) => resolve({ error: `${e.name}: ${e.message}` }));
      },
    );
    req.setTimeout(timeoutMs, () =>
      req.destroy(new Error(`timed out after ${timeoutMs} ms`)),
    );
    req.on("error", (e) => resolve({ error: `${e.name}: ${e.message}` }));
    req.end(body);
  });

/** A blocking `GET`: a worker makes the request, this thread waits for it. */
const getSync = (
  url: string,
  timeoutMs: number,
  waitMs: number,
): HttpResult => {
  const flag = new Int32Array(new SharedArrayBuffer(4));
  const { port1, port2 } = new MessageChannel();
  let worker: Worker | undefined;
  try {
    worker = new Worker(KEYS_WORKER, {
      eval: true,
      workerData: { url, timeoutMs, port: port2, flag },
      transferList: [port2],
      // The app's `--require` / `--import` hooks have no business here.
      execArgv: [],
    });
    // Anything the worker still throws (it catches its own errors) is
    // already a failed fetch here; unhandled, it would crash the app.
    worker.on("error", () => {});
    worker.unref();
    Atomics.wait(flag, 0, 0, waitMs);
    const received = receiveMessageOnPort(port1);
    return received === undefined
      ? { error: `no answer within ${waitMs} ms` }
      : (received.message as HttpResult);
  } catch (e) {
    return { error: `${(e as Error).name}: ${(e as Error).message}` };
  } finally {
    port1.close();
    void worker?.terminate();
  }
};

let resolved = false;
let client: MockClient | undefined;

/**
 * The mock client, or `undefined` when `LMNR_MOCK_URL` is unset or empty
 * (the production case). Reads the environment once.
 */
export const getMockClient = (): MockClient | undefined => {
  if (resolved) {
    return client;
  }
  const url = (process.env[MOCK_URL_ENV] ?? "").trim();
  client = url ? new MockClient(url, timeoutMs()) : undefined;
  resolved = true;
  return client;
};

/**
 * Forget the client so the next observed call re-reads the environment
 * (tests).
 */
export const resetMockClient = (): void => {
  resolved = false;
  client = undefined;
};

const timeoutMs = (): number => {
  const raw = (process.env[MOCK_TIMEOUT_ENV] ?? "").trim();
  const ms = raw ? Number(raw) : DEFAULT_TIMEOUT_MS;
  return Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_TIMEOUT_MS;
};
