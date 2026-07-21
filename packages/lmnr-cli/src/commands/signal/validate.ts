/**
 * Client-side validation for `signal create`, mirroring the constraints the
 * Laminar UI's create-signal drawer imposes:
 * - payload schema: `schemaFieldsToJsonSchema` + the per-field rules in
 *   `schema-field-row.tsx` (identifier field names, string/number/boolean
 *   types, enum values only on strings, every field required);
 * - triggers: `SIGNAL_TRIGGER_COLUMNS` + `dataTypeOperationsMap` (four
 *   columns with pinned operators/values).
 * Field names MUST be identifiers — the backend search/sort paths silently
 * drop non-identifier payload fields, so we reject them at creation time.
 */

// Same regex as the UI form rule and the Rust PAYLOAD_FIELD_NAME_RE.
const FIELD_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

const PROPERTY_TYPES = ["string", "number", "boolean"] as const;
type PropertyType = (typeof PROPERTY_TYPES)[number];

export interface SchemaProperty {
  type: PropertyType;
  description: string;
  enum?: string[];
}

export interface StructuredOutput {
  type: "object";
  properties: Record<string, SchemaProperty>;
  required: string[];
}

export interface TriggerFilter {
  column: string;
  operator: string;
  value: string | number;
}

export interface Trigger {
  filters: TriggerFilter[];
  /** 0 = batch, 1 = realtime */
  mode: number;
}

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
 * Parse + validate the payload schema JSON. Accepts the stored JSON Schema
 * shape (`{type: "object", properties, required}`); `type` and `required` may
 * be omitted and are normalized to `"object"` / all property names — the UI
 * always marks every field required, so a partial `required` list is rejected.
 */
export const parseStructuredOutput = (raw: string): StructuredOutput => {
  const parsed = parseJsonArg(raw, "--schema");
  if (!isPlainObject(parsed)) {
    throw new Error("--schema must be a JSON object like " +
      '{"type":"object","properties":{...},"required":[...]}');
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

  const outProperties: Record<string, SchemaProperty> = {};
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
    if (
      !Array.isArray(required) ||
      required.some((r) => typeof r !== "string")
    ) {
      throw new Error('--schema "required" must be an array of field names');
    }
    const requiredSet = new Set(required as string[]);
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

const parseProperty = (name: string, value: unknown): SchemaProperty => {
  if (!isPlainObject(value)) {
    throw new Error(`Field "${name}" must be an object like {"type":"string","description":"..."}`);
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
  if (description !== undefined && typeof description !== "string") {
    throw new Error(`Field "${name}" description must be a string`);
  }

  const property: SchemaProperty = {
    type: type as PropertyType,
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
    const trimmed = (enumValues as string[]).map((v) => v.trim());
    if (new Set(trimmed).size !== trimmed.length) {
      throw new Error(`Field "${name}" enum values must be unique`);
    }
    property.enum = trimmed;
  }

  return property;
};

// The trigger columns the UI offers, with their allowed operators and value
// shapes (SIGNAL_TRIGGER_COLUMNS + dataTypeOperationsMap). `includes` is
// deliberately absent — the backend trigger evaluator drops it.
const EQ_NE = ["eq", "ne"] as const;
const NUMBER_OPS = ["eq", "ne", "gt", "gte", "lt", "lte"] as const;

const TRIGGER_COLUMNS: Record<
  string,
  { operators: readonly string[]; validateValue: (value: unknown) => string | number }
> = {
  span_name: {
    operators: EQ_NE,
    validateValue: (value) => {
      if (typeof value !== "string" || value.length === 0) {
        throw new Error('Trigger filter "span_name" value must be a non-empty string');
      }
      return value;
    },
  },
  status: {
    operators: EQ_NE,
    validateValue: (value) => {
      if (value !== "error") {
        throw new Error('Trigger filter "status" value must be "error"');
      }
      return value;
    },
  },
  root_span_finished: {
    operators: EQ_NE,
    validateValue: (value) => {
      if (value !== "true") {
        throw new Error('Trigger filter "root_span_finished" value must be "true"');
      }
      return value;
    },
  },
  total_token_count: {
    operators: NUMBER_OPS,
    validateValue: (value) => {
      const ok =
        typeof value === "number" ||
        (typeof value === "string" && value.length > 0 && Number.isFinite(Number(value)));
      if (!ok) {
        throw new Error('Trigger filter "total_token_count" value must be a number');
      }
      return value;
    },
  },
};

/** Parse + validate one `--trigger` JSON argument. */
export const parseTrigger = (raw: string): Trigger => {
  const parsed = parseJsonArg(raw, "--trigger");
  if (!isPlainObject(parsed)) {
    throw new Error('--trigger must be a JSON object like {"filters":[...]}');
  }
  const { filters, mode, ...rest } = parsed;
  const extraKeys = Object.keys(rest);
  if (extraKeys.length > 0) {
    throw new Error(`--trigger has unsupported keys: ${extraKeys.join(", ")}`);
  }
  if (!Array.isArray(filters) || filters.length === 0) {
    throw new Error('--trigger must carry a non-empty "filters" array');
  }
  if (mode !== undefined && mode !== 0 && mode !== 1) {
    throw new Error("--trigger mode must be 0 (batch) or 1 (realtime)");
  }

  return {
    filters: filters.map(parseTriggerFilter),
    // Default matches the UI drawer's realtime default (batch is feature-disabled).
    mode: (mode as number | undefined) ?? 1,
  };
};

const parseTriggerFilter = (value: unknown): TriggerFilter => {
  if (!isPlainObject(value)) {
    throw new Error(
      'Each trigger filter must be an object like {"column":...,"operator":...,"value":...}',
    );
  }
  const { column, operator, value: filterValue, ...rest } = value;
  const extraKeys = Object.keys(rest);
  if (extraKeys.length > 0) {
    throw new Error(`Trigger filter has unsupported keys: ${extraKeys.join(", ")}`);
  }
  if (typeof column !== "string" || !(column in TRIGGER_COLUMNS)) {
    throw new Error(
      `Trigger filter column must be one of: ${Object.keys(TRIGGER_COLUMNS).join(", ")}`,
    );
  }
  const spec = TRIGGER_COLUMNS[column];
  if (typeof operator !== "string" || !spec.operators.includes(operator)) {
    throw new Error(
      `Trigger filter "${column}" operator must be one of: ${spec.operators.join(", ")}`,
    );
  }
  return { column, operator, value: spec.validateValue(filterValue) };
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
  if (trimmed.length > 255) {
    throw new Error("Signal name must be less than 255 characters");
  }
  return trimmed;
};

/** Validate the prompt: non-empty (the UI requires it even though the server allows empty). */
export const validatePrompt = (prompt: string): string => {
  if (prompt.trim().length === 0) {
    throw new Error("Signal prompt is required");
  }
  return prompt;
};
