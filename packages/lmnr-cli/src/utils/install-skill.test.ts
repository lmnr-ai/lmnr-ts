import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SKILL_NAME } from "../skill/laminar-skill";
import { installSkill } from "./install-skill";

// Mock giget: instead of hitting the network, write a small fixture skill tree
// (SKILL.md + references/quickstart-node.md) into the dir giget was asked to
// populate. Tests can override the impl (e.g. reject) per case. `vi.hoisted`
// lets the mock factory (hoisted above imports) reference the same spy the
// tests configure.
const { downloadTemplate } = vi.hoisted(() => ({ downloadTemplate: vi.fn() }));
vi.mock("giget", () => ({ downloadTemplate }));

let scratch: string;

const REL_FILES = ["SKILL.md", join("references", "quickstart-node.md")];
const skillPaths = (root: string) =>
  REL_FILES.map((rel) => join(root, "skills", SKILL_NAME, rel)).sort();

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "lmnr-cli-skill-"));
  downloadTemplate.mockReset();
  downloadTemplate.mockImplementation((_source: string, opts: { dir: string }) => {
    mkdirSync(join(opts.dir, "references"), { recursive: true });
    writeFileSync(join(opts.dir, "SKILL.md"), "# Laminar quickstart trace\n");
    writeFileSync(join(opts.dir, "references", "quickstart-node.md"), "node quickstart\n");
    return Promise.resolve({ dir: opts.dir, source: _source });
  });
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("installSkill", () => {
  it("writes the full skill tree into .claude when present", async () => {
    mkdirSync(join(scratch, ".claude"));
    const result = await installSkill(scratch);
    expect(result.skipped).toBe(false);
    expect(result.defaulted).toBe(false);
    expect([...result.written].sort()).toEqual(skillPaths(join(scratch, ".claude")));
    for (const p of result.written) expect(existsSync(p)).toBe(true);
    expect(readFileSync(skillPaths(join(scratch, ".claude"))[0], "utf8")).toContain("Laminar");
    // downloaded once, regardless of target count
    expect(downloadTemplate).toHaveBeenCalledTimes(1);
  });

  it("writes into every present agent dir", async () => {
    mkdirSync(join(scratch, ".cursor"));
    mkdirSync(join(scratch, ".codex"));
    const result = await installSkill(scratch);
    expect(result.defaulted).toBe(false);
    expect([...result.written].sort()).toEqual(
      [...skillPaths(join(scratch, ".cursor")), ...skillPaths(join(scratch, ".codex"))].sort(),
    );
    for (const p of result.written) expect(existsSync(p)).toBe(true);
    expect(downloadTemplate).toHaveBeenCalledTimes(1);
  });

  it("defaults to .claude (never .agents) when no agent dir exists", async () => {
    const result = await installSkill(scratch);
    expect(result.defaulted).toBe(true);
    expect([...result.written].sort()).toEqual(skillPaths(join(scratch, ".claude")));
    expect(existsSync(join(scratch, ".agents"))).toBe(false);
  });

  it("is idempotent (overwrites on rerun)", async () => {
    mkdirSync(join(scratch, ".claude"));
    await installSkill(scratch);
    const result = await installSkill(scratch);
    expect([...result.written].sort()).toEqual(skillPaths(join(scratch, ".claude")));
    expect(existsSync(result.written[0])).toBe(true);
  });

  it("skips gracefully (no throw) when the download fails", async () => {
    mkdirSync(join(scratch, ".claude"));
    downloadTemplate.mockRejectedValueOnce(new Error("network down"));
    const result = await installSkill(scratch);
    expect(result.skipped).toBe(true);
    expect(result.written).toEqual([]);
    expect(result.defaulted).toBe(false);
    expect(existsSync(join(scratch, ".claude", "skills", SKILL_NAME))).toBe(false);
  });
});
