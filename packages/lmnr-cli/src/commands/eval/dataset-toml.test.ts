import { describe, expect, it } from "vitest";

import { formatDatasetToml, parseDatasetToml } from "./dataset-toml";

const H1 = "a".repeat(64);
const H2 = "b".repeat(64);

const FILE = "tasks/dataset.toml";

void describe("parseDatasetToml", () => {
  void it("reads the name and the pins", () => {
    const manifest = parseDatasetToml(
      `[dataset]\nname = "acme/support"\n\n[[tasks]]\nname = "acme/b"\n` +
        `digest = "sha256:${H2}"\n\n[[tasks]]\nname = "other/a"\n` +
        `digest = "sha256:${H1}"\n`,
      FILE,
    );
    expect(manifest.name).toBe("acme/support");
    expect(manifest.pins).toEqual({ "acme/b": H2, "other/a": H1 });
  });

  void it("has no pins without [[tasks]], and empty ones with tasks = []", () => {
    expect(
      parseDatasetToml('[dataset]\nname = "acme/s"\n', FILE).pins,
    ).toBeNull();
    expect(
      parseDatasetToml('tasks = []\n[dataset]\nname = "acme/s"\n', FILE).pins,
    ).toEqual({});
  });

  void it.each([
    ["no [dataset]", "[metadata]\nx = 1\n"],
    ["a flat name", '[dataset]\nname = "support"\n'],
    ["a '..'", '[dataset]\nname = "acme/a..b"\n'],
    [
      "a bad task name",
      `[dataset]\nname = "a/s"\n[[tasks]]\nname = "t"\ndigest = "sha256:${H1}"\n`,
    ],
    [
      "a digest without sha256:",
      `[dataset]\nname = "a/s"\n[[tasks]]\nname = "a/t"\ndigest = "${H1}"\n`,
    ],
    [
      "a task listed twice",
      `[dataset]\nname = "a/s"\n[[tasks]]\nname = "a/t"\ndigest = "sha256:${H1}"\n` +
        `[[tasks]]\nname = "a/t"\ndigest = "sha256:${H2}"\n`,
    ],
    ["invalid TOML", "[dataset\n"],
  ])("rejects %s", (_, text) => {
    expect(() => parseDatasetToml(text, FILE)).toThrow(
      expect.objectContaining({ code: "invalid_evals_dir" }),
    );
  });
});

void describe("formatDatasetToml", () => {
  void it("rewrites the pins sorted, keeping everything else", () => {
    const text =
      "# Our support cases.\n\n" +
      'schema_version = "1.0"\n\n' +
      '[dataset]\nname = "acme/support"\ndescription = "Support"\n\n' +
      `[[tasks]]\nname = "acme/old"\ndigest = "sha256:${H1}"\n\n` +
      '[[files]]\npath = "metric.py"\ndigest = ""\n\n' +
      '[metadata]\nowner = "evals"\n';
    const manifest = parseDatasetToml(text, FILE);
    const out = formatDatasetToml(manifest, { "acme/z": H2, "acme/a": H1 });
    expect(out).toBe(
      "# Our support cases.\n\n" +
        'schema_version = "1.0"\n\n' +
        '[dataset]\nname = "acme/support"\ndescription = "Support"\n\n' +
        `[[tasks]]\nname = "acme/a"\ndigest = "sha256:${H1}"\n\n` +
        `[[tasks]]\nname = "acme/z"\ndigest = "sha256:${H2}"\n\n` +
        '[[files]]\npath = "metric.py"\ndigest = ""\n\n' +
        '[metadata]\nowner = "evals"\n',
    );
    expect(parseDatasetToml(out, FILE).pins).toEqual({
      "acme/a": H1,
      "acme/z": H2,
    });
  });

  void it("writes tasks = [] before any table when nothing is pinned", () => {
    const manifest = parseDatasetToml('[dataset]\nname = "acme/s"\n', FILE);
    const out = formatDatasetToml(manifest, {});
    expect(out).toBe('tasks = []\n\n[dataset]\nname = "acme/s"\n');
    expect(parseDatasetToml(out, FILE).pins).toEqual({});
  });
});
