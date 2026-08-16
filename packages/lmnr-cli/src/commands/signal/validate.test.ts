import { describe, expect, it } from "vitest";

import {
  parseFilter,
  parseMode,
  parseSampleRate,
  parseStructuredOutput,
  parseTrigger,
  validateName,
  validatePrompt,
} from "./validate";

void describe("parseTrigger", () => {
  void it("returns undefined when --trigger is absent so the server defaults", () => {
    expect(parseTrigger(undefined, [])).toBeUndefined();
  });

  void it("maps root-span-finished to the tagged wire shape", () => {
    expect(parseTrigger("root-span-finished", [])).toEqual({ type: "rootSpanFinished" });
  });

  void it("maps none to null, meaning backfill-only", () => {
    expect(parseTrigger("none", [])).toBeNull();
  });

  void it("collects repeated --span-name values", () => {
    expect(parseTrigger("span-name", ["agent.run", "worker.step"])).toEqual({
      type: "spanName",
      spanNames: ["agent.run", "worker.step"],
    });
  });

  void it("trims span names and drops blank ones", () => {
    expect(parseTrigger("span-name", ["  agent.run  ", "", "   "])).toEqual({
      type: "spanName",
      spanNames: ["agent.run"],
    });
  });

  void it("rejects span-name with no usable name, which could never fire", () => {
    expect(() => parseTrigger("span-name", [])).toThrow(/requires at least one --span-name/);
    expect(() => parseTrigger("span-name", ["  "])).toThrow(/requires at least one --span-name/);
  });

  void it("rejects --span-name without --trigger span-name instead of inferring it", () => {
    // Inferring the kind would let a typo'd --trigger silently change when the
    // signal fires, which is the failure mode this command exists to prevent.
    expect(() => parseTrigger(undefined, ["agent.run"])).toThrow(/requires --trigger span-name/);
    expect(() => parseTrigger("root-span-finished", ["agent.run"])).toThrow(
      /only applies to --trigger span-name/,
    );
    expect(() => parseTrigger("none", ["agent.run"])).toThrow(/only applies to/);
  });

  void it("rejects an unknown trigger kind and lists the valid ones", () => {
    expect(() => parseTrigger("rootSpanFinished", [])).toThrow(/root-span-finished/);
    expect(() => parseTrigger("span_name", [])).toThrow(/--trigger must be one of/);
  });
});

void describe("parseFilter", () => {
  void it("parses each operator symbol to its wire name", () => {
    const cases: [string, string, string][] = [
      ["total_token_count > 1000", "gt", "1000"],
      ["total_token_count >= 1000", "gte", "1000"],
      ["total_token_count < 1000", "lt", "1000"],
      ["total_token_count <= 1000", "lte", "1000"],
      ["status = error", "eq", "error"],
      ["status != error", "ne", "error"],
    ];
    for (const [input, operator, value] of cases) {
      expect(parseFilter(input)).toEqual({
        column: input.split(" ")[0],
        operator,
        value,
      });
    }
  });

  void it("prefers the longer symbol so >= is not read as >", () => {
    expect(parseFilter("total_token_count >= 5").operator).toBe("gte");
    expect(parseFilter("total_token_count <= 5").operator).toBe("lte");
    expect(parseFilter("status != error").operator).toBe("ne");
  });

  void it("works without spaces around the operator", () => {
    expect(parseFilter("total_token_count>1000")).toEqual({
      column: "total_token_count",
      operator: "gt",
      value: "1000",
    });
  });

  void it("keeps the value as text for the server to coerce", () => {
    // The server distinguishes a numeric string from a number and validates
    // finiteness; re-implementing that here would drift from it.
    expect(parseFilter("total_token_count > 1000").value).toBe("1000");
  });

  void it("strips matching quotes so a span name can contain spaces", () => {
    expect(parseFilter('span_names = "my span"').value).toBe("my span");
    expect(parseFilter("span_names = 'my span'").value).toBe("my span");
    // Mismatched quotes are left alone rather than half-stripped.
    expect(parseFilter("span_names = \"unbalanced").value).toBe('"unbalanced');
  });

  void it("rejects a filter with no operator, missing column, or missing value", () => {
    expect(() => parseFilter("total_token_count 1000")).toThrow(/must look like/);
    expect(() => parseFilter("> 1000")).toThrow(/missing a column/);
    expect(() => parseFilter("total_token_count >")).toThrow(/missing a value/);
  });

  void it("does not validate the column, leaving the allowlist to the server", () => {
    // A bad column must reach the server so its 400 names the supported ones.
    expect(parseFilter("nonsense = 1")).toEqual({
      column: "nonsense",
      operator: "eq",
      value: "1",
    });
  });
});

