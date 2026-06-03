import { LaminarClient } from "@lmnr-ai/client";
import { errorMessage } from "@lmnr-ai/types";

import { resolveAuth } from "../../utils/auth-context";
import { initializeLogger } from "../../utils/logger";
import { outputJson, outputJsonError } from "../../utils/output";
import { renderTable } from "../../utils/table";
import { EXIT_NOT_LOGGED_IN } from "../auth";

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
  let auth;
  try {
    auth = await resolveAuth(options);
  } catch (err) {
    if (options.json) outputJsonError(err);
    logger.error(errorMessage(err));
    process.exit(
      (err as { code?: string })?.code === "NOT_LOGGED_IN" ? EXIT_NOT_LOGGED_IN : 1,
    );
  }
  const client = new LaminarClient({
    projectApiKey: auth.projectApiKey,
    baseUrl: auth.baseUrl,
    port: auth.port,
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
    logger.error(`Query failed: ${errorMessage(error)}`);
    process.exit(1);
  }
};

