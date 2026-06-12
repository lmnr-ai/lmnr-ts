import { LaminarClient } from "@lmnr-ai/client";

import type { GlobalOpts } from "../../auth/with-client";
import { resolveTraceId } from "../../utils/debug-session-file";
import { initializeLogger } from "../../utils/logger";
import { outputJson } from "../../utils/output";
import {
  normalizeTraceId,
  NOTE_METADATA_KEY,
  readNoteFromMetadata,
} from "../../utils/trace-note";

const logger = initializeLogger();

// Separator between appended note entries. The note is rendered as markdown,
// so a blank line keeps each appended entry its own paragraph.
const NOTE_SEPARATOR = "\n\n";

/** Options accepted by `trace append-note` (extends the shared globals). */
export interface TraceAppendNoteOpts extends GlobalOpts {
  /** Set by `--trace-id`; omitted → the debug-session.json `trace_id`. */
  traceId?: string;
}

/**
 * Append a free-text note to an existing trace. Stored under the
 * `rollout.note` trace-metadata key via the post-factum metadata patch
 * endpoint. The patch endpoint is last-write-wins per key, so the current
 * note is read back first (via the SQL endpoint) and the new text is pushed
 * as `existing + "\n\n" + note`. The note may contain markdown /
 * span-reference links.
 *
 * The target trace is the optional `--trace-id` flag; when omitted the trace
 * comes from `.lmnr/debug-session.json`'s `trace_id` — the root trace of the
 * most recent debug run in this directory (see `resolveTraceId`).
 *
 * Pure handler: the command wrapper (`withProjectClient`) resolves a user-token
 * {@link LaminarClient} (routes to `/v1/cli/*` with the resolved project) and
 * owns the error envelope (`--json` → structured error + exit, else log + exit).
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
  client: LaminarClient,
  note: string,
  opts: TraceAppendNoteOpts,
): Promise<void> => {
  const id = normalizeTraceId(resolveTraceId(opts.traceId));

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

  if (opts.json) {
    outputJson({ traceId: id, note: updated });
    return;
  }

  logger.info(`Appended note to trace ${id}.`);
};
