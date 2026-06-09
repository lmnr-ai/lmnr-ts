import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installSkill } from "./install-skill";

let scratch: string;

const skillRel = join("skills", "laminar", "SKILL.md");

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "lmnr-cli-skill-"));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("installSkill", () => {
  it("writes into .claude when it is present", async () => {
    mkdirSync(join(scratch, ".claude"));
    const result = await installSkill(scratch);
    const expected = join(scratch, ".claude", skillRel);
    expect(result.written).toEqual([expected]);
    expect(result.defaulted).toBe(false);
    expect(existsSync(expected)).toBe(true);
    expect(readFileSync(expected, "utf8")).toContain("# Laminar");
  });

  it("writes into every present agent dir", async () => {
    mkdirSync(join(scratch, ".cursor"));
    mkdirSync(join(scratch, ".codex"));
    const result = await installSkill(scratch);
    expect(result.defaulted).toBe(false);
    expect(result.written).toEqual([
      join(scratch, ".cursor", skillRel),
      join(scratch, ".codex", skillRel),
    ]);
    for (const p of result.written) expect(existsSync(p)).toBe(true);
  });

  it("defaults to .claude (never .agents) when no agent dir exists", async () => {
    const result = await installSkill(scratch);
    expect(result.defaulted).toBe(true);
    expect(result.written).toEqual([join(scratch, ".claude", skillRel)]);
    expect(existsSync(join(scratch, ".agents"))).toBe(false);
  });

  it("is idempotent (overwrites on rerun)", async () => {
    mkdirSync(join(scratch, ".claude"));
    await installSkill(scratch);
    const result = await installSkill(scratch);
    expect(result.written).toEqual([join(scratch, ".claude", skillRel)]);
    expect(readFileSync(result.written[0], "utf8")).toContain("# Laminar");
  });
});
