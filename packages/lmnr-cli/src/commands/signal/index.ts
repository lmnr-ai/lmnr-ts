import type { LaminarClient } from "@lmnr-ai/client";
import type { Signal, SignalFilter, SignalTrigger } from "@lmnr-ai/types";

import type { GlobalOpts } from "../../auth/with-client";
import { initializeLogger } from "../../utils/logger";
import { outputJson } from "../../utils/output";
import { renderTable } from "../../utils/table";
import {
  parseFilter,
  parseMode,
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
  trigger?: string;
  spanName?: string[];
  filter?: string[];
  mode?: string;
  sampleRate?: string;
  disabled?: boolean;
};

type SignalUpdateOpts = GlobalOpts & {
  schema?: string;
  prompt?: string;
  trigger?: string;
  spanName?: string[];
  filter?: string[];
  /** commander's `--no-filters` sets this false; clears all filters. */
  filters?: boolean;
  mode?: string;
  sampleRate?: string;
  /** `--no-sampling` clears the stored rate. */
  sampling?: boolean;
  disabled?: boolean;
  /** commander's `--no-disabled` → `disabled: false`, i.e. re-enable. */
};

/** When the signal is evaluated, in the same words `--trigger` accepts. */
export const describeTrigger = (trigger: SignalTrigger | null): string => {
  if (trigger === null) return "none — runs only via backfill";
  if (trigger.type === "rootSpanFinished") return "root span finished";
  return `span name in [${trigger.spanNames.join(", ")}]`;
};

const OPERATOR_SYMBOLS: Record<string, string> = {
  eq: "=",
  ne: "!=",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
};

/** Render a filter back in the `--filter` syntax so output can be copy-pasted. */
export const describeFilter = (filter: SignalFilter): string => {
  const value = Array.isArray(filter.value) ? filter.value.join(", ") : String(filter.value);
  return `${filter.column} ${OPERATOR_SYMBOLS[filter.operator] ?? filter.operator} ${value}`;
};

const printSignal = (signal: Signal): void => {
  logger.info(`${signal.name} (${signal.id})`);
  logger.info(`  prompt:       ${signal.prompt}`);
  const fields = Object.keys(signal.structuredOutput?.properties ?? {}).join(", ");
  logger.info(`  fields:       ${fields}`);
  logger.info(`  trigger:      ${describeTrigger(signal.trigger)}`);
  logger.info(
    `  filters:      ${signal.filters.length === 0
      ? "none — runs on every trace it fires for"
      : signal.filters.map(describeFilter).join(" AND ")}`,
  );
  logger.info(`  mode:         ${signal.mode}`);
  logger.info(`  sample rate:  ${signal.sampleRate ?? "none"}`);
  logger.info(`  status:       ${signal.disabled ? "disabled" : "active"}`);
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
    describeTrigger(s.trigger),
    s.filters.length === 0 ? "-" : s.filters.map(describeFilter).join(" AND "),
    s.mode,
  ]);
  logger.info(
    renderTable(["ID", "Name", "Status", "Sample", "Trigger", "Filters", "Mode"], rows),
  );
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
  // undefined → the server applies its default (root span finished / >1000 tokens).
  const trigger = parseTrigger(opts.trigger, opts.spanName ?? []);

  const signal = await client.signals.create({
    name: validatedName,
    prompt,
    structuredOutput,
    ...(trigger !== undefined ? { trigger } : {}),
    ...(opts.filter !== undefined ? { filters: opts.filter.map(parseFilter) } : {}),
    ...(opts.mode !== undefined ? { mode: parseMode(opts.mode) } : {}),
    ...(opts.sampleRate !== undefined
      ? { sampleRate: parseSampleRate(opts.sampleRate) }
      : {}),
    ...(opts.disabled ? { disabled: true } : {}),
  });

  if (opts.json) {
    outputJson(signal);
    return;
  }
  logger.info(`Created signal "${signal.name}".`);
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
  if (opts.filter !== undefined && opts.filters === false) {
    throw new Error("--filter cannot be combined with --no-filters");
  }

  const trigger = parseTrigger(opts.trigger, opts.spanName ?? []);

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
    // `null` (from `--trigger none`) is a real value here, so check for absence.
    ...(trigger !== undefined ? { trigger } : {}),
    ...(opts.filter !== undefined ? { filters: opts.filter.map(parseFilter) } : {}),
    ...(opts.filters === false ? { filters: [] } : {}),
    ...(opts.mode !== undefined ? { mode: parseMode(opts.mode) } : {}),
  };

  if (Object.keys(patch).length === 0) {
    throw new Error(
      "Nothing to update. Pass at least one of --prompt, --schema, --trigger, " +
      "--filter, --no-filters, --mode, --sample-rate, --no-sampling, " +
      "--disabled, --no-disabled.",
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
