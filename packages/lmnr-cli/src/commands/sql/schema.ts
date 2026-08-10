import type { LaminarClient } from "@lmnr-ai/client";
import { errorMessage, type SqlSchema } from "@lmnr-ai/types";

import type { GlobalOpts } from "../../auth/with-client";
import { schemaFetchFailed } from "../../errors";
import { outputJson, printData } from "../../utils/output";

/** Max width before a column list wraps onto a continuation line. */
const WRAP_WIDTH = 76;
const INDENT = "    ";

/**
 * Wrap `parts` into comma-separated lines at `WRAP_WIDTH`, so a wide table
 * stays readable in a terminal without truncating anything.
 */
const wrapList = (parts: string[]): string[] => {
  const lines: string[] = [];
  let current = "";

  for (const [i, part] of parts.entries()) {
    const piece = i === parts.length - 1 ? part : `${part},`;
    if (current === "") {
      current = piece;
    } else if (`${current} ${piece}`.length + INDENT.length <= WRAP_WIDTH) {
      current = `${current} ${piece}`;
    } else {
      lines.push(current);
      current = piece;
    }
  }
  if (current !== "") lines.push(current);

  return lines;
};

/**
 * Render the server's schema as the human/agent-facing text block. Column
 * descriptions are deliberately dropped — the CLI surface is a list of fields
 * and their types; prose belongs in the docs.
 */
export const renderSqlSchema = (schema: SqlSchema): string => {
  const out: string[] = [
    "",
    "Queries are scoped to your project automatically. There is no project_id",
    "column — referencing it is rejected.",
    "",
    "Available tables:",
  ];

  for (const table of schema.tables) {
    out.push(`  ${table.name}`);
    const cols = table.columns.map((c) => `${c.name} (${c.type})`);
    out.push(...wrapList(cols).map((line) => `${INDENT}${line}`));
    out.push("");
  }

  if (schema.enums.length > 0) {
    out.push("Enums:");
    for (const e of schema.enums) {
      // Hang the continuation under the values, not under the enum name, so a
      // long list (span_type has 9) stays inside the terminal width.
      const [first, ...rest] = wrapList(e.values.map((v) => `'${v}'`));
      out.push(`  ${e.name}: ${first}`);
      const hang = " ".repeat(`  ${e.name}: `.length);
      out.push(...rest.map((line) => `${hang}${line}`));
    }
    out.push("");
  }

  return out.join("\n");
};

/**
 * Print the schema the SERVER reports. Pure handler — `withProjectClient` owns
 * the client and error envelope.
 *
 * There is no bundled fallback on purpose: a local copy is what drifted last
 * time (it advertised columns that did not exist), so an unreachable API is an
 * error, not a reason to print a stale guess.
 */
export const handleSqlSchema = async (
  client: LaminarClient,
  opts: GlobalOpts,
): Promise<void> => {
  let schema: SqlSchema;
  try {
    schema = await client.sql.schema();
  } catch (err) {
    // A bare `fetch failed` names neither the host nor the fix, and this is
    // exactly when the user is already misconfigured (a stale LMNR_BASE_URL in
    // a project `.env` is the common case).
    //
    // Read the origin off the client rather than rebuilding it from
    // `baseUrl` + `port`: the client strips a trailing slash and any port
    // already in `baseUrl` before appending the effective one, so
    // reconstruction drifts (`http://host:8000:9000`) and names an address
    // that was never fetched.
    const url = client.apiBaseUrl;
    throw schemaFetchFailed(
      `Could not fetch the SQL schema from ${url}: ${errorMessage(err)}. ` +
      "Check your connection, or that --base-url / --port (LMNR_BASE_URL / " +
      "LMNR_HTTP_PORT) point at a reachable Laminar API.",
    );
  }

  if (opts.json) {
    outputJson(schema);
    return;
  }

  printData(renderSqlSchema(schema));
};
