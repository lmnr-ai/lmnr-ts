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

void describe("parseTrigger", () => {
  void it("parses conditions / filters / mode through without rewriting them", () => {
    const parsed = parseTrigger(
      trigger({
        conditions: [{ column: "span_name", operator: "includes", value: ["agent.run"] }],
        filters: [{ column: "span_names", operator: "ne", value: "healthcheck" }],
        mode: 1,
      }),
    );
    expect(parsed.conditions).toHaveLength(1);
    expect(parsed.filters).toHaveLength(1);
    expect(parsed.mode).toBe(1);
  });

  void it("omits mode when unset so the server applies its own default", () => {
    expect(parseTrigger(trigger({ conditions: [ROOT_SPAN] })).mode).toBeUndefined();
  });

  void it("does not reject domain mistakes — those are the server's 400", () => {
    parseTrigger(trigger({ conditions: [] }));
    parseTrigger(
      trigger({ conditions: [{ column: "status", operator: "eq", value: "error" }] }),
    );
    parseTrigger(trigger({ conditions: [ROOT_SPAN], mode: 2 }));
  });

  void it("rejects unknown keys instead of silently dropping them", () => {
    expect(() => {
      parseTrigger(trigger({ conditions: [ROOT_SPAN], filter: [] }));
    }).toThrow(/unsupported keys: filter/);
  });

  void it("rejects a non-object or a non-array conditions/filters list", () => {
    expect(() => {
      parseTrigger("[]");
    }).toThrow(/must be a JSON object/);
    expect(() => {
      parseTrigger(trigger({ conditions: "nope" }));
    }).toThrow(/"conditions" must be an array/);
    expect(() => {
      parseTrigger(trigger({ conditions: [ROOT_SPAN], filters: {} }));
    }).toThrow(/"filters" must be an array/);
  });

  void it("reports malformed JSON with the flag name", () => {
    expect(() => {
      parseTrigger("{not json");
    }).toThrow(/--trigger is not valid JSON/);
  });
});

void describe("parseStructuredOutput", () => {
  const schema = (properties: unknown, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ properties, ...extra });

  void it("fills omitted type and required so the short --help shape is valid", () => {
    const parsed = parseStructuredOutput(
      schema({ a: { type: "string", description: "d" }, b: { type: "number", description: "d" } }),
    );
    expect(parsed.type).toBe("object");
    expect(parsed.required.sort()).toEqual(["a", "b"]);
  });

  void it("passes an explicit required list through, even if partial", () => {
    const parsed = parseStructuredOutput(
      schema(
        { a: { type: "string", description: "d" }, b: { type: "string", description: "d" } },
        { required: ["a"] },
      ),
    );
    expect(parsed.required).toEqual(["a"]);
  });

  void it("does not rewrite property contents", () => {
    const parsed = parseStructuredOutput(
      schema({ a: { type: "string", description: "d", format: "email" } }),
    );
    expect(parsed.properties.a).toEqual({
      type: "string",
      description: "d",
      format: "email",
    });
  });

  void it("rejects a non-object or a missing properties object", () => {
    expect(() => {
      parseStructuredOutput("[]");
    }).toThrow(/must be a JSON object/);
    expect(() => {
      parseStructuredOutput("{}");
    }).toThrow(/"properties" object/);
  });

  void it("reports malformed JSON with the flag name", () => {
    expect(() => {
      parseStructuredOutput("{not json");
    }).toThrow(/--schema is not valid JSON/);
  });
});

void describe("scalars", () => {
  void it("coerces --sample-rate to an integer and rejects non-integers", () => {
    expect(parseSampleRate("95")).toBe(95);
    expect(parseSampleRate("0")).toBe(0);
    for (const raw of ["1.5", "abc", ""]) {
      expect(() => {
        parseSampleRate(raw);
      }).toThrow(/must be an integer/);
    }
  });

  void it("trims the name and rejects a blank one", () => {
    expect(validateName("  Padded  ")).toBe("Padded");
    expect(() => {
      validateName("   ");
    }).toThrow(/name is required/);
  });

  void it("requires a non-blank prompt", () => {
    expect(() => {
      validatePrompt("  ");
    }).toThrow(/prompt is required/);
    expect(validatePrompt("find things")).toBe("find things");
  });
});
