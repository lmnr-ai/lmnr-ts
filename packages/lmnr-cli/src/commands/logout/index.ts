import {
  credentialsPath,
  deleteCredentials,
  findProfile,
  getActiveProfile,
  type ProfileEntry,
  readCredentials,
  type StoredCredentialsV2,
  writeCredentials,
} from "../../auth/credentials";

export interface LogoutOptions {
  all?: boolean;
}

/**
 * Best-effort RFC 7009 revoke. Logout MUST complete locally even if the
 * server is unreachable - the user expects "log me out" to remove the file.
 * On any failure we log to stderr and continue.
 */
export async function revokeRefreshToken(profile: ProfileEntry): Promise<void> {
  // Derive the revoke endpoint from the saved token endpoint. The discovery
  // metadata now exposes `revocation_endpoint` but we avoid an extra fetch
  // here - the token / revoke routes are siblings under `/oauth/` by design.
  const revokeUrl = deriveRevokeEndpoint(profile.tokenEndpoint);
  if (!revokeUrl) {
    process.stderr.write(
      "warning: could not derive revoke endpoint from " +
        `${profile.tokenEndpoint}; skipping server-side revoke.\n`,
    );
    return;
  }
  const body = new URLSearchParams({
    token: profile.refreshToken,
    token_type_hint: "refresh_token",
  });
  try {
    const res = await fetch(revokeUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) {
      process.stderr.write(
        `warning: refresh-token revoke at ${revokeUrl} returned ` +
          `${res.status}; local credentials still removed.\n`,
      );
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(
      `warning: refresh-token revoke at ${revokeUrl} failed ` +
        `(${msg}); local credentials still removed.\n`,
    );
  }
}

export function deriveRevokeEndpoint(tokenEndpoint: string): string | null {
  try {
    const url = new URL(tokenEndpoint);
    if (url.pathname.endsWith("/oauth/token")) {
      url.pathname = url.pathname.slice(0, -"/oauth/token".length) + "/oauth/revoke";
      return url.toString();
    }
    if (url.pathname.endsWith("/token")) {
      url.pathname = url.pathname.slice(0, -"/token".length) + "/revoke";
      return url.toString();
    }
    return null;
  } catch {
    return null;
  }
}

export async function handleLogout(
  target: string | undefined,
  options: LogoutOptions = {},
): Promise<void> {
  if (options.all) {
    // Revoke every refresh family before nuking the file so the server-side
    // tokens are dead even if the user re-installs / re-uses the file.
    const creds = await readCredentials();
    if (creds) {
      await Promise.all(Object.values(creds.profiles).map(revokeRefreshToken));
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
    // resolveTarget already wrote a stderr message and called process.exit.
    return;
  }

  // Revoke BEFORE removing from credentials so a crash between revoke + write
  // leaves the user able to retry. If revoke fails we still proceed locally.
  await revokeRefreshToken(toRemove);

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
  creds: StoredCredentialsV2,
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

// Re-export for tests that want to inspect type without depending on creds.
export type { StoredCredentialsV2 };
