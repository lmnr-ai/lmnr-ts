// Standalone `GET /v1/cli/whoami` probe authed by a PROJECT API KEY (not the
// user JWT). It's a separate helper rather than a `CliResource` method because
// `CliResource` is keyed by the user JWT, while whoami is keyed by the project
// key already sitting in the environment — overloading the resource's
// single-key model would be confusing.

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

const DEFAULT_BASE_URL = "https://api.lmnr.ai";

/**
 * Resolve which project an `LMNR_PROJECT_API_KEY` belongs to. Returns the
 * projectId on success, or null when the key is invalid/revoked (401) — the
 * caller treats null the same as "doesn't match the selected project" and
 * mints a fresh key.
 */
export async function whoami(
  projectApiKey: string,
  baseUrl: string = DEFAULT_BASE_URL,
): Promise<string | null> {
  const url = `${trimSlash(baseUrl)}/v1/cli/whoami`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${projectApiKey}`,
        Accept: "application/json",
      },
    });
  } catch {
    // Network error — can't verify; treat as "unknown" so the caller mints.
    return null;
  }
  if (res.status === 401) return null;
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as { projectId?: string } | null;
  return body?.projectId ?? null;
}
