# lmnr-ts

TypeScript SDK for Laminar. pnpm monorepo:
- `@lmnr-ai/lmnr` (main SDK + instrumentations)
- `@lmnr-ai/client`
- `@lmnr-ai/types`
- `lmnr-cli`

## Testing

- Unit tests live under `packages/lmnr/test/` and use node's built-in test runner.
- HTTP responses are mocked via JSON recordings in `packages/lmnr/test/recordings/`. Each file matches an `it(...)` name with dashes.
- Run a single package's suite with `pnpm --filter @lmnr-ai/lmnr test`. Avoid running the full project-wide test/format commands.

## Formatting

- NEVER run `pnpm format:write` or `prettier --write .` — formats files unrelated to the task.
- Only run prettier on files you changed: `npx prettier --write <file1> <file2>`.

## Anthropic instrumentation

- `messages.parse` (anthropic-ai/sdk >= 0.60) is a thin wrapper that internally calls `this.create(params, options)` and parses the response via `output_config.format.parse`. The `create` wrap already captures parse calls — wrapping both produces duplicate nested spans.
- Structured output schemas are detected via `params.output_config.format.schema` (for both `create` and `parse` in the TS SDK — unlike the Python SDK which has a separate `output_format` path). The `zodOutputFormat` and `jsonSchemaOutputFormat` helpers from `@anthropic-ai/sdk/helpers/zod` produce that shape.
- Stored on the span as `gen_ai.request.structured_output_schema` (JSON-serialized).
- Both the regular `Messages` and `Beta.Messages` classes must be wrapped individually in `manuallyInstrument` and `patch`.
