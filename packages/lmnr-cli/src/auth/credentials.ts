import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const CREDENTIALS_VERSION = 1;

export interface StoredCredentials {
  version: number;
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

export async function readCredentials(): Promise<StoredCredentials | null> {
  const path = credentialsPath();
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as StoredCredentials;
    if (parsed.version !== CREDENTIALS_VERSION) return null;
    return parsed;
  } catch (e: unknown) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

export async function writeCredentials(creds: StoredCredentials): Promise<void> {
  const path = credentialsPath();
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(creds, null, 2), { mode: 0o600 });
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
