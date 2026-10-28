/**
 * Translate `dashboard chart upsert` flags (or a `--file` batch) into chart
 * entries. Only wire shape is checked here; the query checks (dashboard
 * parameters, axes vs result columns, breakdown) and the test run are the
 * server's (`dashboards/chart_query.rs`), and its 400s are shown verbatim.
 */

import { readFileSync } from "node:fs";

import type { DashboardChartInput } from "@lmnr-ai/client";
import type {
  DashboardChartConfig,
  DashboardChartDisplayMode,
  DashboardChartLayout,
  DashboardChartType,
} from "@lmnr-ai/types";

const CHART_TYPES: DashboardChartType[] = [
  "line",
  "bar",
  "horizontalBar",
  "table",
];
const DISPLAY_MODES: DashboardChartDisplayMode[] = ["total", "average", "none"];

export interface ChartFlagOpts {
  chartId?: string;
  name?: string;
  query?: string;
  queryFile?: string;
  type?: string;
  x?: string;
  y?: string;
  breakdown?: string;
  displayMode?: string;
  layout?: string;
  file?: string;
}

const SINGLE_CHART_FLAGS: [keyof ChartFlagOpts, string][] = [
  ["chartId", "--chart-id"],
  ["name", "--name"],
  ["query", "--query"],
  ["queryFile", "--query-file"],
  ["type", "--type"],
  ["x", "--x"],
  ["y", "--y"],
  ["breakdown", "--breakdown"],
  ["displayMode", "--display-mode"],
  ["layout", "--layout"],
];

/** `-` reads stdin, so a query or batch can be piped in. */
export const readSource = (path: string): string =>
  readFileSync(path === "-" ? 0 : path, "utf-8");

/** `x,y,w,h` on the 12-column grid. Bounds are checked server-side. */
export const parseLayout = (raw: string): DashboardChartLayout => {
  const parts = raw.split(",").map((p) => p.trim());
  const nums = parts.map(Number);
  if (parts.length !== 4 || nums.some((n) => !Number.isInteger(n))) {
    throw new Error(
      `--layout must be four integers "x,y,w,h" (e.g. "0,0,6,6"), got "${raw}"`,
    );
  }
  const [x, y, w, h] = nums;
  return { x, y, w, h };
};

const buildConfig = (opts: ChartFlagOpts): DashboardChartConfig | undefined => {
  if (opts.type === undefined) {
    const stray = (
      [
        ["x", "--x"],
        ["y", "--y"],
        ["breakdown", "--breakdown"],
        ["displayMode", "--display-mode"],
      ] as const
    ).find(([key]) => opts[key] !== undefined);
    if (stray) {
      throw new Error(
        `${stray[1]} needs --type: the chart config is sent as a whole, ` +
          "so pass --type and every mapping the chart uses",
      );
    }
    return undefined;
  }
  if (!CHART_TYPES.includes(opts.type as DashboardChartType)) {
    throw new Error(
      `--type must be one of ${CHART_TYPES.join(" | ")}, got "${opts.type}"`,
    );
  }
  if (
    opts.displayMode !== undefined &&
    !DISPLAY_MODES.includes(opts.displayMode as DashboardChartDisplayMode)
  ) {
    throw new Error(
      `--display-mode must be one of ${DISPLAY_MODES.join(" | ")}, ` +
        `got "${opts.displayMode}"`,
    );
  }
  return {
    type: opts.type as DashboardChartType,
    ...(opts.x !== undefined ? { x: opts.x } : {}),
    ...(opts.y !== undefined ? { y: opts.y } : {}),
    ...(opts.breakdown !== undefined ? { breakdown: opts.breakdown } : {}),
    ...(opts.displayMode !== undefined
      ? { displayMode: opts.displayMode as DashboardChartDisplayMode }
      : {}),
  };
};

/** One chart from the single-chart flags. */
export const buildChartFromFlags = (
  opts: ChartFlagOpts,
): DashboardChartInput => {
  if (opts.query !== undefined && opts.queryFile !== undefined) {
    throw new Error("Pass either --query or --query-file, not both.");
  }
  const query =
    opts.queryFile !== undefined ? readSource(opts.queryFile) : opts.query;
  const config = buildConfig(opts);
  // The server re-checks a query against its config, so they travel together.
  if ((query === undefined) !== (config === undefined)) {
    throw new Error(
      "--query (or --query-file) and --type must be passed together: the " +
        "query is checked against the chart config on every change.",
    );
  }

  const chart: DashboardChartInput = {
    ...(opts.chartId !== undefined ? { id: opts.chartId } : {}),
    ...(opts.name !== undefined ? { name: opts.name } : {}),
    ...(query !== undefined ? { query } : {}),
    ...(config !== undefined ? { config } : {}),
    ...(opts.layout !== undefined ? { layout: parseLayout(opts.layout) } : {}),
  };
  if (chart.id === undefined) {
    if (chart.name === undefined || chart.query === undefined) {
      throw new Error(
        "A new chart needs --name, --query (or --query-file) and --type. " +
          "Pass --chart-id to update an existing chart instead.",
      );
    }
  } else if (Object.keys(chart).length === 1) {
    throw new Error(
      "Nothing to update. Pass at least one of --name, --query/--query-file " +
        "with --type, or --layout.",
    );
  }
  return chart;
};

/**
 * A `--file` batch: a JSON array of chart entries, or `{"charts": [...]}`.
 * Entries pass through as-is so the server's per-entry errors
 * (`charts[2]: ...`) line up with the file.
 */
export const parseChartsFile = (raw: string): DashboardChartInput[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("--file is not valid JSON.");
  }
  const charts =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as { charts?: unknown }).charts
      : parsed;
  if (
    !Array.isArray(charts) ||
    charts.length === 0 ||
    charts.some((c) => typeof c !== "object" || c === null || Array.isArray(c))
  ) {
    throw new Error(
      '--file must hold a non-empty JSON array of chart objects (or {"charts": [...]}).',
    );
  }
  return charts as DashboardChartInput[];
};

/** Either the batch file or the single-chart flags, never both. */
export const buildCharts = (opts: ChartFlagOpts): DashboardChartInput[] => {
  if (opts.file === undefined) {
    return [buildChartFromFlags(opts)];
  }
  const mixed = SINGLE_CHART_FLAGS.filter(([key]) => opts[key] !== undefined);
  if (mixed.length > 0) {
    throw new Error(
      `--file cannot be combined with ${mixed.map(([, flag]) => flag).join(", ")}; ` +
        "put every field in the file's chart entries.",
    );
  }
  return parseChartsFile(readSource(opts.file));
};
