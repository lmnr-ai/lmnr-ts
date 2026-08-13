/**
 * Client-side validation for the `signal` commands, mirroring what the Laminar
 * create-signal drawer enforces so an agent gets a fast, actionable error before
 * any network call. The app-server re-validates all of it — this is UX, not a
 * security boundary.
 *
 * The trigger model has TWO lists with different meanings, and mixing them up
 * silently produces a signal that looks configured but never fires:
 *
 * - `conditions` — WHEN the signal is evaluated. Decidable from a single span
 *   batch. Columns: `root_span_finished`, `span_name`. EMPTY never fires.
 * - `filters` — WHETHER a fired trigger runs. Properties of the whole trace,
 *   read back from ClickHouse. Columns: `total_token_count`, `status`,
 *   `span_names`. Empty passes (run on every trace the trigger fires for).
 *
 * `span_name` (condition, matches only the firing batch) and `span_names`
 * (filter, matches anywhere in the trace) are DIFFERENT columns — so a column
 * used in the wrong list is rejected with a message naming the right one.
 */

import type {
  SignalFilter,
  SignalStructuredOutput,
  SignalTrigger,
} from "@lmnr-ai/client";

// Same regex as the UI form rule and the Rust PAYLOAD_FIELD_NAME_RE. Non-identifier
// names are silently unsearchable/unsortable server-side, so reject them here.
const FIELD_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

const PROPERTY_TYPES = ["string", "number", "boolean"] as const;
type PropertyType = (typeof PROPERTY_TYPES)[number];

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
 * Parse + validate the payload schema JSON. `type` and `required` may be omitted
 * and are normalized to `"object"` / all property names — the UI always marks
 * every field required, so a PARTIAL `required` list is rejected rather than
 * silently widened.
 */
export const parseStructuredOutput = (raw: string): SignalStructuredOutput => {
  const parsed = parseJsonArg(raw, "--schema");
  if (!isPlainObject(parsed)) {
    throw new Error(
      "--schema must be a JSON object like " +
      '{"type":"object","properties":{...},"required":[...]}',
    );
  }

  const { type, properties, required, ...rest } = parsed;
  const extraKeys = Object.keys(rest);
  if (extraKeys.length > 0) {
    throw new Error(`--schema has unsupported top-level keys: ${extraKeys.join(", ")}`);
  }
  if (type !== undefined && type !== "object") {
    throw new Error('--schema "type" must be "object"');
  }
  if (!isPlainObject(properties)) {
    throw new Error('--schema must carry a "properties" object with at least one field');
  }

  const names = Object.keys(properties);
  if (names.length === 0) {
    throw new Error("--schema must define at least one payload field");
  }

  const outProperties: SignalStructuredOutput["properties"] = {};
  for (const name of names) {
    if (!FIELD_NAME_RE.test(name)) {
      throw new Error(
        `Field name "${name}" must be a valid identifier ` +
        "(letters, digits, underscores; not starting with a digit)",
      );
    }
    outProperties[name] = parseProperty(name, properties[name]);
  }

  if (required !== undefined) {
    if (!Array.isArray(required) || required.some((r) => typeof r !== "string")) {
      throw new Error('--schema "required" must be an array of field names');
    }
    const requiredSet = new Set(required);
    const matchesAll =
      requiredSet.size === names.length && names.every((n) => requiredSet.has(n));
    if (!matchesAll) {
      throw new Error(
        '--schema "required" must list exactly the property names — ' +
        "every payload field is required (same rule as the UI)",
      );
    }
  }

  return { type: "object", properties: outProperties, required: names };
};

