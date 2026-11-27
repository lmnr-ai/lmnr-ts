import type { SignalFilter } from "./signals";

/**
 * `SIGNAL_EVENT` fires per extracted event; `NEW_CLUSTER` when events form a new
 * cluster; `METRIC` checks a number (cost, tokens, traffic, errors, latency)
 * on a schedule.
 */
export type AlertType = "SIGNAL_EVENT" | "NEW_CLUSTER" | "METRIC";

export type AlertSeverity = "info" | "warning" | "critical";

export interface AlertSlackChannel {
  channelId: string;
  channelName: string | null;
}

export type MetricAlertMetric =
  | "total_cost"
  | "cost_per_trace"
  | "trace_cost"
  | "input_tokens"
  | "output_tokens"
  | "total_tokens"
  | "tokens_per_trace"
  | "trace_count"
  | "error_traces"
  | "error_rate"
  | "no_cost_rate"
  | "no_tokens_rate"
  | "llm_no_cost_rate"
  | "llm_no_tokens_rate"
  | "latency_p50"
  | "latency_p95";

/**
 * What a threshold is compared with: the value itself, the value as a percent
 * of the same window shifted back by `compareTo`, spend against a limit
 * (warning at `warnAtPercent` of it, 80 by default, and critical at the limit),
 * or one trace's cost as a percent of the project's p99 trace cost.
 */
export type MetricAlertCondition =
  | { type: "value" }
  | {
      type: "change";
      compareTo: "5m" | "15m" | "30m" | "1h" | "1d" | "1w" | "30d";
    }
  | { type: "spending_limit"; limit: number; warnAtPercent?: number }
  | { type: "trace_p99" };

/** The rule of a `METRIC` alert. The server validates it and owns the defaults. */
export interface MetricAlertRule {
  metric: MetricAlertMetric;
  /** Trace filters, the same `{column, operator, value}` the traces table uses. */
  filters: { column: string; operator: string; value: unknown }[];
  /** `model` keeps separate state and incidents per model. */
  groupBy?: "model" | null;
  /**
   * `minutes` is 5, 15, 30, 60 or 1440. A spending limit covers the last day
   * (`{ minutes: 1440 }`) or the month so far (`{ monthToDate: true }`).
   */
  window: { minutes: number } | { monthToDate: true };
  condition: MetricAlertCondition;
  direction: "above" | "below";
  /** At least one of `warning` / `critical`, except for a spending limit (neither). */
  warning?: number | null;
  critical?: number | null;
  /** Where an open incident closes. Unset, it follows the first threshold. */
  resolve?: number | null;
  /** `change` only: smallest absolute difference that still counts. */
  minChange?: number | null;
  checksInARow: number;
  minTraces?: number | null;
  onNoData?: "skip" | "zero" | "alert" | null;
  /** ISO timestamp; no messages are sent until then. */
  snoozedUntil?: string | null;
  disabled?: boolean;
}

export interface Alert {
  id: string;
  name: string;
  type: AlertType;
  /** `null` for a `METRIC` alert, which watches no signal. */
  signalId: string | null;
  /** `null` when the signal no longer exists, and for a `METRIC` alert. */
  signalName: string | null;
  /** Severities that fire a `SIGNAL_EVENT` alert; empty for `NEW_CLUSTER`. */
  severities: AlertSeverity[];
  skipSimilar: boolean;
  disabled: boolean;
  /** Whether the caller's email is a target. Other members' emails are never returned. */
  notifyMe: boolean;
  slackChannels: AlertSlackChannel[];
  /**
   * Filter groups over the signal's output fields: conditions in a group are
   * ANDed, groups are ORed. Empty = fire on every matching event.
   */
  filters: SignalFilter[][];
  /**
   * The rule of a `METRIC` alert; `null` for the signal alert types, and
   * absent from a server that has no metric alerts.
   */
  rule?: MetricAlertRule | null;
  createdAt: string;
}
