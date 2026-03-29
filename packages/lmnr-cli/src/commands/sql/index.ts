import { LaminarClient } from "@lmnr-ai/client";

import { initializeLogger } from "../../utils/logger";
import { outputJson, outputJsonError } from "../../utils/output";
import { renderTable } from "../../utils/table";

const logger = initializeLogger();

interface SqlCommandOptions {
  projectApiKey?: string;
  baseUrl?: string;
  port?: number;
  json?: boolean;
}

export const handleSqlQuery = async (
  query: string,
  options: SqlCommandOptions,
): Promise<void> => {
  const client = new LaminarClient({
    projectApiKey: options.projectApiKey,
    baseUrl: options.baseUrl,
    port: options.port,
  });

  try {
    const rows = await client.sql.query(query);

    if (options.json) {
      outputJson(rows);
      return;
    }

    if (rows.length === 0) {
      console.log("No rows returned.");
      return;
    }

    const columns = Object.keys(rows[0]);
    const tableRows = rows.map((row) =>
      columns.map((col) => String(row[col] ?? "")),
    );

    console.log(renderTable(columns, tableRows));
    console.log(`\n${rows.length} row(s)\n`);
  } catch (error) {
    if (options.json) outputJsonError(error);
    logger.error(`Query failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
};

