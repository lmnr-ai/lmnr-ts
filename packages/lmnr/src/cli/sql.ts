import { LaminarClient } from "@lmnr-ai/client";

import { initializeLogger } from "../utils";

const logger = initializeLogger();

const stringify = (val: unknown): string => {
  if (val === null) return "NULL";
  if (val === undefined) return "NULL";
  if (typeof val === "object") return JSON.stringify(val);
  return String(val as string | number | boolean);
};

interface SqlCommandOptions {
  projectApiKey?: string;
  baseUrl?: string;
  port?: number;
  execute?: string;
  file?: string;
  format?: "json" | "csv" | "table";
  params?: string;
}

/**
 * Resolve the SQL query from positional arg, --execute flag,
 * --file flag, or stdin.
 * Priority: positional > --execute > --file > stdin
 */
const resolveQuery = async (
  positionalQuery: string | undefined,
  options: SqlCommandOptions,
): Promise<string> => {
  if (positionalQuery) {
    return positionalQuery;
  }

  if (options.execute) {
    return options.execute;
  }

  if (options.file) {
    const { readFile } = await import("fs/promises");
    const content = await readFile(options.file, "utf-8");
    return content.trim();
  }

  // Try reading from stdin if data is being piped
  if (!process.stdin.isTTY && process.stdin.readable) {
    const stdinData = await new Promise<string | null>(
      (resolve) => {
        let data = "";
        let received = false;
        process.stdin.setEncoding("utf-8");
        process.stdin.on("data", (chunk: string) => {
          received = true;
          data += chunk;
        });
        process.stdin.on("end", () => {
          resolve(received ? data.trim() : null);
        });
        process.stdin.on("error", () => {
          resolve(null);
        });
        // Timeout after 100ms — if no data arrives, stdin
        // is not being piped to
        setTimeout(() => {
          if (!received) {
            process.stdin.destroy();
            resolve(null);
          }
        }, 100);
      },
    );

    if (stdinData) {
      return stdinData;
    }
  }

  throw new Error(
    "No SQL query provided. Use an argument, "
    + "--execute, --file, or pipe via stdin.\n"
    + "Examples:\n"
    + '  lmnr sql "SELECT count() FROM spans"\n'
    + '  lmnr sql -e "SELECT count() FROM spans"\n'
    + "  lmnr sql --file query.sql\n"
    + '  echo "SELECT count() FROM spans" | lmnr sql',
  );
};

/**
 * Parse the --params flag value as JSON.
 */
const parseParams = (
  paramsStr?: string,
): Record<string, unknown> => {
  if (!paramsStr) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(paramsStr);
    if (
      typeof parsed !== "object"
      || Array.isArray(parsed)
      || parsed === null
    ) {
      throw new Error("Parameters must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(
        `Invalid JSON for --params: ${error.message}\n`
        + 'Example: --params \'{"trace_id": "abc-123"}\'',
        { cause: error },
      );
    }
    throw error;
  }
};

/**
 * Format query results as a table string.
 */
const formatTable = (
  data: Array<Record<string, unknown>>,
): string => {
  if (data.length === 0) {
    return "No results.";
  }

  const columns = Object.keys(data[0]);

  // Calculate column widths (min 4 chars for readability)
  const widths = columns.map((col) => {
    const values = data.map((row) => stringify(row[col]));
    const maxVal = Math.max(...values.map((v) => v.length));
    return Math.min(Math.max(col.length, maxVal, 4), 60);
  });

  // Header row
  const header = columns
    .map((col, i) => col.padEnd(widths[i]))
    .join("  ");
  const separator = widths
    .map((w) => "-".repeat(w))
    .join("  ");

  // Data rows
  const rows = data.map((row) =>
    columns
      .map((col, i) => {
        const str = stringify(row[col]);
        // Truncate long values
        const truncated = str.length > widths[i]
          ? str.slice(0, widths[i] - 3) + "..."
          : str;
        return truncated.padEnd(widths[i]);
      })
      .join("  "),
  );

  return [header, separator, ...rows].join("\n");
};

/**
 * Format query results as CSV string.
 */
const formatCsv = (
  data: Array<Record<string, unknown>>,
): string => {
  if (data.length === 0) {
    return "";
  }

  const columns = Object.keys(data[0]);

  const escapeCsv = (val: unknown): string => {
    if (val === null || val === undefined) return "";
    const str = stringify(val);
    if (
      str.includes(",")
      || str.includes('"')
      || str.includes("\n")
    ) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const header = columns.map(escapeCsv).join(",");
  const rows = data.map((row) =>
    columns.map((col) => escapeCsv(row[col])).join(","),
  );

  return [header, ...rows].join("\n");
};

/**
 * Determine the default output format based on whether
 * stdout is a TTY.
 */
const getDefaultFormat = (): "json" | "table" =>
  process.stdout.isTTY ? "table" : "json";

/**
 * Handle the `sql` CLI command.
 */
export const handleSql = async (
  query: string | undefined,
  options: SqlCommandOptions,
): Promise<void> => {
  let sql: string;
  try {
    sql = await resolveQuery(query, options);
  } catch (error) {
    logger.error(
      error instanceof Error ? error.message : String(error),
    );
    process.exit(2);
  }

  let parameters: Record<string, unknown>;
  try {
    parameters = parseParams(options.params);
  } catch (error) {
    logger.error(
      error instanceof Error ? error.message : String(error),
    );
    process.exit(2);
  }

  const client = new LaminarClient({
    projectApiKey: options.projectApiKey,
    baseUrl: options.baseUrl,
    port: options.port,
  });

  try {
    const data = await client.sql.query(sql, parameters);
    const format = options.format ?? getDefaultFormat();

    switch (format) {
      case "json":
        process.stdout.write(
          JSON.stringify(data, null, 2) + "\n",
        );
        break;
      case "csv":
        process.stdout.write(formatCsv(data) + "\n");
        break;
      case "table":
        if (data.length === 0) {
          console.log("No results.");
        } else {
          console.log(formatTable(data));
          process.stderr.write(
            `\n(${data.length} row${data.length !== 1 ? "s" : ""})\n`,
          );
        }
        break;
    }
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : String(error);
    logger.error(`Query failed: ${message}`);
    process.exit(1);
  }
};
