/**
 * The connection to a trial's mock server: `LMNR_MOCK_URL`, the cached key
 * set (with retry and backoff while the server is unreachable), and the
 * calls. Line-comparable with lmnr-python's `sdk/mock/client.py`.
 *
 * The env var is read once, on the first observed call (`getMockClient`), so
 * an app without it pays one cached check per call and makes no request.
 */
import { request } from "node:http";

import { MOCK_FAILURE, MockedError } from "./errors";
import { fnPath, type Outcome, parseKeys, parseOutcome } from "./protocol";

const MOCK_URL_ENV = "LMNR_MOCK_URL";
const MOCK_TIMEOUT_ENV = "LMNR_MOCK_TIMEOUT_MS";
const DEFAULT_TIMEOUT_MS = 30_000;
const KEYS_TIMEOUT_MS = 2_000;
export const RETRY_BACKOFF_MS = 100;
const MAX_RETRY_BACKOFF_MS = 2_000;

type HttpResult = { status: number; body: string } | { error: string };

export class MockClient {
  // Never log `url`: it holds the trial's token.
  readonly url: string;
  readonly timeoutMs: number;
  private keys: Set<string> | undefined;
  private loading: Promise<Set<string>> | undefined;
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
   * The key set, loading it on the first call. Rejects while the server is
   * unreachable, and retries after a growing backoff.
   */
  mockedKeys(): Promise<Set<string>> {
    if (this.keys !== undefined) {
      return Promise.resolve(this.keys);
    }
    if (this.loading === undefined) {
      try {
        this.checkBackoff();
      } catch (e) {
        return Promise.reject(e);
      }
      this.loading = this.loadKeys().finally(() => {
        this.loading = undefined;
      });
      this.loading.catch(() => {
        // Callers that only start the load (`startLoading`) don't await it;
        // the failure reaches the next call through the backoff.
      });
    }
    return this.loading;
  }

  /**
   * Start loading the keys without waiting. Once a load has failed, throws
   * the last failure until one succeeds: inside the backoff, and while a
   * retry is in flight. Only calls made before the first load finishes may
   * run unmocked.
   */
  startLoading(): void {
    if (this.keys !== undefined) {
      return;
    }
    if (this.loading === undefined) {
      this.checkBackoff();
      void this.mockedKeys();
    }
    if (this.lastError !== "") {
      throw this.unreachableError();
    }
  }

  private async loadKeys(): Promise<Set<string>> {
    const result = await httpRequest(
      "GET",
      `${this.url}/keys`,
      undefined,
      KEYS_TIMEOUT_MS,
    );
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
      throw this.unreachableError();
    }
  }

  private unreachableError(): MockedError {
    return new MockedError(
      MOCK_FAILURE,
      `mock server unreachable (${this.lastError})`,
    );
  }

  /**
   * Fail closed: until `/keys` answers, every observed call throws, and the
   * next try waits for a growing backoff.
   */
  private unreachable(reason: string): MockedError {
    this.lastError = reason;
    this.retryAt = Date.now() + this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_RETRY_BACKOFF_MS);
    return this.unreachableError();
  }

  // Calls

  async call(key: string, body: string): Promise<Outcome> {
    const result = await httpRequest(
      "POST",
      this.url + fnPath(key),
      body,
      this.timeoutMs,
    );
    if ("error" in result) {
      throw new MockedError(
        MOCK_FAILURE,
        `${key}: mock server unreachable (${result.error})`,
      );
    }
    return parseOutcome(key, result.status, result.body);
  }
}

// `node:http`, never `fetch`: the server is on loopback, never behind the
// app's proxy settings.
const httpRequest = (
  method: "GET" | "POST",
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
