import { readCredentials } from "../../auth/credentials";
import { refreshIfNeeded } from "../../auth/resolve";
import type { GlobalOpts } from "../../auth/with-client";
import { DEFAULT_FRONTEND_URL } from "../../constants";
import { readLocalProjectFile } from "../../utils/local-project-file";
import { initializeLogger } from "../../utils/logger";
import { outputJson } from "../../utils/output";
import {
  parseSampleRate,
  parseStructuredOutput,
  parseTrigger,
  validateName,
  validatePrompt,
} from "./validate";

const logger = initializeLogger();

type SignalCreateOpts = GlobalOpts & {
  schema: string;
  prompt: string;
  trigger?: string[];
  /** commander's `--no-default-trigger` sets this to false; absent flag → true. */
  defaultTrigger?: boolean;
  sampleRate?: string;
  disabled?: boolean;
  frontendUrl?: string;
};

interface CreatedSignal {
  id: string;
  projectId: string;
  name: string;
  prompt: string;
  structuredOutput: Record<string, unknown>;
  sampleRate: number | null;
  disabled: boolean;
  createdAt: string;
  triggers: { id: string; filters: unknown[]; mode: number }[];
}

const trimTrailingSlashes = (url: string): string => url.replace(/\/+$/, "");

/**
 * `lmnr-cli signal create <name>` — create a Signal with a validated payload
 * schema and trigger filters.
 *
 * Signal creation lives in the Laminar frontend (Next.js) — the same
 * transaction that auto-creates the signal's alert — so this command POSTs
 * `/api/cli/signals` on the FRONTEND (issuer) with the BetterAuth session
 * token as bearer, exactly like the api-key mint in `setup`. This is unlike
 * `sql`/`dataset`, which hit the app-server `/v1/cli/*` twins with the JWT.
 *
 * All payload-schema and trigger constraints the UI drawer imposes are
 * validated locally first (see ./validate.ts) so agents get fast, actionable
 * errors before any network call.
 */
export const handleSignalCreate = async (name: string, opts: SignalCreateOpts): Promise<void> => {
  const validatedName = validateName(name);
  const prompt = validatePrompt(opts.prompt);
  const structuredOutput = parseStructuredOutput(opts.schema);
  const explicitTriggers = opts.trigger ?? [];
  if (opts.defaultTrigger === false && explicitTriggers.length > 0) {
    throw new Error("--no-default-trigger cannot be combined with --trigger");
  }
  // undefined → the server seeds the UI's default trigger; [] → no triggers.
  const triggers =
    opts.defaultTrigger === false
      ? []
      : explicitTriggers.length > 0
        ? explicitTriggers.map(parseTrigger)
        : undefined;
  const sampleRate = opts.sampleRate !== undefined ? parseSampleRate(opts.sampleRate) : undefined;

  const creds = await readCredentials();
  if (!creds) {
    throw new Error("Not authenticated. Run `lmnr-cli login`.");
  }
  // The endpoint is session-bearer authed; refresh keeps the stored session
  // usable and surfaces a clear "run login" error when it expired.
  await refreshIfNeeded(creds);

  let projectId = opts.projectId;
  if (!projectId || projectId.length === 0) {
    projectId = (await readLocalProjectFile())?.projectId;
  }
  if (!projectId || projectId.length === 0) {
    throw new Error(
      "No project for this directory. Run `lmnr-cli setup` here, or pass --project-id <id>.",
    );
  }

  // The frontend (issuer) URL — same resolution as login: flag → env → the
  // issuer stored at login → cloud default.
  const issuer =
    opts.frontendUrl?.trim() ||
    process.env.LMNR_FRONTEND_URL?.trim() ||
    creds.issuer ||
    DEFAULT_FRONTEND_URL;

  const res = await fetch(`${trimTrailingSlashes(issuer)}/api/cli/signals`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${creds.sessionToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      projectId,
      name: validatedName,
      prompt,
      structuredOutput,
      ...(triggers !== undefined ? { triggers } : {}),
      ...(sampleRate !== undefined ? { sampleRate } : {}),
      ...(opts.disabled ? { disabled: true } : {}),
    }),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (res.status === 401) {
      throw new Error("Session expired — run `lmnr-cli login`.");
    }
    throw new Error(body.error ?? `signal create failed (HTTP ${res.status})`);
  }

  const signal = (await res.json()) as CreatedSignal;

  if (opts.json) {
    outputJson(signal);
    return;
  }

  logger.info(
    `Created signal "${signal.name}" (${signal.id}) with ${signal.triggers.length} trigger(s).`,
  );
  process.stdout.write(`${signal.id}\n`);
};
