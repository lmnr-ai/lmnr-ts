import { findProfile, readCredentials, writeCredentials } from "../../auth/credentials";

export async function handleSwitch(target: string): Promise<void> {
  const creds = await readCredentials();
  if (!creds || Object.keys(creds.profiles).length === 0) {
    process.stderr.write("Not logged in.\n");
    process.exit(6);
  }

  const match = findProfile(creds, target);
  if (!match) {
    process.stderr.write(
      `No profile matching '${target}'. Run \`lmnr-cli list\` to see available profiles.\n`,
    );
    process.exit(1);
  }

  creds.active = match.userId;
  await writeCredentials(creds);
  const label = match.userEmail ?? match.userId;
  process.stdout.write(`Switched to ${label}\n`);
}
