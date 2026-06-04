import { credentialsPath, readCredentials } from "../../auth/credentials";

export async function handleStatus(): Promise<void> {
  const creds = await readCredentials();
  if (!creds) {
    process.stderr.write("Not logged in. Run `lmnr-cli login`.\n");
    process.exit(6);
  }

  const accessExpiresAt = new Date(creds.accessTokenExpiresAt);
  const refreshExpiresAt = new Date(creds.refreshTokenExpiresAt);
  const accessLeftSec = Math.max(0, Math.floor((accessExpiresAt.getTime() - Date.now()) / 1000));
  const refreshLeftSec = Math.max(0, Math.floor((refreshExpiresAt.getTime() - Date.now()) / 1000));

  process.stdout.write(`Email:       ${creds.userEmail ?? "<unknown>"}\n`);
  process.stdout.write(`Project:     ${creds.projectName ?? creds.projectId ?? "<unknown>"}\n`);
  if (creds.workspaceName) process.stdout.write(`Workspace:   ${creds.workspaceName}\n`);
  process.stdout.write(`Issuer:      ${creds.issuer}\n`);
  process.stdout.write(`Base URL:    ${creds.baseUrl}\n`);
  process.stdout.write(`Scope:       ${creds.scope}\n`);
  const accessIso = accessExpiresAt.toISOString();
  const refreshIso = refreshExpiresAt.toISOString();
  process.stdout.write(
    `Access:      expires in ${formatDuration(accessLeftSec)} (${accessIso})\n`,
  );
  process.stdout.write(
    `Refresh:     expires in ${formatDuration(refreshLeftSec)} (${refreshIso})\n`,
  );
  process.stdout.write(`Stored at:   ${credentialsPath()}\n`);
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}
