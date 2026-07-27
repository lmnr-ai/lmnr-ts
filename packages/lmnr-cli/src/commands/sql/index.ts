import { LaminarClient } from "@lmnr-ai/client";

import type { GlobalOpts } from "../../auth/with-client";
import { toCsv } from "../../utils/csv";
import { initializeLogger } from "../../utils/logger";
import { outputJson, printData } from "../../utils/output";
import { renderTable } from "../../utils/table";

const logger = initializeLogger();

/**
 * Run a SQL query against the project's data and print the rows. Pure handler:
 * the command wrapper (`withProjectClient`) resolves the client and owns the
 * error envelope (`--json` → structured error + exit, otherwise log + exit).
 *
 * Output modes:
 * - `--json`   → JSON array of row objects (machine-readable, unchanged).
 * - `--pretty` → the borderless human table (previous default).
 * - default    → CSV: one record per line, compact and agent-parseable when
 *   piped. Only the CSV goes to stdout; the row-count summary is logged to
 *   stderr so a downstream parser gets pure CSV.
 */
export const handleSqlQuery = async (
  client: LaminarClient,
  query: string,
  opts: GlobalOpts,
): Promise<void> => {
  const rows = await client.sql.query(query);

  if (opts.json) {
    outputJson(rows);
    return;
  }

  if (rows.length === 0) {
    // Nothing to serialize. In the default (CSV) path keep stdout empty so a
    // piped consumer doesn't parse a note as a data row; humans get a stderr
    // note. `--pretty` keeps the note on stdout, as before.
    if (opts.pretty) {
      printData("No rows returned.");
    } else {
      logger.info("No rows returned.");
    }
    return;
  }

  const columns = Object.keys(rows[0]);

  if (opts.pretty) {
    const tableRows = rows.map((row) =>
      columns.map((col) => String(row[col] ?? "")),
    );
    printData(renderTable(columns, tableRows));
    printData(`\n${rows.length} row(s)\n`);
    return;
  }

  // Default: CSV to stdout, row-count summary to stderr (keeps stdout pure CSV).
  printData(toCsv(columns, rows));
  logger.info(`${rows.length} row(s)`);
};