const parseProperty = (
  name: string,
  value: unknown,
): SignalStructuredOutput["properties"][string] => {
  if (!isPlainObject(value)) {
    throw new Error(
      `Field "${name}" must be an object like {"type":"string","description":"..."}`,
    );
  }
  const { type, description, enum: enumValues, ...rest } = value;
  const extraKeys = Object.keys(rest);
  if (extraKeys.length > 0) {
    throw new Error(`Field "${name}" has unsupported keys: ${extraKeys.join(", ")}`);
  }
  if (typeof type !== "string" || !PROPERTY_TYPES.includes(type as PropertyType)) {
    throw new Error(
      `Field "${name}" type must be one of: ${PROPERTY_TYPES.join(", ")} ` +
      '(for an enum, use type "string" with an "enum" array)',
    );
  }
  // The server requires a description (it's what the LLM reads to fill the
  // field), so default it to "" rather than omitting the key.
  if (description !== undefined && typeof description !== "string") {
    throw new Error(`Field "${name}" description must be a string`);
  }

  const property: SignalStructuredOutput["properties"][string] = {
    type,
    description: description ?? "",
  };

  if (enumValues !== undefined) {
    if (type !== "string") {
      throw new Error(`Field "${name}": enum values are only allowed on string fields`);
    }
    if (
      !Array.isArray(enumValues) ||
      enumValues.length === 0 ||
      enumValues.some((v) => typeof v !== "string" || v.trim().length === 0)
    ) {
      throw new Error(`Field "${name}" enum must be a non-empty array of non-empty strings`);
    }
    const trimmed = enumValues.map((v) => (v as string).trim());
    if (new Set(trimmed).size !== trimmed.length) {
      throw new Error(`Field "${name}" enum values must be unique`);
    }
    property.enum = trimmed;
  }

  return property;
};

const EQ_NE = ["eq", "ne"] as const;
const NUMBER_OPS = ["eq", "ne", "gt", "gte", "lt", "lte"] as const;

interface ColumnSpec {
  operators: readonly string[];
  validateValue: (value: unknown, operator: string) => SignalFilter["value"];
}

/** Trigger CONDITION columns — WHEN to evaluate. */
const CONDITION_COLUMNS: Record<string, ColumnSpec> = {
  root_span_finished: {
    operators: ["eq"],
    validateValue: (value) => {
      // The evaluator compares against the STRING "true", so a JSON boolean
      // would never match.
      if (value !== "true") {
        throw new Error('Condition "root_span_finished" value must be the string "true"');
      }
      return value;
    },
  },
  span_name: {
    operators: ["eq", "ne", "includes"],
    validateValue: (value, operator) => {
      const names = (Array.isArray(value) ? value : [value]).map((v) => {
        if (typeof v !== "string") {
          throw new Error('Condition "span_name" values must be strings');
        }
        return v.trim();
      }).filter((v) => v.length > 0);

      if (names.length === 0) {
        throw new Error('Condition "span_name" requires at least one non-blank span name');
      }
      // `includes` is the array-valued operator; eq/ne are scalar, so multiple
      // names under eq could never match.
      if (operator === "includes") {
        return names;
      }
      if (names.length > 1) {
        throw new Error(
          'Condition "span_name" with multiple names must use the "includes" operator',
        );
      }
      return names[0];
    },
  },
};

/** Trigger FILTER columns — WHETHER to run. */
const FILTER_COLUMNS: Record<string, ColumnSpec> = {
  total_token_count: {
    operators: NUMBER_OPS,
    validateValue: (value) => {
      if (typeof value === "number") {
        if (!Number.isFinite(value)) {
          throw new Error('Filter "total_token_count" value must be a finite number');
        }
        return value;
      }
      // Number(" ") is 0, so trim before the emptiness check or a whitespace-only
      // string would pass as a valid threshold. The server also trims before
      // storing, since its evaluator's parse does NOT trim.
      const trimmed = typeof value === "string" ? value.trim() : "";
      if (trimmed.length === 0 || !Number.isFinite(Number(trimmed))) {
        throw new Error('Filter "total_token_count" value must be a finite number');
      }
      return trimmed;
    },
  },
  status: {
    operators: EQ_NE,
    validateValue: (value) => {
      // The evaluator derives status from has_error, so nothing else can match.
      if (value !== "error" && value !== "success") {
        throw new Error('Filter "status" value must be "error" or "success"');
      }
      return value;
    },
  },
  span_names: {
    operators: EQ_NE,
    validateValue: (value) => {
      // A blank target matches EVERYTHING under `ne`, so it must be rejected.
      const trimmed = typeof value === "string" ? value.trim() : "";
      if (trimmed.length === 0) {
        throw new Error('Filter "span_names" value must be a non-blank span name');
      }
      return trimmed;
    },
  },
};

