import { randomUUID } from "node:crypto";

import { LaminarClient } from "@lmnr-ai/client";
import { errorMessage, type SessionBlock } from "@lmnr-ai/types";
import open from "open";

import type { GlobalOpts } from "../../auth/with-client";
import { DEFAULT_FRONTEND_URL } from "../../constants";
import {
  readDebugSessionFile,
  resolveDebugSessionDir,
  resolveSessionId,
  writeDebugSessionFile,
} from "../../utils/debug-session-file";
import { readLocalProjectFile } from "../../utils/local-project-file";
import { initializeLogger } from "../../utils/logger";
import { outputJson } from "../../utils/output";

const logger = initializeLogger();

/**
 * Options accepted by the session-scoped debug commands (`set-name`, `summary`,
 * `open`), extending the shared globals.
 */
export interface DebugSessionScopedOpts extends GlobalOpts {
  /** Set by `--session-id`; omitted → the debug-session.json `session_id`. */
  sessionId?: string;
}

/**
 * Upsert the display name of a debug session. Update-only on the backend: a
 * session id unknown to the project 404s rather than creating a ghost session.
 *
 * The target session is the optional `--session-id` flag; when omitted the
 * session comes from `.lmnr/debug-session.json` (see `resolveSessionId`).
 *
 * Pure handler: the command wrapper (`withProjectClient`) resolves a user-token
 * {@link LaminarClient} (routes to `/v1/cli/*` with the resolved project) and
 * owns the error envelope.
 */
export const handleDebugSessionSetName = async (
  client: LaminarClient,
  name: string,
  opts: DebugSessionScopedOpts,
): Promise<void> => {
  const sessionId = resolveSessionId(opts.sessionId);
  await client.rolloutSessions.setName({ sessionId, name });

  if (opts.json) {
    outputJson({ sessionId, name });
    return;
  }

  logger.info(`Set name of session ${sessionId} to "${name}".`);
};

/** Options accepted by `debug session add-note` (extends the shared globals). */
export interface DebugSessionAddNoteOpts extends GlobalOpts {
  /** Set by `--session-id`; omitted → the debug-session.json `session_id`. */
  sessionId?: string;
}

/**
 * Attach a free-text note to a debug session as a standalone `text` block.
 *
 * The note is written to the session's block list (`debugger_session_blocks`)
 * keyed by session id — NOT to any trace / evaluation metadata. Each call
 * appends a new block, interleaved by time with the session's trace / evaluation
 * blocks in the debugger UI (and in `debug session summary`). This is the
 * unified note path for both debug runs and evals: `rollout.session_id` links
 * traces / evals to the session; the note only needs the session id.
 *
 * The target session is the optional `--session-id` flag; when omitted the
 * session comes from `.lmnr/debug-session.json` (see `resolveSessionId`) — which
 * every LMNR_DEBUG=1 run (agents and evals alike) keeps pointed at the current
 * session via the SDK's shutdown pointer write.
 *
 * Pure handler: the command wrapper (`withProjectClient`) resolves a user-token
 * {@link LaminarClient} (routes to `/v1/cli/*` with the resolved project) and
 * owns the error envelope.
 */
export const handleDebugSessionAddNote = async (
  client: LaminarClient,
  note: string,
  opts: DebugSessionAddNoteOpts,
): Promise<void> => {
  const sessionId = resolveSessionId(opts.sessionId);
  // failOnNotFound: a CLI exit 0 must mean the note actually landed.
  const blockId = await client.rolloutSessions.addBlock({
    sessionId,
    type: "text",
    content: { text: note },
    failOnNotFound: true,
  });

  if (opts.json) {
    outputJson({ sessionId, blockId, note });
    return;
  }

  logger.info(`Added note to session ${sessionId}.`);
};

