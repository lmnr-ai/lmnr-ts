/**
 * Shared contract for debugger-session blocks — an ordered list of blocks (see
 * app-server `debugger_session_blocks`), each with a `type` and type-specific
 * `content`:
 *
 *  - `trace`      — a trace under the session; written at ingest.
 *  - `evaluation` — an eval under the session; written at eval creation.
 *  - `text`       — a free-text note via `debug session add-note`.
 *  - `command`    — a CLI command (`sql query`, `ask`) recorded into the session.
 *
 * `type` is a plain string on the wire so new types need no client bump.
 */

/** Block type the CLI knows how to render. `type` is a plain string on the wire. */
export type SessionBlockType = "trace" | "evaluation" | "text" | "command";

/** `content` of a `trace` block. */
export interface TraceBlockContent {
  traceId: string;
  /** Legacy note folded onto the trace block at ingest, if any. */
  note?: string | null;
}

/** `content` of an `evaluation` block. */
export interface EvaluationBlockContent {
  evaluationId: string;
  /** Legacy note folded onto the evaluation block at ingest, if any. */
  note?: string | null;
}

/** `content` of a `text` block — a standalone agent note. */
export interface TextBlockContent {
  text: string;
}

/** `content` of a `command` block — a CLI command recorded into the session. */
export interface CommandBlockContent {
  /** The command path, e.g. `"sql query"` or `"ask"`. */
  command: string;
  /** The command's positional arguments (raw — may contain the query text). */
  args: string[];
  /** The process exit code observed at post-action time (0 on the success path). */
  exitCode: number;
  /** Captured stdout, truncated to a bounded prefix. Null when empty. */
  output?: string | null;
  /** Captured stderr, truncated to a bounded prefix. Null when empty. */
  stderr?: string | null;
  /** Agent thinking for this step, via `--thinking`. Null when not provided. */
  thinking?: string | null;
}

/** Union of the known block content shapes. */
export type SessionBlockContent =
  | TraceBlockContent
  | EvaluationBlockContent
  | TextBlockContent
  | CommandBlockContent;

/**
 * One block in a debugger session (from `GET /v1/cli/rollouts/{sessionId}/blocks`).
 * `content` is loose (`Record<string, unknown>`) since `type` is open-ended;
 * narrow it with the `*BlockContent` interfaces above once `type` is known.
 */
export interface SessionBlock {
  /** Block id (deterministic UUIDv5 for trace/eval blocks; random for text). */
  id: string;
  /** ISO-8601 creation timestamp — the sort key for rendering oldest-first. */
  createdAt: string;
  /** Block type; one of {@link SessionBlockType} for known blocks. */
  type: string;
  /** Type-specific payload; narrow via the `*BlockContent` interfaces. */
  content: Record<string, unknown>;
}
