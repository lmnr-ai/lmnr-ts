import {
  type Alert,
  type AlertSeverity,
  type AlertType,
  type SignalFilter,
} from "@lmnr-ai/types";

import { BaseResource, type LaminarAuth } from ".";

export interface CreateAlertOptions {
  signalId: string;
  /** Defaults to `"<signal name> alert"`. */
  name?: string;
  /** Defaults to `SIGNAL_EVENT`. */
  type?: AlertType;
  /** `SIGNAL_EVENT` only. Defaults to `["critical"]`. */
  severities?: AlertSeverity[];
  skipSimilar?: boolean;
  disabled?: boolean;
  /** Send the alert to the caller's email. Defaults to true. */
  notifyMe?: boolean;
  /** Channel ids or names (`#name`) in the workspace's connected Slack. */
  slackChannels?: string[];
  /** Conditions in a group are ANDed, groups are ORed. */
  filters?: SignalFilter[][];
}

/**
 * A partial patch: omitted fields keep their stored value. `slackChannels` and
 * `filters` replace the whole list (`[]` clears it). The type and signal can't
 * change.
 */
export type UpdateAlertOptions = Partial<
  Omit<CreateAlertOptions, "signalId" | "type">
>;

/**
 * Alert CRUD over the CLI user-token surface (`/v1/cli/alerts`). Validation is
 * server-side and its error messages come back user-ready.
 */
export class AlertsResource extends BaseResource {
  constructor(baseHttpUrl: string, auth: LaminarAuth) {
    super(baseHttpUrl, auth);
  }

  /**
   * Errors come back as `{error: string}` with user-facing text, so unwrap the
   * envelope before raising rather than showing the raw JSON body.
   */
  private async raiseAlertError(response: Response): Promise<never> {
    const body = await response.text();
    let message = body;
    try {
      const parsed = JSON.parse(body) as { error?: unknown };
      if (typeof parsed?.error === "string" && parsed.error.length > 0) {
        message = parsed.error;
      }
    } catch {
      // Not JSON (proxy error page, body deserialize error) — use it as-is.
    }
    throw new Error(`${response.status} ${message}`);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const response = await fetch(
      `${this.baseHttpUrl}${this.apiPrefix}/alerts${path}`,
      {
        method,
        headers: this.headers(),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      },
    );
    if (!response.ok) {
      await this.raiseAlertError(response);
    }
    return response.json() as Promise<T>;
  }

  /** The project's alerts, oldest first, optionally for one signal. */
  public async list(signalId?: string): Promise<Alert[]> {
    const query =
      signalId !== undefined ? `?signalId=${encodeURIComponent(signalId)}` : "";
    const body = await this.request<{ alerts?: Alert[] }>("GET", query);
    return Array.isArray(body?.alerts) ? body.alerts : [];
  }

  public async get(alertId: string): Promise<Alert> {
    return this.request("GET", `/${alertId}`);
  }

  public async create(options: CreateAlertOptions): Promise<Alert> {
    return this.request("POST", "", options);
  }

  public async update(
    alertId: string,
    options: UpdateAlertOptions,
  ): Promise<Alert> {
    return this.request("PATCH", `/${alertId}`, options);
  }

  /** Deletes the alert with its targets and filters. */
  public async delete(alertId: string): Promise<{ id: string; deleted: true }> {
    return this.request("DELETE", `/${alertId}`);
  }
}
