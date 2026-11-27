/**
 * The connection to a trial's mock server: `LMNR_MOCK_URL`, the cached key
 * set (with retry and backoff while the server is unreachable), and the
 * calls. Line-comparable with lmnr-python's `sdk/mock/client.py`.
 *
 * The env var is read once, on the first observed call (`getMockClient`), so
 * an app without it pays one cached check per call and makes no request.
 *
 * Like Python, a function that isn't `async` gets its answer synchronously:
 * `mockedKeysSync` / `callSync` block this thread until the server answers.
 * Node has no synchronous HTTP, so a worker makes the request while this
 * thread waits in `Atomics.wait` (`requestSync`).
 */
import { request } from "node:http";
import {
  MessageChannel,
  type MessagePort,
  receiveMessageOnPort,
  Worker,
} from "node:worker_threads";

import { MOCK_FAILURE, MockedError } from "./errors";
import { fnPath, type Outcome, parseKeys, parseOutcome } from "./protocol";

const MOCK_URL_ENV = "LMNR_MOCK_URL";
const MOCK_TIMEOUT_ENV = "LMNR_MOCK_TIMEOUT_MS";
const DEFAULT_TIMEOUT_MS = 30_000;
const KEYS_TIMEOUT_MS = 2_000;
export const RETRY_BACKOFF_MS = 100;
const MAX_RETRY_BACKOFF_MS = 2_000;
// How long a blocking request waits for the worker beyond the request's own
// timeout: the worker's startup on the first request.
const WORKER_STARTUP_MS = 3_000;

type HttpResult = { status: number; body: string } | { error: string };
type Method = "GET" | "POST";

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

  /** The key set, if it has loaded. */
  loadedKeys(): Set<string> | undefined {
    return this.keys;
  }

  /**
   * The key set, fetched on the first call (blocking). Throws while the
   * server is unreachable, and retries after a growing backoff.
   */
  mockedKeysSync(): Set<string> {
    if (this.keys !== undefined) {
      return this.keys;
    }
    this.checkBackoff();
    return this.parseKeys(
      requestSync("GET", `${this.url}/keys`, undefined, KEYS_TIMEOUT_MS),
    );
  }

  async mockedKeys(): Promise<Set<string>> {
    if (this.keys !== undefined) {
      return this.keys;
    }
    // Two concurrent first fetches are harmless.
    this.checkBackoff();
    return this.parseKeys(
      await httpRequest("GET", `${this.url}/keys`, undefined, KEYS_TIMEOUT_MS),
    );
  }

  private parseKeys(result: HttpResult): Set<string> {
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

  callSync(key: string, body: string): Outcome {
    return outcome(
      key,
      requestSync("POST", this.url + fnPath(key), body, this.timeoutMs),
    );
  }

  async call(key: string, body: string): Promise<Outcome> {
    return outcome(
      key,
      await httpRequest("POST", this.url + fnPath(key), body, this.timeoutMs),
    );
  }
}

const outcome = (key: string, result: HttpResult): Outcome => {
  if ("error" in result) {
    throw new MockedError(
      MOCK_FAILURE,
      `${key}: mock server unreachable (${result.error})`,
    );
  }
  return parseOutcome(key, result.status, result.body);
};

// `node:http`, never `fetch`: the server is on loopback, never behind the
// app's proxy settings.
const httpRequest = (
  method: Method,
  url: string,
  body: string | undefined,
  timeoutMs: number,
) =>
  new Promise<HttpResult>((resolve) => {
    const fail = (e: Error) => resolve({ error: `${e.name}: ${e.message}` });
    try {
      const req = request(
        url,
        {
          method,
          headers:
            body === undefined
              ? {}
              : {
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
          res.on("error", fail);
        },
      );
      req.setTimeout(timeoutMs, () =>
        req.destroy(new Error(`timed out after ${timeoutMs} ms`)),
      );
      req.on("error", fail);
      req.end(body);
    } catch (e) {
      // A malformed URL or an unsupported protocol throws synchronously.
      fail(e as Error);
    }
  });

// Runs in the worker (CommonJS, `eval: true`): `httpRequest` above, plus the
// reply. Each request carries its own `flag`; the answer goes to `port`
// before the flag is raised, so the waiting thread finds it there. Every
// failure is an answer: an exception escaping the worker would reach the app
// as an `'error'` event, and the caller would wait out its whole timeout.
const WORKER = `
const { request } = require("node:http");
const { workerData, parentPort } = require("node:worker_threads");
const { port } = workerData;
parentPort.on("message", ({ id, flag, method, url, body, timeoutMs }) => {
  let sent = false;
  const done = (result) => {
    if (sent) return;
    sent = true;
    try {
      port.postMessage({ id, result });
    } finally {
      Atomics.store(flag, 0, 1);
      Atomics.notify(flag, 0);
    }
  };
  const fail = (e) => done({ error: e.name + ": " + e.message });
  try {
    const headers = body === undefined ? {} : {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    };
    const req = request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () =>
        done({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", fail);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("timed out after " + timeoutMs + " ms")));
    req.on("error", fail);
    req.end(body);
  } catch (e) {
    fail(e);
  }
});
`;

let worker: { worker: Worker; port: MessagePort } | undefined;
let nextId = 0;

const startWorker = () => {
  const { port1, port2 } = new MessageChannel();
  const started = new Worker(WORKER, {
    eval: true,
    workerData: { port: port2 },
    transferList: [port2],
    // The app's `--require` / `--import` hooks have no business here.
    execArgv: [],
  });
  const current = { worker: started, port: port1 };
  const forget = () => {
    if (worker === current) {
      worker = undefined;
    }
  };
  // The worker answers its own failures; anything else (it died) means a
  // new one for the next request. Unhandled, an 'error' would crash the app.
  started.on("error", forget);
  started.on("exit", forget);
  // Never keeps the app alive.
  started.unref();
  port1.unref();
  return current;
};

/**
 * A blocking request: the worker makes it while this thread waits. The
 * worker lives as long as the process and serves every blocking request.
 */
const requestSync = (
  method: Method,
  url: string,
  body: string | undefined,
  timeoutMs: number,
): HttpResult => {
  try {
    worker ??= startWorker();
    const id = nextId++;
    const flag = new Int32Array(new SharedArrayBuffer(4));
    worker.worker.postMessage({ id, flag, method, url, body, timeoutMs });
    const waitMs = timeoutMs + WORKER_STARTUP_MS;
    if (Atomics.wait(flag, 0, 0, waitMs) === "timed-out") {
      return { error: `Error: no answer within ${waitMs} ms` };
    }
    // Skip answers to earlier requests that timed out here.
    for (;;) {
      const received = receiveMessageOnPort(worker.port);
      if (received === undefined) {
        return { error: "Error: the answer got lost" };
      }
      const message = received.message as { id: number; result: HttpResult };
      if (message.id === id) {
        return message.result;
      }
    }
  } catch (e) {
    return { error: `${(e as Error).name}: ${(e as Error).message}` };
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
