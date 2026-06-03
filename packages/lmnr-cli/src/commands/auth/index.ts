import { errorMessage } from "@lmnr-ai/types";
import { randomUUID } from "crypto";
import open from "open";
import os from "os";

import { version as cliVersion } from "../../../package.json";
import { initializeLogger } from "../../utils/logger";
import { outputJson, outputJsonError } from "../../utils/output";
import {
  Credentials,
  credentialsPath,
  deleteCredentials,
  readCredentials,
  writeCredentials,
} from "./credentials";
import { b64url, decryptBox, generateKeyPair } from "./crypto";

const logger = initializeLogger();

// Defaults. CI / private deployments override via --dashboard-url / --base-url
// or LMNR_DASHBOARD_URL / LMNR_BASE_URL.
const DEFAULT_DASHBOARD_URL = "https://www.laminar.sh";
const DEFAULT_BASE_URL = "https://api.lmnr.ai";

const POLL_INTERVAL_MS = 2000;
const POLL_MAX_ATTEMPTS = 150; // 5 minutes wall-clock.

// Exit codes — keep stable, callers (scripts / CI) compare numerically.
export const EXIT_GENERIC = 1;
export const EXIT_INVALID_ARGS = 2;
export const EXIT_EXPIRED = 3;
export const EXIT_ALREADY_CLAIMED = 4;
export const EXIT_TIMED_OUT = 5;
export const EXIT_NOT_LOGGED_IN = 6;

export interface AuthCommandOptions {
  dashboardUrl?: string;
  baseUrl?: string;
  port?: number;
  json?: boolean;
}

const resolveDashboardUrl = (opts: AuthCommandOptions): string => {
  const url =
    opts.dashboardUrl ?? process.env.LMNR_DASHBOARD_URL ?? DEFAULT_DASHBOARD_URL;
  // Strip trailing slash so URL concatenation is consistent.
  return url.replace(/\/+$/, "");
};

