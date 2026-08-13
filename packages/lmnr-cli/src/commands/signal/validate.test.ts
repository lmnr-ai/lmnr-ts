import { describe, expect, it } from "vitest";

import {
  parseSampleRate,
  parseStructuredOutput,
  parseTrigger,
  validateName,
  validatePrompt,
} from "./validate";

const ROOT_SPAN = { column: "root_span_finished", operator: "eq", value: "true" };
const trigger = (body: Record<string, unknown>) => JSON.stringify(body);

// ---------------------------------------------------------------------------
// The conditions/filters split — mixing the two lists produces a signal that
// looks configured but silently never fires, so both directions must reject.
// ---------------------------------------------------------------------------

void describe("trigger conditions vs filters", () => {
  void it("rejects a FILTER column passed as a condition, naming `filters`", () => {
    for (const column of ["total_token_count", "status", "span_names"]) {
      expect(() =>
        parseTrigger(trigger({ conditions: [{ column, operator: "eq", value: "1" }] })),
      ).toThrow(/is a filter column — pass it in `filters`/);
    }
  });

  void it("rejects a CONDITION column passed as a filter, naming `conditions`", () => {
    for (const column of ["root_span_finished", "span_name"]) {
      expect(() =>
        parseTrigger(
          trigger({
            conditions: [ROOT_SPAN],
            filters: [{ column, operator: "eq", value: "true" }],
          }),
        ),
      ).toThrow(/is a trigger condition column — pass it in `conditions`/);
    }
  });

  void it("accepts span_name (condition) and span_names (filter) together", () => {
    const parsed = parseTrigger(
      trigger({
        conditions: [{ column: "span_name", operator: "includes", value: ["agent.run"] }],
        filters: [{ column: "span_names", operator: "ne", value: "healthcheck" }],
      }),
    );
    expect(parsed.conditions).toHaveLength(1);
    expect(parsed.filters).toHaveLength(1);
  });

  void it("rejects an empty conditions list — it would never fire", () => {
    expect(() => parseTrigger(trigger({ conditions: [] }))).toThrow(/non-empty "conditions"/);
  });

  void it("allows empty filters — runs on every firing trace", () => {
    expect(parseTrigger(trigger({ conditions: [ROOT_SPAN] })).filters).toEqual([]);
  });

  void it("omits mode when unset so the server applies its own default", () => {
    expect(parseTrigger(trigger({ conditions: [ROOT_SPAN] })).mode).toBeUndefined();
    expect(parseTrigger(trigger({ conditions: [ROOT_SPAN], mode: 1 })).mode).toBe(1);
  });

  void it("rejects a mode outside 0/1", () => {
    expect(() => parseTrigger(trigger({ conditions: [ROOT_SPAN], mode: 2 }))).toThrow(
      /mode must be 0/,
    );
  });

  void it("rejects a misspelled trigger key instead of silently dropping it", () => {
    expect(() => parseTrigger(trigger({ conditions: [ROOT_SPAN], filter: [] }))).toThrow(
      /unsupported keys: filter/,
    );
  });
});

void describe("per-column value rules", () => {
  // The evaluator compares against the STRING "true".
  void it("rejects a JSON boolean for root_span_finished", () => {
    expect(() =>
      parseTrigger(
        trigger({ conditions: [{ column: "root_span_finished", operator: "eq", value: true }] }),
      ),
    ).toThrow(/must be the string "true"/);
  });

  // The evaluator's parse does NOT trim, so " 1000 " would compare false forever.
  void it("trims a numeric-string token count", () => {
    const parsed = parseTrigger(
      trigger({
        conditions: [ROOT_SPAN],
        filters: [{ column: "total_token_count", operator: "gt", value: "  1000  " }],
      }),
    );
    expect(parsed.filters[0].value).toBe("1000");
  });

  void it("rejects non-finite / blank token counts", () => {
    for (const value of ["NaN", "Infinity", "", "   ", "abc"]) {
      expect(() =>
        parseTrigger(
          trigger({
            conditions: [ROOT_SPAN],
            filters: [{ column: "total_token_count", operator: "gt", value }],
          }),
        ),
      ).toThrow(/finite number/);
    }
  });

  void it("accepts only error/success for status", () => {
    for (const value of ["error", "success"]) {
      expect(() =>
        parseTrigger(
          trigger({
            conditions: [ROOT_SPAN],
            filters: [{ column: "status", operator: "eq", value }],
          }),
        ),
      ).not.toThrow();
    }
    expect(() =>
      parseTrigger(
        trigger({
          conditions: [ROOT_SPAN],
          filters: [{ column: "status", operator: "eq", value: "OK" }],
        }),
      ),
    ).toThrow(/"error" or "success"/);
  });

  // A blank target matches EVERYTHING under `ne`.
  void it("rejects a blank span_names filter target", () => {
    for (const value of ["", "  "]) {
      expect(() =>
        parseTrigger(
          trigger({
            conditions: [ROOT_SPAN],
            filters: [{ column: "span_names", operator: "ne", value }],
          }),
        ),
      ).toThrow(/non-blank span name/);
    }
  });

  void it("drops blank span names but rejects an all-blank list", () => {
    const parsed = parseTrigger(
      trigger({
        conditions: [
          { column: "span_name", operator: "includes", value: ["  agent.run  ", "", "  "] },
        ],
      }),
    );
    expect(parsed.conditions[0].value).toEqual(["agent.run"]);

    expect(() =>
      parseTrigger(
        trigger({ conditions: [{ column: "span_name", operator: "includes", value: ["", " "] }] }),
      ),
    ).toThrow(/at least one non-blank span name/);
  });

  void it("collapses a one-element list to a scalar for eq, rejects many", () => {
    const single = parseTrigger(
      trigger({ conditions: [{ column: "span_name", operator: "eq", value: ["only"] }] }),
    );
    expect(single.conditions[0].value).toBe("only");

    expect(() =>
      parseTrigger(
        trigger({ conditions: [{ column: "span_name", operator: "eq", value: ["a", "b"] }] }),
      ),
    ).toThrow(/must use the "includes" operator/);
  });

  void it("rejects an unsupported operator for a column", () => {
    expect(() =>
      parseTrigger(
        trigger({
          conditions: [ROOT_SPAN],
          filters: [{ column: "status", operator: "gt", value: "error" }],
        }),
      ),
    ).toThrow(/operator must be one of/);
  });
});

