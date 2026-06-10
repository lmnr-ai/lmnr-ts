import {
  type Credentials,
  credentialsPath,
  deleteCredentials,
  readCredentials,
} from "../../auth/credentials";

/**
 * Best-effort server-side session revoke via POST /api/auth/sign-out with the
 * session token as Bearer. Logout MUST complete locally even if the server is
 * unreachable — the user expects "log me out" to remove the file. On any
 * failure we log to stderr and continue.
 */
export async function revokeSession(creds: Credentials): Promise<void> {
  if (!creds.sessionToken || creds.sessionToken.length === 0) {
    return;
  }
  const url = `${trimSlash(creds.issuer)}/api/auth/sign-out`;
  try {
    // BetterAuth's sign-out 500s on an empty body (JSON parse fails); send `{}`.
    const res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${creds.sessionToken}`,
        "content-type": "application/json",
      },
      body: "{}",
    });
    if (!res.ok) {
      process.stderr.write(
        `warning: session revoke at ${url} returned ${res.status}; ` +
          "local credentials still removed.\n",
      );
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(
      `warning: session revoke at ${url} failed (${msg}); local credentials still removed.\n`,
    );
  }
}

export async function handleLogout(): Promise<void> {
  const creds = await readCredentials();
  if (!creds) {
    process.stderr.write("Already logged out.\n");
    return;
  }
  const label = creds.userEmail ?? creds.userId;
  // Delete the local file FIRST, then best-effort revoke the server session.
  // "Log me out" must remove the credentials even if the network revoke hangs
  // or fails. Accepted residual race: a concurrent near-expiry refresh may
  // re-write creds just after this delete (durable token + inert JWT; no lock).
  await deleteCredentials();
  await revokeSession(creds);
  process.stderr.write(`Logged out of ${label}. Removed ${credentialsPath()}.\n`);
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}
