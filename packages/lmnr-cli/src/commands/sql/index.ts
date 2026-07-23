import { LaminarClient } from "@lmnr-ai/client";

import type { GlobalOpts } from "../../auth/with-client";
import { outputJson, printData } from "../../utils/output";
import { renderTable } from "../../utils/table";

/**
 * Run a SQL query against the project's data and print the rows. Pure handler:
 * the command wrapper (`withProjectClient`) resolves the client and owns the
 * error envelope (`--json` → structured error + exit, otherwise log + exit).
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
    printData("No rows returned.");
    return;
  }

  const columns = Object.keys(rows[0]);
  const tableRows = rows.map((row) =>
    columns.map((col) => String(row[col] ?? "")),
  );

  printData(renderTable(columns, tableRows));
  printData(`\n${rows.length} row(s)\n`);
};
