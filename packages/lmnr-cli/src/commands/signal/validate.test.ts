import { describe, expect, it } from "vitest";

import {
  collectFlag,
  parseFilter,
  parseMode,
  parseSampleRate,
  parseStructuredOutput,
  parseTrigger,
  validateName,
  validatePrompt,
} from "./validate";

void describe("collectFlag", () => {
  void it("starts from undefined so an absent flag is not an empty array", () => {
    // With a commander `[]` default this returns [] for an absent flag, which
    // made `signal update --prompt x` clear the signal's filters.
    expect(collectFlag("a", undefined)).toEqual(["a"]);
    expect(collectFlag("b", ["a"])).toEqual(["a", "b"]);
  });
});

void describe("parseTrigger", () => {
  void it("maps each kind to its wire shape", () => {
    // Absent must stay undefined so the handler omits the key and the server
    // applies its default.
    expect(parseTrigger(undefined, [])).toBeUndefined();
    expect(parseTrigger("root-span-finished", [])).toEqual({ type: "rootSpanFinished" });
    expect(parseTrigger("none", [])).toBeNull();
    expect(parseTrigger("span-name", ["  agent.run  ", "", "worker.step"])).toEqual({
      type: "spanName",
      spanNames: ["agent.run", "worker.step"],
    });
  });

  void it("rejects span-name with no usable name, which could never fire", () => {
    expect(() => parseTrigger("span-name", [])).toThrow(/requires at least one --span-name/);
    expect(() => parseTrigger("span-name", ["  "])).toThrow(/requires at least one --span-name/);
  });

  void it("rejects --span-name without --trigger span-name instead of inferring it", () => {
    expect(() => parseTrigger(undefined, ["agent.run"])).toThrow(/requires --trigger span-name/);
    expect(() => parseTrigger("root-span-finished", ["agent.run"])).toThrow(/only applies to/);
  });

  void it("rejects an unknown kind and lists the valid ones", () => {
    expect(() => parseTrigger("rootSpanFinished", [])).toThrow(/root-span-finished/);
  });
});

void describe("parseFilter", () => {
  void it("passes the filter object through for the server to validate", () => {
    expect(parseFilter('{"column":"total_token_count","operator":"gt","value":"1000"}')).toEqual({
      column: "total_token_count",
      operator: "gt",
      value: "1000",
    });
  });

  void it("preserves richer value types and extra keys", () => {
    // The point of keeping filters as JSON: the shape can grow server-side
    // without a CLI change, so nothing here may narrow or drop it.
    expect(parseFilter('{"column":"span_names","operator":"eq","value":["a","b"],"negate":true}'))
      .toEqual({ column: "span_names", operator: "eq", value: ["a", "b"], negate: true });
    expect(parseFilter('{"column":"total_token_count","operator":"gt","value":1000}').value)
      .toBe(1000);
  });

  void it("rejects malformed JSON and a missing column / operator / value", () => {
    expect(() => parseFilter("{nope")).toThrow(/not valid JSON/);
    expect(() => parseFilter('["a"]')).toThrow(/must be a JSON object/);
    expect(() => parseFilter('{"operator":"gt","value":"1"}')).toThrow(/"column"/);
    expect(() => parseFilter('{"column":"c","value":"1"}')).toThrow(/"operator"/);
    expect(() => parseFilter('{"column":"c","operator":"gt"}')).toThrow(/"value"/);
  });

  void it("does not validate the column, leaving the allowlist to the server", () => {
    expect(parseFilter('{"column":"nonsense","operator":"eq","value":"1"}').column)
      .toBe("nonsense");
  });
});

void describe("parseMode", () => {
  void it("accepts the named modes and rejects the raw discriminant", () => {
    expect(parseMode("batch")).toBe("batch");
    expect(parseMode("realtime")).toBe("realtime");
    expect(() => parseMode("1")).toThrow(/--mode must be one of/);
  });
});

void describe("parseStructuredOutput", () => {
  void it("fills omitted type and required from the properties", () => {
    const parsed = parseStructuredOutput('{"properties":{"a":{"type":"string"}}}');
    expect(parsed.type).toBe("object");
    expect(parsed.required).toEqual(["a"]);
  });

  void it("rejects non-JSON, non-objects, and a missing properties map", () => {
    expect(() => parseStructuredOutput("{nope")).toThrow(/not valid JSON/);
    expect(() => parseStructuredOutput('["a"]')).toThrow(/must be a JSON object/);
    expect(() => parseStructuredOutput("{}")).toThrow(/"properties"/);
  });
});

void describe("parseSampleRate", () => {
  void it("rejects blanks and non-integers that would serialize as null", () => {
    // `Number("")` is 0 and `Number("abc")` is NaN → JSON `null`, which the
    // server reads as "clear sampling" — the opposite of what was asked.
    expect(parseSampleRate("25")).toBe(25);
    for (const bad of ["", "abc", "2.5"]) {
      expect(() => parseSampleRate(bad)).toThrow(/must be an integer/);
    }
  });
});

void describe("name and prompt", () => {
  void it("trims the name and rejects blanks", () => {
    expect(validateName("  Refunds  ")).toBe("Refunds");
    expect(() => validateName("   ")).toThrow(/name is required/);
    expect(() => validatePrompt("  ")).toThrow(/prompt is required/);
  });
});
