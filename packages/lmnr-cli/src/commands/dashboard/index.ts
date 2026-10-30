import type { LaminarClient } from "@lmnr-ai/client";
import type { Dashboard } from "@lmnr-ai/types";

import type { GlobalOpts } from "../../auth/with-client";
import { initializeLogger } from "../../utils/logger";
import { outputJson } from "../../utils/output";
import { renderTable } from "../../utils/table";
import { buildCharts, type ChartFlagOpts } from "./flags";

const logger = initializeLogger();

type DashboardUpsertOpts = GlobalOpts & { id?: string };
type ChartUpsertOpts = GlobalOpts & ChartFlagOpts;

const printDashboard = (verb: string, dashboard: Dashboard): void => {
  logger.info(`${verb} dashboard "${dashboard.name}" (${dashboard.id}).`);
  logger.info(`  ${dashboard.dashboardUrl}`);
};

/**
 * `lmnr-cli dashboard upsert <name> [--id <dashboard-id>]` — creates a
 * dashboard, or renames the one `--id` names.
 */
export const handleDashboardUpsert = async (
  client: LaminarClient,
  name: string,
  opts: DashboardUpsertOpts,
): Promise<void> => {
  const dashboard =
    opts.id === undefined
      ? await client.dashboards.create(name)
      : await client.dashboards.rename(opts.id, name);
  if (opts.json) {
    outputJson(dashboard);
    return;
  }
  printDashboard(opts.id === undefined ? "Created" : "Renamed", dashboard);
};

/** `lmnr-cli dashboard delete <dashboard-id>` */
export const handleDashboardDelete = async (
  client: LaminarClient,
  dashboardId: string,
  opts: GlobalOpts,
): Promise<void> => {
  // The server refuses (409) to delete a project's last dashboard.
  const result = await client.dashboards.delete(dashboardId);
  if (opts.json) {
    outputJson(result);
    return;
  }
  logger.info(`Deleted dashboard ${dashboardId} and its charts.`);
};

/** `lmnr-cli dashboard chart upsert <dashboard-id>` */
export const handleChartUpsert = async (
  client: LaminarClient,
  dashboardId: string,
  opts: ChartUpsertOpts,
): Promise<void> => {
  const charts = buildCharts(opts);
  const result = await client.dashboards.upsertCharts(dashboardId, charts);
  if (opts.json) {
    outputJson(result);
    return;
  }

  const rows = result.charts.map((c) => [
    c.id,
    c.name,
    c.config?.type ?? "-",
    c.layout ? `${c.layout.x},${c.layout.y},${c.layout.w},${c.layout.h}` : "-",
  ]);
  logger.info(renderTable(["ID", "Name", "Type", "Layout (x,y,w,h)"], rows));
  for (const warning of result.warnings) {
    logger.warn(warning);
  }
  logger.info(result.dashboardUrl);
};

/** `lmnr-cli dashboard chart delete <dashboard-id> <chart-ids...>` */
export const handleChartDelete = async (
  client: LaminarClient,
  dashboardId: string,
  chartIds: string[],
  opts: GlobalOpts,
): Promise<void> => {
  const result = await client.dashboards.deleteCharts(dashboardId, chartIds);
  if (opts.json) {
    outputJson(result);
    return;
  }
  logger.info(
    `Deleted ${result.deleted} of ${result.requested} chart(s) from dashboard ${dashboardId}.`,
  );
  if (result.deleted < result.requested) {
    logger.warn(
      "Some ids were not charts on this dashboard. List its charts with " +
        `\`lmnr-cli sql query "SELECT id, name FROM dashboard_charts WHERE dashboard_id = '${dashboardId}'"\`.`,
    );
  }
};
