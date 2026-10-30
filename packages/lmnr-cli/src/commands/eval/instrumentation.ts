import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

/** How deep below the cwd to look for manifests (monorepo packages, apps/*). */
const MAX_DEPTH = 3;

/** Dirs never worth descending into: deps, builds, VCS, caches. */
const SKIPPED = new Set([
  "node_modules",
  ".git",
  ".venv",
  "venv",
  "dist",
  "build",
  ".next",
  "__pycache__",
  ".pnpm-store",
  "target",
]);

const JS_SDK = "@lmnr-ai/lmnr";
const JS_DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

// The Python SDK is `lmnr`, optionally with extras (`lmnr[all]`), followed by a
// version spec, quote, comma or end of line. `lmnr-foo` is a different package.
const PY_SDK = /(^|[\s"',[])lmnr(\[[^\]]*\])?(?=\s*([=<>~!;"',\]]|$))/m;

const isPythonManifest = (name: string): boolean =>
  name === "pyproject.toml" ||
  name === "Pipfile" ||
  name === "setup.py" ||
  name === "setup.cfg" ||
  /^requirements.*\.txt$/.test(name);

const declaresJsSdk = (text: string): boolean => {
  try {
    const pkg = JSON.parse(text) as Record<string, unknown>;
    return JS_DEP_FIELDS.some((field) => {
      const deps = pkg[field];
      return typeof deps === "object" && deps !== null && JS_SDK in deps;
    });
  } catch {
    return false;
  }
};

/**
 * Manifests under `root` (up to {@link MAX_DEPTH} levels) that declare a
 * Laminar SDK: `@lmnr-ai/lmnr` in a package.json, or `lmnr` in a Python
 * manifest. Returns paths relative to `root`; empty means none found.
 *
 * It only sets the default answer of "is your agent instrumented?". A user
 * knows better than a dependency scan (the SDK may sit in a package that isn't
 * the agent), so it's never used to skip the question.
 */
export const findLaminarSdk = async (root: string): Promise<string[]> => {
  const found: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH && !SKIPPED.has(entry.name)) {
          await walk(path, depth + 1);
        }
        continue;
      }
      if (!entry.isFile()) continue;
      const isJs = entry.name === "package.json";
      if (!isJs && !isPythonManifest(entry.name)) continue;
      let text: string;
      try {
        text = await readFile(path, "utf-8");
      } catch {
        continue;
      }
      if (isJs ? declaresJsSdk(text) : PY_SDK.test(text)) {
        found.push(relative(root, path));
      }
    }
  };
  await walk(root, 0);
  return found.sort();
};
