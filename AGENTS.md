# AGENTS.md

Guidance for coding agents working in this repository. Package- and module-specific knowledge lives in nested `AGENTS.md` files next to the code (each has a `CLAUDE.md` symlink so Claude Code loads it on demand); read the relevant one before editing a module.

## Project Overview

Laminar TypeScript SDK — a pnpm monorepo publishing `@lmnr-ai/lmnr`, `@lmnr-ai/client`, `@lmnr-ai/types`, and `lmnr-cli`.

## Repository Structure

- `packages/lmnr` — main `@lmnr-ai/lmnr` package: tracing, OpenTelemetry instrumentations, custom framework exporters (Mastra, Vercel AI SDK, OpenAI, etc.).
- `packages/client` — typed HTTP client for the Laminar API (`@lmnr-ai/client`).
- `packages/types` — shared type defs.
- `packages/lmnr-cli` — `lmnr` CLI.

## Development Commands

```bash
pnpm install                    # Install across workspace
pnpm -r build                   # Build all packages
pnpm -r test                    # Run tests in all packages
pnpm -r lint                    # Lint all packages
pnpm check-versions             # Verify package versions are aligned
```

Work inside a specific package with `pnpm --filter @lmnr-ai/lmnr ...` or `cd packages/lmnr && pnpm ...`.

## Releases (`.github/workflows/publish-to-npm.yml`)

- A GitHub release triggers it. `cli-v<version>` tags publish `lmnr-cli`; any other tag (`<version>`) publishes types, client and lmnr. An optional `-post.N` suffix is stripped before the version check.
- Each job checks out `github.repository` at `github.sha` with `persist-credentials: false` and fails unless the release tag points to that commit, the commit is on `main`, and the tag matches the package version (`packages/lmnr-cli` for the CLI, `packages/lmnr` for the SDK). So: bump versions on `main` first, then tag that commit.
- The tag comes from `github.event.release.tag_name`, never `GITHUB_REF` / `github.ref`: those are intermittently empty on `release` events (actions/runner#2788, open since 2023). The provenance check's `--source-ref` is likewise built as `refs/tags/$RELEASE_TAG`.
- After publishing, the job re-downloads each tarball and runs `gh attestation verify` on npm's SLSA provenance bundle (repo, commit, tag, signer workflow). `--digest-alg sha512` is required: npm attests sha512 digests, and without the flag the failure is an opaque `verifying with issuer "sigstore.dev"`. On success `gh` prints nothing when not on a TTY, so the step echoes its own success line.
- The two jobs share that step through a YAML anchor (`&verify-provenance` / `*verify-provenance`). Keep the verification inline in the workflow. A local composite action would be loaded from the checked-out tree, which is the code being verified.
- Actions and the npm CLI are pinned (`uses: owner/repo@<sha> # vX.Y.Z`, `npm@X.Y.Z`). Bump them by resolving the new tag's SHA (`gh api repos/<owner>/<repo>/commits/<tag> --jq .sha`), not by switching back to a floating tag.

## Coding Style

- Prefer arrow functions: `const foo = async (...) => { ... }` over named `function foo()`.
- Rely on pre-commit hooks; don't run project-wide type-checks manually.
- Use `errorMessage(err)` from `@lmnr-ai/types` for stringifying unknown error values. `@lmnr-ai/types/utils.ts` is the canonical home for small shared runtime helpers that all packages can depend on (it already has a runtime build, not just types).

## Formatting / Lint

- No project-wide `prettier` binary is installed and there is **no eslint** either; lint AND format are both biome (`biome.json` at the repo root).
- **Lint only exists at the MONOREPO ROOT — the packages have no `lint` script.** `pnpm --filter @lmnr-ai/lmnr lint` fails with `ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT`. Run `pnpm lint` (`biome check`) / `pnpm lint:fix` (`biome check --write`) from `/repos/lmnr-ts`, which is exactly what `.github/workflows/check-lint.yml` runs on PRs. `pnpm typecheck` (`tsc`) is also root-only.
- Line width is biome's default **80** (`biome.json` sets no `lineWidth`); the old `@stylistic/max-len`-at-100 note was stale. `biome check --write` rewraps for you, so let it rather than hand-wrapping.
- **Biome's `includes` is `**`, so it formats and lints non-source files too — including JSON test fixtures / nock cassettes under `packages/lmnr/test/recordings/`.** `JSON.stringify(x, null, 2)` output does NOT match biome's JSON formatting, so a freshly recorded cassette fails CI's `pnpm lint` until you run `biome check --write` on it. Do that for every new or re-recorded cassette.
- `assist/source/organizeImports` is enforced: imports sort ASCII with uppercase first, so a type export like `ResourceKind` must precede `recordError` in the same import block. `noExplicitAny` is only a **warning** and is pre-existing throughout the instrumentation code — don't chase it.

## Memory files

- Root `CLAUDE.md` and every nested `CLAUDE.md` are symlinks to the `AGENTS.md` next to them. Edit the `AGENTS.md`, never the symlink.
- Put new knowledge in the most specific `AGENTS.md` that covers it. Only repo-wide facts (workspace commands, releases, style, lint) belong in this file. For a module with no `AGENTS.md` yet, create one plus a `CLAUDE.md -> AGENTS.md` symlink, and list it in the parent package's index.
- Packages only publish `dist`, so these files never reach npm.

## Nested AGENTS.md files

- `packages/lmnr/AGENTS.md` - SDK package: evaluations memory model, TypeScript build, OTel dependency ranges; indexes the module files below it (debug, tracing, every instrumentation, tests)
- `packages/lmnr-cli/AGENTS.md` - CLI: output strategy, package boundaries, agent-friendly CLI guidelines; indexes the per-command files
