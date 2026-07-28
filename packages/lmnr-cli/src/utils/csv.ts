/**
 * Minimal RFC 4180-style CSV serializer for tabular command output (the default
 * `sql query` format, tuned for agents piping stdout).
 * - Rows joined with LF, not CRLF — Unix tooling handles LF and it avoids stray `\r`.
 * - A cell is quoted only if it has a comma, double-quote, CR, or LF; embedded
 *   double-quotes are doubled.
 * - `null` / `undefined` render as an empty field.
 * - Object/array cells (e.g. jsonb) are JSON-stringified, keeping one record per row.
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
 * Serialize rows to CSV: first line is the header, the rest are records. Column
 * order is fixed by `columns`, so keys missing from a row become empty fields.
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
