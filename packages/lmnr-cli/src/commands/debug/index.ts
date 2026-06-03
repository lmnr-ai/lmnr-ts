import { LaminarClient } from "@lmnr-ai/client";
import { errorMessage } from "@lmnr-ai/types";

import { resolveAuth } from "../../utils/auth-context";
import { initializeLogger } from "../../utils/logger";
import { outputJson, outputJsonError } from "../../utils/output";
import { readNoteFromMetadata } from "../../utils/trace-note";
import { EXIT_NOT_LOGGED_IN } from "../auth";

const logger = initializeLogger();

interface DebugCommandOptions {
  projectApiKey?: string;
  baseUrl?: string;
  port?: number;
  json?: boolean;
}

const resolveAuthOrExit = async (options: DebugCommandOptions) => {
  try {
    return await resolveAuth(options);
  } catch (err) {
    if (options.json) outputJsonError(err);
    logger.error(errorMessage(err));
    process.exit(
      (err as { code?: string })?.code === "NOT_LOGGED_IN" ? EXIT_NOT_LOGGED_IN : 1,
    );
  }
};

/**
 * Upsert the display name of a debug session. Update-only on the backend: a
 * session id unknown to the project 404s rather than creating a ghost session.
 */
export const handleDebugSessionSetName = async (
  sessionId: string,
  name: string,
  options: DebugCommandOptions,
): Promise<void> => {
  const auth = await resolveAuthOrExit(options);
  const client = new LaminarClient({
    projectApiKey: auth.projectApiKey,
    baseUrl: auth.baseUrl,
    port: auth.port,
  });

  try {
    await client.rolloutSessions.setName({ sessionId, name });

    if (options.json) {
      outputJson({ sessionId, name });
      return;
    }

    logger.info(`Set name of session ${sessionId} to "${name}".`);
  } catch (error) {
    if (options.json) outputJsonError(error);
    logger.error(`Failed to set session name: ${errorMessage(error)}`);
    process.exit(1);
  }
};

const SUMMARY_PAGE_SIZE = 1000;

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
 */
export const handleDebugSessionSummary = async (
  sessionId: string,
  options: DebugCommandOptions,
): Promise<void> => {
  const auth = await resolveAuthOrExit(options);
  const client = new LaminarClient({
    projectApiKey: auth.projectApiKey,
    baseUrl: auth.baseUrl,
    port: auth.port,
  });

  try {
    const traces: SessionTraceSummary[] = [];
    let offset = 0;
    for (;;) {
      // formatDateTime pins end_time to unambiguous ISO-8601 UTC — the raw
      // column serializes as ClickHouse's space-separated local-looking format.
      const rows = await client.sql.query(
        "SELECT id, " +
          "formatDateTime(end_time, '%Y-%m-%dT%H:%i:%S.%fZ') AS end_time, " +
          "metadata FROM traces " +
          "WHERE simpleJSONExtractString(metadata, 'rollout.session_id') " +
          "= {session_id:String} " +
          "ORDER BY start_time LIMIT {limit:UInt32} OFFSET {offset:UInt32}",
        { session_id: sessionId, limit: SUMMARY_PAGE_SIZE, offset },
      );
      for (const row of rows) {
        traces.push({
          note: readNoteFromMetadata(row.metadata),
          traceId: String(row.id ?? ""),
          endTime: String(row.end_time ?? ""),
        });
      }
      if (rows.length < SUMMARY_PAGE_SIZE) {
        break;
      }
      offset += SUMMARY_PAGE_SIZE;
    }

    if (options.json) {
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
  } catch (error) {
    if (options.json) outputJsonError(error);
    logger.error(`Failed to summarize session: ${errorMessage(error)}`);
    process.exit(1);
  }
};
