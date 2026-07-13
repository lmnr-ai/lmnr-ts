/**
 * Mint a project API key from a logged-in user session. Shared by `setup` and
 * `plugin add` — both POST /api/cli/api-key with the session bearer for an
 * explicit project; the only difference is the `deviceName` label the key shows
 * under in the dashboard.
 */

export interface MintedApiKey {
  apiKey: string;
  apiKeyId?: string;
  projectId?: string;
  projectName?: string;
  workspaceId?: string;
  workspaceName?: string;
}

const trimTrailingSlashes = (url: string): string => url.replace(/\/+$/, "");

export const mintProjectApiKey = async (
  issuer: string,
  sessionToken: string,
  projectId: string,
  deviceName: string,
): Promise<MintedApiKey> => {
  const res = await fetch(`${trimTrailingSlashes(issuer)}/api/cli/api-key`, {
    method: "POST",
    headers: { authorization: `Bearer ${sessionToken}`, "content-type": "application/json" },
    body: JSON.stringify({ deviceName, projectId }),
  });
  if (res.ok) {
    return (await res.json()) as MintedApiKey;
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  throw new Error(body.error ?? `api-key request failed (${res.status})`);
};
