import fs from "fs/promises";
import os from "os";
import path from "path";

export interface Credentials {
  version: 1;
  baseUrl: string;
  dashboardUrl: string;
  projectId: string;
  projectName: string;
  // On-disk key field is `projectApiKey` (read by resolveAuth). SPEC's `apiKey`
  // maps here.
  projectApiKey: string;
  // No longer returned by the new token route — kept optional so legacy files
  // and `status` output stay stable.
  workspaceId?: string;
  workspaceName?: string;
  userEmail?: string;
  createdAt?: string;
}

// XDG-aware: ~/.config/lmnr/credentials.json (honours XDG_CONFIG_HOME).
export const credentialsDir = (): string =>
  path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "lmnr");
export const credentialsPath = (): string =>
  path.join(credentialsDir(), "credentials.json");

export const readCredentials = async (): Promise<Credentials | null> => {
  try {
    const raw = await fs.readFile(credentialsPath(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<Credentials>;
    if (parsed.version !== 1 || typeof parsed.projectApiKey !== "string") {
      // Schema mismatch — bail rather than silently use stale fields.
      throw new Error(
        `Unrecognized credentials schema in ${credentialsPath()}.` +
          " Run `lmnr-cli setup` or `lmnr-cli login` to refresh.",
      );
    }
    return parsed as Credentials;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
};

export const writeCredentials = async (creds: Credentials): Promise<void> => {
  await fs.mkdir(credentialsDir(), { recursive: true, mode: 0o700 });
  // Ensure 0700 even when dir already existed; mkdir's mode is only honoured on
  // creation. POSIX-only; Windows ignores chmod silently.
  try {
    await fs.chmod(credentialsDir(), 0o700);
  } catch {
    /* ignore — Windows */
  }
  await fs.writeFile(credentialsPath(), JSON.stringify(creds, null, 2), {
    mode: 0o600,
  });
  try {
    await fs.chmod(credentialsPath(), 0o600);
  } catch {
    /* ignore — Windows */
  }
};

export const deleteCredentials = async (): Promise<boolean> => {
  try {
    await fs.unlink(credentialsPath());
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
};
