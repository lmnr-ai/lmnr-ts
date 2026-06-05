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

export async function handleLogout(
  target: string | undefined,
  options: LogoutOptions = {},
): Promise<void> {
  if (options.all) {
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
