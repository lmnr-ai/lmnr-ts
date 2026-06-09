// Standalone `GET /v1/project` probe authed by a PROJECT API KEY (not the
// user JWT). It's a separate helper rather than a `CliResource` method because
// `CliResource` is keyed by the user JWT, while this probe is keyed by the
// project key already sitting in the environment — overloading the resource's
// single-key model would be confusing.

import { DEFAULT_BASE_URL } from "../constants";

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Resolve which project an `LMNR_PROJECT_API_KEY` belongs to. Returns the
 * projectId on success, or null when the key is invalid/revoked (401) — the
 * caller treats null the same as "doesn't match the selected project" and
 * mints a fresh key.
 */
export async function getProjectId(
  projectApiKey: string,
  baseUrl: string = DEFAULT_BASE_URL,
): Promise<string | null> {
  const url = `${trimSlash(baseUrl)}/v1/project`;
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
