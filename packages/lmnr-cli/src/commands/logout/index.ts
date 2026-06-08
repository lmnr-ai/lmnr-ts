import {
  credentialsPath,
  deleteCredentials,
  findProfile,
  getActiveProfile,
  type ProfileEntry,
  readCredentials,
  type StoredCredentials,
  writeCredentials,
} from "../../auth/credentials";

export interface LogoutOptions {
  all?: boolean;
}

/**
 * Best-effort server-side revoke of the project API key. Logout MUST complete
 * locally even if the server is unreachable - the user expects "log me out"
 * to remove the file. On any failure we log to stderr and continue.
 *
 * Auth: we send the same API key being deleted as the Bearer. The Laminar
 * project API keys DELETE route accepts the key being revoked as auth for
 * itself; if the project's authz rules tighten in the future this becomes a
 * best-effort fall-through (the local file is still deleted).
 */
export async function revokeProjectApiKey(profile: ProfileEntry): Promise<void> {
  if (!profile.apiKeyId || profile.apiKeyId.length === 0) {
    process.stderr.write(
      "warning: profile has no apiKeyId; skipping server-side revoke. " +
        `Revoke manually at ${trimSlash(profile.issuer)}/project/${profile.projectId}/settings/api-keys.\n`,
    );
    return;
  }
  const url = `${trimSlash(profile.issuer)}/api/projects/${profile.projectId}/api-keys/${profile.apiKeyId}`;
  try {
    const res = await fetch(url, {
      method: "DELETE",
      headers: { authorization: `Bearer ${profile.accessToken}` },
    });
    if (!res.ok) {
      process.stderr.write(
        `warning: API key revoke at ${url} returned ${res.status}; local credentials still removed.\n`,
      );
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(
      `warning: API key revoke at ${url} failed (${msg}); local credentials still removed.\n`,
    );
  }
}

export async function handleLogout(
  target: string | undefined,
  options: LogoutOptions = {},
): Promise<void> {
  if (options.all) {
    const creds = await readCredentials();
    if (creds) {
      await Promise.all(Object.values(creds.profiles).map(revokeProjectApiKey));
    }
    const existed = await deleteCredentials();
    if (existed) {
      process.stderr.write(`Removed ${credentialsPath()}.\n`);
    } else {
      process.stderr.write("Already logged out.\n");
    }
    return;
  }

  const creds = await readCredentials();
  if (!creds || Object.keys(creds.profiles).length === 0) {
    process.stderr.write("Already logged out.\n");
    return;
  }

  const toRemove = resolveTarget(creds, target);
  if (!toRemove) {
    return;
  }

  await revokeProjectApiKey(toRemove);

  const removedLabel = toRemove.projectName ?? toRemove.projectId;
  delete creds.profiles[toRemove.projectId];

  const remaining = Object.values(creds.profiles);
  if (remaining.length === 0) {
    await deleteCredentials();
    process.stderr.write(`Logged out of ${removedLabel}.\n`);
    return;
  }

  if (creds.active === toRemove.projectId) {
    creds.active = pickNextActive(remaining).projectId;
  }
  await writeCredentials(creds);
  process.stderr.write(`Logged out of ${removedLabel}.\n`);
}

function resolveTarget(
  creds: StoredCredentials,
  target: string | undefined,
): ProfileEntry | null {
  if (target && target.length > 0) {
    const match = findProfile(creds, target);
    if (!match) {
      process.stderr.write(
        `No profile matching '${target}'. Run \`lmnr-cli list\` to see available profiles.\n`,
      );
      process.exit(1);
    }
    return match;
  }
  const all = Object.values(creds.profiles);
  if (all.length === 1) return all[0];
  const active = getActiveProfile(creds);
  if (active) return active;
  process.stderr.write("No active profile to log out of. Pass <id|name> or --all.\n");
  process.exit(1);
}

function pickNextActive(profiles: ProfileEntry[]): ProfileEntry {
  const sorted = [...profiles].sort((a, b) => {
    const aT = new Date(a.lastUsedAt ?? a.createdAt).getTime();
    const bT = new Date(b.lastUsedAt ?? b.createdAt).getTime();
    return bT - aT;
  });
  return sorted[0];
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

// Re-export for tests that want to inspect type without depending on creds.
export type { StoredCredentials };
