import { LaminarClient } from "@lmnr-ai/client";
import { errorMessage } from "@lmnr-ai/types";

import { initializeLogger } from "../../utils/logger";
import { outputJson, outputJsonError } from "../../utils/output";
import {
  normalizeTraceId,
  NOTE_METADATA_KEY,
  readNoteFromMetadata,
} from "../../utils/trace-note";

const logger = initializeLogger();

// ---------------------------------------------------------------------------
// trace append-note — debugger feature (project-key auth)
// ---------------------------------------------------------------------------

interface TraceCommandOptions {
  projectApiKey?: string;
  baseUrl?: string;
  port?: number;
  json?: boolean;
}

/**
 * trace append-note is a project-API-key surface (not the user-token wrappers).
 * Build the client from the project key (flag or LMNR_PROJECT_API_KEY).
 */
function buildProjectKeyClient(options: TraceCommandOptions): LaminarClient {
  return new LaminarClient({
    baseUrl: options.baseUrl,
    port: options.port,
    ...(options.projectApiKey
      ? { auth: { type: "apiKey", key: options.projectApiKey } as const }
      : {}),
  });
}

// Separator between appended note entries. The note is rendered as markdown,
// so a blank line keeps each appended entry its own paragraph.
const NOTE_SEPARATOR = "\n\n";

/**
 * Append a free-text note to an existing trace. Stored under the
 * `rollout.note` trace-metadata key via the post-factum metadata patch
 * endpoint. The patch endpoint is last-write-wins per key, so the current
 * note is read back first (via the SQL endpoint) and the new text is pushed
 * as `existing + "\n\n" + note`. The note may contain markdown /
 * span-reference links.
 *
 * The read-modify-write is not transactional: the patch lands via the async
 * ingestion queue, so a second append issued within ~a second of the first
 * can read the pre-patch note and drop the first append. Fine for the
 * intended cadence (one note per investigation step), not for concurrent
 * writers.
 *
 * TODO: revisit — make the append atomic server-side (e.g. an append mode on
 * the metadata patch endpoint that concatenates within the Postgres UPDATE,
 * which already serializes on the trace row lock).
 */
export const handleTraceAppendNote = async (
  traceId: string,
  note: string,
  options: TraceCommandOptions,
): Promise<void> => {
  const client = buildProjectKeyClient(options);

  try {
    const id = normalizeTraceId(traceId);

    const rows = await client.sql.query(
      "SELECT metadata FROM traces WHERE id = {trace_id:UUID} LIMIT 1",
      { trace_id: id },
    );
    if (rows.length === 0) {
      throw new Error(
        `Trace ${id} not found. If the run just finished, the trace may not ` +
          "be flushed yet. Retry in a few seconds.",
      );
    }

    const existing = readNoteFromMetadata(rows[0].metadata);
    const updated = existing ? `${existing}${NOTE_SEPARATOR}${note}` : note;
    // failOnNotFound: the SQL pre-read can race a trace deletion, and a CLI
    // exit 0 must mean the note actually landed.
    await client.traces.pushMetadata(
      id,
      { [NOTE_METADATA_KEY]: updated },
      { failOnNotFound: true },
    );

    if (options.json) {
      outputJson({ traceId: id, note: updated });
      return;
    }

    logger.info(`Appended note to trace ${id}.`);
  } catch (error) {
    if (options.json) outputJsonError(error);
    logger.error(`Failed to append trace note: ${errorMessage(error)}`);
    process.exit(1);
  }
};
