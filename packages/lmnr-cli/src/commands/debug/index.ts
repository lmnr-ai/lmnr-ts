import { LaminarClient } from "@lmnr-ai/client";

import type { GlobalOpts } from "../../auth/with-client";
import { initializeLogger } from "../../utils/logger";
import { outputJson } from "../../utils/output";
import { readNoteFromMetadata } from "../../utils/trace-note";

const logger = initializeLogger();

/**
 * Upsert the display name of a debug session. Update-only on the backend: a
 * session id unknown to the project 404s rather than creating a ghost session.
 *
 * Pure handler: the command wrapper (`withProjectClient`) resolves a user-token
 * {@link LaminarClient} (routes to `/v1/cli/*` with the resolved project) and
 * owns the error envelope.
 */
export const handleDebugSessionSetName = async (
  client: LaminarClient,
  sessionId: string,
  name: string,
  opts: GlobalOpts,
): Promise<void> => {
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
 * Pure handler: the command wrapper (`withProjectClient`) resolves a user-token
 * {@link LaminarClient} (routes to `/v1/cli/*` with the resolved project) and
 * owns the error envelope.
 */
export const handleDebugSessionSummary = async (
  client: LaminarClient,
  sessionId: string,
  opts: GlobalOpts,
): Promise<void> => {
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
