import {
  type Dashboard,
  type DashboardChartConfig,
  type DashboardChartLayout,
  type DeleteDashboardChartsResult,
  type UpsertDashboardChartsResult,
} from "@lmnr-ai/types";

import { BaseResource, type LaminarAuth } from ".";

/**
 * One chart entry. With `id` it patches that chart (omitted fields are kept);
 * without `id` it creates one and needs `name`, `query` and `config`. `query`
 * and `config` must be sent together.
 */
export interface DashboardChartInput {
  id?: string;
  name?: string;
  /**
   * ClickHouse SELECT that filters its time column with
   * `{start_time:DateTime64}` / `{end_time:DateTime64}` (and buckets with
   * `{interval_unit:String}` for line/bar charts over `time`).
   */
  query?: string;
  config?: DashboardChartConfig;
  /** Omit to keep an existing chart's position or auto-place a new one. */
  layout?: DashboardChartLayout;
}

/**
 * Dashboard and chart writes over the CLI user-token surface
 * (`/v1/cli/dashboards`). Reads go through SQL (`dashboards` /
 * `dashboard_charts`). Chart queries are checked and test-run server-side
 * before anything is saved; error messages come back user-ready.
 */
export class DashboardsResource extends BaseResource {
  constructor(baseHttpUrl: string, auth: LaminarAuth) {
    super(baseHttpUrl, auth);
  }

  /**
   * Errors come back as `{error: string}` with user-facing text, so unwrap the
   * envelope before raising rather than showing the raw JSON body.
   */
  private async raiseDashboardError(response: Response): Promise<never> {
    const body = await response.text();
    let message = body;
    try {
      const parsed = JSON.parse(body) as { error?: unknown };
      if (typeof parsed?.error === "string" && parsed.error.length > 0) {
        message = parsed.error;
      }
    } catch {
      // Not JSON (proxy error page etc.) — use it as-is.
    }
    throw new Error(`${response.status} ${message}`);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const response = await fetch(
      `${this.baseHttpUrl}${this.apiPrefix}/dashboards${path}`,
      {
        method,
        headers: this.headers(),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      },
    );
    if (!response.ok) {
      await this.raiseDashboardError(response);
    }
    return response.json() as Promise<T>;
  }

  public async create(name: string): Promise<Dashboard> {
    return this.request("POST", "", { name });
  }

  public async rename(dashboardId: string, name: string): Promise<Dashboard> {
    return this.request("PATCH", `/${dashboardId}`, { name });
  }

  /**
   * Deletes the dashboard and all of its charts. The server refuses (409) to
   * delete a project's last dashboard.
   */
  public async delete(
    dashboardId: string,
  ): Promise<{ id: string; deleted: true }> {
    return this.request("DELETE", `/${dashboardId}`);
  }

  /**
   * Creates or updates charts in one all-or-nothing call (at most 30). Entries
   * with a `layout` are placed exactly and must not overlap each other; the
   * other charts on the dashboard are pushed down out of their way.
   */
  public async upsertCharts(
    dashboardId: string,
    charts: DashboardChartInput[],
  ): Promise<UpsertDashboardChartsResult> {
    return this.request("PUT", `/${dashboardId}/charts`, { charts });
  }

  /** Remaining charts keep their positions. */
  public async deleteCharts(
    dashboardId: string,
    chartIds: string[],
  ): Promise<DeleteDashboardChartsResult> {
    return this.request("DELETE", `/${dashboardId}/charts`, { chartIds });
  }
}
