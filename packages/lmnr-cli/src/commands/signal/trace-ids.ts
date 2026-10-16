/**
 * Collect the trace ids for `signal backfill` from positionals and `--file`.
 * Only the input syntax is handled here; id validity, dedupe, and the per-job
 * cap are the server's (`signals/private/backfill.rs`), whose 400 names the
 * offending ids.
 */

import { readFile } from "fs/promises";

/** Column/key names that hold a trace id in `sql query` output. */
const ID_KEYS = ["id", "trace_id", "traceId"] as const;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const unquote = (token: string): string => token.replace(/^"(.*)"$/, "$1");

/** Ids separated by whitespace and/or commas: `a b`, `a,b`, one per line. */
const splitTokens = (text: string): string[] =>
  text
    .split(/[\s,]+/)
    .map(unquote)
    .filter((t) => t.length > 0);

const fromJson = (text: string, source: string): string[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error(
      `${source} starts with "[" but is not valid JSON: ${text.slice(0, 200)}`,
      { cause },
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${source} must be a JSON array`);
  }
  return parsed.map((item, i) => {
    if (typeof item === "string") return item;
    if (isPlainObject(item)) {
      const key = ID_KEYS.find((k) => typeof item[k] === "string");
      if (key) return item[key] as string;
    }
    throw new Error(
      `${source} item ${i} is neither a trace id string nor an object with ` +
        `an "id" or "trace_id" string: ${JSON.stringify(item)?.slice(0, 200)}`,
    );
  });
};

/**
 * Parse `--file` contents. Accepts plain ids (whitespace/comma/newline
 * separated), a JSON array of ids or of `{id}` / `{trace_id}` rows (`sql query
 * --json`), or single-column CSV with an `id` / `trace_id` header (`sql query`).
 */
export const parseTraceIdText = (text: string, source: string): string[] => {
  const trimmed = text.trim();
  if (trimmed.startsWith("[")) return fromJson(trimmed, source);

  const [firstLine, ...rest] = trimmed.split(/\r?\n/);
  const header = firstLine.split(",").map((c) => unquote(c.trim()));
  if (header.some((c) => (ID_KEYS as readonly string[]).includes(c))) {
    if (header.length > 1) {
      throw new Error(
        `${source} is CSV with ${header.length} columns (${header.join(", ")}); ` +
          "select only the trace id column, e.g. `SELECT id FROM traces ...`",
      );
    }
    return splitTokens(rest.join("\n"));
  }
  return splitTokens(trimmed);
};

const readSource = async (file: string): Promise<string> => {
  if (file !== "-") return readFile(file, "utf8");
  if (process.stdin.isTTY) {
    throw new Error(
      "--file - reads stdin, but stdin is a terminal; pipe ids in",
    );
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
};

/** Positionals first, then `--file` (`-` = stdin), in order, as given. */
export const collectTraceIds = async (
  positionals: string[],
  file: string | undefined,
): Promise<string[]> => {
  const ids = positionals.flatMap(splitTokens);
  if (file !== undefined) {
    const source = file === "-" ? "stdin" : `--file ${file}`;
    ids.push(...parseTraceIdText(await readSource(file), source));
  }
  return ids;
};
