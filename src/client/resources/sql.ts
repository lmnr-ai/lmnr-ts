import { BaseResource } from "./index";

export class SqlResource extends BaseResource {
  constructor(baseHttpUrl: string, projectApiKey: string) {
    super(baseHttpUrl, projectApiKey);
  }

  public async query(sql: string): Promise<Array<Record<string, any>>> {
    const response = await fetch(`${this.baseHttpUrl}/v1/sql/query`, {
      method: "POST",
      headers: {
        ...this.headers(),
      },
      body: JSON.stringify({
        query: sql,
      }),
    });

    if (!response.ok) {
      await this.handleError(response);
    }

    return await response.json() as Array<Record<string, any>>;
  }
}
