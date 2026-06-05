import { buildLaminarClient } from "../../auth/client";
import { parseDuration } from "../../utils/duration";

// TODO: revisit whether even this much abstraction is necessary. Today the
// command polls the same SQL surface a user could hit themselves via
// `lmnr-cli sql query "SELECT count() FROM spans WHERE ..."`. If coding
// agents are the only callers, we could collapse this into a one-shot script
// in the agent prompt and delete the command entirely. Keep it for now —
// the retry/timeout/exit-code semantics are nicer than a shell loop.

export interface TracesWaitOptions {
  since?: string;
  count?: string;
  timeout?: string;
  projectApiKey?: string;
  baseUrl?: string;
  port?: number;
  json?: boolean;
}

const POLL_INTERVAL_MS = 2000;

/**
 * Poll the SQL endpoint until at least `--count` spans appear in the last
 * `--since` window, or until `--timeout` elapses. Designed to be invoked by
 * a coding agent after running an instrumented script — exit 0 = "tracing
 * works"; exit 1 = timed out; exit 6 = no credentials.
 */
export async function handleTracesWait(options: TracesWaitOptions): Promise<void> {
  const isJson = options.json === true;
  const sinceSeconds = parseDuration(options.since) ?? 60;
  const targetCount = Number(options.count ?? "1");
  const timeoutSeconds = parseDuration(options.timeout) ?? 120;
  if (!Number.isFinite(targetCount) || targetCount <= 0) {
    emitError(isJson, "bad_count", "Invalid --count");
    process.exit(1);
  }

  let client;
  try {
    client = await buildLaminarClient({
      projectApiKey: options.projectApiKey,
      baseUrl: options.baseUrl,
      port: options.port,
    });
  } catch (err) {
    emitError(isJson, "not_authenticated", describeError(err));
    process.exit(6);
  }

  if (!isJson) {
    process.stderr.write(
      `Waiting for traces (last ${sinceSeconds}s, need ${targetCount})...\n`,
    );
  }

  const sql = `SELECT count() AS count FROM spans WHERE start_time > now() - INTERVAL ${sinceSeconds} SECOND`;
  const start = Date.now();

  for (;;) {
    try {
      const rows = (await client.sql.query(sql)) as Array<Record<string, unknown>>;
      const count = Number(rows[0]?.count ?? 0);
      if (count >= targetCount) {
        const elapsedMs = Date.now() - start;
        if (isJson) {
          process.stdout.write(
            JSON.stringify({ found: count, elapsedMs, timedOut: false }) + "\n",
          );
        } else {
          const noun = count === 1 ? "trace" : "traces";
          const secs = (elapsedMs / 1000).toFixed(1);
          process.stdout.write(`Found ${count} ${noun} in ${secs}s\n`);
        }
        return;
      }
    } catch (err) {
      process.stderr.write(`(query failed: ${describeError(err)})\n`);
    }

    if (Date.now() - start >= timeoutSeconds * 1000) break;
    await sleep(POLL_INTERVAL_MS);
  }

  const elapsedMs = Date.now() - start;
  if (isJson) {
    process.stdout.write(
      JSON.stringify({ found: 0, elapsedMs, timedOut: true }) + "\n",
    );
  } else {
    process.stdout.write(
      `Timed out after ${(elapsedMs / 1000).toFixed(1)}s (0 traces in last ${sinceSeconds}s)\n`,
    );
  }
  process.exit(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveP) => setTimeout(resolveP, ms));
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function emitError(json: boolean, code: string, detail: string): void {
  if (json) {
    process.stdout.write(JSON.stringify({ error: code, detail }) + "\n");
  } else {
    process.stderr.write(`\nERROR (${code}): ${detail}\n`);
  }
}
