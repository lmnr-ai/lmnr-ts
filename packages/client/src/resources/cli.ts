import { BaseResource } from "./index";

export interface CliProject {
  id: string;
  name: string;
  workspaceId: string;
  workspaceName: string;
}

/**
 * User-scoped CLI endpoints that don't target a specific project. Authed by the
 * BetterAuth user JWT (passed as `projectApiKey`); deliberately does NOT send an
 * `x-lmnr-project-id` header (these routes are project discovery, pre-selection).
 */
export class CliResource extends BaseResource {
  constructor(baseHttpUrl: string, projectApiKey: string) {
    super(baseHttpUrl, projectApiKey);
  }

  /** Workspaces + projects the authenticated user can access. */
  public async listProjects(): Promise<CliProject[]> {
    const response = await fetch(`${this.baseHttpUrl}/v1/cli/projects`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.projectApiKey}`,
        Accept: "application/json",
      },
    });
    if (!response.ok) {
      await this.handleError(response);
    }
    return (await response.json()).projects as CliProject[];
  }
}
