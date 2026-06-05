import {
  access,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";

const DEFAULT_VAR_NAME = "LMNR_PROJECT_API_KEY";

export interface WriteEnvResult {
  /** Absolute path of the .env file. */
  path: string;
  /** True when the file did not exist before this call. */
  created: boolean;
  /** True when an existing `<varName>=` line was overwritten. */
  replaced: boolean;
}

/**
 * Write/replace `<varName>=<value>` in the .env file at `envPath`.
 *
 * Semantics:
 * - If the file does not exist: create it with mode 0o600 and a single line.
 * - If the file exists:
 *   - Replace an existing `^<varName>\s*=.*` line in place (preserves comments,
 *     ordering, and other keys).
 *   - Otherwise append the line (with a leading newline if the file does not
 *     end in one).
 *   - DO NOT change the file mode on existing files — the user may have set
 *     a deliberate mode and changing it surprises them.
 * - Writes are atomic: write to `<envPath>.tmp`, then rename.
 */
export async function writeEnvFile(
  envPath: string,
  value: string,
  varName: string = DEFAULT_VAR_NAME,
): Promise<WriteEnvResult> {
  const exists = await fileExists(envPath);

  if (!exists) {
    const contents = `${varName}=${value}\n`;
    await atomicWrite(envPath, contents, 0o600);
    return { path: envPath, created: true, replaced: false };
  }

  const original = await readFile(envPath, "utf-8");
  // ^ at line start, m flag so . doesn't match newlines.
  const regex = new RegExp(`^${escapeRegex(varName)}\\s*=.*$`, "m");
  let next: string;
  let replaced = false;
  if (regex.test(original)) {
    next = original.replace(regex, `${varName}=${value}`);
    replaced = true;
  } else {
    const prefix = original.endsWith("\n") || original.length === 0 ? original : `${original}\n`;
    next = `${prefix}${varName}=${value}\n`;
  }
  // Capture existing mode so the tmp inherits dest's perms — POSIX `rename`
  // adopts the source inode's permissions, so without this an existing 0o600
  // .env would silently widen to the umask default (0o644) on every rerun.
  const existingMode = (await stat(envPath)).mode & 0o777;
  await atomicWrite(envPath, next, existingMode);
  return { path: envPath, created: false, replaced };
}

/**
 * Read a single env var's value from a .env file. Returns null when the file
 * is missing, the var is absent, or its value is empty/whitespace.
 */
export async function readEnvVar(
  envPath: string,
  varName: string = DEFAULT_VAR_NAME,
): Promise<string | null> {
  if (!(await fileExists(envPath))) return null;
  const original = await readFile(envPath, "utf-8");
  const regex = new RegExp(`^${escapeRegex(varName)}\\s*=(.*)$`, "m");
  const match = original.match(regex);
  if (!match) return null;
  const value = match[1].trim().replace(/^["']|["']$/g, "");
  return value.length > 0 ? value : null;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function atomicWrite(
  path: string,
  contents: string,
  mode: number | undefined,
): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, contents, mode === undefined ? undefined : { mode });
  await rename(tmp, path);
}

function escapeRegex(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