/** Render one session block into the summary's text form. */
const renderBlock = (block: SessionBlock): string | null => {
  const content = block.content ?? {};
  switch (block.type) {
    case "trace": {
      const traceId = typeof content.traceId === "string" ? content.traceId : "";
      return traceId ? `<trace id="${traceId}"/>` : null;
    }
    case "evaluation": {
      const evaluationId =
        typeof content.evaluationId === "string" ? content.evaluationId : "";
      return evaluationId ? `<evaluation id="${evaluationId}"/>` : null;
    }
    case "text": {
      const text = typeof content.text === "string" ? content.text : "";
      return text || null;
    }
    default:
      return null;
  }
};

/**
 * Print a chronological digest of a debug session: every block (trace /
 * evaluation / text note) on the session, oldest first — the same data the
 * debugger UI renders.
 *
 * The target session is the optional `--session-id` flag; when omitted the
 * session comes from `.lmnr/debug-session.json` (see `resolveSessionId`).
 *
 * Pure handler: the command wrapper (`withProjectClient`) resolves a user-token
 * {@link LaminarClient} (routes to `/v1/cli/*` with the resolved project) and
 * owns the error envelope.
 */
export const handleDebugSessionSummary = async (
  client: LaminarClient,
  opts: DebugSessionScopedOpts,
): Promise<void> => {
  const sessionId = resolveSessionId(opts.sessionId);
  const blocks = await client.rolloutSessions.listBlocks({ sessionId });
  // Sort oldest-first defensively — the backend returns creation order, but the
  // summary's contract is chronological regardless.
  const ordered = [...blocks].sort((a, b) =>
    String(a.createdAt).localeCompare(String(b.createdAt)),
  );

  if (opts.json) {
    outputJson(ordered);
    return;
  }

  if (ordered.length === 0) {
    console.log(`No blocks found for session ${sessionId}.`);
    return;
  }

  const rendered = ordered
    .map(renderBlock)
    .filter((b): b is string => b !== null);
  console.log(rendered.join("\n\n"));
};

/**
 * Build the frontend debugger-session URL. The frontend URL is its own env var
 * (LMNR_FRONTEND_URL) with a cloud default; self-host/local sets it explicitly.
 */
const buildDebuggerUrl = (projectId: string, sessionId: string): string => {
  const frontend =
    process.env.LMNR_FRONTEND_URL?.trim().replace(/\/+$/, "") || DEFAULT_FRONTEND_URL;
  return `${frontend}/project/${projectId}/debugger-sessions/${sessionId}`;
};

/**
 * Open a debug session's debugger page in the browser.
 *
 * The target session is the optional `--session-id` flag; when omitted the
 * session comes from `.lmnr/debug-session.json` (see `resolveSessionId`).
 * The URL is the file's stored `debugger_url` when it belongs to the resolved
 * session, else it is rebuilt from the resolved project (`--project-id` or the
 * linked `.lmnr/project.json`) + LMNR_FRONTEND_URL.
 *
 * Local-only handler (registered via `withLocalOpts`, NOT `withProjectClient`):
 * everything needed lives on disk, so no auth resolution / API call — `open`
 * works offline and before login.
 */
export const handleDebugSessionOpen = async (
  opts: DebugSessionScopedOpts,
): Promise<void> => {
  const sessionId = resolveSessionId(opts.sessionId);

  const file = readDebugSessionFile(resolveDebugSessionDir());
  let debuggerUrl = file?.session_id === sessionId ? file.debugger_url : null;
  if (!debuggerUrl) {
    const projectId = opts.projectId || (await readLocalProjectFile())?.projectId;
    if (!projectId) {
      throw new Error(
        "Cannot build the debugger URL: no project is linked to this " +
        "directory. Pass --project-id or run `lmnr-cli setup`.",
      );
    }
    debuggerUrl = buildDebuggerUrl(projectId, sessionId);
  }

  if (opts.json) {
    outputJson({ sessionId, debuggerUrl });
  } else {
    // URL to stdout (agent-capturable); the logger keeps stderr for messages.
    console.log(debuggerUrl);
  }

  try {
    await open(debuggerUrl);
  } catch (e) {
    logger.warn(`Could not open a browser (${errorMessage(e)}). URL: ${debuggerUrl}`);
  }
};

