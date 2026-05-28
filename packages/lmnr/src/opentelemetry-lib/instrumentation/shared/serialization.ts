import type { AttributeValue } from "@opentelemetry/api";

// JSON-stringify any value, returning a string unconditionally. Strings pass
// through. `undefined` and bare functions (which `JSON.stringify` would emit
// as the primitive `undefined`) collapse to `""` so callers writing OTel
// attributes always have a string. Circular refs / BigInt / other
// stringify-throws cases degrade to `"[unserializable]"`.
export const serializeJSON = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value === undefined || typeof value === "function") return "";
  try {
    const out = JSON.stringify(value);
    return out ?? "";
  } catch {
    return "[unserializable]";
  }
};

// Coerce `value` to an OTel `AttributeValue` (primitive, or homogeneous
// primitive array). Anything else falls back to `serializeJSON(value)` so the
// attribute is still set — OTel drops mixed / object values silently.
// Returns `undefined` when the value itself is `undefined` / `null` so callers
// can skip the attribute entirely.
export const toAttributeValue = (
  value: unknown,
): AttributeValue | undefined => {
  if (value === undefined || value === null) return undefined;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    if (value.every((v) => typeof v === "string")) return value;
    if (value.every((v) => typeof v === "number")) return value;
    if (value.every((v) => typeof v === "boolean")) return value;
  }
  return serializeJSON(value);
};
