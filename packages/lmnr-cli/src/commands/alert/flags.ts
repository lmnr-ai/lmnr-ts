/**
 * Translate `alert create` / `alert update` flags into the wire body. Only flag
 * syntax is checked here; the rest (filter columns vs the signal's output
 * fields, clustering-only options, Slack channel lookup, email ownership) is the
 * server's (`alerts/mod.rs`), and its 400s are shown verbatim.
 */

import type { CreateAlertOptions, UpdateAlertOptions } from "@lmnr-ai/client";
import type { AlertSeverity, AlertType, SignalFilter } from "@lmnr-ai/types";

import { parseFilter } from "../signal/validate";

const SEVERITIES: AlertSeverity[] = ["info", "warning", "critical"];

const TYPES: Record<string, AlertType> = {
  "signal-event": "SIGNAL_EVENT",
  "new-cluster": "NEW_CLUSTER",
  SIGNAL_EVENT: "SIGNAL_EVENT",
  NEW_CLUSTER: "NEW_CLUSTER",
};

/** Flags shared by create and update. Negations come from commander's `--no-*`. */
export interface AlertShapeOpts {
  name?: string;
  severity?: string[];
  skipSimilar?: boolean;
  disabled?: boolean;
  notifyMe?: boolean;
  slackChannel?: string[];
  /** `--no-slack-channels` sets this false; clears every Slack target. */
  slackChannels?: boolean;
  filter?: string[];
  filterGroup?: string[];
  /** `--no-filters` sets this false; clears every filter group. */
  filters?: boolean;
}

export interface AlertCreateFlagOpts extends AlertShapeOpts {
  type?: string;
}

export const parseAlertType = (raw: string): AlertType => {
  const type = TYPES[raw];
  if (type === undefined) {
    throw new Error(`--type must be signal-event or new-cluster, got "${raw}"`);
  }
  return type;
};

export const parseSeverities = (raw: string[]): AlertSeverity[] => {
  const bad = raw.find((s) => !SEVERITIES.includes(s as AlertSeverity));
  if (bad !== undefined) {
    throw new Error(
      `--severity must be one of ${SEVERITIES.join(" | ")}, got "${bad}"`,
    );
  }
  return raw as AlertSeverity[];
};

/** `--filter-group '[{...}, {...}]'`: one OR-branch whose conditions are ANDed. */
export const parseFilterGroup = (raw: string): SignalFilter[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`--filter-group is not valid JSON: ${raw.slice(0, 200)}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(
      "--filter-group must be a non-empty JSON array of " +
        '{"column","operator","value"} conditions',
    );
  }
  return parsed.map((condition) => parseFilter(JSON.stringify(condition)));
};

/**
 * `--filter` conditions form one group (ANDed); each `--filter-group` adds an
 * OR-branch. `undefined` when no filter flag was passed, `[]` for `--no-filters`.
 */
export const buildFilterGroups = (
  opts: AlertShapeOpts,
): SignalFilter[][] | undefined => {
  const passed = opts.filter !== undefined || opts.filterGroup !== undefined;
  if (opts.filters === false) {
    if (passed) {
      throw new Error(
        "--filter / --filter-group cannot be combined with --no-filters",
      );
    }
    return [];
  }
  if (!passed) {
    return undefined;
  }
  return [
    ...(opts.filter !== undefined ? [opts.filter.map(parseFilter)] : []),
    ...(opts.filterGroup ?? []).map(parseFilterGroup),
  ];
};

const buildSlackChannels = (opts: AlertShapeOpts): string[] | undefined => {
  if (opts.slackChannels === false) {
    if (opts.slackChannel !== undefined) {
      throw new Error(
        "--slack-channel cannot be combined with --no-slack-channels",
      );
    }
    return [];
  }
  return opts.slackChannel;
};

const buildShape = (opts: AlertShapeOpts): UpdateAlertOptions => {
  const severities =
    opts.severity !== undefined ? parseSeverities(opts.severity) : undefined;
  const slackChannels = buildSlackChannels(opts);
  const filters = buildFilterGroups(opts);
  return {
    ...(opts.name !== undefined ? { name: opts.name } : {}),
    ...(severities !== undefined ? { severities } : {}),
    ...(opts.skipSimilar !== undefined
      ? { skipSimilar: opts.skipSimilar }
      : {}),
    ...(opts.disabled !== undefined ? { disabled: opts.disabled } : {}),
    ...(opts.notifyMe !== undefined ? { notifyMe: opts.notifyMe } : {}),
    ...(slackChannels !== undefined ? { slackChannels } : {}),
    ...(filters !== undefined ? { filters } : {}),
  };
};

/** Everything but `signalId`, which the caller resolves from a name or id. */
export const buildCreateAlert = (
  opts: AlertCreateFlagOpts,
): Omit<CreateAlertOptions, "signalId"> => ({
  ...(opts.type !== undefined ? { type: parseAlertType(opts.type) } : {}),
  ...buildShape(opts),
});

export const buildUpdateAlert = (opts: AlertShapeOpts): UpdateAlertOptions => {
  const patch = buildShape(opts);
  if (Object.keys(patch).length === 0) {
    throw new Error(
      "Nothing to update. Pass at least one of --name, --severity, " +
        "--[no-]skip-similar, --[no-]disabled, --[no-]notify-me, " +
        "--slack-channel, --no-slack-channels, --filter, --filter-group, " +
        "--no-filters.",
    );
  }
  return patch;
};
