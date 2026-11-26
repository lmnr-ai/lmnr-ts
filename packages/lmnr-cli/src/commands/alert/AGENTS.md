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

## Metric alerts (`alert metric`)

- `alert metric create|list|update|delete` covers `METRIC` alerts (cost, tokens, traffic, error
  rate, latency). Writes go through the same `/v1/cli/alerts` body with `type: "METRIC"`; a
  metric alert has no signal, so `signalId` is `null` and the rule comes back in `rule`.
- **The rule is a JSON object passed as `--rule` and is never checked here.** The server runs the
  same validation as the UI form and its messages are shown verbatim, so don't add a client-side
  list of metrics, windows or threshold rules beyond the help text. `--template <id>` is also
  resolved by the server (an unknown id comes back with the list of valid ones).
- `--rule` is a patch: on create its keys override the template's, on update they are merged over
  the stored rule. Snooze is `--rule '{"snoozedUntil":"<ISO time>"}'`; mute is `--disabled`.
- `list` is the one read command in the group. It runs SQL over `alerts` (`type = 'METRIC'`) and
  only adds a one-line rule summary, so it stays inside the "reads are SQL" rule above. Alert
  state and incident history are not in SQL, so the CLI cannot show whether a rule is firing.
  It prints two lines per alert, not a `renderTable`: the table shortens ids to fit the terminal,
  and `update` / `delete` need them whole.
- A stored rule leaves unset keys out (no `critical`, no `resolve` on a budget) when it was written
  through this path, and holds explicit `null`s when the UI wrote it. Check with `!= null`.
- `delete` is the plain `alert delete` handler.
