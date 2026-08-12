/**
 * Shared contract for `GET /v1/sql/schema` (and its `/v1/cli` twin) — the
 * logical tables, columns, and enums the SQL engine exposes.
 *
 * The server serializes this straight from app-server's
 * `query_engine::schema` consts, which also render the MCP `query_laminar_sql`
 * tool description and the Platform Agent prompt. That is the point: the CLI
 * used to carry a hand-maintained copy, and it drifted badly enough to
 * advertise columns that did not exist. Do NOT reintroduce a local copy —
 * `lmnr-cli sql schema` renders whatever the server returns.
 */

/** One column of a queryable table. `type` is the ClickHouse type as a string. */
export interface SqlSchemaColumn {
  name: string;
  /** ClickHouse type, e.g. `UUID`, `DateTime64(9,'UTC')`, `String (enum status)`. */
  type: string;
  description: string;
}

/**
 * One logical table. The caller writes this name; the engine rewrites it to a
 * project-scoped view.
 */
export interface SqlSchemaTable {
  name: string;
  description: string;
  columns: SqlSchemaColumn[];
}

/** A constrained column and the literals it accepts. */
export interface SqlSchemaEnum {
  name: string;
  values: string[];
}

/** Full response body of the schema endpoint. */
export interface SqlSchema {
  tables: SqlSchemaTable[];
  enums: SqlSchemaEnum[];
}
