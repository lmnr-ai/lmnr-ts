/* eslint-disable @stylistic/max-len -- this file is a markdown content asset, not code */

// The Laminar agent skill, authored as a CLI asset and written directly to each
// present agent dir by `installSkill` (no `npx skills add` — network dep /
// version drift / historically mis-targeted Claude Code). Keep this concise:
// it teaches an agent to instrument an app with Laminar and use the CLI.

export const SKILL_DIR_NAME = "laminar";
export const SKILL_FILE_NAME = "SKILL.md";

export const LAMINAR_SKILL_MD = `---
name: laminar
description: Instrument an app with Laminar (lmnr) tracing and query/inspect traces with the lmnr-cli. Use when adding observability to an AI agent or LLM app, debugging traces, or verifying that spans are being recorded.
---

# Laminar

Laminar is an open-source observability platform for AI agents: OpenTelemetry-native
tracing, evals, and SQL access to all your trace data.

This project has been set up with the Laminar CLI (\`lmnr-cli setup\`):
- \`LMNR_PROJECT_API_KEY\` is written to \`./.env\` (the SDK reads it at runtime).
- \`.lmnr/project.json\` links this directory to a Laminar project (the CLI reads it).

## Instrumenting an app

Install and initialize the SDK as early as possible in your app's entrypoint, before
the code you want to trace runs.

### Python

\`\`\`bash
uv pip install lmnr
\`\`\`

\`\`\`python
from lmnr import Laminar

# Reads LMNR_PROJECT_API_KEY from the environment (e.g. via .env).
Laminar.initialize()
\`\`\`

Auto-instrumentation covers common LLM/agent libraries. To trace your own
functions, wrap them with the \`@observe()\` decorator:

\`\`\`python
from lmnr import observe

@observe()
def my_agent_step(query: str) -> str:
    ...
\`\`\`

### TypeScript / JavaScript

\`\`\`bash
npm install @lmnr-ai/lmnr
\`\`\`

\`\`\`typescript
import { Laminar } from "@lmnr-ai/lmnr";

// Reads LMNR_PROJECT_API_KEY from the environment.
Laminar.initialize();
\`\`\`

Use \`observe(...)\` to wrap functions you want to appear as spans.

## Verifying tracing works

Run the instrumented code once, then query for recent spans with the CLI:

\`\`\`bash
lmnr-cli sql query "SELECT count() AS n FROM spans WHERE start_time > now() - INTERVAL 5 MINUTE"
\`\`\`

A non-zero count means traces are flowing. Spans can take a few seconds to flush.

## Using the CLI

The CLI is authenticated (\`lmnr-cli login\`) and the directory is linked, so commands
target this project automatically.

- **SQL over your data** (spans, traces, datasets, etc.):
  \`\`\`bash
  lmnr-cli sql query "SELECT id, name, status, total_cost FROM traces ORDER BY start_time DESC LIMIT 20"
  lmnr-cli sql schema   # list available tables + columns
  \`\`\`
- **List projects** you can access (● marks the linked one):
  \`\`\`bash
  lmnr-cli project list
  \`\`\`
- **Datasets** (push/pull/list/create) — pass \`--json\` for machine output:
  \`\`\`bash
  lmnr-cli dataset list --json
  lmnr-cli dataset push data.jsonl -n my-dataset
  lmnr-cli dataset pull output.jsonl -n my-dataset
  \`\`\`
- **Annotate a trace** with a free-text note (accumulates as markdown paragraphs):
  \`\`\`bash
  lmnr-cli trace append-note <trace-id> "Reproduced the timeout on the search tool."
  \`\`\`

Add \`--json\` to most commands for structured stdout.

## Docs

- Documentation: https://laminar.sh/docs
- Dashboard: https://www.laminar.sh
`;
