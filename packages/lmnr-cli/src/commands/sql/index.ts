import { LaminarClient } from "@lmnr-ai/client";

import type { GlobalOpts } from "../../auth/with-client";
import { toCsv } from "../../utils/csv";
import { initializeLogger } from "../../utils/logger";
import { outputJson, printData } from "../../utils/output";
import { renderTable } from "../../utils/table";

const logger = initializeLogger();

/**
 * Run a SQL query and print the rows. Pure handler — `withProjectClient` owns
 * the client and error envelope.
 *
 * Output: `--json` → JSON array, `--pretty` → human table, default → CSV to
 * stdout with the row-count on stderr (keeps stdout pure CSV for piping).
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
    // Keep stdout empty in the CSV path so a piped consumer doesn't read the
    // note as a data row; --pretty still puts it on stdout.
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
