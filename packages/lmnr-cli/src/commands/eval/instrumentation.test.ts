import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { findLaminarSdk } from "./instrumentation";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lmnr-instr-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const write = (rel: string, text: string): void => {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

describe("findLaminarSdk", () => {
  it("finds @lmnr-ai/lmnr in any dependency field of a nested package.json", async () => {
    write("package.json", JSON.stringify({ dependencies: { zod: "^3" } }));
    write(
      "apps/agent/package.json",
      JSON.stringify({ devDependencies: { "@lmnr-ai/lmnr": "^0.8.0" } }),
    );
    expect(await findLaminarSdk(root)).toEqual([
      join("apps", "agent", "package.json"),
    ]);
  });

  it.each([
    ["pyproject.toml", 'dependencies = [\n  "lmnr>=0.7.0",\n]\n'],
    ["pyproject.toml", '[tool.poetry.dependencies]\nlmnr = "^0.7"\n'],
    ["pyproject.toml", 'dependencies = ["lmnr[all]>=0.7"]\n'],
    ["requirements.txt", "openai==1.0\nlmnr==0.7.3\n"],
    ["requirements-dev.txt", "lmnr\n"],
  ])("finds lmnr in %s (%j)", async (file, text) => {
    write(file, text);
    expect(await findLaminarSdk(root)).toEqual([file]);
  });

  it("does not match other packages that start with lmnr", async () => {
    write("requirements.txt", "lmnr-foo==1.0\nnotlmnr==2\n");
    write(
      "package.json",
      JSON.stringify({ dependencies: { "lmnr-cli": "1" } }),
    );
    expect(await findLaminarSdk(root)).toEqual([]);
  });

  it("skips node_modules, virtualenvs and dirs deeper than three levels", async () => {
    const dep = JSON.stringify({ dependencies: { "@lmnr-ai/lmnr": "1" } });
    write("node_modules/x/package.json", dep);
    write(".venv/lib/requirements.txt", "lmnr\n");
    write("a/b/c/d/package.json", dep);
    write("a/b/c/package.json", dep);
    expect(await findLaminarSdk(root)).toEqual([
      join("a", "b", "c", "package.json"),
    ]);
  });

  it("ignores an unparsable package.json", async () => {
    write("package.json", "{ not json");
    expect(await findLaminarSdk(root)).toEqual([]);
  });
});
