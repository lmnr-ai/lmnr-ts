# Signals (`signal`)

- **A signal's firing config is THREE independent flags, not one nested blob**:
  `--trigger` (WHEN it's evaluated: `root-span-finished` | `span-name`, with
  `--span-name` repeatable for the second), `--filter` (WHETHER it runs,
  repeatable JSON, ANDed) and `--mode` (`batch` | `realtime`). They map to the
  API's `trigger` / `filters` / `mode`. `--trigger` is a KIND, never a column
  list. Omitted on create → `root-span-finished`; there is no "no trigger" flag.
- **`--filter` stays `{column, operator, value}` JSON — do NOT turn it into a
  `"col op value"` DSL.** Filters are meant to be versatile and extensible: new
  operators, array/nested values, and extra keys must reach the server without a
  CLI release, so `parseFilter` checks only the wire shape and spreads unknown
  keys through.
- **`--span-name` without `--trigger span-name` is an ERROR, not an implied kind
  switch.** Inferring the kind would let a typo'd `--trigger` quietly change when
  the signal fires — the exact failure class this command is shaped to prevent.
- **Repeatable flags must use the shared `collectFlag` and NOT a commander `[]`
  default.** With a default the handler always receives an array, so an absent
  flag reads as "passed empty": `signal update --prompt x` CLEARED the signal's
  filters, and `create` sent `filters: []` instead of omitting the key for the
  server default. This shipped broken once; `validate.test.ts` covers it.
- `validate.ts` only translates flag syntax into the wire shape and fills omitted
  schema `type`/`required`. Do NOT re-implement column allowlists, sample-rate
  bounds, or field-name regexes here — they drift from `signals/service.rs`.
  `--filter` deliberately does not validate the column, so a bad one reaches the
  server and its 400 names the supported ones (shown verbatim via
  `raiseSignalError`).
- `signal update` is a PARTIAL patch, and the three firing flags are independent —
  changing `--mode` leaves the trigger and filters alone. Omitted flags leave
  stored values alone. `--no-sampling` sends `sampleRate: null` (clears the
  stored rate; evaluate every matching trace). `--no-filters` sends `filters: []`.
  An empty patch is an error listing the valid flags, never a silent no-op.
  `--name` renames in place (id, events, clusters, alerts kept). It runs through
  the same `validateName` as create. The server owns uniqueness: it returns a 409
  and the CLI shows that message verbatim.
- `<signal>` accepts an id or a name. An ambiguous name is an ERROR listing the
  candidates rather than a silent pick — `update` / `delete` are destructive.
- `SignalsResource` (`@lmnr-ai/client`) overrides error handling with its own
  `raiseSignalError` instead of `BaseResource.handleError`: signal routes answer
  `{error: "<message>"}` with user-facing text, and the shared handler would
  print the raw JSON body at the user (`409 {"error":"..."}`).
- **`--llm-profile-id <uuid>` + `--model <name>` are self-hosted only and pass
  through untouched** (wire fields `llmProfileId` / `model` in the signals
  create/update body). They must be sent together (server rejects a half pair
  with a user-facing 400), on Laminar Cloud any pair is rejected, and on
  self-hosted `create` both are REQUIRED. All of that is enforced in
  `signals/service.rs::resolve_llm_route` and the messages are surfaced
  verbatim by `raiseSignalError` — do NOT duplicate any of these rules in
  `validate.ts`. The wire has no shape for CLEARING the route back to the
  server's env LLM on update; do not invent one. Responses echo `llmProfileId`
  + `llmProfileName` (display only) + `model`.
- **`signal backfill <signal> <trace-ids...>`** posts the positional ids to
  `/v1/cli/signals/{id}/backfill` (one realtime job; `--json` prints the
  server's `{jobId, signalId, totalTraces}`). UUID validation, dedupe and the
  10k cap are the server's (`signals/private/backfill.rs` in lmnr-private);
  any malformed id fails the request. No `--file`/stdin input yet, by design.
