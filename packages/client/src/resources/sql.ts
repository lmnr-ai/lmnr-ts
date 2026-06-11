import { BaseResource, type LaminarAuth } from "./index";

export class SqlResource extends BaseResource {
  constructor(baseHttpUrl: string, auth: LaminarAuth) {
    super(baseHttpUrl, auth);
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
