# Alerts (`alert`)

- Full CRUD (`list [--signal]` / `get` / `create <signal>` / `update <id>` / `delete <id>`, group
  aliased to `alerts`), backed by `/v1/cli/alerts` (`AlertsResource`). `<signal>` takes an id or
  a name through the shared `resolveSignalId` (exported from `signal/index.ts`).
- **Email is "me" only.** `--[no-]notify-me` adds or removes the CALLER's email target. Responses
  carry only `notifyMe`, and other members' subscriptions are invisible and untouched, matching
  the UI. `create` defaults to subscribing the caller, so an alert never starts with no target.
- **Every boolean flag is defined in both forms** (`--disabled` / `--no-disabled`, etc.), so an
  omitted flag reads as `undefined` and the patch leaves it alone. A lone `--no-x` option makes
  commander default `x` to `true`, which is why `--no-slack-channels` / `--no-filters` (update
  only) are checked with `=== false`.
- Filters: `--filter` conditions are ANDed into ONE group, and each `--filter-group '[...]'` adds
  an OR-branch (the stored `alert_filters` rows). Conditions go through the signal `parseFilter`
  (shape only). Columns, operators, Slack channel lookup and the clustering-only options
  (`--skip-similar`, `--type new-cluster`) are checked by the server, and its messages are shown
  verbatim. An unknown operator surfaces as actix's `Json deserialize error: unknown variant …`,
  which is readable enough. Do not add a client-side operator list (see the `--filter` note in
  `src/commands/signal/AGENTS.md`).
