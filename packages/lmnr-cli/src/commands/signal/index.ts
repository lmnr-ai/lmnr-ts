import type { LaminarClient, Signal, SignalTrigger } from "@lmnr-ai/client";

import type { GlobalOpts } from "../../auth/with-client";
import { initializeLogger } from "../../utils/logger";
import { outputJson } from "../../utils/output";
import { renderTable } from "../../utils/table";
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
  /** commander's `--no-default-trigger` sets this false; absent flag → undefined. */
  defaultTrigger?: boolean;
  sampleRate?: string;
  disabled?: boolean;
};

type SignalUpdateOpts = GlobalOpts & {
  schema?: string;
  prompt?: string;
  trigger?: string[];
  sampleRate?: string;
  /** `--no-sampling` clears the stored rate. */
  sampling?: boolean;
  disabled?: boolean;
  /** commander's `--no-disabled` → `disabled: false`, i.e. re-enable. */
};

/** One-line summary of a trigger for the human table. */
const describeTrigger = (trigger: SignalTrigger): string => {
  const fmt = (f: { column: string; operator: string; value: string | number | string[] }) => {
    const shown = Array.isArray(f.value) ? `[${f.value.join(", ")}]` : String(f.value);
    return `${f.column} ${f.operator} ${shown}`;
  };
  const when = trigger.conditions.map(fmt).join(" AND ") || "(never fires)";
  const unless =
    trigger.filters.length > 0 ? ` if ${trigger.filters.map(fmt).join(" AND ")}` : "";
  return `${when}${unless}`;
};

const printSignal = (signal: Signal): void => {
  logger.info(`${signal.name} (${signal.id})`);
  logger.info(`  prompt:       ${signal.prompt}`);
  const fields = Object.keys(signal.structuredOutput?.properties ?? {}).join(", ");
  logger.info(`  fields:       ${fields}`);
  logger.info(`  sample rate:  ${signal.sampleRate ?? "none"}`);
  logger.info(`  status:       ${signal.disabled ? "disabled" : "active"}`);
  if (signal.triggers.length === 0) {
    logger.info("  triggers:     none — this signal will never fire");
  } else {
    for (const trigger of signal.triggers) {
      logger.info(`  trigger:      ${describeTrigger(trigger)}`);
    }
  }
};

/**
 * Resolve a signal reference (id or name) to its id. Accepts a name so an agent
 * doesn't have to list first; an ambiguous substring is an error rather than a
 * silent pick, since update/delete are destructive.
 */
const resolveSignalId = async (client: LaminarClient, ref: string): Promise<string> => {
  // A uuid is unambiguous — use it directly and let the server 404.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref)) {
    return ref;
  }
  const matches = await client.signals.list(ref);
  const exact = matches.filter((s) => s.name === ref);
  const candidates = exact.length > 0 ? exact : matches;

  if (candidates.length === 0) {
    throw new Error(`No signal matching "${ref}" in this project.`);
  }
  if (candidates.length > 1) {
    throw new Error(
      `"${ref}" matches ${candidates.length} signals: ` +
      `${candidates.map((s) => `${s.name} (${s.id})`).join(", ")}. ` +
      "Pass the id instead.",
    );
  }
  return candidates[0].id;
};

/** `lmnr-cli signal list [name]` */
export const handleSignalList = async (
  client: LaminarClient,
  name: string | undefined,
  opts: GlobalOpts,
): Promise<void> => {
  const signals = await client.signals.list(name);

  if (opts.json) {
    outputJson(signals);
    return;
  }
  if (signals.length === 0) {
    logger.info("No signals found.");
    return;
  }

  const rows = signals.map((s) => [
    s.id,
    s.name,
    s.disabled ? "disabled" : "active",
    s.sampleRate === null ? "-" : `${s.sampleRate}%`,
    String(s.triggers.length),
  ]);
  logger.info(renderTable(["ID", "Name", "Status", "Sample", "Triggers"], rows));
};

/** `lmnr-cli signal get <signal>` */
export const handleSignalGet = async (
  client: LaminarClient,
  ref: string,
  opts: GlobalOpts,
): Promise<void> => {
  const signal = await client.signals.get(await resolveSignalId(client, ref));
  if (opts.json) {
    outputJson(signal);
    return;
  }
  printSignal(signal);
};

/** `lmnr-cli signal create <name>` */
export const handleSignalCreate = async (
  client: LaminarClient,
  name: string,
  opts: SignalCreateOpts,
): Promise<void> => {
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

  const signal = await client.signals.create({
    name: validatedName,
    prompt,
    structuredOutput,
    ...(triggers !== undefined ? { triggers } : {}),
    ...(opts.sampleRate !== undefined
      ? { sampleRate: parseSampleRate(opts.sampleRate) }
      : {}),
    ...(opts.disabled ? { disabled: true } : {}),
  });

  if (opts.json) {
    outputJson(signal);
    return;
  }
  logger.info(
    `Created signal "${signal.name}" with ${signal.triggers.length} trigger(s).`,
  );
  printSignal(signal);
};

/**
 * `lmnr-cli signal update <signal>` — partial patch: flags you don't pass leave
 * the stored value alone, so changing the prompt can't clear sampling or
 * re-enable a deactivated signal.
 */
export const handleSignalUpdate = async (
  client: LaminarClient,
  ref: string,
  opts: SignalUpdateOpts,
): Promise<void> => {
  if (opts.sampleRate !== undefined && opts.sampling === false) {
    throw new Error("--sample-rate cannot be combined with --no-sampling");
  }

  const patch = {
    ...(opts.prompt !== undefined ? { prompt: validatePrompt(opts.prompt) } : {}),
    ...(opts.schema !== undefined
      ? { structuredOutput: parseStructuredOutput(opts.schema) }
      : {}),
    ...(opts.sampleRate !== undefined
      ? { sampleRate: parseSampleRate(opts.sampleRate) }
      : {}),
    // Explicit null is what clears the stored rate server-side.
    ...(opts.sampling === false ? { sampleRate: null } : {}),
    ...(opts.disabled !== undefined ? { disabled: opts.disabled } : {}),
    ...(opts.trigger !== undefined && opts.trigger.length > 0
      ? { triggers: opts.trigger.map(parseTrigger) }
      : {}),
  };

  if (Object.keys(patch).length === 0) {
    throw new Error(
      "Nothing to update. Pass at least one of --prompt, --schema, --trigger, " +
      "--sample-rate, --no-sampling, --disabled, --no-disabled.",
    );
  }

  const signal = await client.signals.update(await resolveSignalId(client, ref), patch);

  if (opts.json) {
    outputJson(signal);
    return;
  }
  logger.info(`Updated signal "${signal.name}".`);
  printSignal(signal);
};

/** `lmnr-cli signal delete <signal>` */
export const handleSignalDelete = async (
  client: LaminarClient,
  ref: string,
  opts: GlobalOpts,
): Promise<void> => {
  const signal = await client.signals.delete(await resolveSignalId(client, ref));

  if (opts.json) {
    outputJson(signal);
    return;
  }
  logger.info(
    `Deleted signal "${signal.name}" (${signal.id}), its triggers, alerts, and events.`,
  );
};
