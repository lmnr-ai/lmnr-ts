import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const CREDENTIALS_VERSION = 2;

/**
 * v2 schema: profile-keyed credentials. One file holds N projects' tokens.
 * `active` is the projectId of the currently selected profile.
 */
export interface StoredCredentialsV2 {
  version: 2;
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
  createdAt: string;
  lastUsedAt?: string;
}

/** Legacy v1 shape. Read-only — we migrate to v2 on first read. */
export interface StoredCredentialsV1 {
  version: 1;
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
  projectId?: string;
  projectName?: string;
  workspaceId?: string;
  workspaceName?: string;
  createdAt: string;
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
 * Read the credentials file, migrating v1 → v2 transparently if needed.
 * Returns null when no file exists.
 * Throws on unknown / unsupported versions.
 */
export async function readCredentials(): Promise<StoredCredentialsV2 | null> {
  const path = credentialsPath();
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (e: unknown) {
    if (isNotFound(e)) return null;
    throw e;
  }
  const parsed = JSON.parse(raw) as { version?: unknown };
  if (parsed.version === 2) {
    return parsed as unknown as StoredCredentialsV2;
  }
  if (parsed.version === 1) {
    const migrated = migrateV1ToV2(parsed as unknown as StoredCredentialsV1);
    await writeCredentials(migrated);
    return migrated;
  }
  throw new Error(
    `Unsupported credentials file version: ${String(parsed.version)}. ` +
      "Delete ~/.config/lmnr/credentials.json and re-run `lmnr-cli login`.",
  );
}

export async function writeCredentials(creds: StoredCredentialsV2): Promise<void> {
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
 * Returns the updated v2 blob.
 */
export async function upsertProfile(profile: ProfileEntry): Promise<StoredCredentialsV2> {
  const existing = (await readCredentials()) ?? emptyCredentials();
  existing.profiles[profile.projectId] = profile;
  existing.active = profile.projectId;
  await writeCredentials(existing);
  return existing;
}

export function emptyCredentials(): StoredCredentialsV2 {
  return { version: 2, active: null, profiles: {} };
}

/**
 * Wrap a v1 single-profile blob into the v2 envelope.
 * v1 entries without a projectId are keyed by a synthetic "default" id — the
 * caller can re-login to replace it with a real projectId-keyed profile.
 */
export function migrateV1ToV2(v1: StoredCredentialsV1): StoredCredentialsV2 {
  const projectId = v1.projectId && v1.projectId.length > 0 ? v1.projectId : "default";
  const profile: ProfileEntry = {
    tokenEndpoint: v1.tokenEndpoint,
    issuer: v1.issuer,
    baseUrl: v1.baseUrl,
    accessToken: v1.accessToken,
    accessTokenExpiresAt: v1.accessTokenExpiresAt,
    refreshToken: v1.refreshToken,
    refreshTokenExpiresAt: v1.refreshTokenExpiresAt,
    tokenType: v1.tokenType,
    scope: v1.scope,
    userEmail: v1.userEmail,
    userId: v1.userId,
    projectId,
    projectName: v1.projectName,
    workspaceId: v1.workspaceId,
    workspaceName: v1.workspaceName,
    createdAt: v1.createdAt,
  };
  return {
    version: 2,
    active: projectId,
    profiles: { [projectId]: profile },
  };
}

/**
 * Resolve a profile from the v2 blob by projectId (exact or prefix>=8) or
 * exact projectName. Returns null if not found.
 */
export function findProfile(
  creds: StoredCredentialsV2,
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

export function getActiveProfile(creds: StoredCredentialsV2): ProfileEntry | null {
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
