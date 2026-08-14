/**
 * Parse `--schema` / `--trigger` / `--sample-rate` into the request body.
 *
 * Domain rules (column allowlists, sample-rate bounds, field-name regex, the
 * conditions/filters split, …) live in app-server. Duplicating them here drifted
 * from the server and the UI; a 400 `{error}` is already unwrapped for the user
 * by `SignalsResource.raiseSignalError`. This file only:
 *
 * - JSON-parses flag strings (with the flag name in the error)
 * - fills omitted schema `type` / `required` so the short `--schema` in --help
 *   matches what the UI stores
 * - rejects values that are not a sendable wire shape (non-object JSON, NaN)
 */

import type {
  SignalFilter,
  SignalStructuredOutput,
  SignalTrigger,
} from "@lmnr-ai/client";

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

/** Parse one `--trigger` JSON argument. Column/operator/value rules are server-side. */
export const parseTrigger = (raw: string): SignalTrigger => {
  const parsed = parseJsonArg(raw, "--trigger");
  if (!isPlainObject(parsed)) {
    throw new Error(
      '--trigger must be a JSON object like {"conditions":[...],"filters":[...]}',
    );
  }
  const { conditions, filters, mode, ...rest } = parsed;
  const extraKeys = Object.keys(rest);
  if (extraKeys.length > 0) {
    throw new Error(`--trigger has unsupported keys: ${extraKeys.join(", ")}`);
  }
  if (conditions !== undefined && !Array.isArray(conditions)) {
    throw new Error('--trigger "conditions" must be an array');
  }
  if (filters !== undefined && !Array.isArray(filters)) {
    throw new Error('--trigger "filters" must be an array');
  }

  return {
    conditions: (conditions ?? []) as SignalFilter[],
    filters: (filters ?? []) as SignalFilter[],
    ...(mode !== undefined ? { mode: mode as number } : {}),
  };
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
