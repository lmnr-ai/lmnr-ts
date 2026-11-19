/**
 * Secret-key redaction for recorded MCP payloads. Always on. The rules and the
 * test vectors are shared with the Python SDK and app-server: change them
 * together.
 */

export const REDACTED = "[REDACTED]";

const SECRET_SUBSTRINGS = [
  "password",
  "passwd",
  "secret",
  "apikey",
  "privatekey",
  "accesskey",
  "authorization",
  "credential",
  "cookie",
  "signature",
];

const SECRET_EXACT = new Set(["auth", "pwd", "otp", "bearer", "jwt"]);

const MAX_DEPTH = 64;

/** Lowercase, all non-alphanumerics removed: `API-Key` -> `apikey`. */
export const normalizeKey = (key: string): string =>
  key.toLowerCase().replace(/[^a-z0-9]/g, "");

export const buildExtraKeys = (keys: readonly unknown[] | undefined) =>
  new Set(
    (keys ?? [])
      .filter((key): key is string => typeof key === "string")
      .map(normalizeKey)
      .filter((key) => key.length > 0),
  );

export const isSecretKey = (
  key: string,
  extraKeys?: ReadonlySet<string>,
): boolean => {
  const k = normalizeKey(key);
  if (k.length === 0) {
    return false;
  }
  if (extraKeys?.has(k)) {
    return true;
  }
  if (SECRET_EXACT.has(k)) {
    return true;
  }
  // `tokens` (e.g. `max_tokens`) does not end with `token`, so it stays.
  if (k.endsWith("token")) {
    return true;
  }
  return SECRET_SUBSTRINGS.some((part) => k.includes(part));
};

/**
 * A copy of `value` in which the value of every secret key, at any depth of
 * nested objects and arrays, is replaced by `[REDACTED]`. Never mutates
 * `value`. Cycles become `"[Circular reference]"`; values with `toJSON` (e.g.
 * `Date`) are converted first, like `JSON.stringify` would.
 */
export const redact = (
  value: unknown,
  extraKeys?: ReadonlySet<string>,
): unknown => {
  const ancestors: object[] = [];
  const walk = (node: unknown, depth: number): unknown => {
    if (node === null || typeof node !== "object") {
      return node;
    }
    if (typeof (node as { toJSON?: unknown }).toJSON === "function") {
      try {
        const converted = (node as { toJSON: () => unknown }).toJSON();
        if (converted !== node) {
          return walk(converted, depth);
        }
      } catch {
        return undefined;
      }
    }
    if (ancestors.includes(node)) {
      return "[Circular reference]";
    }
    if (depth >= MAX_DEPTH) {
      return "[Max depth]";
    }
    ancestors.push(node);
    try {
      if (Array.isArray(node)) {
        return node.map((item) => walk(item, depth + 1));
      }
      if (node instanceof Map) {
        return Array.from(node.entries()).map(([k, v]) => [
          k,
          typeof k === "string" && isSecretKey(k, extraKeys)
            ? REDACTED
            : walk(v, depth + 1),
        ]);
      }
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node)) {
        out[key] = isSecretKey(key, extraKeys)
          ? REDACTED
          : walk(child, depth + 1);
      }
      return out;
    } finally {
      ancestors.pop();
    }
  };
  return walk(value, 0);
};
