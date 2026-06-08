const MAX_SECONDS = 24 * 60 * 60;

/**
 * Parse a duration string like `60s`, `2m`, `1h`. Returns seconds, capped at
 * 24h. Returns null on malformed input (caller decides the fallback).
 *
 * Accepts: positive integers with optional unit suffix `s` (default), `m`, `h`.
 * Whitespace is trimmed. Negative or zero values reject. Values are capped at
 * MAX_SECONDS rather than rejecting so users can pass `99h` without surprise.
 */
export function parseDuration(raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null) return null;
  const trimmed = raw.trim().toLowerCase();
  const match = trimmed.match(/^(\d+)\s*(s|m|h)?$/);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = match[2] ?? "s";
  let seconds = n;
  if (unit === "m") seconds = n * 60;
  if (unit === "h") seconds = n * 3600;
  return Math.min(seconds, MAX_SECONDS);
}
