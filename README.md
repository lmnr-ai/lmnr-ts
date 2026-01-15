# Laminar TypeScript SDK

TypeScript SDK for [Laminar](https://www.laminar.sh).

[Laminar](https://www.laminar.sh) is an open-source platform for engineering LLM products. Trace, evaluate, annotate, and analyze LLM data. Bring LLM applications to production with confidence.

Check our [open-source repo](https://github.com/lmnr-ai/lmnr) and don't forget to star it ⭐

 <a href="https://www.npmjs.com/package/@lmnr-ai/lmnr"> ![NPM Version](https://img.shields.io/npm/v/%40lmnr-ai%2Flmnr?label=lmnr&logo=npm&logoColor=CB3837) </a>
 ![NPM Downloads](https://img.shields.io/npm/dm/%40lmnr-ai%2Flmnr)

## Monorepo Structure

This repository is organized as a monorepo with multiple packages:

- **[@lmnr-ai/types](packages/types)** - Shared types and interfaces
- **[@lmnr-ai/client](packages/client)** - HTTP client for Laminar API
- **[@lmnr-ai/lmnr](packages/lmnr)** - Main SDK with tracing and instrumentation
- **[lmnr-cli](packages/lmnr-cli)** - CLI for rollout debugging

## Installation

### For Application Development

```bash
npm install @lmnr-ai/lmnr
```

### For Rollout Debugging

```bash
npx @lmnrcli@latest dev agent.ts
```

## Development

This project uses pnpm workspaces for monorepo management.

### Setup

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run tests
pnpm test
```

### Package Development

```bash
# Build specific package
pnpm --filter @lmnr-ai/types build
pnpm --filter @lmnr-ai/client build
pnpm --filter @lmnr-cli build
pnpm --filter @lmnr-ai/lmnr build

# Lint
pnpm lint
pnpm lint:fix
```

## Documentation

- [Main SDK Documentation](packages/lmnr/README.md)
- [CLI Documentation](packages/cli/README.md)
- [Shared Laminar Documentation](https://docs.lmnr.ai)
