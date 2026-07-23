import { BaseResource, type LaminarAuth } from "./index";

export interface CliProject {
  id: string;
  name: string;
  workspaceId: string;
  workspaceName: string;
}

/**
 * Locale-aware, case-insensitive comparator for the project listing. Ordering
 * lives here — the single choke point every CLI surface (the `project list`
 * table + its `--json`, and the interactive picker used by `setup` / `plugin
 * add`) reads from — so the order can't drift between surfaces.
 */
const projectCollator = new Intl.Collator(undefined, { sensitivity: "base" });

/** Sort projects by workspace name, then project name (stable, human-scannable). */
const sortProjects = (projects: CliProject[]): CliProject[] =>
  [...projects].sort(
    (a, b) =>
      projectCollator.compare(a.workspaceName ?? "", b.workspaceName ?? "") ||
      projectCollator.compare(a.name ?? "", b.name ?? ""),
  );

/**
 * Outcome of resolving which project a project API key belongs to via the
 * user-token CLI endpoint. The states are deliberately distinct so the caller
 * doesn't conflate "key is bad" with "couldn't reach the server":
 *  - `ok`           → key verified AND the user is a member; `projectId` is its owner.
 *  - `invalid`      → 401: key revoked/invalid. Safe to mint a fresh one.
 *  - `unverifiable` → 403 (key belongs to a project the user can't access) /
 *    network error / other non-2xx / malformed body. The key may be perfectly
 *    valid — caller MUST NOT mint (minting would clobber it on a blip).
 */
export type ProjectKeyProbe =
  | { status: "ok"; projectId: string }
  | { status: "invalid" }
  | { status: "unverifiable" };

/**
 * User-scoped CLI endpoints that don't target a specific project. Authed by the
 * BetterAuth user JWT (the `credential`); deliberately does NOT send an
 * `x-lmnr-project-id` header (these routes are project discovery, pre-selection).
 *
 * Discovery exception: this resource always hits `/v1/cli/projects` with the
 * bare bearer and overrides `BaseResource.headers()`/`apiPrefix`, so it works
 * even when constructed with a `userToken` auth that has no real project id yet.
 */
export class CliResource extends BaseResource {
  constructor(baseHttpUrl: string, auth: LaminarAuth) {
    super(baseHttpUrl, auth);
  }

  /** Workspaces + projects the authenticated user can access. */
  public async listProjects(): Promise<CliProject[]> {
    const response = await fetch(`${this.baseHttpUrl}/v1/cli/projects`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.credential}`,
        Accept: "application/json",
      },
    });
    if (!response.ok) {
      await this.handleError(response);
    }
    // Coerce a missing/non-array `projects` to [] so callers (.length/.map)
    // don't throw. A malformed body on a 2xx is exceptional — let it surface.
    // Sort here so every consumer inherits one stable, alphabetical order.
    const body = (await response.json()) as { projects?: CliProject[] };
    return Array.isArray(body?.projects) ? sortProjects(body.projects) : [];
  }

  /**
   * Resolve which project a project API key belongs to. Authed by the user JWT
   * (the bearer); the project key travels in the body, NOT in `Authorization`.
   * The server verifies the key and that the authenticated user is a member of
   * the resolved project. Returns a tri-state probe so callers can distinguish a
   * revoked key (401 → `invalid`) from a server/access problem (`unverifiable`).
   */
  public async resolveProjectByApiKey(apiKey: string): Promise<ProjectKeyProbe> {
    let response: Response;
    try {
      response = await fetch(`${this.baseHttpUrl}/v1/cli/project`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.credential}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ apiKey }),
      });
    } catch {
      return { status: "unverifiable" };
    }
    if (response.status === 401) return { status: "invalid" };
    if (!response.ok) return { status: "unverifiable" };
    const body = (await response.json().catch(() => null)) as { projectId?: string } | null;
    return body?.projectId
      ? { status: "ok", projectId: body.projectId }
      : { status: "unverifiable" };
  }
}
