import { describe, expect, it } from "vitest";

import { deriveProjectName, parseRepoNameFromUrl } from "./project-name";

describe("parseRepoNameFromUrl", () => {
  it("strips .git from https URLs", () => {
    expect(parseRepoNameFromUrl("https://github.com/owner/repo.git")).toBe("repo");
  });
  it("strips trailing slashes", () => {
    expect(parseRepoNameFromUrl("https://github.com/owner/repo/")).toBe("repo");
  });
  it("handles ssh-style URLs (colon as separator)", () => {
    expect(parseRepoNameFromUrl("git@github.com:owner/repo.git")).toBe("repo");
  });
  it("returns undefined for empty or no-separator inputs", () => {
    expect(parseRepoNameFromUrl("")).toBeUndefined();
    expect(parseRepoNameFromUrl("nonsense")).toBeUndefined();
  });
});

describe("deriveProjectName", () => {
  it("uses explicit name when provided (normalised)", () => {
    expect(deriveProjectName({ explicit: "My Cool Repo" })).toBe("my-cool-repo");
  });
  it("normalises capital letters and special chars", () => {
    expect(deriveProjectName({ explicit: "ABC_123 Foo!" })).toBe("abc-123-foo");
  });
  it("collapses repeated dashes", () => {
    expect(deriveProjectName({ explicit: "foo---bar" })).toBe("foo-bar");
  });
  it("caps at 64 chars", () => {
    const longName = "a".repeat(100);
    const out = deriveProjectName({ explicit: longName });
    expect(out.length).toBeLessThanOrEqual(64);
  });
  it("falls back to 'default' when explicit is whitespace and cwd basename is empty", () => {
    // Whitespace only normalises to empty → "default".
    expect(deriveProjectName({ explicit: "   " })).not.toBe("");
  });
  it("falls back to cwd basename when no explicit provided", () => {
    const out = deriveProjectName({ cwd: "/tmp/my-project" });
    expect(out).toBe("my-project");
  });
});
