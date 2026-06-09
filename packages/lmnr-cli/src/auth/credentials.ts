import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const CREDENTIALS_VERSION = 1;

/**
 * The signed-in user's BetterAuth tokens. The CLI is single-user — one account
 * at a time, so the file is flat (no profiles map / active pointer).
 * Pre-release: version stays 1, no backcompat with any earlier shape.
 * - `sessionToken` is the durable BetterAuth session token (the refresh token).
 * - `accessToken` is the short-lived (15m) EdDSA JWT minted from the session.
 */
export interface Credentials {
  version: 1;
  issuer: string;
  baseUrl: string;
  sessionToken: string;
  accessToken: string;
  accessTokenExpiresAt: string;
  sessionExpiresAt?: string;
  userEmail?: string;
  userId: string;
  createdAt: string;
  lastUsedAt?: string;
}

// The lmnr config dir (XDG_CONFIG_HOME or ~/.config, then `lmnr`). Named
// generically since we may store more than credentials here in the future.
export function globalLmnrDirectory(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
  return join(base, "lmnr");
}

export function credentialsPath(): string {
  return join(globalLmnrDirectory(), "credentials.json");
}

/**
 * Read the credentials file. Returns null when missing or not the current flat
 * v1 shape (treated as "not logged in" — `lmnr-cli login` overwrites).
 */
export async function readCredentials(): Promise<Credentials | null> {
  const path = credentialsPath();
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (e: unknown) {
    if (isNotFound(e)) return null;
    throw e;
  }
  let parsed: Partial<Credentials>;
  try {
    parsed = JSON.parse(raw) as Partial<Credentials>;
  } catch {
    return null;
  }
  if (parsed.version === CREDENTIALS_VERSION && typeof parsed.sessionToken === "string") {
    return parsed as Credentials;
  }
  return null;
}

export async function writeCredentials(creds: Credentials): Promise<void> {
  const path = credentialsPath();
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });

  // Preserve a tighter user-set mode (e.g. 0o600) across token-refresh writes;
  // default 0o600 for new files. The temp adopts this mode and the rename
  // carries it onto the canonical file.
  let mode = 0o600;
  try {
    const existing = await stat(path);
    mode = existing.mode & 0o777;
  } catch (e: unknown) {
    if (!isNotFound(e)) throw e;
  }

  // Atomic temp+rename so a crashed write can't corrupt the canonical file.
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, JSON.stringify(creds, null, 2), { mode, flag: "wx" });
  await rename(tmp, path);
}

export async function deleteCredentials(): Promise<boolean> {
  const path = credentialsPath();
  try {
    await stat(path);
  } catch (e: unknown) {
    if (isNotFound(e)) return false;
    throw e;
  }
  await rm(path, { force: true });
  return true;
}

function isNotFound(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    (e as { code?: string }).code === "ENOENT"
  );
}
