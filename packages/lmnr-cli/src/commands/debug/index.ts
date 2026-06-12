import { randomUUID } from "node:crypto";

import { LaminarClient } from "@lmnr-ai/client";
import { errorMessage } from "@lmnr-ai/types";
import open from "open";

import type { GlobalOpts } from "../../auth/with-client";
import { DEFAULT_FRONTEND_URL } from "../../constants";
import {
  readDebugSessionFile,
  resolveSessionId,
  writeDebugSessionFile,
} from "../../utils/debug-session-file";
import { readLocalProjectFile } from "../../utils/local-project-file";
import { initializeLogger } from "../../utils/logger";
import { outputJson } from "../../utils/output";
import { readNoteFromMetadata } from "../../utils/trace-note";

const logger = initializeLogger();

/**
 * Upsert the display name of a debug session. Update-only on the backend: a
 * session id unknown to the project 404s rather than creating a ghost session.
 *
 * `explicitSessionId` is the optional `[session-id]` positional; when omitted
 * the session comes from `.lmnr/debug-session.json` (see `resolveSessionId`).
 *
 * Pure handler: the command wrapper (`withProjectClient`) resolves a user-token
 * {@link LaminarClient} (routes to `/v1/cli/*` with the resolved project) and
 * owns the error envelope.
 */
export const handleDebugSessionSetName = async (
  client: LaminarClient,
  name: string,
  explicitSessionId: string | undefined,
  opts: GlobalOpts,
): Promise<void> => {
  const sessionId = resolveSessionId(explicitSessionId);
  await client.rolloutSessions.setName({ sessionId, name });

  if (opts.json) {
    outputJson({ sessionId, name });
    return;
  }

  logger.info(`Set name of session ${sessionId} to "${name}".`);
};

interface SessionTraceSummary {
  note: string;
  traceId: string;
  // Trace `end_time` — the closest thing to "last updated" on a trace (it
  // advances as spans keep arriving for the trace).
  endTime: string;
}

/**
 * Print a per-trace summary of a debug session: every trace whose metadata
 * groups it to the session (`rollout.session_id`), oldest first, with the
 * agent-authored note (`rollout.note`) attached to each.
 *
 * `explicitSessionId` is the optional `[session-id]` positional; when omitted
 * the session comes from `.lmnr/debug-session.json` (see `resolveSessionId`).
 *
 * Pure handler: the command wrapper (`withProjectClient`) resolves a user-token
 * {@link LaminarClient} (routes to `/v1/cli/*` with the resolved project) and
 * owns the error envelope.
 */
export const handleDebugSessionSummary = async (
  client: LaminarClient,
  explicitSessionId: string | undefined,
  opts: GlobalOpts,
): Promise<void> => {
  const sessionId = resolveSessionId(explicitSessionId);
  // formatDateTime pins end_time to unambiguous ISO-8601 UTC — the raw
  // column serializes as ClickHouse's space-separated local-looking format.
  const rows = await client.sql.query(
    "SELECT id, " +
    "formatDateTime(end_time, '%Y-%m-%dT%H:%i:%S.%fZ') AS end_time, " +
    "metadata FROM traces " +
    "WHERE simpleJSONExtractString(metadata, 'rollout.session_id') " +
    "= {session_id:String} " +
    "ORDER BY start_time",
    { session_id: sessionId },
  );
  const traces: SessionTraceSummary[] = rows.map((row) => ({
    note: readNoteFromMetadata(row.metadata),
    traceId: String(row.id ?? ""),
    endTime: String(row.end_time ?? ""),
  }));

  if (opts.json) {
    outputJson(traces);
    return;
  }

  if (traces.length === 0) {
    console.log(`No traces found for session ${sessionId}.`);
    return;
  }

  const blocks = traces.map((trace) => {
    const tag = `<trace id="${trace.traceId}" end-time="${trace.endTime}"/>`;
    return trace.note ? `${trace.note}\n${tag}` : tag;
  });
  console.log(blocks.join("\n\n"));
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
 * `explicitSessionId` is the optional `[session-id]` positional; when omitted
 * the session comes from `.lmnr/debug-session.json` (see `resolveSessionId`).
 * The URL is the file's stored `debugger_url` when it belongs to the resolved
 * session, else it is rebuilt from the resolved project (`--project-id` or the
 * linked `.lmnr/project.json`) + LMNR_FRONTEND_URL.
 *
 * Local-only handler (registered via `withLocalOpts`, NOT `withProjectClient`):
 * everything needed lives on disk, so no auth resolution / API call — `open`
 * works offline and before login.
 */
export const handleDebugSessionOpen = async (
  explicitSessionId: string | undefined,
  opts: GlobalOpts,
): Promise<void> => {
  const sessionId = resolveSessionId(explicitSessionId);

  const file = readDebugSessionFile();
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

  // 1. Write the file FIRST (nulls for trace/replay/cache, fresh started_at).
  // The debugger_url is filled in once we learn the project id from register().
  writeDebugSessionFile({
    session_id: sessionId,
    trace_id: null,
    replay_trace_id: null,
    cache_until: null,
    debugger_url: null,
    started_at: new Date().toISOString(),
  });

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
    });
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