void describe("payload schema", () => {
  const schema = (properties: unknown, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ properties, ...extra });

  void it("normalizes required to every property name", () => {
    const parsed = parseStructuredOutput(
      schema({ a: { type: "string", description: "d" }, b: { type: "number", description: "d" } }),
    );
    expect(parsed.type).toBe("object");
    expect(parsed.required.sort()).toEqual(["a", "b"]);
  });

  // The UI marks every field required, so a partial list is a mistake, not a
  // narrowing to honour.
  void it("rejects a partial required list", () => {
    expect(() =>
      parseStructuredOutput(
        schema(
          { a: { type: "string", description: "d" }, b: { type: "string", description: "d" } },
          { required: ["a"] },
        ),
      ),
    ).toThrow(/exactly the property names/);
  });

  void it("rejects non-identifier field names", () => {
    for (const bad of ["1st", "has space", "dash-name", "payload.f1"]) {
      expect(() => parseStructuredOutput(schema({ [bad]: { type: "string", description: "d" } })))
        .toThrow(/must be a valid identifier/);
    }
  });

  void it("requires at least one field", () => {
    expect(() => parseStructuredOutput(schema({}))).toThrow(/at least one payload field/);
  });

  void it("rejects unsupported keys at both levels", () => {
    expect(() =>
      parseStructuredOutput(
        schema({ a: { type: "string", description: "d" } }, { additionalProperties: false }),
      ),
    ).toThrow(/unsupported top-level keys/);

    expect(() =>
      parseStructuredOutput(schema({ a: { type: "string", description: "d", format: "email" } })),
    ).toThrow(/unsupported keys/);
  });

  void it("defaults a missing description to empty rather than omitting it", () => {
    const parsed = parseStructuredOutput(schema({ a: { type: "string" } }));
    expect(parsed.properties.a.description).toBe("");
  });

  void it("enforces the enum rules", () => {
    expect(() =>
      parseStructuredOutput(schema({ a: { type: "number", description: "d", enum: ["1"] } })),
    ).toThrow(/only allowed on string fields/);

    expect(() =>
      parseStructuredOutput(schema({ a: { type: "string", description: "d", enum: ["x", "x"] } })),
    ).toThrow(/must be unique/);

    expect(() =>
      parseStructuredOutput(schema({ a: { type: "string", description: "d", enum: [] } })),
    ).toThrow(/non-empty array/);

    const ok = parseStructuredOutput(
      schema({ a: { type: "string", description: "d", enum: [" low ", "high"] } }),
    );
    expect(ok.properties.a.enum).toEqual(["low", "high"]);
  });

  void it("reports malformed JSON with the flag name", () => {
    expect(() => parseStructuredOutput("{not json")).toThrow(/--schema is not valid JSON/);
  });
});

void describe("scalar validators", () => {
  void it("bounds the sample rate to 1..95", () => {
    for (const raw of ["0", "96", "-1", "1.5", "abc"]) {
      expect(() => parseSampleRate(raw)).toThrow(/between 1 and 95/);
    }
    expect(parseSampleRate("95")).toBe(95);
  });

  void it("trims the name and enforces the length cap in CHARACTERS", () => {
    expect(validateName("  Padded  ")).toBe("Padded");
    expect(() => validateName("   ")).toThrow(/name is required/);
    // 255 multibyte chars is within the cap even though its byte length isn't.
    expect(validateName("é".repeat(255))).toHaveLength(255);
    expect(() => validateName("a".repeat(256))).toThrow(/at most 255 characters/);
  });

  void it("requires a non-blank prompt", () => {
    expect(() => validatePrompt("  ")).toThrow(/prompt is required/);
    expect(validatePrompt("find things")).toBe("find things");
  });
});
