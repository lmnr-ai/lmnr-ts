# lmnr-cli dev

Start a language-agnostic debugging session for Laminar AI agents.

The `dev` command is a pure orchestrator that coordinates debugging sessions between your code and the Laminar backend. It is completely language-agnostic, delegating language-specific execution to worker processes.

## Usage

```bash
lmnr-cli dev [file] [options]
# OR
lmnr-cli dev -m <python-module> [options]
```

### Options

- `-m, --python-module <module>` - Python module path (e.g., `src.myfile`)
- `--function <name>` - Specific function to serve (if multiple entrypoint functions found)
- `--project-api-key <key>` - Project API key (or set `LMNR_PROJECT_API_KEY` env variable)
- `--base-url <url>` - Base URL for the Laminar API (default: https://api.lmnr.ai)
- `--port <port>` - Port for the Laminar API (default: 443)
- `--grpc-port <port>` - Port for the Laminar gRPC backend (default: 8443)
- `--frontend-port <port>` - Port for the Laminar frontend (default: 5667)
- `--external-packages <packages...>` - [ADVANCED] Packages to pass as external to esbuild
- `--dynamic-imports-to-skip <modules...>` - [ADVANCED] Dynamic imports to skip
- `--command <command>` - [ADVANCED] Custom worker command (e.g., `python3`, `node`)
- `--command-args <args...>` - [ADVANCED] Arguments for the custom command

### Examples

```bash
# TypeScript
npx lmnr-cli@latest dev agent.ts

# JavaScript (extracts parameter names at runtime)
npx lmnr-cli@latest dev agent.js

# Python - Script mode
npx lmnr-cli@latest dev agent.py

# Python - Module mode
npx lmnr-cli@latest dev -m src.agent
```

## Architecture

The CLI orchestrates three components:

1. **SSE Client**: Connects to Laminar backend and receives run events
2. **Cache Server**: Local HTTP server (port 35667) that provides cached spans to workers
3. **Worker Process**: Language-specific subprocess that executes your code

```
┌─────────────────┐
│  Laminar API    │
└────────┬────────┘
         │ SSE
         │
┌────────▼────────┐      ┌──────────────┐
│   CLI Process   │◄────►│ Cache Server │
│  (Orchestrator) │      │  (HTTP:35667)│
└────────┬────────┘      └──────▲───────┘
         │                      │
         │ spawn                │ HTTP
         │                      │
┌────────▼────────┐      ┌──────┴───────┐
│ Worker Process  │─────►│  Your Code   │
│ (TS/Python/etc) │      │  (agent.ts)  │
└─────────────────┘      └──────────────┘
```

## Worker Protocol

The CLI communicates with workers using a simple JSON protocol over stdin/stdout.

### Input (via stdin)

The CLI sends a single JSON line to the worker's stdin containing the configuration:

```typescript
{
  filePath: string;              // Path to the file to execute
  functionName?: string;         // Specific function to run
  args: Record<string, any> | any[]; // Arguments for the function
  env: Record<string, string>;   // Environment variables
  cacheServerPort: number;       // Port of the cache server
  baseUrl: string;               // Laminar API base URL
  projectApiKey?: string;        // Project API key
  httpPort: number;              // HTTP port for Laminar API
  grpcPort: number;              // gRPC port for Laminar API
  externalPackages?: string[];   // External packages (TS-specific)
  dynamicImportsToSkip?: string[]; // Dynamic imports to skip (TS-specific)
}
```

### Output (via stdout)

Workers send messages prefixed with `__LMNR_WORKER__:` to stdout:

#### Log Message
```typescript
{
  type: 'log';
  level: 'info' | 'debug' | 'error' | 'warn';
  message: string;
}
```

#### Result Message
```typescript
{
  type: 'result';
  data: any;  // Function return value
}
```

#### Error Message
```typescript
{
  type: 'error';
  error: string;    // Error message
  stack?: string;   // Stack trace
}
```

### User Output

Any stdout without the `__LMNR_WORKER__:` prefix is considered user output (e.g., `console.log()`) and passed through transparently.

### Environment Variables

The CLI sets these environment variables for the worker:

- `LMNR_ROLLOUT_SESSION_ID`: Session ID for this debugger run
- `LMNR_ROLLOUT_STATE_SERVER_ADDRESS`: Cache server URL (http://localhost:35667)

### Cache Server API

Workers can query the cache server for cached spans:

**Endpoint**: `POST /cached`

**Request**:
```json
{
  "path": "string",   // Span path
  "index": number     // Span index
}
```

**Response**:
```json
{
  "span": {
    "name": "string",
    "input": "string",      // JSON string
    "output": "string",     // JSON string
    "attributes": {}        // Parsed attributes
  },
  "pathToCount": {
    "path1": 5,
    "path2": 3
  },
  "overrides": {
    "spanName": {
      "system": "string or array",
      "tools": [{
        "name": "string",
        "description": "string",
        "parameters": {}
      }]
    }
  }
}
```

## Implementing a Worker

To support a new language, implement a worker that:

1. Reads JSON configuration from stdin
2. Sets environment variables from `config.env`
3. Loads and executes the specified function
4. Initializes your SDK's tracing (reads `LMNR_ROLLOUT_STATE_SERVER_ADDRESS`)
5. Sends protocol messages to stdout (prefixed with `__LMNR_WORKER__:`)
6. Exits with code 0 on success, non-zero on failure

### Default Worker Resolution

| Extension | Worker Command |
|-----------|----------------|
| `.ts`, `.tsx` | `node @lmnr-ai/lmnr/dist/cli/worker.cjs` |
| `.js`, `.mjs`, `.cjs` | `node @lmnr-ai/lmnr/dist/cli/worker.cjs` |
| `.py` | `python3 -m lmnr.cli.worker` |

Custom workers can be specified with `--command` and `--command-args`.

## Python Language Support

### Metadata Discovery

The CLI needs to discover function metadata (name and parameters) to provide a rich UI experience. For Python files, this is done by calling the `lmnr` Python package.

#### Required Command Interface

```bash
lmnr discover --file <filepath> [--function <name>]
# OR
lmnr discover --module <module> [--function <name>]
```

**Arguments:**

- `--file <filepath>`: Path to the Python file containing entrypoint functions (script mode)
- `--module <module>`: Python module path like `src.myfile` (module mode)
- `--function <name>`: (Optional) Specific function name to discover. If omitted, discover all.

**Note:** Exactly one of `--file` or `--module` must be provided.

**Output Format (JSON to stdout):**

```json
{
  "name": "my_agent",
  "params": [
    {
      "name": "query",
      "type": "string"
    },
    {
      "name": "max_tokens",
      "type": "number"
    }
  ]
}
```

#### Python Execution Modes

**Script Mode (default):**

```bash
npx lmnr-cli dev src/myfile.py
# Internally executes as: python src/myfile.py
# Discovery uses: lmnr discover --file src/myfile.py
```

**Module Mode:**

```bash
npx lmnr-cli dev -m src.myfile
# Internally executes as: python -m src.myfile
# Discovery uses: lmnr discover --module src.myfile
```

### Python Worker

The Python `lmnr` package implements a worker:

```bash
python -m lmnr.cli.worker
```

The worker:

1. Reads JSON configuration from stdin containing either `filePath` (script mode) or `modulePath` (module mode)
2. Sets environment variables from config
3. Initializes the `lmnr` SDK
4. Loads and executes the specified function based on the mode
5. Sends protocol messages to stdout (see [Worker Protocol](#worker-protocol))
6. Exits with appropriate code
