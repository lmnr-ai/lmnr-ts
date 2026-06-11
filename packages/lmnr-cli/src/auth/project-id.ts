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
 * Outcome of probing which project an `LMNR_PROJECT_API_KEY` belongs to. These
 * are deliberately distinct so the caller doesn't conflate "key is bad" with
 * "couldn't reach the server":
 *  - `ok`           → key verified; `projectId` is its owner.
 *  - `invalid`      → 401: key revoked/invalid. Safe to mint a fresh one.
 *  - `unverifiable` → network error / non-401 / malformed body. The key may be
 *    perfectly valid — caller MUST NOT mint (minting would clobber it on a blip).
 */
export type KeyProbe =
  | { status: "ok"; projectId: string }
  | { status: "invalid" }
  | { status: "unverifiable" };

export async function probeProjectKey(
  projectApiKey: string,
  baseUrl: string = DEFAULT_BASE_URL,
  port?: number,
): Promise<KeyProbe> {
  // Compose host + port the same way the real CLI clients do (baseUrl carries
  // no port by convention; LMNR_HTTP_PORT/--port is separate). new URL().port
  // rather than `:${port}` concat so a baseUrl with a path still works.
  const url = new URL(trimSlash(baseUrl));
  if (port) url.port = String(port);
  url.pathname = "/v1/project";
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${projectApiKey}`,
        Accept: "application/json",
      },
    });
  } catch {
    return { status: "unverifiable" };
  }
  if (res.status === 401) return { status: "invalid" };
  if (!res.ok) return { status: "unverifiable" };
  const body = (await res.json().catch(() => null)) as { projectId?: string } | null;
  return body?.projectId ? { status: "ok", projectId: body.projectId } : { status: "unverifiable" };
}
