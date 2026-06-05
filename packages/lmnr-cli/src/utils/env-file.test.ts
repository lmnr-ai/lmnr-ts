import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeEnvFile } from "./env-file";

const isWin = process.platform === "win32";

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "lmnr-cli-envfile-"));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("writeEnvFile", () => {
  it("creates a new .env with mode 0o600 when the file does not exist", async () => {
    const path = join(scratch, ".env");
    const result = await writeEnvFile(path, "lmnr_proj_abc");
    expect(result).toEqual({ path, created: true, replaced: false });
    expect(readFileSync(path, "utf-8")).toBe("LMNR_PROJECT_API_KEY=lmnr_proj_abc\n");
    if (!isWin) {
      const mode = statSync(path).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it("replaces an existing LMNR_PROJECT_API_KEY= line in place", async () => {
    const path = join(scratch, ".env");
    writeFileSync(
      path,
      ["# header", "FOO=bar", "LMNR_PROJECT_API_KEY=old_key", "BAR=baz", ""].join("\n"),
    );
    const result = await writeEnvFile(path, "new_key");
    expect(result.created).toBe(false);
    expect(result.replaced).toBe(true);
    const after = readFileSync(path, "utf-8");
    expect(after).toContain("LMNR_PROJECT_API_KEY=new_key");
    expect(after).toContain("FOO=bar");
    expect(after).toContain("BAR=baz");
    expect(after).toContain("# header");
    // No duplicate line was appended.
    expect(after.match(/LMNR_PROJECT_API_KEY=/g)?.length).toBe(1);
  });

  it("appends to existing file without the key and adds trailing newline if needed", async () => {
    const path = join(scratch, ".env");
    // No trailing newline.
    writeFileSync(path, "FOO=bar\nBAZ=qux");
    const result = await writeEnvFile(path, "k");
    expect(result.replaced).toBe(false);
    expect(result.created).toBe(false);
    const after = readFileSync(path, "utf-8");
    expect(after).toBe("FOO=bar\nBAZ=qux\nLMNR_PROJECT_API_KEY=k\n");
  });

  it("does not touch mode on existing files", async () => {
    if (isWin) return;
    const path = join(scratch, ".env");
    writeFileSync(path, "FOO=bar\n", { mode: 0o644 });
    await writeEnvFile(path, "k");
    expect(statSync(path).mode & 0o777).toBe(0o644);
  });

  it("supports a custom var name", async () => {
    const path = join(scratch, ".env");
    await writeEnvFile(path, "v", "CUSTOM_KEY");
    expect(readFileSync(path, "utf-8")).toBe("CUSTOM_KEY=v\n");
  });

  it("handles a mid-file key with comments and ordering preserved", async () => {
    const path = join(scratch, ".env");
    const before = [
      "# comment 1",
      "A=1",
      "LMNR_PROJECT_API_KEY=stale",
      "# midline comment",
      "B=2",
      "",
    ].join("\n");
    writeFileSync(path, before);
    await writeEnvFile(path, "fresh");
    const after = readFileSync(path, "utf-8");
    const expected = [
      "# comment 1",
      "A=1",
      "LMNR_PROJECT_API_KEY=fresh",
      "# midline comment",
      "B=2",
      "",
    ].join("\n");
    expect(after).toBe(expected);
  });
});
