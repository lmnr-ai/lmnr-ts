import { BaseResource, type LaminarAuth } from "./index";

export interface CliProject {
  id: string;
  name: string;
  workspaceId: string;
  workspaceName: string;
}

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
    // Guard the cast: callers do .length/.map, so coerce a missing/non-array
    // `projects` to [] rather than letting them throw on undefined.
    const body = (await response.json().catch(() => null)) as { projects?: CliProject[] } | null;
    return Array.isArray(body?.projects) ? body.projects : [];
  }
}
