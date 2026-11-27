import type { SignalFilter } from "./signals";

/**
 * `SIGNAL_EVENT` fires per extracted event; `NEW_CLUSTER` when events form a new
 * cluster; `METRIC` checks a number (cost, tokens, traffic, LLM errors and
 * latency) on a schedule.
 */
export type AlertType = "SIGNAL_EVENT" | "NEW_CLUSTER" | "METRIC";

export type AlertSeverity = "info" | "warning" | "critical";

export interface AlertSlackChannel {
  channelId: string;
  channelName: string | null;
}

/**
 * Every metric is read from spans. `span_count` counts spans of any type; the
 * `llm_*` metrics count LLM calls. Rates are a percent of LLM calls, latencies
 * are the duration of one LLM call in seconds.
 */
export type MetricAlertMetric =
  | "span_count"
  | "total_cost"
  | "input_tokens"
  | "output_tokens"
  | "total_tokens"
  | "llm_calls"
  | "llm_errors"
  | "llm_error_rate"
  | "llm_no_cost_rate"
  | "llm_no_tokens_rate"
  | "llm_latency_p50"
  | "llm_latency_p95";

/**
 * What a threshold is compared with: the value itself, or the value as a
 * percent of the same window shifted back by `compareTo`.
 */
export type MetricAlertCondition =
  | { type: "value" }
  | {
      type: "change";
      compareTo: "5m" | "15m" | "30m" | "1h" | "1d" | "1w" | "30d";
    };

/** The rule of a `METRIC` alert. The server validates it and owns the defaults. */
export interface MetricAlertRule {
  metric: MetricAlertMetric;
  /**
   * `model` keeps separate state and incidents per model. Every metric except
   * `span_count` can be split.
   */
  groupBy?: "model" | null;
  /** `minutes` is 5, 15, 30, 60 or 1440. */
  window: { minutes: number };
  condition: MetricAlertCondition;
  direction: "above" | "below";
  /** At least one of `warning` / `critical`. */
  warning?: number | null;
  critical?: number | null;
  /** Where an open incident closes. Unset, it follows the first threshold. */
  resolve?: number | null;
  /** `change` only: smallest absolute difference that still counts. */
  minChange?: number | null;
  checksInARow: number;
  /** LLM calls a window needs before a rate or a latency is checked. */
  minCalls?: number | null;
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
