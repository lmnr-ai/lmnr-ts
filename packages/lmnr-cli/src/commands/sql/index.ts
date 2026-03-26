import { LaminarClient } from "@lmnr-ai/client";

import { initializeLogger } from "../../utils/logger";
import { outputJson, outputJsonError } from "../../utils/output";

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

    // TODO: is there a standard library for printing these types of tables?
    const columns = Object.keys(rows[0]);
    const widths = columns.map((col) =>
      Math.max(col.length, ...rows.map((r) => String(r[col] ?? "").length)),
    );

    const header = columns.map((col, i) => col.padEnd(widths[i])).join(" ");

    const divider = widths.map((w) => "-".repeat(w)).join(" ");

    console.log(`\n${header}`);
    console.log(divider);

    for (const row of rows) {
      console.log(columns.map((col, i) => String(row[col] ?? "").padEnd(widths[i])).join(" "));
    }

    console.log(`\n${rows.length} row(s)\n`);
  } catch (error) {
    if (options.json) outputJsonError(error);
    logger.error(`Query failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
};

