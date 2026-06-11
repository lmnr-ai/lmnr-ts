import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, parse } from "node:path";

/**
 * Directory-scoped project link, written by `setup` to `.lmnr/project.json`.
 * The project the CLI operates on is inferred from the directory you're in
 * (Vercel/Supabase style), overridable with --project-id.
 * Holds the project id plus small display details — never secrets (the API key
 * lives in .env).
 */
export interface LocalProjectFile {
  projectId: string;
  projectName?: string;
  workspaceId?: string;
  workspaceName?: string;
}

const LOCAL_LMNR_DIR = ".lmnr";
const LOCAL_LMNR_PROJECT_FILE = "project.json";

/**
 * Find the nearest `.lmnr/project.json`, walking up from `startDir` to the
 * filesystem root (so commands work from subdirectories of a linked project).
 * Returns null if none is found.
 */
export async function readLocalProjectFile(
  startDir: string = process.cwd(),
): Promise<LocalProjectFile | null> {
  let dir = startDir;
  const root = parse(dir).root;

  while (true) {
    const candidate = join(dir, LOCAL_LMNR_DIR, LOCAL_LMNR_PROJECT_FILE);
    try {
      const parsed = JSON.parse(await readFile(candidate, "utf8")) as LocalProjectFile;
      if (parsed && typeof parsed.projectId === "string" && parsed.projectId.length > 0) {
        return parsed;
      }
    } catch {
      // Not here (missing / unreadable / malformed) — keep walking up.
    }
    const parent = dirname(dir);
    if (parent === dir || dir === root) break;
    dir = parent;
  }
  return null;
}

/** Write `.lmnr/project.json` under `dir` (default cwd). Returns the file path. */
export async function writeLocalProjectFile(
  link: LocalProjectFile,
  dir: string = process.cwd(),
): Promise<string> {
  const linkDir = join(dir, LOCAL_LMNR_DIR);
  await mkdir(linkDir, { recursive: true });
  const path = join(linkDir, LOCAL_LMNR_PROJECT_FILE);
  await writeFile(path, JSON.stringify(link, null, 2) + "\n", "utf8");
  return path;
}
