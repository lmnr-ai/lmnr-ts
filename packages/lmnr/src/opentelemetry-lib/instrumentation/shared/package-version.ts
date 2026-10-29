import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const versions = new Map<string, string | undefined>();

const versionFromPackageJson = (pkg: any, name: string): string | undefined =>
  pkg?.name === name && typeof pkg.version === "string"
    ? (pkg.version as string)
    : undefined;

/**
 * Resolvers to look a package up from: this SDK's own location first (what a
 * `require` of the package from here would load), then the host project's
 * working directory, which is what finds it under a strict package manager
 * layout where the SDK can't see the app's dependencies.
 */
const resolvers = (): NodeJS.Require[] => {
  // biome-ignore lint/style/noCommonJs: dynamic package version resolution needs CJS resolve
  const candidates: NodeJS.Require[] = [require];
  try {
    candidates.push(createRequire(join(process.cwd(), "package.json")));
  } catch {
    // No usable working directory, e.g. in a bundled or sandboxed runtime.
  }
  return candidates;
};

const readPackageVersion = (name: string): string | undefined => {
  for (const resolver of resolvers()) {
    try {
      const version = versionFromPackageJson(
        resolver(`${name}/package.json`),
        name,
      );
      if (version) return version;
    } catch {
      // Not resolvable this way, or `exports` doesn't expose package.json.
    }
    // A package whose `exports` map hides `package.json` can still be found
    // by reading it straight out of the `node_modules` search path.
    let searchPaths: string[] = [];
    try {
      searchPaths = resolver.resolve.paths(name) ?? [];
    } catch {
      // Keep the empty list.
    }
    for (const path of searchPaths) {
      try {
        const version = versionFromPackageJson(
          JSON.parse(readFileSync(join(path, name, "package.json"), "utf8")),
          name,
        );
        if (version) return version;
      } catch {
        // Not installed at this level, keep walking.
      }
    }
  }
  return undefined;
};

/**
 * Record the version of a package the instrumentation hook just loaded.
 * `require-in-the-middle` reads it from the exact copy being patched, so it
 * wins over anything `getPackageVersion` resolved on its own.
 */
export const recordPackageVersion = (
  name: string,
  version: string | undefined,
): void => {
  if (version) versions.set(name, version);
};

/**
 * Installed version of an npm package, or undefined if it can't be resolved.
 * Best-effort and cached for the lifetime of the process, since it is read on
 * every instrumented span.
 */
export const getPackageVersion = (name: string): string | undefined => {
  if (!versions.has(name)) {
    let version: string | undefined;
    try {
      version = readPackageVersion(name);
    } catch {
      version = undefined;
    }
    versions.set(name, version);
  }
  return versions.get(name);
};
