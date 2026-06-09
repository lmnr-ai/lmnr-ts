import { BaseResource } from "./index";

export class SqlResource extends BaseResource {
  constructor(baseHttpUrl: string, projectApiKey: string, cliUserProjectId?: string) {
    super(baseHttpUrl, projectApiKey, cliUserProjectId);
  }

  public async query(
    sql: string,
    parameters: Record<string, any> = {},
  ): Promise<Array<Record<string, any>>> {
    const response = await fetch(`${this.baseHttpUrl}${this.apiPrefix}/sql/query`, {
      method: "POST",
      headers: {
        ...this.headers(),
      },
      body: JSON.stringify({
        query: sql,
        parameters,
      }),
    });

    if (!response.ok) {
      await this.handleError(response);
    }

    return (await response.json()).data as Array<Record<string, any>>;
  }
}
