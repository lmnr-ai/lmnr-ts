/**
 * Python semantics the lmnr-atif writer depends on.
 *
 * The writer is a line-by-line port of the Python SDK's
 * `lmnr/sdk/trajectory/`, and the shared golden suite pins its output byte for
 * byte. These helpers reproduce the Python idioms that JavaScript spells
 * differently: truthiness (`[]` and `{}` are falsy), `==` (`1 == 1.0`,
 * `True == 1`, deep and order-insensitive on dicts), `str()`, and
 * `json.dumps` formatting.
 *
 * Known differences that can't be fixed from JS: a parsed `1.0` is the number
 * `1` (Python re-serializes `1.0`), integers beyond 2^53 lose precision, and
 * objects put integer-like keys first. No golden case depends on them.
 */

export type Json = any;
export type JsonObject = Record<string, any>;

/** `isinstance(value, dict)` for parsed JSON. */
export const isDict = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `key in obj`, own keys only (`"constructor" in {}` is true in JS). */
export const has = (obj: JsonObject, key: string): boolean =>
  // biome-ignore lint/suspicious/noPrototypeBuiltins: `Object.hasOwn` is ES2022
  Object.prototype.hasOwnProperty.call(obj, key);

/** `obj.get(key)`: undefined when absent, never an inherited property. */
export const get = (obj: JsonObject, key: string): any =>
  has(obj, key) ? obj[key] : undefined;

/** `obj.setdefault(key, value)`: the existing value, or `value` once set. */
export const setdefault = <T>(obj: JsonObject, key: string, value: T): T => {
  if (!has(obj, key)) {
    obj[key] = value;
  }
  return obj[key];
};

/** `None` check: a missing key and a JSON null are both None. */
export const isNone = (value: unknown): value is null | undefined =>
  value === null || value === undefined;

/** Python truthiness: `None`, `False`, `0`, `""`, `[]` and `{}` are false. */
export const truthy = (value: unknown): boolean => {
  if (isNone(value) || value === false || value === 0 || value === "") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (isDict(value)) {
    return Object.keys(value).length > 0;
  }
  return true;
};

/** `a or b or ...`: the first truthy value, else the last one. */
export const or = (...values: unknown[]): any => {
  for (const value of values) {
    if (truthy(value)) {
      return value;
    }
  }
  return values[values.length - 1];
};

/** Python `==` on JSON values: numeric across bool/int/float, deep on lists
 * and dicts (dicts ignore key order), None only equals None. */
export const pyEquals = (a: unknown, b: unknown): boolean => {
  const numeric = (v: unknown) =>
    typeof v === "number" || typeof v === "boolean";
  if (numeric(a) && numeric(b)) {
    return Number(a) === Number(b);
  }
  if (isNone(a) || isNone(b)) {
    return isNone(a) && isNone(b);
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => pyEquals(v, b[i]))
    );
  }
  if (isDict(a) || isDict(b)) {
    if (!isDict(a) || !isDict(b)) {
      return false;
    }
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((k) => has(b, k) && pyEquals(a[k], b[k]))
    );
  }
  return a === b;
};

/** `value in values`, with Python `==`. */
export const pyIn = (value: unknown, values: unknown[]): boolean =>
  values.some((v) => pyEquals(value, v));

/** Python's `repr(float)`: shortest round-trip digits, exponent notation
 * below 1e-4 and from 1e16, as `1e-05` / `1.5e+16`. Integer-valued numbers
 * are written as ints (JS can't tell `1.0` from `1`). */
const formatNumber = (value: number): string => {
  if (Number.isNaN(value)) {
    return "NaN";
  }
  if (!Number.isFinite(value)) {
    return value > 0 ? "Infinity" : "-Infinity";
  }
  if (Number.isInteger(value)) {
    // Digits below 1e21 (Python's int), `1e+21` above (Python's float).
    return Object.is(value, -0) ? "0" : String(value);
  }
  const [mantissa, exponentText] = value.toExponential().split("e");
  const exponent = Number(exponentText);
  if (exponent < -4 || exponent >= 16) {
    const sign = exponent < 0 ? "-" : "+";
    return `${mantissa}e${sign}${String(Math.abs(exponent)).padStart(2, "0")}`;
  }
  return String(value);
};

