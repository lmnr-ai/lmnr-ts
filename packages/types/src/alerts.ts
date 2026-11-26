import type { SignalFilter } from "./signals";

/**
 * `SIGNAL_EVENT` fires per extracted event; `NEW_CLUSTER` when events form a new
 * cluster; `METRIC` checks a number (cost, tokens, traffic, error rate,
 * latency) on a schedule.
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
  | "error_rate"
  | "latency_p50"
  | "latency_p95";

/**
 * What a threshold is compared with: the value itself, the value as a percent
 * of the same window shifted back by `compareTo`, month-to-date spend against a
 * budget, or one trace's cost as a percent of the project's p99 trace cost.
 */
export type MetricAlertCondition =
  | { type: "value" }
  | { type: "change"; compareTo: "5m" | "15m" | "1h" | "1d" | "1w" | "30d" }
  | { type: "budget"; amount: number }
  | { type: "trace_p99" };

/** The rule of a `METRIC` alert. The server validates it and owns the defaults. */
export interface MetricAlertRule {
  metric: MetricAlertMetric;
  /** Trace filters, the same `{column, operator, value}` the traces table uses. */
  filters: { column: string; operator: string; value: unknown }[];
  /** `model` keeps separate state and incidents per model. */
  groupBy?: "model" | null;
  /** Budgets use `{ monthToDate: true }`; `minutes` is 5, 15, 60 or 1440. */
  window: { minutes: number } | { monthToDate: true };
  condition: MetricAlertCondition;
  direction: "above" | "below";
  /** At least one of `warning` / `critical`, except for budgets (neither). */
  warning?: number | null;
  critical?: number | null;
  /** The value at which an open incident closes. */
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
