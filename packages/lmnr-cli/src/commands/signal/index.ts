import { resolveAuth } from "../../auth/resolve";
import type { GlobalOpts } from "../../auth/with-client";
import { DEFAULT_BASE_URL } from "../../constants";
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
};

/** Compose the app-server URL from a port-less base URL + optional port. */
const buildAppServerUrl = (baseUrl: string, port: number | undefined, path: string): string => {
  const url = new URL(baseUrl);
  if (port !== undefined) url.port = String(port);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${path}`;
  return url.toString();
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

/**
 * `lmnr-cli signal create <name>` — create a Signal with a validated payload
 * schema and trigger filters.
 *
 * Signal creation is owned by the app-server (shared with the browser drawer),
 * so this command POSTs `/v1/cli/signals` on the APP-SERVER with the user JWT as
 * bearer and the resolved project in `x-lmnr-project-id` — exactly like `sql` /
 * `dataset`. `resolveAuth` handles JWT refresh + project resolution (flag →
 * linked `.lmnr/project.json`).
 *
 * All payload-schema and trigger constraints the UI drawer imposes are
 * validated locally first (see ./validate.ts) so agents get fast, actionable
 * errors before any network call. The app-server re-validates the same rules.
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

  // Resolves the user JWT (auto-refreshed) + the target project, or throws a
  // clear "run login" / "no project" error.
  const auth = await resolveAuth({
    projectId: opts.projectId,
    baseUrl: opts.baseUrl,
    port: opts.port,
  });

  const url = buildAppServerUrl(auth.baseUrl ?? DEFAULT_BASE_URL, auth.port, "/v1/cli/signals");
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${auth.bearer}`,
      "x-lmnr-project-id": auth.projectId,
      "content-type": "application/json",
    },
    body: JSON.stringify({
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
