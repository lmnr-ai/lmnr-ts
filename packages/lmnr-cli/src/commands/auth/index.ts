import { errorMessage } from "@lmnr-ai/types";
import open from "open";
import os from "os";
import path from "path";
import readline from "readline";
import { Writable } from "stream";

import { writeEnvFile } from "../../utils/env-file";
import { initializeLogger } from "../../utils/logger";
import { outputJson, outputJsonError } from "../../utils/output";
import {
  Credentials,
  credentialsPath,
  deleteCredentials,
  readCredentials,
  writeCredentials,
} from "./credentials";
import { startLoopbackServer } from "./loopback";
import { deriveChallenge, generateState, generateVerifier } from "./pkce";

const logger = initializeLogger();

// Defaults. CI / private deployments override via --dashboard-url / --base-url
// or LMNR_DASHBOARD_URL / LMNR_BASE_URL.
const DEFAULT_DASHBOARD_URL = "https://www.laminar.sh";
const DEFAULT_BASE_URL = "https://api.lmnr.ai";

const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

// Exit codes — keep stable, callers (scripts / CI) compare numerically.
export const EXIT_GENERIC = 1;
export const EXIT_INVALID_ARGS = 2;
export const EXIT_EXPIRED = 3;
export const EXIT_ALREADY_CLAIMED = 4;
export const EXIT_TIMED_OUT = 5;
export const EXIT_NOT_LOGGED_IN = 6;
// `.env` write failed AFTER the API key was minted — the key is surfaced on
// stderr so the caller can rescue it. Distinct from EXIT_GENERIC so coding
// agents can branch on "auth succeeded, only persistence failed".
export const EXIT_ENV_WRITE_FAILED = 8;

export interface AuthCommandOptions {
  dashboardUrl?: string;
  baseUrl?: string;
  json?: boolean;
  // Commander's `--no-browser` flag sets `browser: false` (defaults to true).
  browser?: boolean;
}

const resolveDashboardUrl = (opts: AuthCommandOptions): string => {
  const url = opts.dashboardUrl ?? process.env.LMNR_DASHBOARD_URL ?? DEFAULT_DASHBOARD_URL;
  return url.replace(/\/+$/, "");
};

const resolveBaseUrl = (opts: AuthCommandOptions): string => {
  const url = opts.baseUrl ?? process.env.LMNR_BASE_URL ?? DEFAULT_BASE_URL;
  return url.replace(/\/+$/, "");
};

export interface FlowResult {
  apiKey: string;
  projectId: string;
  projectName: string;
}

// Prompt for a single line on stdin with the typed/pasted characters hidden
// (no echo). The prompt question itself is written once to stderr; a muted
// output stream then swallows readline's per-keystroke echo so the secret never
// lands in the terminal or scrollback. Returns trimmed.
const promptLineHidden = (question: string): Promise<string> =>
  new Promise((resolve) => {
    // Mute everything readline tries to echo after the question is printed.
    let muted = false;
    const mutedOut = new Writable({
      write(chunk, _enc, cb) {
        if (!muted) process.stderr.write(chunk);
        cb();
      },
    });
    const rl = readline.createInterface({
      input: process.stdin,
      output: mutedOut,
      terminal: true,
    });
    rl.question(question, (answer) => {
      rl.close();
      // Terminate the line the user could not see being typed.
      process.stderr.write("\n");
      resolve(answer.trim());
    });
    muted = true;
  });

// Manual fallback: print the ?manual=1 URL, let the user authorize and paste the
// key. Used for --no-browser / headless / open-failure.
const runManualFlow = async (dashboardUrl: string): Promise<FlowResult> => {
  const url = `${dashboardUrl}/cli-login?manual=1`;
  process.stderr.write(
    `\nManual login:\n  1. Open: ${url}\n  2. Authorize and copy the API key.\n`,
  );
  const key = await promptLineHidden("Paste your API key (input hidden): ");
  if (!/^[A-Za-z0-9]{8,}$/.test(key)) {
    throw new Error("That does not look like a valid API key.");
  }
  // Manual mode doesn't carry project metadata back; the dashboard shows it.
  return { apiKey: key, projectId: "", projectName: "" };
};

