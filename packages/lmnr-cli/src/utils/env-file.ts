import {
  access,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";

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
  await atomicWrite(envPath, next, undefined);
  return { path: envPath, created: false, replaced };
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
  // Touch the parent dir variable so Windows doesn't complain — no-op on POSIX.
  void dirname(path);
}

function escapeRegex(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
