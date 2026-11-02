// Installs the packed SDK next to each host OTel SDK line in a scratch dir and
// runs host-check.cjs. Not part of `pnpm test` (needs network + npm).
//   node test/sdk-matrix/run.mjs [v1|v2|v3 ...]
// Packs the package first unless LMNR_TARBALL points at an existing tarball.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(here, "../..");

const HOSTS = {
  v1: [
    "@opentelemetry/api@1.9.0",
    "@opentelemetry/sdk-trace-base@1.30.1",
    "@opentelemetry/context-async-hooks@1.30.1",
  ],
  v2: [
    "@opentelemetry/api@1.9.1",
    "@opentelemetry/sdk-trace-base@2.12.0",
    "@opentelemetry/context-async-hooks@2.12.0",
  ],
  v3: [
    "@opentelemetry/api@1.10.0",
    "@opentelemetry/sdk-trace@3.0.0",
    "@opentelemetry/core@3.0.0",
    "@opentelemetry/resources@3.0.0",
    "@opentelemetry/context-async-hooks@3.0.0",
  ],
};

const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, stdio: "inherit" });

let tarball = process.env.LMNR_TARBALL;
if (!tarball) {
  const out = mkdtempSync(join(tmpdir(), "lmnr-pack-"));
  run("pnpm", ["pack", "--pack-destination", out], pkgDir);
  tarball = join(
    out,
    readdirSync(out).find((f) => f.endsWith(".tgz")),
  );
}

const lines = process.argv.slice(2).length
  ? process.argv.slice(2)
  : Object.keys(HOSTS);
let failed = false;
for (const line of lines) {
  console.log(`\n=== host SDK ${line} ===`);
  const dir = mkdtempSync(join(tmpdir(), `lmnr-host-${line}-`));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: `host-${line}`, private: true }),
  );
  try {
    run("npm", ["i", "--silent", tarball, ...HOSTS[line]], dir);
    copyFileSync(join(here, "host-check.cjs"), join(dir, "host-check.cjs"));
    run("node", ["host-check.cjs", line], dir);
    // Informational: peer-range noise is expected for some layouts.
    try {
      run("npm", ["ls", "@opentelemetry/api"], dir);
    } catch {
      console.log(`(npm ls reports peer problems for ${line})`);
    }
  } catch {
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
