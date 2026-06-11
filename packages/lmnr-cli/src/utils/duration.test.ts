import { describe, expect, it } from "vitest";

import { parseDuration } from "./duration";

describe("parseDuration", () => {
  it("parses seconds (default unit)", () => {
    expect(parseDuration("60")).toBe(60);
    expect(parseDuration("60s")).toBe(60);
  });
  it("parses minutes and hours", () => {
    expect(parseDuration("2m")).toBe(120);
    expect(parseDuration("1h")).toBe(3600);
  });
  it("trims whitespace", () => {
    expect(parseDuration("  120s  ")).toBe(120);
  });
  it("rejects bad input", () => {
    expect(parseDuration("")).toBe(null);
    expect(parseDuration("abc")).toBe(null);
    expect(parseDuration("-1s")).toBe(null);
    expect(parseDuration("0")).toBe(null);
    expect(parseDuration(null)).toBe(null);
    expect(parseDuration(undefined)).toBe(null);
  });
  it("caps at 24h", () => {
    expect(parseDuration("48h")).toBe(24 * 60 * 60);
  });
});
