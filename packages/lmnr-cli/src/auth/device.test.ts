import { describe, expect, it } from "vitest";

import { parseProjectFromScope } from "./device";

const UUID = "01234567-89ab-cdef-0123-456789abcdef";

describe("parseProjectFromScope", () => {
  it("extracts the project uuid from the standard scope", () => {
    expect(parseProjectFromScope(`projects:rw lmnr_project=${UUID}`)).toBe(UUID);
  });

  it("tolerates token order (project token first)", () => {
    expect(parseProjectFromScope(`lmnr_project=${UUID} projects:rw`)).toBe(UUID);
  });

  it("tolerates extra whitespace and tokens", () => {
    expect(
      parseProjectFromScope(`  projects:rw   extra  lmnr_project=${UUID}  `),
    ).toBe(UUID);
  });

  it("returns null when the project token is absent", () => {
    expect(parseProjectFromScope("projects:rw")).toBeNull();
  });

  it("returns null for a non-uuid suffix", () => {
    expect(parseProjectFromScope("lmnr_project=not-a-uuid")).toBeNull();
  });

  it("returns null for empty / missing scope", () => {
    expect(parseProjectFromScope("")).toBeNull();
    expect(parseProjectFromScope(undefined)).toBeNull();
    expect(parseProjectFromScope(null)).toBeNull();
  });

  it("does not match a token that merely contains the prefix", () => {
    expect(parseProjectFromScope(`xlmnr_project=${UUID}`)).toBeNull();
  });
});
