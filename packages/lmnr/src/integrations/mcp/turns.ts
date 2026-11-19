import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

import { isValidTraceId } from "../../opentelemetry-lib/tracing/id-generator";

export const DEFAULT_TURN_GAP_MS = 20_000;
/**
 * Must stay under the Signals settle window (30 s): Signals analyse a trace
 * once it has been quiet for 30 s, so a longer gap would let a Signal run
 * mid-turn.
 */
export const MAX_TURN_GAP_MS = 25_000;

const MAX_SESSIONS = 10_000;
const SWEEP_INTERVAL_MS = 30_000;
// A call whose handler never settles must not pin its session to one trace
// forever: an in-flight mark older than this no longer counts.
const STALE_IN_FLIGHT_MS = 10 * 60_000;

/**
 * Deterministic trace id for a client-supplied turn id: the first 16 bytes of
 * SHA-256 of `"{sessionId or ''}\n{turnId}"`, so every copy of the server puts
 * the turn in the same trace.
 */
export const traceIdForTurn = (
  sessionId: string | undefined,
  turnId: string,
): string =>
  bytesToHex(sha256(utf8ToBytes(`${sessionId ?? ""}\n${turnId}`))).slice(0, 32);

export interface RemoteParent {
  traceId: string;
  spanId: string;
  traceFlags: number;
}

const TRACEPARENT_RE =
  /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?$/;

/** Parse a W3C `traceparent`; undefined when it is not valid. */
export const parseTraceparent = (value: unknown): RemoteParent | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const match = TRACEPARENT_RE.exec(value.trim().toLowerCase());
  if (!match) {
    return undefined;
  }
  const [, version, traceId, spanId, flags, rest] = match;
  // Version ff is invalid; version 00 must have nothing after the flags.
  if (version === "ff" || (version === "00" && rest !== undefined)) {
    return undefined;
  }
  if (!isValidTraceId(traceId) || spanId === "0".repeat(16)) {
    return undefined;
  }
  return { traceId, spanId, traceFlags: parseInt(flags, 16) & 0xff };
};

/**
 * One turn of a session. `begin` / `start` hand it to the call, and the call
 * passes the same object to `end`, so a call only ever releases the turn it
 * joined: a later turn that replaced this one in the tracker is untouched.
 */
export interface Turn {
  readonly traceId: string;
  inFlight: number;
  lastActivity: number;
}

/**
 * In-process "one trace per user turn" tracker, keyed by MCP session id. A
 * call reuses the session's current trace id when another call of the session
 * is still in flight or the session's last activity (a call's start or end)
 * was at most `gapMs` ago; otherwise it starts a new trace.
 *
 * Per process: a stateful Streamable HTTP session lives in one process, so
 * this holds across server copies for those. A copy-shared store is a
 * follow-up.
 */
export class TurnTracker {
  private readonly entries = new Map<string, Turn>();
  private lastSweep = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * The session's current turn, which a call of `sessionId` starting now
   * joins, or undefined when the call starts a new turn. Marks the call in
   * flight; pass the turn to {@link end} when the call ends.
   */
  begin(sessionId: string, gapMs: number): Turn | undefined {
    const now = this.now();
    this.sweep(now);
    const entry = this.entries.get(sessionId);
    const idle = entry ? now - entry.lastActivity : Infinity;
    if (
      entry &&
      ((entry.inFlight > 0 && idle <= STALE_IN_FLIGHT_MS) || idle <= gapMs)
    ) {
      entry.inFlight += 1;
      entry.lastActivity = now;
      this.touch(sessionId, entry);
      return entry;
    }
    return undefined;
  }

  /**
   * Record that a call of `sessionId` started a new turn as `traceId`, with
   * the call in flight; pass the returned turn to {@link end}.
   */
  start(sessionId: string, traceId: string): Turn {
    const turn: Turn = {
      traceId,
      inFlight: 1,
      lastActivity: this.now(),
    };
    this.touch(sessionId, turn);
    this.evictOverflow();
    return turn;
  }

  /** Record that a call of `turn` ended. */
  end(turn: Turn): void {
    turn.inFlight = Math.max(0, turn.inFlight - 1);
    turn.lastActivity = this.now();
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  // Re-insert so Map iteration order is least-recently-used first.
  private touch(sessionId: string, entry: Turn) {
    this.entries.delete(sessionId);
    this.entries.set(sessionId, entry);
  }

  private sweep(now: number) {
    if (now - this.lastSweep < SWEEP_INTERVAL_MS) {
      return;
    }
    this.lastSweep = now;
    for (const [sessionId, entry] of this.entries) {
      const idle = now - entry.lastActivity;
      if (
        (entry.inFlight === 0 && idle > MAX_TURN_GAP_MS) ||
        idle > STALE_IN_FLIGHT_MS
      ) {
        this.entries.delete(sessionId);
      }
    }
  }

  private evictOverflow() {
    for (const [sessionId, entry] of this.entries) {
      if (this.entries.size <= MAX_SESSIONS) {
        return;
      }
      if (entry.inFlight === 0) {
        this.entries.delete(sessionId);
      }
    }
  }
}