const escapeNonAscii = (text: string): string =>
  text.replace(
    /[\u007f-￿]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

const dumps = (
  value: unknown,
  itemSeparator: string,
  keySeparator: string,
  sortKeys: boolean,
  ensureAscii: boolean,
): string => {
  const str = (s: string) => {
    const text = JSON.stringify(s);
    return ensureAscii ? escapeNonAscii(text) : text;
  };
  const visit = (v: unknown): string => {
    if (isNone(v)) {
      return "null";
    }
    if (typeof v === "boolean") {
      return v ? "true" : "false";
    }
    if (typeof v === "number") {
      return formatNumber(v);
    }
    if (typeof v === "string") {
      return str(v);
    }
    if (Array.isArray(v)) {
      return `[${v.map(visit).join(itemSeparator)}]`;
    }
    if (isDict(v)) {
      let keys = Object.keys(v).filter((k) => v[k] !== undefined);
      if (sortKeys) {
        keys = keys.sort(compareCodePoints);
      }
      const items = keys.map((k) => `${str(k)}${keySeparator}${visit(v[k])}`);
      return `{${items.join(itemSeparator)}}`;
    }
    // `default=str`.
    return str(pyStr(v));
  };
  return visit(value);
};

/** `json.dumps(value, ensure_ascii=False, default=str)`: Python's default
 * `", "` / `": "` separators. Pass `ensureAscii` for a bare `json.dumps`. */
export const pyJsonDumps = (
  value: unknown,
  options: { ensureAscii?: boolean } = {},
): string => dumps(value, ", ", ": ", false, options.ensureAscii ?? false);

/** `json.dumps(value, sort_keys=True, separators=(",", ":"),
 * ensure_ascii=False)`. Keys sort by code point, as Python's do. */
export const canonicalJson = (value: unknown): string =>
  dumps(value, ",", ":", true, false);

/** Order strings by code point (Python), not UTF-16 code unit (JS). */
export const compareCodePoints = (a: string, b: string): number => {
  const left = Array.from(a);
  const right = Array.from(b);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const diff = left[i].codePointAt(0)! - right[i].codePointAt(0)!;
    if (diff !== 0) {
      return diff;
    }
  }
  return left.length - right.length;
};

const pyRepr = (value: unknown): string => {
  if (typeof value === "string") {
    const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
    const escapes: Record<string, string> = {
      "\\": "\\\\",
      "\n": "\\n",
      "\r": "\\r",
      "\t": "\\t",
      [quote]: `\\${quote}`,
    };
    let body = "";
    for (const c of value) {
      const code = c.charCodeAt(0);
      if (has(escapes, c)) {
        body += escapes[c];
      } else if (code < 0x20 || code === 0x7f) {
        body += `\\x${code.toString(16).padStart(2, "0")}`;
      } else {
        body += c;
      }
    }
    return `${quote}${body}${quote}`;
  }
  if (Array.isArray(value)) {
    return `[${value.map(pyRepr).join(", ")}]`;
  }
  if (isDict(value)) {
    const items = Object.keys(value).map(
      (k) => `${pyRepr(k)}: ${pyRepr(value[k])}`,
    );
    return `{${items.join(", ")}}`;
  }
  return pyStr(value);
};

/** Python's `str(value)` for JSON values: `None`, `True`, reprs of
 * containers. */
export const pyStr = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  if (isNone(value)) {
    return "None";
  }
  if (typeof value === "boolean") {
    return value ? "True" : "False";
  }
  if (typeof value === "number") {
    return formatNumber(value);
  }
  if (Array.isArray(value) || isDict(value)) {
    return pyRepr(value);
  }
  return String(value);
};

/** `json.loads`, or undefined when the text isn't JSON. */
export const jsonLoads = (text: string): { value: Json } | undefined => {
  try {
    return { value: JSON.parse(text) };
  } catch {
    return undefined;
  }
};

/** `round(value, digits)`. Python rounds exact ties to even, `toFixed` away
 * from zero; ties of a binary float at a decimal digit are rare enough that
 * no output depends on them. */
export const pyRound = (value: number, digits: number): number =>
  Number(value.toFixed(digits));

/** `Counter(values)`: counts in first-seen order. */
export const counter = <T>(values: T[]): Map<T, number> => {
  const counts = new Map<T, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
};

/** Compare tuples of numbers lexicographically, as `sorted(key=tuple)`. */
export const compareTuples = (a: number[], b: number[]): number => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      return a[i] - b[i];
    }
  }
  return a.length - b.length;
};