// Loopback + PKCE: bind 127.0.0.1:0, open the dashboard, await the browser
// redirect carrying the one-time code, then exchange it for the api key.
const runLoopbackFlow = async (opts: AuthCommandOptions): Promise<FlowResult> => {
  const dashboardUrl = resolveDashboardUrl(opts);

  if (opts.browser === false) {
    return runManualFlow(dashboardUrl);
  }

  const verifier = generateVerifier();
  const challenge = deriveChallenge(verifier);
  const state = generateState();

  const server = await startLoopbackServer({ state, timeoutMs: CALLBACK_TIMEOUT_MS });
  try {
    const loginUrl =
      `${dashboardUrl}/cli-login?port=${server.port}` +
      `&state=${encodeURIComponent(state)}` +
      `&code_challenge=${encodeURIComponent(challenge)}`;

    process.stderr.write(`Opening ${loginUrl} in your browser.\n`);
    process.stderr.write("If your browser does not open, visit the URL above to continue.\n");

    let opened = true;
    try {
      await open(loginUrl);
    } catch {
      opened = false;
    }
    if (!opened) {
      // Couldn't launch a browser — fall back to manual paste.
      server.close();
      return runManualFlow(dashboardUrl);
    }

    process.stderr.write("Waiting for authorization...\n");
    const { code } = await server.result;

    const res = await fetch(`${dashboardUrl}/api/cli-login/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, codeVerifier: verifier, hostname: os.hostname() }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.error ?? `Token exchange failed (HTTP ${res.status}).`);
    }
    const data = (await res.json()) as FlowResult;
    return data;
  } finally {
    server.close();
  }
};

// Manual paste returns the api key but NO project metadata (the key alone
// carries none). When that happens, preserve a prior good projectId/projectName
// from an earlier browser login instead of clobbering them with empties — the
// freshly-minted key still belongs to that project. PKCE flow always supplies
// both, so this only ever merges in the manual fallback path.
const buildCredentials = (
  result: FlowResult,
  baseUrl: string,
  dashboardUrl: string,
  existing: Credentials | null,
): Credentials => ({
  version: 1,
  baseUrl,
  dashboardUrl,
  projectId: result.projectId || existing?.projectId || "",
  projectName: result.projectName || existing?.projectName || "",
  projectApiKey: result.apiKey,
  createdAt: new Date().toISOString(),
});

// `setup`: full zero-to-first-trace flow — login → write .env → write
// credentials → print summary.
export const handleSetup = async (opts: AuthCommandOptions): Promise<void> => {
  const dashboardUrl = resolveDashboardUrl(opts);
  const baseUrl = resolveBaseUrl(opts);

  let result: FlowResult;
  try {
    result = await runLoopbackFlow(opts);
  } catch (err) {
    if (opts.json) outputJsonError(err);
    logger.error(`Setup failed: ${errorMessage(err)}`);
    process.exit(EXIT_NOT_LOGGED_IN);
  }

  const existing = await readCredentials().catch(() => null);
  const creds = buildCredentials(result, baseUrl, dashboardUrl, existing);
  await writeCredentials(creds);

  const envPath = path.resolve(".env");
  try {
    await writeEnvFile(envPath, result.apiKey);
  } catch (err) {
    // Surface the key on stderr so the user isn't locked out if .env failed.
    process.stderr.write(`Failed to write ${envPath}: ${errorMessage(err)}\n`);
    process.stderr.write(`Your API key (set LMNR_PROJECT_API_KEY manually): ${result.apiKey}\n`);
    process.exit(EXIT_ENV_WRITE_FAILED);
  }

  const dashboardLink = creds.projectId
    ? `${dashboardUrl}/project/${creds.projectId}/traces`
    : dashboardUrl;
  if (opts.json) {
    outputJson({
      projectId: creds.projectId,
      projectName: creds.projectName,
      envPath,
      credentialsPath: credentialsPath(),
      dashboardUrl: dashboardLink,
    });
    return;
  }
  logger.info("Setup complete.");
  if (creds.projectName) logger.info(`Project: ${creds.projectName}`);
  logger.info(`Wrote LMNR_PROJECT_API_KEY to ${envPath}`);
  logger.info(`Credentials saved to ${credentialsPath()}`);
  logger.info(`Dashboard: ${dashboardLink}`);
};

// `login`: like setup but writes ONLY the credentials file (no .env).
export const handleAuthLogin = async (opts: AuthCommandOptions): Promise<void> => {
  const dashboardUrl = resolveDashboardUrl(opts);
  const baseUrl = resolveBaseUrl(opts);

  let result: FlowResult;
  try {
    result = await runLoopbackFlow(opts);
  } catch (err) {
    if (opts.json) outputJsonError(err);
    logger.error(`Login failed: ${errorMessage(err)}`);
    process.exit(EXIT_NOT_LOGGED_IN);
  }

  const existing = await readCredentials().catch(() => null);
  const creds = buildCredentials(result, baseUrl, dashboardUrl, existing);
  await writeCredentials(creds);

  if (opts.json) {
    outputJson({
      projectId: creds.projectId,
      projectName: creds.projectName,
      credentialsPath: credentialsPath(),
    });
    return;
  }
  logger.info("Logged in.");
  if (creds.projectName) logger.info(`Active project: ${creds.projectName}`);
  logger.info(`Credentials saved to ${credentialsPath()}.`);
};

export const handleAuthLogout = async (opts: AuthCommandOptions): Promise<void> => {
  const existed = await deleteCredentials();
  if (opts.json) {
    outputJson({ deleted: existed, path: credentialsPath() });
    return;
  }
  if (existed) {
    logger.info(`Removed credentials at ${credentialsPath()}.`);
  } else {
    logger.info("No credentials file to remove.");
  }
};

export const handleAuthStatus = async (opts: AuthCommandOptions): Promise<void> => {
  const creds = await readCredentials();
  if (!creds) {
    if (opts.json) {
      outputJson({ loggedIn: false });
    } else {
      logger.info("Not logged in. Run `lmnr-cli setup` to authorize the CLI.");
    }
    process.exit(EXIT_NOT_LOGGED_IN);
  }
  // Mask all but the leading/trailing 4 chars so `status --json` is safe
  // to include in bug reports.
  const masked =
    creds.projectApiKey.length > 8
      ? `${creds.projectApiKey.slice(0, 4)}...${creds.projectApiKey.slice(-4)}`
      : "********";
  if (opts.json) {
    outputJson({
      loggedIn: true,
      userEmail: creds.userEmail,
      projectId: creds.projectId,
      projectName: creds.projectName,
      baseUrl: creds.baseUrl,
      dashboardUrl: creds.dashboardUrl,
      projectApiKeyShorthand: masked,
      credentialsPath: credentialsPath(),
      createdAt: creds.createdAt,
    });
    return;
  }
  logger.info(`Logged in${creds.userEmail ? ` as ${creds.userEmail}` : ""}.`);
  if (creds.projectName) logger.info(`Active project: ${creds.projectName}`);
  logger.info(`Base URL: ${creds.baseUrl}`);
  logger.info(`Credentials: ${credentialsPath()}`);
  logger.info(`API key shorthand: ${masked}`);
};
