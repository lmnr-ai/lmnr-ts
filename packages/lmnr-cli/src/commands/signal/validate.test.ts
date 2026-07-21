import { describe, expect, it } from "vitest";

import {
  parseSampleRate,
  parseStructuredOutput,
  parseTrigger,
  validateName,
  validatePrompt,
} from "./validate";

describe("parseStructuredOutput", () => {
  it("accepts a full JSON Schema shape and normalizes required", () => {
    const out = parseStructuredOutput(
      JSON.stringify({
        type: "object",
        properties: {
          reason: { type: "string", description: "why" },
          count: { type: "number", description: "how many" },
          flagged: { type: "boolean", description: "" },
        },
        required: ["reason", "count", "flagged"],
      }),
    );
    expect(out.type).toBe("object");
    expect(out.required).toEqual(["reason", "count", "flagged"]);
    expect(out.properties.reason).toEqual({ type: "string", description: "why" });
  });

  it("accepts a minimal shape (no type/required) and fills them in", () => {
    const out = parseStructuredOutput(
      JSON.stringify({ properties: { reason: { type: "string", description: "why" } } }),
    );
    expect(out.type).toBe("object");
    expect(out.required).toEqual(["reason"]);
  });

  it("accepts enum fields on strings and trims values", () => {
    const out = parseStructuredOutput(
      JSON.stringify({
        properties: {
          severity: { type: "string", description: "d", enum: ["low ", "high"] },
        },
      }),
    );
    expect(out.properties.severity.enum).toEqual(["low", "high"]);
  });

  it("defaults a missing description to an empty string", () => {
    const out = parseStructuredOutput(JSON.stringify({ properties: { a: { type: "string" } } }));
    expect(out.properties.a.description).toBe("");
  });

  it.each([
    ["not json", "not-json"],
    ["not an object", JSON.stringify([1, 2])],
    ["no properties", JSON.stringify({ type: "object" })],
    ["empty properties", JSON.stringify({ properties: {} })],
    [
      "wrong top-level type",
      JSON.stringify({ type: "array", properties: { a: { type: "string" } } }),
    ],
    [
      "extra top-level key",
      JSON.stringify({ properties: { a: { type: "string" } }, additionalProperties: false }),
    ],
    ["bad field name (dash)", JSON.stringify({ properties: { "bad-name": { type: "string" } } })],
    [
      "bad field name (leading digit)",
      JSON.stringify({ properties: { "1abc": { type: "string" } } }),
    ],
    ["bad field name (space)", JSON.stringify({ properties: { "a b": { type: "string" } } })],
    ["unsupported field type", JSON.stringify({ properties: { a: { type: "array" } } })],
    ["enum literal type", JSON.stringify({ properties: { a: { type: "enum", enum: ["x"] } } })],
    ["enum on number", JSON.stringify({ properties: { a: { type: "number", enum: ["1"] } } })],
    ["empty enum", JSON.stringify({ properties: { a: { type: "string", enum: [] } } })],
    ["blank enum value", JSON.stringify({ properties: { a: { type: "string", enum: [" "] } } })],
    [
      "duplicate enum values",
      JSON.stringify({ properties: { a: { type: "string", enum: ["x", "x "] } } }),
    ],
    [
      "extra field key",
      JSON.stringify({ properties: { a: { type: "string", format: "uri" } } }),
    ],
    [
      "partial required list",
      JSON.stringify({
        properties: { a: { type: "string" }, b: { type: "string" } },
        required: ["a"],
      }),
    ],
    [
      "required lists unknown field",
      JSON.stringify({ properties: { a: { type: "string" } }, required: ["a", "b"] }),
    ],
  ])("rejects %s", (_label, raw) => {
    expect(() => parseStructuredOutput(raw)).toThrow();
  });
});

describe("parseTrigger", () => {
  it("accepts all four UI columns and defaults mode to realtime", () => {
    const trigger = parseTrigger(
      JSON.stringify({
        filters: [
          { column: "span_name", operator: "eq", value: "agent.run" },
          { column: "status", operator: "eq", value: "error" },
          { column: "root_span_finished", operator: "eq", value: "true" },
          { column: "total_token_count", operator: "gt", value: 1000 },
        ],
      }),
    );
    expect(trigger.mode).toBe(1);
    expect(trigger.filters).toHaveLength(4);
  });

  it("accepts numeric strings for total_token_count and explicit mode 0", () => {
    const trigger = parseTrigger(
      JSON.stringify({
        filters: [{ column: "total_token_count", operator: "lte", value: "500" }],
        mode: 0,
      }),
    );
    expect(trigger.mode).toBe(0);
    expect(trigger.filters[0].value).toBe("500");
  });

  it.each([
    ["not json", "oops"],
    ["no filters", JSON.stringify({})],
    ["empty filters", JSON.stringify({ filters: [] })],
    [
      "extra key",
      JSON.stringify({
        filters: [{ column: "status", operator: "eq", value: "error" }],
        name: "x",
      }),
    ],
    [
      "bad mode",
      JSON.stringify({
        filters: [{ column: "status", operator: "eq", value: "error" }],
        mode: 2,
      }),
    ],
    [
      "unknown column",
      JSON.stringify({ filters: [{ column: "user_id", operator: "eq", value: "x" }] }),
    ],
    [
      "status wrong value",
      JSON.stringify({ filters: [{ column: "status", operator: "eq", value: "success" }] }),
    ],
    [
      "root_span_finished wrong value",
      JSON.stringify({
        filters: [{ column: "root_span_finished", operator: "eq", value: "false" }],
      }),
    ],
    [
      "span_name empty value",
      JSON.stringify({ filters: [{ column: "span_name", operator: "eq", value: "" }] }),
    ],
    [
      "span_name gt operator",
      JSON.stringify({ filters: [{ column: "span_name", operator: "gt", value: "x" }] }),
    ],
    [
      "includes operator",
      JSON.stringify({ filters: [{ column: "span_name", operator: "includes", value: "x" }] }),
    ],
    [
      "token count non-numeric",
      JSON.stringify({ filters: [{ column: "total_token_count", operator: "gt", value: "abc" }] }),
    ],
    [
      "filter extra key",
      JSON.stringify({
        filters: [{ column: "status", operator: "eq", value: "error", dataType: "enum" }],
      }),
    ],
  ])("rejects %s", (_label, raw) => {
    expect(() => parseTrigger(raw)).toThrow();
  });
});

describe("parseSampleRate", () => {
  it.each(["1", "25", "95"])("accepts %s", (raw) => {
    expect(parseSampleRate(raw)).toBe(Number(raw));
  });
  it.each(["0", "96", "-1", "2.5", "abc", ""])("rejects %s", (raw) => {
    expect(() => parseSampleRate(raw)).toThrow();
  });
});

describe("validateName / validatePrompt", () => {
  it("trims and accepts a normal name", () => {
    expect(validateName("  My signal ")).toBe("My signal");
  });
  it("rejects an empty name and a 256-char name", () => {
    expect(() => validateName("   ")).toThrow();
    expect(() => validateName("x".repeat(256))).toThrow();
  });
  it("accepts a 255-char name", () => {
    expect(validateName("x".repeat(255))).toHaveLength(255);
  });
  it("rejects an empty prompt", () => {
    expect(() => validatePrompt(" ")).toThrow();
  });
});