const parseEntry = (
  value: unknown,
  columns: Record<string, ColumnSpec>,
  otherColumns: Record<string, ColumnSpec>,
  kind: "condition" | "filter",
): SignalFilter => {
  if (!isPlainObject(value)) {
    throw new Error(
      `Each ${kind} must be an object like ` +
      '{"column":...,"operator":...,"value":...}',
    );
  }
  const { column, operator, value: entryValue, ...rest } = value;
  const extraKeys = Object.keys(rest);
  if (extraKeys.length > 0) {
    throw new Error(`A ${kind} has unsupported keys: ${extraKeys.join(", ")}`);
  }
  if (typeof column !== "string") {
    throw new Error(`Each ${kind} needs a "column"`);
  }
  if (!(column in columns)) {
    // Name the right list explicitly: the two column sets are easy to confuse
    // (span_name vs span_names), and a wrong-list entry silently never fires.
    if (column in otherColumns) {
      const right = kind === "condition" ? "filters" : "conditions";
      const wrong = kind === "condition" ? "a filter" : "a trigger condition";
      throw new Error(`"${column}" is ${wrong} column — pass it in \`${right}\``);
    }
    throw new Error(
      `${kind === "condition" ? "Condition" : "Filter"} column must be one of: ` +
      Object.keys(columns).join(", "),
    );
  }
  const spec = columns[column];
  if (typeof operator !== "string" || !spec.operators.includes(operator)) {
    throw new Error(
      `${kind === "condition" ? "Condition" : "Filter"} "${column}" operator must be one of: ` +
      spec.operators.join(", "),
    );
  }
  return { column, operator, value: spec.validateValue(entryValue, operator) };
};

/** Parse + validate one `--trigger` JSON argument. */
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
  // An empty condition list never fires, which would produce a signal that looks
  // configured but is silently inert.
  if (!Array.isArray(conditions) || conditions.length === 0) {
    throw new Error('--trigger must carry a non-empty "conditions" array');
  }
  if (filters !== undefined && !Array.isArray(filters)) {
    throw new Error('--trigger "filters" must be an array');
  }
  if (mode !== undefined && mode !== 0 && mode !== 1) {
    throw new Error("--trigger mode must be 0 (batch) or 1 (realtime)");
  }

  return {
    conditions: conditions.map((c) =>
      parseEntry(c, CONDITION_COLUMNS, FILTER_COLUMNS, "condition"),
    ),
    // Empty filters is legitimate: run on every trace the trigger fires for.
    filters: (filters ?? []).map((f) =>
      parseEntry(f, FILTER_COLUMNS, CONDITION_COLUMNS, "filter"),
    ),
    ...(mode !== undefined ? { mode } : {}),
  };
};

/** Validate `--sample-rate`: an integer percent in 1..95, like the server gate. */
export const parseSampleRate = (raw: string): number => {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 95) {
    throw new Error("--sample-rate must be an integer between 1 and 95");
  }
  return n;
};

/** Validate the signal name: non-empty, at most 255 chars (UI + server rule). */
export const validateName = (name: string): string => {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new Error("Signal name is required");
  }
  // Characters, not bytes — a multibyte name at the boundary is still valid.
  if ([...trimmed].length > 255) {
    throw new Error("Signal name must be at most 255 characters");
  }
  return trimmed;
};

/** Validate the prompt: non-empty (the UI requires it). */
export const validatePrompt = (prompt: string): string => {
  if (prompt.trim().length === 0) {
    throw new Error("Signal prompt is required");
  }
  return prompt;
};
