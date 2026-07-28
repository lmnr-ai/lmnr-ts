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

/** Options for the session-scoped debug commands (`set-name`, `summary`, `open`). */
export interface DebugSessionScopedOpts extends GlobalOpts {
  /** Set by `--session-id`; omitted → the debug-session.json `session_id`. */
  sessionId?: string;
}

/**
 * Upsert a debug session's display name. Update-only on the backend: an unknown
 * session id 404s rather than creating a ghost session. Session id defaults from
 * `.lmnr/debug-session.json` when `--session-id` is omitted.
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
 * Attach a free-text note to a debug session as a standalone `text` block,
 * keyed by session id — not to any trace / evaluation metadata. Notes interleave
 * by time with the session's trace / evaluation blocks in the UI and in
 * `debug session summary`. Session id defaults from `.lmnr/debug-session.json`
 * when `--session-id` is omitted.
 */
export const handleDebugSessionAddNote = async (
  client: LaminarClient,
  note: string,
  opts: DebugSessionAddNoteOpts,
): Promise<void> => {
  const sessionId = resolveSessionId(opts.sessionId);
  // failOnNotFound: exit 0 must mean the note actually landed.
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
    case "command": {
      // One digest line per command: what ran + how it exited (+ thinking, when
      // supplied). Full stdout/stderr stay in `--json`.
      const command = typeof content.command === "string" ? content.command : "";
      if (!command) return null;
      const args = Array.isArray(content.args)
        ? content.args.map((a) => (typeof a === "string" ? a : String(a)))
        : [];
      const exitCode = typeof content.exitCode === "number" ? content.exitCode : 0;
      const thinking =
        typeof content.thinking === "string" && content.thinking
          ? ` thinking="${content.thinking}"`
          : "";
      const invocation = args.length ? `${command} ${args.join(" ")}` : command;
      return `<command exitCode="${exitCode}"${thinking}>${invocation}</command>`;
    }
    default:
      return null;
  }
};

/**
 * Print a chronological digest of a debug session: every block (trace /
 * evaluation / text note), oldest first. Session id defaults from
 * `.lmnr/debug-session.json` when `--session-id` is omitted.
 */
export const handleDebugSessionSummary = async (
  client: LaminarClient,
  opts: DebugSessionScopedOpts,
): Promise<void> => {
  const sessionId = resolveSessionId(opts.sessionId);
  const blocks = await client.rolloutSessions.listBlocks({ sessionId });
  // Sort oldest-first defensively; the summary's contract is chronological.
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

/** Build the frontend debugger-session URL (LMNR_FRONTEND_URL, else cloud default). */
const buildDebuggerUrl = (projectId: string, sessionId: string): string => {
  const frontend =
    process.env.LMNR_FRONTEND_URL?.trim().replace(/\/+$/, "") || DEFAULT_FRONTEND_URL;
  return `${frontend}/project/${projectId}/debugger-sessions/${sessionId}`;
};

/**
 * Open a debug session's debugger page in the browser. The URL is the file's
 * stored `debugger_url` when it matches the resolved session, else it is rebuilt
 * from the resolved project + LMNR_FRONTEND_URL. Session id defaults from
 * `.lmnr/debug-session.json` when `--session-id` is omitted.
 *
 * Local-only: everything lives on disk, so `open` works offline and before login.
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
 * Mint a fresh debug session and reset `.lmnr/debug-session.json` to it. The next
 * `LMNR_DEBUG=1 <run>` reads that file and rejoins the session silently.
 *
 * Ordering matters: the local file is written FIRST (so the session is usable
 * even if the backend is unreachable), THEN best-effort registered. A
 * registration failure warns but does not fail the command (exit 0).
 */
export const handleDebugSessionNew = async (
  client: LaminarClient,
  opts: DebugSessionNewOpts,
): Promise<void> => {
  const sessionId = randomUUID();

  // Project-scoped: reset the nearest existing .lmnr/debug-session.json (walking
  // up from cwd), only creating one in cwd if none exists up the tree. Resolved
  // once — both writes must hit the same file.
  const sessionDir = resolveDebugSessionDir();

  // 1. Write the file FIRST. debugger_url is filled in after register().
  writeDebugSessionFile({
    session_id: sessionId,
    trace_id: null,
    replay_trace_id: null,
    cache_until: null,
    debugger_url: null,
    started_at: new Date().toISOString(),
  }, sessionDir);

  // 2. Best-effort register. A failure warns but never fails — the file is
  // already usable for continuation.
  let projectId: string | null = null;
  try {
    projectId = await client.rolloutSessions.register({ sessionId });
  } catch (e) {
    logger.warn(
      "Could not register the debug session with the backend " +
      `(the local .lmnr/debug-session.json is still usable): ${errorMessage(e)}`,
    );
  }

  // 3. Once the project id is known, rewrite the file with the debugger URL.
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
