# LLM profiles (`llm-profile`)

- Full CRUD (`list` / `get <id>` / `create <name>` / `update <id>` /
  `delete <id>`, group aliased to `llm-profiles`), backed by
  `/v1/cli/llm-profiles[/{id}]` (`api::v1::cli::llm_profiles`,
  `CliProjectAuth`; shares `llm/profiles/service.rs` with the frontend routes).
  Profiles are addressed by UUID everywhere; `list` prints the `ID` column that
  feeds `signal create --llm-profile-id <id> --model <name>` and the other
  subcommands.
- **The CLI does NO validation of provider shapes** — `flags.ts` only maps
  flags onto the flat `{name, provider, config, secrets, models}` wire body.
  Which flags a provider needs, url shapes, secret completeness, duplicate
  names, and in-use (RESTRICT FK) refusals are all server-side and surfaced
  verbatim. Auth is derived from the flags: `--access-key-id` → `aws_keys`,
  `--token` → `bearer_token`, else omitted (server defaults to `api_key`).
- **The provider endpoint flag is `--provider-base-url`, NOT `--base-url`.**
  The group-level `--base-url` is the Laminar API URL and
  `optsWithGlobals()` would let a subcommand flag of the same name shadow it —
  breaking `buildLaminarClient`. Keep the names distinct.
- **Update semantics come from the server**: omitted fields keep stored values,
  secrets are an overlay (an omitted secret keeps the stored one — credentials
  never need re-sending), but `config` is a WHOLE-object replace (any config
  flag requires re-passing every config field the provider needs) and
  `--model` replaces the whole model list. `buildProfileConfigAndSecrets`
  returns `undefined` for config/secrets when none of their flags were passed
  so the patch omits them — do not send `{}` there.
- Secrets are write-only: reads return `first3***last3` masks plus custom
  header names (`LlmProfileSecretMasks`), which `printProfile` shows as-is.
- Self-hosted only: on Laminar Cloud the server 404s every route with
  `{error: "LLM profiles are not available on this deployment"}` (same envelope
  the signals routes use). `LlmProfilesResource` unwraps it with
  `handleErrorMessage` for the same reason `SignalsResource` does — the raw JSON
  body is not user-facing text.
