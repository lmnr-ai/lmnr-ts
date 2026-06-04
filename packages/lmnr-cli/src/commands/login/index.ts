import open from "open";

import { type StoredCredentials, writeCredentials } from "../../auth/credentials";
import { decodeAccessToken } from "../../auth/jwt";
import { CLI_CLIENT_ID, CLI_SCOPE, getConfig, initiate, poll } from "../../auth/oidc";

const DEFAULT_DASHBOARD_URL = "https://www.laminar.sh";
const DEFAULT_BASE_URL = "https://api.lmnr.ai";

export interface LoginOptions {
  dashboardUrl?: string;
  baseUrl?: string;
  projectId?: string;
  noBrowser?: boolean;
}

export async function handleLogin(options: LoginOptions): Promise<void> {
  const issuer = pick(options.dashboardUrl, process.env.LMNR_DASHBOARD_URL, DEFAULT_DASHBOARD_URL);
  const baseUrl = pick(options.baseUrl, process.env.LMNR_BASE_URL, DEFAULT_BASE_URL);

  const config = await getConfig(issuer);

  const da = await initiate(
    config,
    CLI_SCOPE,
    options.projectId ? { project_id: options.projectId } : undefined,
  );

  const completeUri = da.verification_uri_complete ?? da.verification_uri;
  process.stderr.write(`\nOpen this URL in your browser to authorize:\n  ${completeUri}\n`);
  if (da.user_code) {
    process.stderr.write(`Code: ${da.user_code}\n\n`);
  }

  if (!options.noBrowser) {
    try {
      await open(completeUri);
    } catch {
      // Best-effort — the user can copy/paste the URL.
    }
  }

  process.stderr.write("Waiting for authorization...\n");
  const tokens = await poll(config, da);

  if (!tokens.access_token || !tokens.refresh_token) {
    throw new Error("Token response missing access_token or refresh_token");
  }

  const claims = decodeAccessToken(tokens.access_token);
  const expiresInSec = tokens.expires_in ?? 3600;
  const refreshExpiresIn =
    typeof (tokens as Record<string, unknown>).refresh_token_expires_in === "number"
      ? ((tokens as Record<string, unknown>).refresh_token_expires_in as number)
      : 30 * 24 * 60 * 60;

  // Best-effort name enrichment via /api/cli/me — fails silently if the
  // browser session is not shared with the CLI process.
  let projectName: string | undefined;
  let workspaceName: string | undefined;
  let workspaceId: string | undefined;
  if (claims?.project_id) {
    try {
      const trimmedIssuer = issuer.replace(/\/+$/, "");
      const projectIdQs = encodeURIComponent(claims.project_id);
      const url = `${trimmedIssuer}/api/cli/me?projectId=${projectIdQs}`;
      const res = await fetch(url, {
        headers: { authorization: `Bearer ${tokens.access_token}` },
      });
      if (res.ok) {
        const body = (await res.json()) as {
          project?: { id: string; name: string; workspaceId: string; workspaceName: string };
        };
        if (body.project) {
          projectName = body.project.name;
          workspaceName = body.project.workspaceName;
          workspaceId = body.project.workspaceId;
        }
      }
    } catch {
      // Ignore — CLI doesn't carry the browser session cookie.
    }
  }

  const creds: StoredCredentials = {
    version: 1,
    tokenEndpoint: `${issuer.replace(/\/+$/, "")}/oauth/token`,
    issuer,
    baseUrl,
    accessToken: tokens.access_token,
    accessTokenExpiresAt: new Date(Date.now() + expiresInSec * 1000).toISOString(),
    refreshToken: tokens.refresh_token,
    refreshTokenExpiresAt: new Date(Date.now() + refreshExpiresIn * 1000).toISOString(),
    tokenType: tokens.token_type ?? "Bearer",
    scope: tokens.scope ?? CLI_SCOPE,
    userEmail: claims?.email,
    userId: claims?.sub,
    projectId: claims?.project_id,
    projectName,
    workspaceId,
    workspaceName,
    createdAt: new Date().toISOString(),
  };
  await writeCredentials(creds);

  const projectLabel = projectName ? `${projectName}` : (claims?.project_id ?? "<unknown>");
  process.stderr.write(`Logged in as ${claims?.email ?? "<unknown>"}. Project: ${projectLabel}.\n`);
  process.stderr.write(
    `Client: ${CLI_CLIENT_ID}. Tokens stored at ~/.config/lmnr/credentials.json (mode 0600).\n`,
  );
}

function pick(...candidates: (string | undefined)[]): string {
  for (const c of candidates) {
    if (c && c.length > 0) return c;
  }
  return "";
}