/** Options accepted by `debug session new` (extends the shared globals). */
export interface DebugSessionNewOpts extends GlobalOpts {
  /** Set by commander's `--no-browser`; false suppresses the browser open. */
  browser?: boolean;
}

/**
 * Mint a fresh debug session and reset `.lmnr/debug-session.json` to it.
 *
 * The next `LMNR_DEBUG=1 <run>` in this directory reads that file and rejoins the
 * minted session silently (no browser) — "new session" is owned by this command;
 * the SDK only mints when no file exists.
 *
 * Ordering matters: the local file is written FIRST (so the minted session is
 * usable for `LMNR_DEBUG=1` continuation even if the network is down / the
 * backend endpoint isn't deployed yet), THEN the session is best-effort
 * registered with the backend. A registration failure WARNS but does not fail
 * the command (exit 0) — the file is already written.
 *
 * Pure handler: the command wrapper (`withProjectClient`) resolves a user-token
 * {@link LaminarClient} (routes `register()` to `POST /v1/cli/rollouts/{id}` with
 * the resolved project) and owns the error envelope.
 */
export const handleDebugSessionNew = async (
  client: LaminarClient,
  opts: DebugSessionNewOpts,
): Promise<void> => {
  const sessionId = randomUUID();

  // The session file is project-scoped: reset the NEAREST existing
  // .lmnr/debug-session.json (walking up from cwd) rather than shadowing it
  // with a nested copy; only when none exists anywhere up the tree is a fresh
  // one created in cwd. Resolved once — both writes must hit the same file.
  const sessionDir = resolveDebugSessionDir();

  // 1. Write the file FIRST (nulls for trace/replay/cache, fresh started_at).
  // The debugger_url is filled in once we learn the project id from register().
  writeDebugSessionFile({
    session_id: sessionId,
    trace_id: null,
    replay_trace_id: null,
    cache_until: null,
    debugger_url: null,
    started_at: new Date().toISOString(),
  }, sessionDir);

  // 2. Best-effort register. Routes to POST /v1/cli/rollouts/{id} (userToken
  // auth). A failure (endpoint missing / offline) warns but never fails — the
  // file is already usable for continuation.
  let projectId: string | null = null;
  try {
    projectId = await client.rolloutSessions.register({ sessionId });
  } catch (e) {
    logger.warn(
      "Could not register the debug session with the backend " +
      `(the local .lmnr/debug-session.json is still usable): ${errorMessage(e)}`,
    );
  }

  // 3. Build the per-session debugger URL once the project id is known and
  // rewrite the file with it filled in.
  const debuggerUrl = projectId ? buildDebuggerUrl(projectId, sessionId) : null;
  if (debuggerUrl) {
    writeDebugSessionFile({
      session_id: sessionId,
      trace_id: null,
      replay_trace_id: null,
      cache_until: null,
      debugger_url: debuggerUrl,
      started_at: new Date().toISOString(),
    }, sessionDir);
  }

  // 4. Output.
  if (opts.json) {
    outputJson({ sessionId, projectId, debuggerUrl });
    return;
  }

  if (debuggerUrl) {
    logger.info(`New debug session: ${debuggerUrl}`);
  } else {
    logger.info(`New debug session: ${sessionId}`);
  }
  // Print the bare session id to stdout so an agent can capture it directly.
  console.log(sessionId);

  // Default-open the browser (suppressed by --no-browser). Best-effort.
  if (opts.browser !== false && debuggerUrl) {
    try {
      await open(debuggerUrl);
    } catch {
      // Best-effort: the URL is already printed for the user to open.
    }
  }
};
