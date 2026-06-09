import { type CachedSpan, errorMessage } from "@lmnr-ai/types";

import { initializeLogger } from "../utils";
import { BaseResource, type LaminarAuth } from "./index";

const logger = initializeLogger();

/**
 * Result of a debug-replay cache lookup (debug-replay v2).
 *
 *  - `hit`  — the server served a cached response for this input hash; replay it
 *             and mark the span CACHED.
 *  - `miss` — no cache entry; the caller latches process-wide live mode and runs
 *             every subsequent call live.
 *  - `live` — run THIS call live without latching (server COLD warmup-timeout
 *             degrade, or any non-OK / transport error here).
 */
export type CacheOutcome =
  | { kind: "hit"; cached: CachedSpan }
  | { kind: "miss" }
  | { kind: "live" };

/**
 * Map the opaque HIT `response` payload onto a {@link CachedSpan} the provider
 * wrappers can replay. The server-side shape of `response` is not yet frozen
 * (app-server plan 01 leaves it as a `serde_json::Value`), so this stays
 * deliberately tolerant: the whole payload is serialized into `output` (the only
 * field the AI SDK wrapper's `parseCachedSpan` actually reads, via
 * `JSON.parse`), and a `finishReason` is surfaced into `attributes` when the
 * payload carries one. `name`/`input` are irrelevant to replay and left empty.
 */
const toCachedSpan = (response: unknown): CachedSpan => {
  const output =
    typeof response === "string" ? response : JSON.stringify(response ?? null);
  const attributes: Record<string, any> = {};
  if (
    response !== null &&
    typeof response === "object" &&
    typeof (response as Record<string, unknown>).finishReason === "string"
  ) {
    attributes["ai.response.finishReason"] = (
      response as Record<string, unknown>
    ).finishReason;
  }
  return { name: "", input: "", output, attributes };
};

export class RolloutSessionsResource extends BaseResource {
  constructor(baseHttpUrl: string, auth: LaminarAuth) {
    super(baseHttpUrl, auth);
  }

  /**
   * Idempotently register (upsert) a debug session on the backend, keyed on the
   * SDK-supplied session id. The backend stores the row so the session is
   * visible in the UI; a null/omitted name never clobbers a name set elsewhere.
   *
   * Returns the backend-resolved `projectId` (derived from the API key) so the
   * caller can build the debugger URL; null if the body can't be parsed.
   */
  public async register({
    sessionId,
    name,
  }: {
    sessionId: string;
    name?: string;
  }): Promise<string | null> {
    const response = await fetch(
      `${this.baseHttpUrl}/v1/rollouts/${sessionId}`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ name }),
      },
    );

    if (!response.ok) {
      await this.handleError(response);
    }

    try {
      const body = (await response.json()) as { projectId?: string };
      return body.projectId ?? null;
    } catch (e) {
      logger.warn(
        `Failed to parse rollout register response: ${errorMessage(e)}`,
      );
      return null;
    }
  }

  /**
   * Rename an existing debug session. Update-only: the backend returns 404 (and
   * this throws) when the session id is unknown for the project, so a mistyped
   * id surfaces as an error rather than silently creating a session. Creation
   * stays the SDK's job via {@link register}.
   */
  public async setName({
    sessionId,
    name,
  }: {
    sessionId: string;
    name: string;
  }): Promise<void> {
    const response = await fetch(
      `${this.baseHttpUrl}/v1/rollouts/${sessionId}/name`,
      {
        method: "PATCH",
        headers: this.headers(),
        body: JSON.stringify({ name }),
      },
    );

    if (!response.ok) {
      await this.handleError(response);
    }
  }

  /**
   * Look up the debug-replay cache for a single LLM call (debug-replay v2).
   *
   * The server is keyed by `inputHash` (hex blake3 of the canonicalized,
   * system-stripped input messages). It returns one of three outcomes:
   *   - `{ outcome: "hit", response }` — a cached response to replay.
   *   - `{ outcome: "miss" }`          — no entry; caller latches live mode.
   *   - `{ outcome: "live" }`          — run this call live (COLD degrade).
   *
   * Error posture: a non-OK response or a transport error degrades to
   * `{ kind: "live" }` for THIS call only — it never throws and never latches
   * the process-wide live flag (only a real MISS does that). This keeps a flaky
   * cache backend from turning a replay into a crash.
   */
  public async cache({
    sessionId,
    replayTraceId,
    cacheUntil,
    inputHash,
  }: {
    sessionId: string;
    replayTraceId: string;
    cacheUntil: string;
    inputHash: string;
  }): Promise<CacheOutcome> {
    let response: Response;
    try {
      response = await fetch(
        `${this.baseHttpUrl}/v1/rollouts/${sessionId}/cache`,
        {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify({ replayTraceId, cacheUntil, inputHash }),
        },
      );
    } catch (e) {
      logger.warn(`Debug cache lookup failed, running live: ${errorMessage(e)}`);
      return { kind: "live" };
    }

    if (!response.ok) {
      logger.warn(
        `Debug cache lookup returned ${response.status}, running live`,
      );
      return { kind: "live" };
    }

    let body: { outcome?: string; response?: unknown };
    try {
      body = (await response.json()) as { outcome?: string; response?: unknown };
    } catch (e) {
      logger.warn(
        `Failed to parse debug cache response, running live: ${errorMessage(e)}`,
      );
      return { kind: "live" };
    }

    switch (body.outcome) {
      case "hit":
        // A HIT with no replayable payload (missing / JSON `null` response) is
        // useless: serializing it would store the string "null", which parses
        // back to `null` and crashes reconstruction. Degrade to live instead.
        if (body.response === null || body.response === undefined) {
          logger.warn("Debug cache HIT had no response payload, running live");
          return { kind: "live" };
        }
        return { kind: "hit", cached: toCachedSpan(body.response) };
      case "miss":
        return { kind: "miss" };
      case "live":
        return { kind: "live" };
      default:
        logger.warn(
          `Unknown debug cache outcome "${body.outcome}", running live`,
        );
        return { kind: "live" };
    }
  }

  public async delete({ sessionId }: { sessionId: string }): Promise<void> {
    const response = await fetch(
      `${this.baseHttpUrl}/v1/rollouts/${sessionId}`,
      {
        method: "DELETE",
        headers: this.headers(),
      },
    );

    if (!response.ok) {
      await this.handleError(response);
    }
  }
}
