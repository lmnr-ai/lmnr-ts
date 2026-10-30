import type { SignalFilter } from "./signals";

/** `SIGNAL_EVENT` fires per extracted event; `NEW_CLUSTER` when events form a new cluster. */
export type AlertType = "SIGNAL_EVENT" | "NEW_CLUSTER";

export type AlertSeverity = "info" | "warning" | "critical";

export interface AlertSlackChannel {
  channelId: string;
  channelName: string | null;
}

export interface Alert {
  id: string;
  name: string;
  type: AlertType;
  signalId: string;
  /** `null` when the signal no longer exists. */
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
  createdAt: string;
}
