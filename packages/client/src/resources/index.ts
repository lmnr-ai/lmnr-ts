class BaseResource {
  protected readonly baseHttpUrl: string;
  protected readonly projectApiKey: string;
  /**
   * When set, the bearer is a BetterAuth user access JWT (not a project API
   * key): requests route to the `/v1/cli/*` user-token surface and carry the
   * target project in the `x-lmnr-project-id` header. Unset → normal `/v1/*`.
   */
  protected readonly cliUserProjectId?: string;

  constructor(baseHttpUrl: string, projectApiKey: string, cliUserProjectId?: string) {
    this.baseHttpUrl = baseHttpUrl;
    this.projectApiKey = projectApiKey;
    this.cliUserProjectId = cliUserProjectId;
  }

  /** API path prefix: `/v1/cli` for CLI user-token auth, `/v1` otherwise. */
  protected get apiPrefix(): string {
    return this.cliUserProjectId ? "/v1/cli" : "/v1";
  }

  protected headers() {
    return {
      Authorization: `Bearer ${this.projectApiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(this.cliUserProjectId ? { "x-lmnr-project-id": this.cliUserProjectId } : {}),
    };
  }

  protected async handleError(response: Response) {
    const errorMsg = await response.text();
    throw new Error(`${response.status} ${errorMsg}`);
  }
}

export { BaseResource };
