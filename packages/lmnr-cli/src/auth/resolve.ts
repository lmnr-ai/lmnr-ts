import {
  findProfile,
  getActiveProfile,
  type ProfileEntry,
  readCredentials,
  type StoredCredentials,
  writeCredentials,
} from "./credentials";

export interface AuthInputs {
  projectApiKey?: string;
  baseUrl?: string;
  port?: number;
  /** Explicit profile selector (id or name). Overrides env + active. */
  project?: string;
}

export interface ResolvedAuth {
  /** The Laminar project API key — passed to LaminarClient as projectApiKey. */
  bearer: string;
  baseUrl?: string;
  port?: number;
}

/**
 * Precedence (highest first):
 *   1. --project-api-key flag
 *   2. LMNR_PROJECT_API_KEY env
 *   3. --project <id|name> flag
 *   4. LMNR_PROJECT_ID env (matched against profile projectId / name / prefix)
 *   5. active profile in credentials.json
 *   6. single-profile shortcut
 *   7. error
 */
export async function resolveAuth(opts: AuthInputs): Promise<ResolvedAuth> {
  if (opts.projectApiKey && opts.projectApiKey.length > 0) {
    return { bearer: opts.projectApiKey, baseUrl: opts.baseUrl, port: opts.port };
  }
  const envKey = process.env.LMNR_PROJECT_API_KEY;
  if (envKey && envKey.length > 0) {
    return { bearer: envKey, baseUrl: opts.baseUrl, port: opts.port };
  }

  const creds = await readCredentials();
  if (!creds) {
    throw new Error(
      "Not authenticated. Run `lmnr-cli login` or pass --project-api-key " +
        "/ set LMNR_PROJECT_API_KEY.",
    );
  }

  const profile = pickProfile(creds, opts.project);
  const updated = await touchLastUsed(creds, profile);
  return {
    bearer: updated.accessToken,
    baseUrl: opts.baseUrl ?? updated.baseUrl,
    port: opts.port,
  };
}

function pickProfile(creds: StoredCredentials, explicit?: string): ProfileEntry {
  if (explicit && explicit.length > 0) {
    const match = findProfile(creds, explicit);
    if (!match) {
      throw new Error(
        `No profile matching '${explicit}'. Run \`lmnr-cli list\` to see available profiles.`,
      );
    }
    return match;
  }
  const envProject = process.env.LMNR_PROJECT_ID;
  if (envProject && envProject.length > 0) {
    const match = findProfile(creds, envProject);
    if (!match) {
      throw new Error(
        `LMNR_PROJECT_ID='${envProject}' does not match any stored profile. ` +
          "Run `lmnr-cli list` to see available profiles.",
      );
    }
    return match;
  }
  const active = getActiveProfile(creds);
  if (active) return active;
  const all = Object.values(creds.profiles);
  if (all.length === 1) return all[0];
  if (all.length === 0) {
    throw new Error("Not authenticated. Run `lmnr-cli login`.");
  }
  throw new Error(
    "Multiple profiles found, specify --project <name|id> or run `lmnr-cli switch <name>`.",
  );
}

/**
 * Bump lastUsedAt on the picked profile and persist. Project API keys don't
 * expire — the historical refresh-grant branch is gone.
 */
export async function refreshIfNeeded(
  creds: StoredCredentials,
  profile: ProfileEntry,
): Promise<ProfileEntry> {
  return touchLastUsed(creds, profile);
}

async function touchLastUsed(
  creds: StoredCredentials,
  profile: ProfileEntry,
): Promise<ProfileEntry> {
  const updated: ProfileEntry = { ...profile, lastUsedAt: new Date().toISOString() };
  creds.profiles[updated.projectId] = updated;
  await writeCredentials(creds);
  return updated;
}
