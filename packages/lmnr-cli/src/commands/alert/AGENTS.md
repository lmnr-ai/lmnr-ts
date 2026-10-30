# Alerts (`alert`)

- Writes only (`create <signal>` / `update <id>` / `delete <id>`, group aliased to `alerts`),
  backed by `/v1/cli/alerts` (`AlertsResource`), which app-server forwards to the frontend.
  There is no `list` / `get`: reads are SQL over `alerts`, `alert_targets` and `alert_filters`
  (`lmnr-cli sql query`), so don't add read commands back. `<signal>` takes an id or a name
  through the shared `resolveSignalId` (exported from `signal/index.ts`).
- **Email is "me" only.** `--[no-]notify-me` adds or removes the CALLER's email target, and other
  members' subscriptions are untouched. Write responses carry only `notifyMe`. `create` defaults
  to subscribing the caller, so an alert never starts with no target.
- **Every boolean flag is defined in both forms** (`--disabled` / `--no-disabled`, etc.), so an
  omitted flag reads as `undefined` and the patch leaves it alone. A lone `--no-x` option makes
  commander default `x` to `true`, which is why `--no-slack-channels` / `--no-filters` (update
  only) are checked with `=== false`.
- Filters: `--filter` conditions are ANDed into ONE group, and each `--filter-group '[...]'` adds
  an OR-branch (the stored `alert_filters` rows). Conditions go through the signal `parseFilter`
  (shape only). Columns, operators and the Slack channel lookup are checked by the server,
  and its messages are shown verbatim (an unknown operator is a zod error naming the field).
  `--skip-similar` / `--type new-cluster` are not checked against clustering, same as the UI. Do not add a client-side operator list (see the `--filter` note in
  `src/commands/signal/AGENTS.md`).
