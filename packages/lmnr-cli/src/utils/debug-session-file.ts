import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DEBUG_SESSION_DIR, DEBUG_SESSION_FILE, type DebugSessionFile } from "@lmnr-ai/types";

/**
 * Write `${dir ?? cwd}/.lmnr/debug-session.json` (mkdir -p first). Best-effort:
 * swallows IO errors. Shares the `DebugSessionFile` contract + filename consts
 * with the SDK (`@lmnr-ai/types`), so the SDK reads this same file at init to
 * join the session `debug session new` minted.
 */
export const writeDebugSessionFile = (
  file: DebugSessionFile,
  dir: string = process.cwd(),
): boolean => {
  try {
    const directory = join(dir, DEBUG_SESSION_DIR);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, DEBUG_SESSION_FILE), JSON.stringify(file), "utf-8");
    return true;
  } catch {
    return false;
  }
};
