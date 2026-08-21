/**
 * Parse the signal flags into a request body. Domain rules (column allowlists,
 * sample-rate bounds, field-name regex) live in app-server; duplicating them
 * here drifted from the server and the UI, and a 400 `{error}` is already shown
 * verbatim by `SignalsResource.raiseSignalError`.
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

/** `type` and `required` may be omitted; they default to `"object"` / all fields. */
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
    type:
      parsed.type === undefined
        ? "object"
        : (parsed.type as SignalStructuredOutput["type"]),
    properties:
      parsed.properties as unknown as SignalStructuredOutput["properties"],
    required:
      parsed.required === undefined
        ? Object.keys(parsed.properties)
        : (parsed.required as string[]),
  };
};

/**
 * Collector for repeatable flags. Must NOT be paired with a commander default of
 * `[]`: the handler would then always receive an array, so an absent flag would
 * read as "passed empty" and `signal update --prompt x` would clear the signal's
 * filters instead of leaving them alone.
 */
export const collectFlag = (val: string, prev: string[] = []): string[] => [
  ...prev,
  val,
];

export const TRIGGER_KINDS = ["root-span-finished", "span-name"] as const;

export type TriggerKind = (typeof TRIGGER_KINDS)[number];

/**
 * `--span-name` without `--trigger span-name` is an error rather than an implied
 * kind switch: inferring it would let a typo'd kind quietly change when the
 * signal fires.
 */
export const parseTrigger = (
  kind: string | undefined,
  spanNames: string[],
): SignalTrigger | undefined => {
  if (kind === undefined) {
    if (spanNames.length > 0) {
      throw new Error("--span-name requires --trigger span-name");
    }
    return undefined;
  }
  if (!(TRIGGER_KINDS as readonly string[]).includes(kind)) {
    throw new Error(
      `--trigger must be one of ${TRIGGER_KINDS.join(", ")} (got "${kind}")`,
    );
  }
  if (kind !== "span-name" && spanNames.length > 0) {
    throw new Error(
      `--span-name only applies to --trigger span-name, not ${kind}`,
    );
  }

  if (kind === "root-span-finished") return { type: "rootSpanFinished" };

  const names = spanNames
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  if (names.length === 0) {
    throw new Error(
      "--trigger span-name requires at least one --span-name, " +
        "or the signal would never fire",
    );
  }
  return { type: "spanName", spanNames: names };
};

/**
 * Filters stay `{column, operator, value}` JSON so new operators and richer
 * value types need no CLI change. Only the wire shape is checked here.
 */
export const parseFilter = (raw: string): SignalFilter => {
  const parsed = parseJsonArg(raw, "--filter");
  if (!isPlainObject(parsed)) {
    throw new Error(
      '--filter must be a JSON object like {"column":"total_token_count",' +
        '"operator":"gt","value":"1000"}',
    );
  }
  if (typeof parsed.column !== "string" || parsed.column.trim().length === 0) {
    throw new Error('--filter must carry a non-empty "column" string');
  }
  if (
    typeof parsed.operator !== "string" ||
    parsed.operator.trim().length === 0
  ) {
    throw new Error('--filter must carry a non-empty "operator" string');
  }
  if (parsed.value === undefined) {
    throw new Error('--filter must carry a "value"');
  }

  // Spread so any additional keys a future filter shape carries reach the server
  // untouched instead of being silently dropped here.
  return {
    ...parsed,
    column: parsed.column,
    operator: parsed.operator,
  } as SignalFilter;
};

export const MODES = ["batch", "realtime"] as const;

export const parseMode = (raw: string): SignalMode => {
  if (!(MODES as readonly string[]).includes(raw)) {
    throw new Error(`--mode must be one of ${MODES.join(", ")} (got "${raw}")`);
  }
  return raw as SignalMode;
};

/** The 1-95 range is enforced server-side. */
export const parseSampleRate = (raw: string): number => {
  const n = Number(raw);
  // `Number("")` is 0; `Number("abc")` is NaN.
  if (raw.trim() === "" || !Number.isInteger(n)) {
    throw new Error("--sample-rate must be an integer");
  }
  return n;
};

export const validateName = (name: string): string => {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new Error("Signal name is required");
  }
  return trimmed;
};

export const validatePrompt = (prompt: string): string => {
  if (prompt.trim().length === 0) {
    throw new Error("Signal prompt is required");
  }
  return prompt;
};
