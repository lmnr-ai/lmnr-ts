import { initializeLogger } from "../../utils";
import { buildExtraKeys } from "./redact";
import { DEFAULT_TURN_GAP_MS, MAX_TURN_GAP_MS } from "./turns";

const logger = initializeLogger();

export interface WrapMcpServerOptions {
  /**
   * Add an optional `context` string argument to every tool's advertised
   * input schema, asking the model for one sentence on the user's overall
   * goal. It is removed before the SDK validates the arguments and before the
   * tool handler runs, and recorded on the span as `lmnr.mcp.context`. Tools
   * that already declare their own `context` argument are left alone.
   * Always off when `recordPayloads` is false. Defaults to true.
   */
  context?: boolean;
  /**
   * Record arguments, results, the `context` argument and resource URIs
   * (redacted). False records only names, counts and errors. Defaults to true.
   */
  recordPayloads?: boolean;
  /**
   * Extra key names whose values are replaced with `[REDACTED]` in recorded
   * payloads, on top of the built-in secret-key rules. Matched
   * case-insensitively, ignoring non-alphanumerics (`API-Key` = `apikey`).
   */
  redactKeys?: string[];
  /**
   * Requests of one MCP session less than this many milliseconds apart (or
   * overlapping) are grouped into one trace, one trace per user turn.
   * Defaults to 20000; values above 25000 are clamped to 25000.
   */
  turnGapMs?: number;
}

export interface ResolvedOptions {
  context: boolean;
  recordPayloads: boolean;
  extraKeys: ReadonlySet<string>;
  turnGapMs: number;
}

const resolveTurnGapMs = (turnGapMs: unknown): number => {
  if (turnGapMs === undefined) {
    return DEFAULT_TURN_GAP_MS;
  }
  if (
    typeof turnGapMs !== "number" ||
    !Number.isFinite(turnGapMs) ||
    turnGapMs < 0
  ) {
    logger.warn(
      `Laminar MCP: invalid turnGapMs ${String(turnGapMs)}, ` +
        `using ${DEFAULT_TURN_GAP_MS}`,
    );
    return DEFAULT_TURN_GAP_MS;
  }
  if (turnGapMs > MAX_TURN_GAP_MS) {
    logger.warn(
      `Laminar MCP: turnGapMs ${turnGapMs} is above the maximum ` +
        `of ${MAX_TURN_GAP_MS} (it must stay under the 30 s Signals settle ` +
        `window), using ${MAX_TURN_GAP_MS}`,
    );
    return MAX_TURN_GAP_MS;
  }
  return turnGapMs;
};

/** Exported for tests. */
export const resolveMcpOptions = (
  options: WrapMcpServerOptions = {},
): ResolvedOptions => {
  const recordPayloads = options.recordPayloads !== false;
  return {
    context: recordPayloads && options.context !== false,
    recordPayloads,
    extraKeys: buildExtraKeys(options.redactKeys),
    turnGapMs: resolveTurnGapMs(options.turnGapMs),
  };
};
