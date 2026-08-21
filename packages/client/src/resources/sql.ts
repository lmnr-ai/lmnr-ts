import type { SqlSchema } from "@lmnr-ai/types";

import { BaseResource, type LaminarAuth } from "./index";

export class SqlResource extends BaseResource {
  constructor(baseHttpUrl: string, auth: LaminarAuth) {
    super(baseHttpUrl, auth);
  }

  public async query(
    sql: string,
    parameters: Record<string, any> = {},
  ): Promise<Array<Record<string, any>>> {
    const response = await fetch(
      `${this.baseHttpUrl}${this.apiPrefix}/sql/query`,
      {
        method: "POST",
        headers: {
          ...this.headers(),
        },
        body: JSON.stringify({
          query: sql,
          parameters,
        }),
      },
    );

    if (!response.ok) {
      await this.handleError(response);
    }

    return (await response.json()).data as Array<Record<string, any>>;
  }

  /**
   * Fetch the queryable tables, columns, and enums. Server-rendered from
   * app-server's `query_engine::schema`, so it is the same source that backs
   * the MCP `query_laminar_sql` tool description — never a client-side copy.
   */
  public async schema(): Promise<SqlSchema> {
    const response = await fetch(
      `${this.baseHttpUrl}${this.apiPrefix}/sql/schema`,
      {
        method: "GET",
        headers: {
          ...this.headers(),
        },
      },
    );

    if (!response.ok) {
      await this.handleError(response);
    }

    return (await response.json()) as SqlSchema;
  }
}
