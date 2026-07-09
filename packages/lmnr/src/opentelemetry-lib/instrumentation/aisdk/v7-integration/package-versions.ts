import { readdirSync } from "node:fs";
import { join, sep } from "node:path";

import {
  SPAN_INSTRUMENTATION_SCOPE_NAME,
  SPAN_INSTRUMENTATION_SCOPE_VERSION,
} from "../../../tracing/attributes";

/**
 * Installed versions of the `ai` package and any `@ai-sdk/*` packages
 * resolvable from the host application's `node_modules`. Best-effort: a
 * package that can't be resolved is simply omitted.
 */
export interface AiSdkPackageVersions {
  aiVersion?: string;
  aiSdkPackages: Record<string, string>;
}

let cached: AiSdkPackageVersions | undefined;

const readPackageVersion = (specifier: string): string | undefined => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require(`${specifier}/package.json`);
    return typeof pkg?.version === "string" ? pkg.version as string : undefined;
  } catch {
    return undefined;
  }
};

/**
 * A `node_modules` search-path entry is a package-manager-internal virtual
 * store (pnpm's `.pnpm`, yarn's `.yarn`, etc.) if any path segment starts
 * with `.` — excluding the `.`/`..` relative-path segments themselves, which
 * are unrelated. Packages resolved from inside such a store are some
 * dependency's OWN transitive deps (e.g. `ai`'s `@ai-sdk/provider`), not
 * what the host project declared, so those entries must be skipped.
 */
export const isPackageManagerInternalPath = (path: string): boolean =>
  path.split(sep).some((segment) => segment.startsWith(".") && segment !== "." && segment !== "..");

/**
 * Given the ordered `node_modules` search-path list Node would use to
 * resolve a module from this file's location, find the closest directory
 * that actually has an `@ai-sdk` scope — skipping package-manager-internal
 * stores — and return the packages listed under it. The first path with a
 * usable `@ai-sdk` directory wins; levels are not merged, so an unrelated
 * ancestor/monorepo-root's `@ai-sdk` scope is never mixed in once a closer
 * one has already matched.
 */
export const findAiSdkScopeEntries = (searchPaths: string[]): string[] => {
  for (const path of searchPaths) {
    if (isPackageManagerInternalPath(path)) continue;
    try {
      const entries = readdirSync(join(path, "@ai-sdk"));
      if (entries.length > 0) return entries;
    } catch {
      // No @ai-sdk scope at this level — keep walking.
    }
  }
  return [];
};

const discoverAiSdkPackages = (): Record<string, string> => {
  const packages: Record<string, string> = {};
  let searchPaths: string[];
  try {
    searchPaths = require.resolve.paths("@ai-sdk/__probe__") ?? [];
  } catch {
    searchPaths = [];
  }

  for (const entry of findAiSdkScopeEntries(searchPaths)) {
    const specifier = `@ai-sdk/${entry}`;
    const version = readPackageVersion(specifier);
    if (version) packages[specifier] = version;
  }
  return packages;
};

/**
 * Reads installed `ai` / `@ai-sdk/*` package versions once and caches the
 * result for the lifetime of the process — this is expected to be called on
 * every span creation, so the actual `require`/`readdirSync` work must not
 * repeat.
 */
export const getAiSdkPackageVersions = (): AiSdkPackageVersions => {
  if (cached) return cached;
  try {
    cached = {
      aiVersion: readPackageVersion("ai"),
      aiSdkPackages: discoverAiSdkPackages(),
    };
  } catch {
    cached = { aiSdkPackages: {} };
  }
  return cached;
};

/**
 * Flat span-attribute object for the `ai` package's instrumentation scope
 * plus one `lmnr.span.instrumentation.@ai-sdk/<pkg>.version` entry per
 * resolvable `@ai-sdk/*` package. Merge this into every span this
 * integration creates.
 */
export const buildAiSdkInstrumentationAttributes = (): Record<
  string,
  string
> => {
  const { aiVersion, aiSdkPackages } = getAiSdkPackageVersions();
  const attributes: Record<string, string> = {
    [SPAN_INSTRUMENTATION_SCOPE_NAME]: "ai",
  };
  if (aiVersion) attributes[SPAN_INSTRUMENTATION_SCOPE_VERSION] = aiVersion;
  for (const [pkg, version] of Object.entries(aiSdkPackages)) {
    attributes[`lmnr.span.instrumentation.${pkg}.version`] = version;
  }
  return attributes;
};
