# setup

- `lmnr-cli setup` checks whether an existing `LMNR_PROJECT_API_KEY` in the
  environment / `.env` already points at the linked project before minting a new
  one. By setup time the CLI is **already logged in**, so this probe authenticates
  as the USER (JWT bearer) via `client.cli.resolveProjectByApiKey(apiKey)`
  (`@lmnr-ai/client`, `POST /v1/cli/project`, key in the body) — NOT by deriving
  auth from the project key itself. The server also confirms the user is a member
  of the resolved project. The result is a tri-state `ProjectKeyProbe`: `ok`
  (with `projectId`), `invalid` (401 → key revoked, safe to mint), `unverifiable`
  (403 / network / other non-2xx → do NOT mint, would clobber a possibly-valid
  key on a blip). The local helper is `probeProjectKey` in
  `src/commands/setup/index.ts`. The old standalone `GET /v1/project` probe
  (`src/auth/project-id.ts`) was DELETED — do not reintroduce a key-authed probe.
