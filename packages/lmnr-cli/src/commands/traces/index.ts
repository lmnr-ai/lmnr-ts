import { readCredentials } from "../../auth/credentials";
import { refreshIfNeeded } from "../../auth/resolve";
import { parseDuration } from "../../utils/duration";

export interface TracesWaitOptions {
  since?: string;
  count?: string;
  timeout?: string;
  project?: string;
  json?: boolean;
  baseUrl?: string;
}

const POLL_INTERVAL_MS = 2000;

/**
 * Poll the app-server until at least `--count` spans appear in the last
 * `--since` window, or until `--timeout` elapses. Designed to be invoked by
 * a coding agent after running an instrumented script — exit 0 = "tracing
 * works"; exit 1 = timed out; exit 6 = no credentials and no API key.
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

  // Resolve project id + bearer. Use OAuth credentials first; API-key callers
  // must pass --project because the key doesn't carry a project id over the
  // wire on the CLI side.
  const creds = await readCredentials();
  let bearer: string;
  let issuer: string;
  let projectId: string;

  if (creds) {
    const refreshed = await refreshIfNeeded(creds);
    bearer = refreshed.accessToken;
    issuer = refreshed.issuer;
    projectId = options.project ?? refreshed.projectId ?? "";
    if (!projectId) {
      emitError(
        isJson,
        "no_project",
        "No project id in credentials. Pass --project <uuid>.",
      );
      process.exit(1);
    }
  } else {
    const envKey = process.env.LMNR_PROJECT_API_KEY;
    if (!envKey) {
      emitError(
        isJson,
        "not_authenticated",
        "Run `lmnr-cli login` or set LMNR_PROJECT_API_KEY.",
      );
      process.exit(6);
    }
    if (!options.project) {
      emitError(
        isJson,
        "no_project",
        "API key auth requires --project <uuid>.",
      );
      process.exit(6);
    }
    bearer = envKey;
    issuer = process.env.LMNR_DASHBOARD_URL ?? "https://www.laminar.sh";
    projectId = options.project;
  }

  if (!isJson) {
    process.stderr.write(
      `Waiting for traces (last ${sinceSeconds}s, need ${targetCount})...\n`,
    );
  }

  const start = Date.now();
  const trimmedIssuer = issuer.replace(/\/+$/, "");
  const url =
    `${trimmedIssuer}/api/cli/projects/${projectId}/traces/recent?since=${sinceSeconds}s`;

  for (;;) {
    let res: Response;
    try {
      res = await fetch(url, { headers: { authorization: `Bearer ${bearer}` } });
    } catch (err) {
      process.stderr.write(`(network error: ${describeError(err)})\n`);
      // continue polling
      if (Date.now() - start >= timeoutSeconds * 1000) break;
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    if (res.status === 401 || res.status === 403) {
      emitError(isJson, "unauthorized", `Server returned ${res.status}`);
      process.exit(6);
    }
    if (!res.ok) {
      process.stderr.write(`(server returned ${res.status})\n`);
    } else {
      const body = (await res.json().catch(() => null)) as { count?: number } | null;
      const count = body?.count ?? 0;
      if (count >= targetCount) {
        const elapsedMs = Date.now() - start;
        if (isJson) {
          process.stdout.write(
            JSON.stringify({ found: count, projectId, elapsedMs, timedOut: false }) + "\n",
          );
        } else {
          const noun = count === 1 ? "trace" : "traces";
          const secs = (elapsedMs / 1000).toFixed(1);
          process.stdout.write(`✓ Found ${count} ${noun} in ${secs}s\n`);
        }
        return;
      }
    }

    if (Date.now() - start >= timeoutSeconds * 1000) break;
    await sleep(POLL_INTERVAL_MS);
  }

  const elapsedMs = Date.now() - start;
  if (isJson) {
    process.stdout.write(
      JSON.stringify({ found: 0, projectId, elapsedMs, timedOut: true }) + "\n",
    );
  } else {
    process.stdout.write(
      `✗ Timed out after ${(elapsedMs / 1000).toFixed(1)}s (0 traces in last ${sinceSeconds}s)\n`,
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