const resolveBaseUrl = (opts: AuthCommandOptions): string => {
  const url = opts.baseUrl ?? process.env.LMNR_BASE_URL ?? DEFAULT_BASE_URL;
  return url.replace(/\/+$/, "");
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

interface GrantPollResult {
  status: "pending" | "approved" | "expired" | "already_claimed";
  encrypted?: string;
  nonce?: string;
  ephemeralPublicKey?: string;
}

interface DecryptedPayload {
  projectApiKey: string;
  projectId: string;
  projectName: string;
  workspaceId: string;
  workspaceName: string;
  userEmail: string;
  createdAt: string;
}

export const handleAuthLogin = async (
  opts: AuthCommandOptions,
): Promise<void> => {
  const dashboardUrl = resolveDashboardUrl(opts);
  const baseUrl = resolveBaseUrl(opts);

  const keypair = generateKeyPair();
  const publicKey = b64url.encode(keypair.publicKey);

  let sessionId: string;
  try {
    const res = await fetch(`${dashboardUrl}/api/cli/grants`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        publicKey,
        clientInfo: {
          hostname: os.hostname(),
          platform: process.platform,
          cliVersion,
        },
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Failed to create CLI grant (HTTP ${res.status}): ${body}`);
    }
    const data = (await res.json()) as { sessionId: string };
    sessionId = data.sessionId ?? randomUUID();
  } catch (err) {
    if (opts.json) outputJsonError(err);
    logger.error(`Failed to start CLI login: ${errorMessage(err)}`);
    process.exit(EXIT_GENERIC);
  }

  const loginUrl =
    `${dashboardUrl}/cli-login?session_id=${encodeURIComponent(sessionId)}` +
    `&public_key=${encodeURIComponent(publicKey)}`;

  // URL printed to STDERR so stdout stays clean for the `auth status` JSON pipe-out later.
  process.stderr.write(`Opening ${loginUrl} in your browser.\n`);
  process.stderr.write(
    `If your browser does not open, visit the URL above to continue.\n`,
  );

  try {
    await open(loginUrl);
  } catch {
    // open() can fail on headless machines; we still print the URL above.
  }

  process.stderr.write("Waiting for approval...\n");

  let decrypted: DecryptedPayload | null = null;
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    let poll: GrantPollResult;
    try {
      const res = await fetch(
        `${dashboardUrl}/api/cli/grants/${encodeURIComponent(sessionId)}`,
      );
      if (res.status === 404) {
        if (opts.json) outputJsonError(new Error("Grant disappeared"));
        logger.error(
          "CLI grant disappeared on the server. Run `lmnr-cli auth login` again.",
        );
        process.exit(EXIT_GENERIC);
      }
      if (!res.ok) {
        throw new Error(`Poll failed: HTTP ${res.status}`);
      }
      poll = (await res.json()) as GrantPollResult;
    } catch (err) {
      // Transient network blips: log on first failure, continue polling.
      if (attempt === 0) {
        logger.warn(`Poll error: ${errorMessage(err)} (continuing).`);
      }
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    if (poll.status === "pending") {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    if (poll.status === "expired") {
      if (opts.json) outputJsonError(new Error("Grant expired"));
      logger.error("Grant expired. Run `lmnr-cli auth login` again.");
      process.exit(EXIT_EXPIRED);
    }
    if (poll.status === "already_claimed") {
      if (opts.json) outputJsonError(new Error("Already claimed"));
      logger.error(
        "This session was already claimed by another CLI process. Run `lmnr-cli auth login` again.",
      );
      process.exit(EXIT_ALREADY_CLAIMED);
    }
    if (poll.status === "approved") {
      if (!poll.encrypted || !poll.nonce || !poll.ephemeralPublicKey) {
        if (opts.json) outputJsonError(new Error("Malformed approved payload"));
        logger.error(
          "Grant approved but the encrypted payload is missing. Run `lmnr-cli auth login` again.",
        );
        process.exit(EXIT_GENERIC);
      }
      const plaintext = decryptBox(
        b64url.decode(poll.encrypted),
        b64url.decode(poll.nonce),
        b64url.decode(poll.ephemeralPublicKey),
        keypair.secretKey,
      );
      if (!plaintext) {
        if (opts.json) outputJsonError(new Error("Decryption failed"));
        logger.error(
          "Failed to decrypt approval payload. Run `lmnr-cli auth login` again.",
        );
        process.exit(EXIT_GENERIC);
      }
      try {
        decrypted = JSON.parse(
          Buffer.from(plaintext).toString("utf-8"),
        ) as DecryptedPayload;
      } catch (err) {
        if (opts.json) outputJsonError(err);
        logger.error(`Malformed decrypted payload: ${errorMessage(err)}`);
        process.exit(EXIT_GENERIC);
      }
      break;
    }
  }

  if (!decrypted) {
    if (opts.json) outputJsonError(new Error("Timed out waiting for approval"));
    logger.error(
      "Timed out waiting for approval. Run `lmnr-cli auth login` again.",
    );
    process.exit(EXIT_TIMED_OUT);
  }

  const creds: Credentials = {
    version: 1,
    baseUrl,
    dashboardUrl,
    projectId: decrypted.projectId,
    projectName: decrypted.projectName,
    workspaceId: decrypted.workspaceId,
    workspaceName: decrypted.workspaceName,
    userEmail: decrypted.userEmail,
    projectApiKey: decrypted.projectApiKey,
    createdAt: decrypted.createdAt,
  };

  await writeCredentials(creds);

  if (opts.json) {
    outputJson({
      userEmail: creds.userEmail,
      projectId: creds.projectId,
      projectName: creds.projectName,
      workspaceId: creds.workspaceId,
      workspaceName: creds.workspaceName,
      credentialsPath: credentialsPath(),
    });
    return;
  }

  logger.info(`Logged in as ${creds.userEmail}.`);
  logger.info(
    `Active project: ${creds.projectName} (workspace: ${creds.workspaceName}).`,
  );
  logger.info(`Credentials saved to ${credentialsPath()}.`);
};

export const handleAuthLogout = async (
  opts: AuthCommandOptions,
): Promise<void> => {
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

export const handleAuthStatus = async (
  opts: AuthCommandOptions,
): Promise<void> => {
  const creds = await readCredentials();
  if (!creds) {
    if (opts.json) {
      outputJson({ loggedIn: false });
    } else {
      logger.info("Not logged in. Run `lmnr-cli auth login` to authorize the CLI.");
    }
    process.exit(EXIT_NOT_LOGGED_IN);
  }
  // Mask all but the trailing 4 chars of the API key so `auth status --json`
  // is safe to include in bug reports.
  const masked =
    creds.projectApiKey.length > 8
      ? `${"*".repeat(creds.projectApiKey.length - 4)}${creds.projectApiKey.slice(-4)}`
      : "********";
  if (opts.json) {
    outputJson({
      loggedIn: true,
      userEmail: creds.userEmail,
      projectId: creds.projectId,
      projectName: creds.projectName,
      workspaceId: creds.workspaceId,
      workspaceName: creds.workspaceName,
      baseUrl: creds.baseUrl,
      dashboardUrl: creds.dashboardUrl,
      projectApiKeyShorthand: masked,
      credentialsPath: credentialsPath(),
      createdAt: creds.createdAt,
    });
    return;
  }
  logger.info(`Logged in as ${creds.userEmail}.`);
  logger.info(
    `Active project: ${creds.projectName} (workspace: ${creds.workspaceName}).`,
  );
  logger.info(`Base URL: ${creds.baseUrl}`);
  logger.info(`Credentials: ${credentialsPath()}`);
  logger.info(`API key shorthand: ${masked}`);
};
