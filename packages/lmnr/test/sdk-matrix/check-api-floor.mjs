// Checks that the built dist only uses `@opentelemetry/api` exports that exist
// in the lowest api version our `dependencies` range accepts.
//   node check-api-floor.mjs <dist-dir> <floor-api-dir> <newest-api-dir>
// The bundled OTel SDK (v3) declares `api >=1.10` as a peer, but npm never
// sees that peer, so nothing else enforces it: a v3 release that starts
// calling a 1.10-only export would fail on apps with an older api, and only
// in that path (ESM fails at link time, CJS gets `undefined`). Only names
// that the newest api exports and the floor lacks are flagged, so unrelated
// identifiers that happen to share the namespace binding's name don't count.
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const [distDir, floorDir, newestDir] = process.argv.slice(2);
const exportsOf = (dir) => {
  const mod = createRequire(join(dir, "package.json"))(dir);
  const { version } = JSON.parse(
    readFileSync(join(dir, "package.json"), "utf8"),
  );
  return { names: new Set(Object.keys(mod)), version };
};
const floor = exportsOf(floorDir);
const newest = exportsOf(newestDir);
const newOnly = [...newest.names].filter((n) => !floor.names.has(n));

const files = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (/\.(c|m)?js$/.test(entry.name)) files.push(path);
  }
};
walk(distDir);

const escapeRegExp = (s) => s.replace(/[$]/g, "\\$");
const problems = [];
for (const file of files) {
  const src = readFileSync(file, "utf8");
  const used = new Set();
  // ESM named imports: import { a, b as c } from "@opentelemetry/api"
  for (const m of src.matchAll(
    /import\s*\{([^}]*)\}\s*from\s*"@opentelemetry\/api"/g,
  )) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/)[0];
      if (name) used.add(name);
    }
  }
  // Namespace / CJS bindings, then `<binding>.<name>`.
  const bindings = [
    ...src.matchAll(
      /import\s*\*\s*as\s+([\w$]+)\s+from\s*"@opentelemetry\/api"/g,
    ),
    ...src.matchAll(
      /(?:let|var|const)\s+([\w$]+)\s*=\s*(?:__toESM\()?require\("@opentelemetry\/api"\)/g,
    ),
  ].map((m) => m[1]);
  for (const binding of bindings) {
    for (const m of src.matchAll(
      new RegExp(`(?<![\\w$.])${escapeRegExp(binding)}\\.([\\w$]+)`, "g"),
    )) {
      used.add(m[1]);
    }
  }
  for (const name of newOnly) {
    if (used.has(name)) problems.push(`${file}: ${name}`);
  }
}

if (problems.length) {
  console.error(
    `dist uses @opentelemetry/api exports missing from api ${floor.version} (present in ${newest.version}):\n  ${problems.join("\n  ")}`,
  );
  process.exit(1);
}
console.log(
  `api floor check: ok (${files.length} files; none of the ${newOnly.length} exports added after api ${floor.version} are used)`,
);
