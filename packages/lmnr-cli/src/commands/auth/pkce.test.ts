import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { deriveChallenge, generateState, generateVerifier, safeEqual } from "./pkce";

describe("pkce", () => {
  it("verifier is base64url, 43–128 chars", () => {
    for (let i = 0; i < 50; i++) {
      const v = generateVerifier();
      expect(v.length).toBeGreaterThanOrEqual(43);
      expect(v.length).toBeLessThanOrEqual(128);
      expect(v).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("challenge = base64url(sha256(verifier))", () => {
    const v = generateVerifier();
    const expected = createHash("sha256").update(v).digest("base64url");
    expect(deriveChallenge(v)).toBe(expected);
  });

  it("generates distinct states", () => {
    const a = generateState();
    const b = generateState();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("safeEqual is true for equal strings, false otherwise", () => {
    const s = generateState();
    expect(safeEqual(s, s)).toBe(true);
    expect(safeEqual(s, generateState())).toBe(false);
  });

  it("safeEqual returns false on length mismatch (no throw)", () => {
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "x")).toBe(false);
  });
});
