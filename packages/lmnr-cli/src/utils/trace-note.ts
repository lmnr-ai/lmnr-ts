// Trace-metadata key the debugger UI reads the agent's note from. Metadata
// naming stays `rollout.*` (matching `rollout.session_id`); the value is an
// opaque string the frontend renders as markdown.
export const NOTE_METADATA_KEY = "rollout.note";

/**
 * Normalize a user-supplied trace id (UUID or 32-char OTel hex, optionally
 * 0x-prefixed) to the dashed UUID form used by the SQL endpoint. Throws on
 * anything else so a typo fails loudly instead of querying nothing.
 */
export const normalizeTraceId = (traceId: string): string => {
  const id = traceId.trim().toLowerCase().replace(/^0x/, "");
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
    return id;
  }
  if (/^[0-9a-f]{32}$/.test(id)) {
    return id.replace(
      /^([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})$/,
      "$1-$2-$3-$4-$5",
    );
  }
  throw new Error(
    `Invalid trace id "${traceId}". Expected a UUID or a 32-char OTel hex trace id.`,
  );
};

/**
 * Extract the note from a trace's `metadata` column as returned by the SQL
 * endpoint (a JSON string; tolerate an already-parsed object too). Missing /
 * malformed metadata reads as "no note".
 */
export const readNoteFromMetadata = (metadata: unknown): string => {
  let parsed: unknown = metadata;
  if (typeof metadata === "string") {
    if (metadata === "") {
      return "";
    }
    try {
      parsed = JSON.parse(metadata);
    } catch {
      return "";
    }
  }
  if (typeof parsed !== "object" || parsed === null) {
    return "";
  }
  const note = (parsed as Record<string, unknown>)[NOTE_METADATA_KEY];
  return typeof note === "string" ? note : "";
};
