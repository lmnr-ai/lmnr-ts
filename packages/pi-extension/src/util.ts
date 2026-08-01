import { MAX_CHARS } from "./config.js";
import type { Json } from "./types.js";

/** JSON.stringify with a fallback for non-serializable values. */
export function jsonDumps(value: Json): string {
  return JSON.stringify(value, (_key: string, v: unknown): unknown => {
    if (typeof v === "bigint" || typeof v === "symbol" || typeof v === "function") {
      return String(v);
    }
    return v;
  });
}

/** Truncate a string to MAX_CHARS, appending a marker when clipped. */
export function truncateText(text: string, maxChars = MAX_CHARS): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}… [truncated ${text.length - maxChars} chars]`;
}

/** JSON-serialize then truncate — used for span input/output values. */
export function jsonDumpsTruncated(value: Json, maxChars = MAX_CHARS): string {
  return truncateText(jsonDumps(value), maxChars);
}

/** Parse a pi timestamp (ISO string) to a Date, or null. */
export function parseTimestamp(ts: unknown): Date | null {
  if (typeof ts !== "string") {
    return null;
  }
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Extract concatenated text from a pi content array (text blocks only). */
export function extractText(content: Json): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of content) {
    if (
      block && typeof block === "object" &&
      block.type === "text" && typeof block.text === "string"
    ) {
      parts.push(block.text);
    }
  }
  return parts.join("");
}
