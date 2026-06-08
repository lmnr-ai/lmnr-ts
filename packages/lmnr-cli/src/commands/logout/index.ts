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
 * Best-effort server-side session revoke via POST /api/auth/sign-out with the
 * session token as Bearer. Logout MUST complete locally even if the server is
 * unreachable — the user expects "log me out" to remove the file. On any
 * failure we log to stderr and continue.
 */
export async function revokeSession(profile: ProfileEntry): Promise<void> {
  if (!profile.sessionToken || profile.sessionToken.length === 0) {
    return;
  }
  const url = `${trimSlash(profile.issuer)}/api/auth/sign-out`;
  try {
    // BetterAuth's sign-out 500s on an empty body (JSON parse fails); send `{}`.
    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${profile.sessionToken}`, "content-type": "application/json" },
      body: "{}",
    });
    if (!res.ok) {
      process.stderr.write(
        `warning: session revoke at ${url} returned ${res.status}; local credentials still removed.\n`,
      );
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(
      `warning: session revoke at ${url} failed (${msg}); local credentials still removed.\n`,
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
      await Promise.all(Object.values(creds.profiles).map(revokeSession));
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

  await revokeSession(toRemove);

  const removedLabel = toRemove.userEmail ?? toRemove.userId;
  delete creds.profiles[toRemove.userId];

  const remaining = Object.values(creds.profiles);
  if (remaining.length === 0) {
    await deleteCredentials();
    process.stderr.write(`Logged out of ${removedLabel}.\n`);
    return;
  }

  if (creds.active === toRemove.userId) {
    creds.active = pickNextActive(remaining).userId;
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
  process.stderr.write("No active profile to log out of. Pass <email|userId> or --all.\n");
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
