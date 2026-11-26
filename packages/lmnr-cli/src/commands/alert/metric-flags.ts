/**
 * Translate `alert metric create` / `alert metric update` flags into the wire
 * body, and describe a stored rule in one line. Only flag syntax is checked
 * here: the rule itself is validated by the server, the same check the UI form
 * runs, and its 400s are shown verbatim.
 */

import type {
  CreateMetricAlertOptions,
  UpdateAlertOptions,
} from "@lmnr-ai/client";
import type { MetricAlertRule } from "@lmnr-ai/types";

/** Negations come from commander's `--no-*`. */
export interface MetricAlertFlagOpts {
  name?: string;
  template?: string;
  rule?: string;
  disabled?: boolean;
  notifyMe?: boolean;
  slackChannel?: string[];
  /** `--no-slack-channels` sets this false; clears every Slack target. */
  slackChannels?: boolean;
}

/** `--rule '{...}'`: rule keys, merged over the template or the stored rule. */
export const parseRule = (raw: string): Partial<MetricAlertRule> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`--rule is not valid JSON: ${raw.slice(0, 200)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      '--rule must be a JSON object like {"metric":"total_cost","warning":50}',
    );
  }
  return parsed as Partial<MetricAlertRule>;
};

const buildSlackChannels = (
  opts: MetricAlertFlagOpts,
): string[] | undefined => {
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

const buildShape = (opts: MetricAlertFlagOpts): UpdateAlertOptions => {
  const slackChannels = buildSlackChannels(opts);
  return {
    ...(opts.name !== undefined ? { name: opts.name } : {}),
    ...(opts.rule !== undefined ? { rule: parseRule(opts.rule) } : {}),
    ...(opts.disabled !== undefined ? { disabled: opts.disabled } : {}),
    ...(opts.notifyMe !== undefined ? { notifyMe: opts.notifyMe } : {}),
    ...(slackChannels !== undefined ? { slackChannels } : {}),
  };
};

export const buildCreateMetricAlert = (
  opts: MetricAlertFlagOpts,
): CreateMetricAlertOptions => {
  if (opts.template === undefined && opts.rule === undefined) {
    throw new Error("Pass --template, --rule, or both.");
  }
  return {
    type: "METRIC",
    ...(opts.template !== undefined ? { template: opts.template } : {}),
    ...buildShape(opts),
  };
};

export const buildUpdateMetricAlert = (
  opts: MetricAlertFlagOpts,
): UpdateAlertOptions => {
  const patch = buildShape(opts);
  if (Object.keys(patch).length === 0) {
    throw new Error(
      "Nothing to update. Pass at least one of --name, --rule, " +
        "--[no-]disabled, --[no-]notify-me, --slack-channel, " +
        "--no-slack-channels.",
    );
  }
  return patch;
};

/** The server's default for a spending limit stored without `warnAtPercent`. */
const DEFAULT_WARN_AT_PERCENT = 80;

const describeWindow = (window: MetricAlertRule["window"]): string => {
  if ("monthToDate" in window) {
    return "month to date";
  }
  const { minutes } = window;
  if (minutes % 1440 === 0) {
    return `${minutes / 1440}d`;
  }
  return minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
};

const describeCondition = (rule: MetricAlertRule): string => {
  const { condition } = rule;
  if (condition.type === "spending_limit") {
    const warnAt = condition.warnAtPercent ?? DEFAULT_WARN_AT_PERCENT;
    return `limit ${condition.limit}, warn at ${warnAt}%`;
  }
  const unit =
    condition.type === "change"
      ? `% of ${condition.compareTo} earlier`
      : condition.type === "trace_p99"
        ? "% of p99"
        : "";
  const thresholds = [
    rule.warning != null ? `warning ${rule.warning}${unit}` : null,
    rule.critical != null ? `critical ${rule.critical}${unit}` : null,
  ].filter((t) => t !== null);
  // A rule the server no longer accepts still has to be listed, so it can be deleted.
  if (thresholds.length === 0) {
    return `${condition.type} (no thresholds)`;
  }
  return `${rule.direction} ${thresholds.join(", ")}`;
};

/** `total_cost by model over 1h, above warning 130% of 1w earlier` */
export const describeRule = (rule: MetricAlertRule): string =>
  `${rule.metric}${rule.groupBy ? ` by ${rule.groupBy}` : ""} over ` +
  `${describeWindow(rule.window)}, ${describeCondition(rule)}`;

export const ruleStatus = (rule: MetricAlertRule, now = new Date()): string => {
  if (rule.disabled) {
    return "muted";
  }
  if (rule.snoozedUntil && new Date(rule.snoozedUntil) > now) {
    return `snoozed until ${rule.snoozedUntil}`;
  }
  return "active";
};
