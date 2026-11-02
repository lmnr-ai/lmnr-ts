// Installs the packed SDK into scratch apps on each OTel SDK line and runs the
// checks in this directory. Not part of `pnpm test` (needs network + npm).
//   node test/sdk-matrix/run.mjs [v1|v2.0|v2.12|v3|fresh ...]
// Packs the package first unless LMNR_TARBALL points at an existing tarball.
//
// Each app gets its own OTel packages FIRST and lmnr in a SECOND `npm i`, the
// way users add lmnr to an existing app. Installing both in one command lets
// npm pick versions for everything at once, which hides real failures (an
// optional peer once made the second step fail with ERESOLVE while the single
// command passed).
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(here, "../..");

const HOSTS = {
  // api 1.9.0: the floor of our `@opentelemetry/api` range. Any lower floor
  // than the app's would make npm nest a second api under lmnr.
  v1: [
    "@opentelemetry/api@1.9.0",
    "@opentelemetry/sdk-trace-base@1.30.1",
    "@opentelemetry/context-async-hooks@1.30.1",
    "@opentelemetry/instrumentation@0.57.2",
  ],
  // Before `@opentelemetry/sdk-trace` existed (2.9), and without
  // `instrumentation`, so npm resolves lmnr's own copy.
  "v2.0": [
    "@opentelemetry/api@1.9.1",
    "@opentelemetry/sdk-trace-base@2.0.0",
    "@opentelemetry/context-async-hooks@2.0.0",
  ],
  "v2.12": [
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
    "@opentelemetry/instrumentation@0.300.0",
    "@opentelemetry/sdk-node@0.300.0",
  ],
  // No OTel at all: lmnr brings its own.
  fresh: [],
};

const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, stdio: "inherit" });
const npmInstall = (args, cwd) =>
  run("npm", ["i", "--silent", "--no-audit", "--no-fund", ...args], cwd);
const scratch = (name) => {
  const dir = mkdtempSync(join(tmpdir(), `lmnr-${name}-`));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name, private: true }),
  );
  return dir;
};

let tarball = process.env.LMNR_TARBALL;
if (!tarball) {
  const out = mkdtempSync(join(tmpdir(), "lmnr-pack-"));
  run("pnpm", ["pack", "--pack-destination", out], pkgDir);
  tarball = join(
    out,
    readdirSync(out).find((f) => f.endsWith(".tgz")),
  );
}

let failed = false;
const step = (label, fn) => {
  try {
    fn();
  } catch {
    console.error(`FAIL: ${label}`);
    failed = true;
  }
};

// Static check of the built dist against the api floor (see check-api-floor.mjs).
step("api floor check", () => {
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  const floor = pkg.dependencies["@opentelemetry/api"].replace(/^[\^~]/, "");
  const dir = scratch("api-floor");
  npmInstall(
    [
      `api-floor@npm:@opentelemetry/api@${floor}`,
      "api-newest@npm:@opentelemetry/api@latest",
    ],
    dir,
  );
  const unpacked = join(dir, "unpacked");
  mkdirSync(unpacked);
  run("tar", ["-xzf", tarball, "-C", unpacked], dir);
  run(
    "node",
    [
      join(here, "check-api-floor.mjs"),
      join(unpacked, "package", "dist"),
      join(dir, "node_modules", "api-floor"),
      join(dir, "node_modules", "api-newest"),
    ],
    dir,
  );
});

const lines = process.argv.slice(2).length
  ? process.argv.slice(2)
  : Object.keys(HOSTS);
for (const line of lines) {
  console.log(`\n=== app on OTel ${line} ===`);
  const dir = scratch(`host-${line.replace(".", "-")}`);
  step(`${line}: install`, () => {
    if (HOSTS[line].length) npmInstall(HOSTS[line], dir);
    npmInstall([tarball], dir);
  });
  for (const file of ["host-check.cjs", "laminar-first.cjs", "esm-smoke.mjs"]) {
    copyFileSync(join(here, file), join(dir, file));
  }
  if (line !== "fresh") {
    step(`${line}: host-check`, () =>
      run("node", ["host-check.cjs", line], dir),
    );
    step(`${line}: laminar-first`, () =>
      run("node", ["laminar-first.cjs", line], dir),
    );
  }
  step(`${line}: esm`, () => run("node", ["esm-smoke.mjs", line], dir));
  // Informational: `invalid` peer ranges are expected for some layouts.
  try {
    run("npm", ["ls", "@opentelemetry/api"], dir);
  } catch {
    console.log(`(npm ls reports peer problems for ${line})`);
  }
}
process.exit(failed ? 1 : 0);
