/**
 * Minimal RFC 4180-style CSV serializer for tabular command output.
 *
 * Design notes (kept deliberately narrow — this is the default `sql query`
 * output format, tuned for agents piping stdout):
 * - Rows are joined with `\n` (LF), NOT CRLF. RFC 4180 specifies CRLF, but
 *   Unix tooling and agent parsers handle LF universally and it avoids stray
 *   `\r` bytes in piped output.
 * - A cell is quoted only when it contains a comma, double-quote, CR, or LF;
 *   embedded double-quotes are doubled (`"` -> `""`).
 * - `null` / `undefined` render as an empty (unquoted) field.
 * - Object/array cells (e.g. jsonb columns) are `JSON.stringify`-ed, then
 *   escaped like any other string. This keeps one record per row (the whole
 *   point of CSV here) instead of expanding nested structures across cells.
 */

const needsQuoting = (value: string): boolean =>
  value.includes(",") ||
  value.includes('"') ||
  value.includes("\n") ||
  value.includes("\r");

const toStringCell = (value: unknown): string => {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  // Primitives from JSON-parsed rows stringify without Object's default format.
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return value.toString();
  }
  // Objects/arrays (e.g. jsonb columns) become a single JSON string cell.
  return JSON.stringify(value);
};

const escapeCell = (value: unknown): string => {
  const str = toStringCell(value);
  return needsQuoting(str) ? `"${str.replace(/"/g, '""')}"` : str;
};

/**
 * Serialize rows to CSV. The first line is the header (column names, escaped
 * like any cell); each subsequent line is one record. Column order is fixed by
 * `columns`, so missing keys in a row become empty fields.
 */
export const toCsv = (
  columns: string[],
  rows: Record<string, unknown>[],
): string => {
  const lines = [columns.map(escapeCell).join(",")];
  for (const row of rows) {
    lines.push(columns.map((col) => escapeCell(row[col])).join(","));
  }
  return lines.join("\n");
};
