class BaseResource {
  protected readonly baseHttpUrl: string;
  protected readonly projectApiKey: string;

  constructor(baseHttpUrl: string, projectApiKey: string) {
    this.baseHttpUrl = baseHttpUrl;
    this.projectApiKey = projectApiKey;
  }

  protected headers() {
    return {
      Authorization: `Bearer ${this.projectApiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  protected async handleError(response: Response) {
    const errorMsg = await response.text();
    throw new Error(`${response.status} ${errorMsg}`);
  }
}

export { BaseResource };
