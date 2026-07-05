/**
 * Shared contract for debugger-session blocks.
 *
 * A debug session renders as an ordered list of blocks (see the app-server
 * `debugger_session_blocks` table). Each block has a plain-text `type` and a
 * jsonb `content` whose shape depends on the type:
 *
 *  - `trace`      — a trace produced under the session (`rollout.session_id`);
 *    written at ingest.
 *  - `evaluation` — an evaluation created under the session; written at eval
 *    creation.
 *  - `text`       — a free-text note the agent attaches post-factum via
 *    `lmnr-cli debug session add-note` (keyed by session id, not tied to any
 *    trace / eval).
 *
 * `type` is a plain string on the wire so new block types can be added without
 * a client bump; the union below is the set this SDK knows how to render.
 */

/** Block type the CLI knows how to render. `type` is a plain string on the wire. */
export type SessionBlockType = "trace" | "evaluation" | "text";

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

/** Union of the known block content shapes. */
export type SessionBlockContent =
  | TraceBlockContent
  | EvaluationBlockContent
  | TextBlockContent;

/**
 * One block in a debugger session, as returned by
 * `GET /v1/cli/rollouts/{sessionId}/blocks`.
 *
 * `content` is typed loosely (`Record<string, unknown>`) because `type` is
 * open-ended on the wire; narrow it with the `*BlockContent` interfaces above
 * once `type` is known.
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
