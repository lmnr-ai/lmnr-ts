/**
 * Parse the signal flags into a request body.
 *
 * Domain rules (column allowlists, sample-rate bounds, field-name regex, …) live
 * in app-server. Duplicating them here drifted from the server and the UI; a 400
 * `{error}` is already unwrapped for the user by
 * `SignalsResource.raiseSignalError`. This file only:
 *
 * - turns the flag syntax into the wire shape (trigger kind → tagged object,
 *   `"col op value"` → `{column, operator, value}`)
 * - JSON-parses `--schema` and fills omitted `type` / `required` so the short
 *   form in --help matches what the UI stores
 * - rejects values that are not a sendable wire shape (non-object JSON, NaN)
 */

import type {
  SignalFilter,
  SignalMode,
  SignalStructuredOutput,
  SignalTrigger,
} from "@lmnr-ai/types";

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const parseJsonArg = (raw: string, what: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${what} is not valid JSON: ${raw.slice(0, 200)}`);
  }
};

/**
 * Parse the payload schema JSON. `type` and `required` may be omitted — the
 * help example is just `{"properties":{...}}` — and are filled to `"object"` /
 * all property names. Everything else is sent as-is for the server to validate.
 */
export const parseStructuredOutput = (raw: string): SignalStructuredOutput => {
  const parsed = parseJsonArg(raw, "--schema");
  if (!isPlainObject(parsed)) {
    throw new Error(
      "--schema must be a JSON object like " +
      '{"type":"object","properties":{...},"required":[...]}',
    );
  }
  if (!isPlainObject(parsed.properties)) {
    throw new Error('--schema must carry a "properties" object');
  }

  return {
    type: parsed.type === undefined ? "object" : parsed.type as SignalStructuredOutput["type"],
    properties: parsed.properties as unknown as SignalStructuredOutput["properties"],
    required: parsed.required === undefined
      ? Object.keys(parsed.properties)
      : parsed.required as string[],
  };
};

/** `--trigger` values. `none` means the signal only runs via backfill. */
export const TRIGGER_KINDS = ["root-span-finished", "span-name", "none"] as const;

export type TriggerKind = (typeof TRIGGER_KINDS)[number];

/**
 * Build the trigger from `--trigger` plus `--span-name`. Returns `null` for
 * `none`, which the server stores as "never fires on its own".
 *
 * `--span-name` without `--trigger span-name` is an ERROR rather than an implied
 * kind switch: silently inferring it would make a typo'd trigger kind change
 * when the signal fires, which is exactly the class of quiet misconfiguration
 * this command tries to make impossible.
 */
export const parseTrigger = (
  kind: string | undefined,
  spanNames: string[],
): SignalTrigger | null | undefined => {
  if (kind === undefined) {
    if (spanNames.length > 0) {
      throw new Error("--span-name requires --trigger span-name");
    }
    return undefined;
  }
  if (!(TRIGGER_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`--trigger must be one of ${TRIGGER_KINDS.join(", ")} (got "${kind}")`);
  }
  if (kind !== "span-name" && spanNames.length > 0) {
    throw new Error(`--span-name only applies to --trigger span-name, not ${kind}`);
  }

  if (kind === "none") return null;
  if (kind === "root-span-finished") return { type: "rootSpanFinished" };

  const names = spanNames.map((name) => name.trim()).filter((name) => name.length > 0);
  if (names.length === 0) {
    throw new Error(
      "--trigger span-name requires at least one --span-name, " +
      "or the signal would never fire",
    );
  }
  return { type: "spanName", spanNames: names };
};

/**
 * Filter operators, longest first so `>=` is matched before `>`. `=` / `!=` on
 * `span_names` read as include / do not include, matching the UI's labels.
 */
const FILTER_OPERATORS: [string, string][] = [
  [">=", "gte"],
  ["<=", "lte"],
  ["!=", "ne"],
  [">", "gt"],
  ["<", "lt"],
  ["=", "eq"],
];

/**
 * Parse one `--filter "<column> <op> <value>"`. The value keeps its literal text
 * (the server coerces and validates it) except for surrounding quotes, so a span
 * name with spaces can be passed as `span_names = "my span"`.
 */
export const parseFilter = (raw: string): SignalFilter => {
  const match = FILTER_OPERATORS.flatMap(([symbol, operator]) => {
    const at = raw.indexOf(symbol);
    return at === -1 ? [] : [{ at, symbol, operator }];
  })
    // Earliest position wins so the column can't swallow an operator; ties go to
    // the longer symbol, which is why `>=` is listed before `>` and `sort` is
    // stable.
    .sort((a, b) => a.at - b.at)[0];

  if (!match) {
    throw new Error(
      `--filter must look like "<column> <operator> <value>" ` +
      `(operators: ${FILTER_OPERATORS.map(([s]) => s).join(" ")}), got: ${raw}`,
    );
  }

  const column = raw.slice(0, match.at).trim();
  const value = stripQuotes(raw.slice(match.at + match.symbol.length).trim());
  if (column.length === 0) {
    throw new Error(`--filter is missing a column before "${match.symbol}": ${raw}`);
  }
  if (value.length === 0) {
    throw new Error(`--filter is missing a value after "${match.symbol}": ${raw}`);
  }

  return { column, operator: match.operator, value };
};

const stripQuotes = (value: string): string =>
  (value.length >= 2 && (value.startsWith('"') || value.startsWith("'"))
    && value[0] === value[value.length - 1])
    ? value.slice(1, -1)
    : value;

export const MODES = ["batch", "realtime"] as const;

export const parseMode = (raw: string): SignalMode => {
  if (!(MODES as readonly string[]).includes(raw)) {
    throw new Error(`--mode must be one of ${MODES.join(", ")} (got "${raw}")`);
  }
  return raw as SignalMode;
};

/** Coerce `--sample-rate` to an integer. The 1–95 range is enforced server-side. */
export const parseSampleRate = (raw: string): number => {
  const n = Number(raw);
  // `Number("")` is 0; `Number("abc")` is NaN, which stringifies to `null`
  // and would look like `--no-sampling` on update.
  if (raw.trim() === "" || !Number.isInteger(n)) {
    throw new Error("--sample-rate must be an integer");
  }
  return n;
};

/** Trim the signal name. Empty after trim is a missing positional, not a 400. */
export const validateName = (name: string): string => {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new Error("Signal name is required");
  }
  return trimmed;
};

/** Reject a blank `--prompt` so we don't round-trip an empty required flag. */
export const validatePrompt = (prompt: string): string => {
  if (prompt.trim().length === 0) {
    throw new Error("Signal prompt is required");
  }
  return prompt;
};
