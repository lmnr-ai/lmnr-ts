/**
 * Debug-replay input hashing.
 *
 * Computes the per-LLM-call `input_hash` the server-side debugger cache (v2) is
 * keyed by. The SDK and the Rust app-server MUST produce byte-identical hashes,
 * so this is a faithful port of the app-server primitives:
 *   - `canonical_json`        — `app-server/src/traces/input_dedup.rs`
 *   - `extract_system_message`— `app-server/src/traces/prompt_hash.rs`
 *   - `debug_input_hash`      — `app-server/src/traces/debug_cache.rs` (plan 01 §3)
 *
 * The whole non-system message array is hashed as ONE blob: strip the first
 * `role === "system"` message (when its text is non-empty), canonicalize the
 * remaining array, then blake3 over its UTF-8 bytes and hex-encode the digest.
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
 * Extract the system prompt text from a system-role message, or "" when none.
 *
 * Faithful port of Rust `extract_system_message`'s text resolution: a plain
 * string content, else an array of `{text}` blocks joined by a space (only when
 * the join is non-empty), else `parts[0].text` / `parts[0].content`.
 */
const systemMessageText = (sysMsg: Record<string, unknown>): string => {
  const content = sysMsg.content;
  // "content": "plain string" (OpenAI format) — wins even when empty.
  if (typeof content === "string") {
    return content;
  }
  // "content": [{"text": "...", "type": "text"}, ...] (Anthropic format).
  if (Array.isArray(content)) {
    const joined = content
      .map((block) =>
        block !== null && typeof block === "object"
          ? (block as Record<string, unknown>).text
          : undefined,
      )
      .filter((t): t is string => typeof t === "string")
      .join(" ");
    if (joined.length > 0) {
      return joined;
    }
  }
  // "parts" shapes — only the first part is inspected (Gemini `{text}` /
  // OTel GenAI `{type, content}`).
  const parts = sysMsg.parts;
  if (Array.isArray(parts) && parts.length > 0) {
    const first = parts[0];
    if (first !== null && typeof first === "object") {
      const f = first as Record<string, unknown>;
      const t = typeof f.text === "string" ? f.text : f.content;
      if (typeof t === "string") {
        return t;
      }
    }
  }
  return "";
};

/**
 * Drop the first `role === "system"` message, matching the server.
 *
 * Returns the array unchanged when there is no system message OR when the system
 * message's resolved text is empty (Rust `extract_system_message` returns `None`
 * in both cases, leaving the system message in the hashed array).
 */
const stripSystemMessage = (messages: unknown[]): unknown[] => {
  const sysIdx = messages.findIndex(
    (m) =>
      m !== null &&
      typeof m === "object" &&
      (m as Record<string, unknown>).role === "system",
  );
  if (sysIdx === -1) {
    return messages;
  }
  const sysText = systemMessageText(messages[sysIdx] as Record<string, unknown>);
  if (sysText.length === 0) {
    return messages;
  }
  return messages.filter((_, i) => i !== sysIdx);
};

/**
 * Compute the hex blake3 `input_hash` for a reconstructed message array.
 *
 * `messages` must already be the server's reconstructed shape (the SDK reshapes
 * provider-specific prompts via `aisdk-normalize.ts` so the hashed bytes match
 * what `spans_v0` stores). The system message is stripped, the remainder
 * canonicalized, and the digest hex-encoded (64 chars).
 */
export const debugInputHash = (messages: unknown[]): string => {
  const stripped = stripSystemMessage(messages);
  const canonical = canonicalJson(stripped);
  const digest = blake3(new TextEncoder().encode(canonical));
  return bytesToHex(digest);
};
