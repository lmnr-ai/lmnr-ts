# Dashboards (`dashboard`)

- Write-only, matching the Laminar agent's dashboard tools: `dashboard upsert <name> [--id]`
  (create, or rename with `--id`), `dashboard delete <id>`,
  `dashboard chart upsert <dashboard-id>` and `dashboard chart delete <dashboard-id> <chart-ids...>`.
  They are backed by `/v1/cli/dashboards` (`DashboardsResource` in `@lmnr-ai/client`). There is
  NO list/get. Reads go through `lmnr-cli sql query` on `dashboards` / `dashboard_charts`,
  and every help text points there.
- **Chart query rules are the SERVER's** (`dashboards/chart_query.rs` in lmnr: dashboard
  time params, interval bucketing, axes vs result columns, the breakdown check, the test run over
  the last 24h). `flags.ts` only translates flag syntax. The one rule it does enforce is that
  `--query` and `--type` travel together, because the server re-checks a query against its
  config. Its 400s (`charts[i]: …`) are shown verbatim through `raiseDashboardError`.
- `chart upsert` takes either the single-chart flags or `--file` (a JSON array in API shape,
  or `{charts}`; `-` = stdin), never both. File entries pass through untouched, so the server's
  `charts[i]` indexes line up with the file. The chart id flag is `--chart-id`, not `--id`, so it
  can't be mistaken for the dashboard id.
- Warnings (e.g. the query returned no rows, so axes were not checked) come back in the 200
  body and are logged with `logger.warn`. They are not errors.
