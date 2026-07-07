/**
 * Debug-replay input hashing.
 *
 * Computes the per-LLM-call `input_hash` the server-side debugger cache (v2) is
 * keyed by. The SDK and the Rust app-server MUST produce byte-identical hashes,
 * so this is a faithful port of the app-server primitives:
 *   - `canonical_json`     — `app-server/src/traces/input_dedup.rs`
 *   - `debug_input_hash`   — `app-server/src/traces/input_dedup.rs`
 *
 * The whole non-system message array is hashed as ONE blob: strip EVERY
 * `role === "system"` message (regardless of content or position), canonicalize
 * the remaining array, then blake3 over its UTF-8 bytes and hex-encode the
 * digest.
 *
 * Keep this file line-comparable with the Python `debug/hash.py`.
 */

import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";

/**
 * JSON with object keys sorted lexicographically (recursively); array order is
 * preserved. Mirrors Rust `canonical_json`.
 *
 * Limitation (parity with v1 server): there is NO number canonicalization, so a
 * value parsed as `1.0` serializes as `1` here (JS) and as `1.0` under serde —
 * a known v1 gap, documented in the shared spec §5.1. Object keys are assumed
 * ASCII (message-shape keys always are), so default UTF-16 sort matches Rust's
 * byte-wise `String::cmp`.
 */
export const canonicalJson = (value: unknown): string => {
  if (value === null || value === undefined) {
    return "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      // serde skips `None` fields, so an `undefined` value is omitted entirely
      // rather than serialized — keep parity by dropping it before sorting.
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const body = entries
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(",");
    return `{${body}}`;
  }
  // Scalars (string / number / boolean): JSON.stringify matches serde for
  // strings, booleans and integers; floats differ (see limitation above).
  return JSON.stringify(value);
};

/**
 * Drop EVERY `role === "system"` message, matching the server.
 *
 * Content and position are irrelevant: an empty system string, a block-array
 * system, or repeated/trailing system messages are all stripped. The coding
 * agent may add/remove/edit its own system prompt(s) between iterations and
 * those edits must not change the cache key.
 */
const stripSystemMessages = (messages: unknown[]): unknown[] =>
  messages.filter(
    (m) =>
      !(
        m !== null &&
        typeof m === "object" &&
        (m as Record<string, unknown>).role === "system"
      ),
  );

/**
 * Compute the hex blake3 `input_hash` for a message array.
 *
 * `messages` is the verbatim LanguageModel-level prompt
 * (`JSON.parse(stringifyPromptForTelemetry(options.prompt))`) — the same bytes
 * the SDK records as `gen_ai.input.messages` and the server hashes on ingest.
 * System messages are stripped, the remainder canonicalized, and the digest
 * hex-encoded (64 chars).
 */
export const debugInputHash = (messages: unknown[]): string => {
  const stripped = stripSystemMessages(messages);
  const canonical = canonicalJson(stripped);
  const digest = blake3(new TextEncoder().encode(canonical));
  return bytesToHex(digest);
};
