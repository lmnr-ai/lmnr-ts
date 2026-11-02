/** Position on the 12-column dashboard grid: `x + w <= 12`. */
export interface DashboardChartLayout {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type DashboardChartType = "line" | "bar" | "horizontalBar" | "table";

export type DashboardChartDisplayMode = "total" | "average" | "none";

/**
 * How a raw-SQL chart draws its result rows; `x` / `y` / `breakdown` name
 * columns of the query's result. Line/bar/horizontalBar need `x` and `y`.
 */
export interface DashboardChartConfig {
  type: DashboardChartType;
  x?: string;
  y?: string;
  breakdown?: string;
  displayMode?: DashboardChartDisplayMode;
}

export interface Dashboard {
  id: string;
  projectId: string;
  name: string;
  createdAt: string;
  dashboardUrl: string;
}

export interface DashboardChartSummary {
  id: string;
  name: string;
  config: DashboardChartConfig | null;
  layout: DashboardChartLayout | null;
}

export interface UpsertDashboardChartsResult {
  /** The written charts, in input order. */
  charts: DashboardChartSummary[];
  /** Non-blocking caveats, e.g. a query with no rows to check axes against. */
  warnings: string[];
  dashboardUrl: string;
}

export interface DeleteDashboardChartsResult {
  /** Charts actually removed; ids not on the dashboard are skipped. */
  deleted: number;
  requested: number;
}
