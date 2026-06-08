import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const CREDENTIALS_VERSION = 1;

/**
 * Profile-keyed credentials. One file holds N projects' tokens.
 * `active` is the projectId of the currently selected profile.
 */
export interface StoredCredentials {
  version: 1;
  active: string | null;
  profiles: Record<string, ProfileEntry>;
}

export interface ProfileEntry {
  tokenEndpoint: string;
  issuer: string;
  baseUrl: string;
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  tokenType: string;
  scope: string;
  userEmail?: string;
  userId?: string;
  projectId: string;
  projectName?: string;
  workspaceId?: string;
  workspaceName?: string;
  // Server-side row id for the project API key stored in `accessToken`. Used by
  // `lmnr-cli logout` to revoke via DELETE /api/projects/<id>/api-keys/<keyId>.
  apiKeyId?: string;
  createdAt: string;
  lastUsedAt?: string;
}

export function credentialsDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
  return join(base, "lmnr");
}

export function credentialsPath(): string {
  return join(credentialsDir(), "credentials.json");
}

/**
 * Read the credentials file. Returns null when no file exists.
 * Throws on unknown / unsupported versions.
 */
export async function readCredentials(): Promise<StoredCredentials | null> {
  const path = credentialsPath();
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (e: unknown) {
    if (isNotFound(e)) return null;
    throw e;
  }
  const parsed = JSON.parse(raw) as { version?: unknown };
  if (parsed.version === CREDENTIALS_VERSION) {
    return parsed as unknown as StoredCredentials;
  }
  throw new Error(
    `Unsupported credentials file version: ${String(parsed.version)}. ` +
      "Delete ~/.config/lmnr/credentials.json and re-run `lmnr-cli login`.",
  );
}

export async function writeCredentials(creds: StoredCredentials): Promise<void> {
  const path = credentialsPath();
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });

  // Mode preservation: Node's writeFile `mode` option only applies when the
  // file is being CREATED. On overwrite the existing mode survives, but here
  // we are writing to a `.tmp` and then renaming, so the temp adopts whatever
  // mode `writeFile` sets and the final file inherits that. Capture the
  // current dest mode first if present (default 0o600 for new files) so
  // tighter user-set modes like 0o640 / 0o600 survive token-refresh writes.
  let mode = 0o600;
  try {
    const existing = await stat(path);
    mode = existing.mode & 0o777;
  } catch (e: unknown) {
    if (!isNotFound(e)) throw e;
  }

  // Atomic temp+rename: a partial / crashed write can't corrupt the canonical
  // file, and two concurrent writers can't interleave bytes (the later
  // rename overwrites the earlier - last-write-wins is acceptable for this
  // file). `wx` ensures we never collide with a leftover from a previous run.
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

/**
 * Insert / replace a profile keyed by projectId, set it active, and write back.
 * Returns the updated blob.
 */
export async function upsertProfile(profile: ProfileEntry): Promise<StoredCredentials> {
  const existing = (await readCredentials()) ?? emptyCredentials();
  existing.profiles[profile.projectId] = profile;
  existing.active = profile.projectId;
  await writeCredentials(existing);
  return existing;
}

export function emptyCredentials(): StoredCredentials {
  return { version: 1, active: null, profiles: {} };
}

/**
 * Resolve a profile from the blob by projectId (exact or prefix>=8) or
 * exact projectName. Returns null if not found.
 */
export function findProfile(
  creds: StoredCredentials,
  needle: string,
): ProfileEntry | null {
  const trimmed = needle.trim();
  if (trimmed.length === 0) return null;
  const direct = creds.profiles[trimmed];
  if (direct) return direct;
  for (const p of Object.values(creds.profiles)) {
    if (p.projectName && p.projectName === trimmed) return p;
  }
  if (trimmed.length >= 8) {
    const prefixMatches = Object.values(creds.profiles).filter((p) =>
      p.projectId.startsWith(trimmed),
    );
    if (prefixMatches.length === 1) return prefixMatches[0];
  }
  return null;
}

export function getActiveProfile(creds: StoredCredentials): ProfileEntry | null {
  if (!creds.active) return null;
  return creds.profiles[creds.active] ?? null;
}

function isNotFound(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    (e as { code?: string }).code === "ENOENT"
  );
}