void describe("repeatable flag collectors", () => {
  // These mirror the `--span-name` / `--filter` collectors in index.ts. They must
  // NOT be registered with a `[]` default: commander would then always hand the
  // handler an array, so an absent flag would look like "passed empty" and
  // `signal update --prompt x` would CLEAR the signal's filters.
  const collect = (val: string, prev: string[] = []) => [...prev, val];

  void it("starts from undefined and accumulates", () => {
    expect(collect("a", undefined)).toEqual(["a"]);
    expect(collect("b", ["a"])).toEqual(["a", "b"]);
  });
});

void describe("parseMode", () => {
  void it("accepts the two named modes", () => {
    expect(parseMode("batch")).toBe("batch");
    expect(parseMode("realtime")).toBe("realtime");
  });

  void it("rejects the raw discriminant and unknown values", () => {
    // 0/1 is a storage detail and must not be part of the CLI contract.
    expect(() => parseMode("1")).toThrow(/--mode must be one of/);
    expect(() => parseMode("Realtime")).toThrow(/--mode must be one of/);
  });
});

void describe("parseStructuredOutput", () => {
  void it("fills omitted type and required from the properties", () => {
    const parsed = parseStructuredOutput('{"properties":{"a":{"type":"string"}}}');
    expect(parsed.type).toBe("object");
    expect(parsed.required).toEqual(["a"]);
  });

  void it("preserves an explicit required list", () => {
    const parsed = parseStructuredOutput(
      '{"properties":{"a":{"type":"string"},"b":{"type":"number"}},"required":["b","a"]}',
    );
    expect(parsed.required).toEqual(["b", "a"]);
  });

  void it("rejects non-JSON, non-objects, and a missing properties map", () => {
    expect(() => parseStructuredOutput("{nope")).toThrow(/not valid JSON/);
    expect(() => parseStructuredOutput('["a"]')).toThrow(/must be a JSON object/);
    expect(() => parseStructuredOutput("{}")).toThrow(/"properties"/);
  });
});

void describe("parseSampleRate", () => {
  void it("parses an integer percent", () => {
    expect(parseSampleRate("25")).toBe(25);
  });

  void it("rejects blanks and non-integers that would serialize as null", () => {
    // `Number("")` is 0 and `Number("abc")` is NaN → JSON `null`, which the
    // server reads as "clear sampling" — the opposite of what was asked.
    for (const bad of ["", "  ", "abc", "2.5"]) {
      expect(() => parseSampleRate(bad)).toThrow(/must be an integer/);
    }
  });

  void it("leaves the 1-95 range to the server", () => {
    expect(parseSampleRate("0")).toBe(0);
    expect(parseSampleRate("100")).toBe(100);
  });
});

void describe("name and prompt", () => {
  void it("trims the name and rejects a blank one", () => {
    expect(validateName("  Refunds  ")).toBe("Refunds");
    expect(() => validateName("   ")).toThrow(/name is required/);
  });

  void it("rejects a blank prompt without trimming the stored value", () => {
    expect(validatePrompt("  Find refunds  ")).toBe("  Find refunds  ");
    expect(() => validatePrompt("  ")).toThrow(/prompt is required/);
  });
});
