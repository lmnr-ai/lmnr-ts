import { credentialsPath, deleteCredentials } from "../../auth/credentials";

export async function handleLogout(): Promise<void> {
  const existed = await deleteCredentials();
  if (existed) {
    process.stderr.write(`Removed ${credentialsPath()}.\n`);
  } else {
    process.stderr.write("Already logged out.\n");
  }
}
