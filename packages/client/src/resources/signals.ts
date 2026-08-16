import {
  type Signal,
  type SignalFilter,
  type SignalMode,
  type SignalStructuredOutput,
  type SignalTrigger,
} from "@lmnr-ai/types";

import { BaseResource, type LaminarAuth } from ".";

export interface CreateSignalOptions {
  name: string;
  prompt: string;
  structuredOutput: SignalStructuredOutput;
  sampleRate?: number;
  disabled?: boolean;
  /** Omit for the default (root span finished); `null` never fires on its own. */
  trigger?: SignalTrigger | null;
  /** Omit for the default (>1000 tokens); `[]` runs on every firing trace. */
  filters?: SignalFilter[];
  /** Defaults to `"batch"`. */
  mode?: SignalMode;
}

/**
 * A partial patch. Every field is optional and an ABSENT field leaves the stored
 * value alone — so updating the prompt can't clear sampling, re-enable a
 * deactivated signal, or change when the signal fires. `sampleRate: null`
 * explicitly clears sampling, `trigger: null` stops the signal firing on its
 * own, and `filters: []` clears its filters.
 */
export interface UpdateSignalOptions {
  prompt?: string;
  structuredOutput?: SignalStructuredOutput;
  sampleRate?: number | null;
  disabled?: boolean;
  trigger?: SignalTrigger | null;
  filters?: SignalFilter[];
  mode?: SignalMode;
}

/** Signals CRUD over the CLI user-token surface (`/v1/cli/signals`). */
export class SignalsResource extends BaseResource {
  constructor(baseHttpUrl: string, auth: LaminarAuth) {
    super(baseHttpUrl, auth);
  }

  /**
   * Every signal route answers errors as `{ error: "<message>" }`, and those
   * messages are written to be shown to the user verbatim (e.g. "A signal named
   * X already exists in this project"). The shared `handleError` would surface
   * the raw JSON body, so unwrap the envelope here and fall back to it when the
   * body isn't the expected shape.
   */
  private async raiseSignalError(response: Response): Promise<never> {
    const body = await response.text();
    let message = body;
    try {
      const parsed = JSON.parse(body) as { error?: unknown };
      if (typeof parsed?.error === "string" && parsed.error.length > 0) {
        message = parsed.error;
      }
    } catch {
      // Not JSON (a proxy error page, an actix plain-text 413) — use it as-is.
    }
    throw new Error(`${response.status} ${message}`);
  }

  public async list(name?: string): Promise<Signal[]> {
    const query = name ? `?${new URLSearchParams({ name }).toString()}` : "";
    const response = await fetch(`${this.baseHttpUrl}${this.apiPrefix}/signals${query}`, {
      method: "GET",
      headers: this.headers(),
    });
    if (!response.ok) {
      await this.raiseSignalError(response);
    }
    // Coerce a missing/non-array `signals` to [] so callers can .map/.length it;
    // a malformed body on a 2xx is exceptional, not the normal empty case.
    const body = (await response.json()) as { signals?: Signal[] };
    return Array.isArray(body?.signals) ? body.signals : [];
  }

  public async get(signalId: string): Promise<Signal> {
    const response = await fetch(
      `${this.baseHttpUrl}${this.apiPrefix}/signals/${signalId}`,
      { method: "GET", headers: this.headers() },
    );
    if (!response.ok) {
      await this.raiseSignalError(response);
    }
    return response.json() as Promise<Signal>;
  }

  public async create(options: CreateSignalOptions): Promise<Signal> {
    const response = await fetch(`${this.baseHttpUrl}${this.apiPrefix}/signals`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(options),
    });
    if (!response.ok) {
      await this.raiseSignalError(response);
    }
    return response.json() as Promise<Signal>;
  }

  /**
   * PATCH, not PUT: only the keys present in `options` are sent, so the server
   * leaves everything else as stored. An explicit `null` on `sampleRate` /
   * `trigger` must survive serialization (it means "clear"), so nulls are NOT
   * stripped here.
   */
  public async update(signalId: string, options: UpdateSignalOptions): Promise<Signal> {
    const response = await fetch(
      `${this.baseHttpUrl}${this.apiPrefix}/signals/${signalId}`,
      {
        method: "PATCH",
        headers: this.headers(),
        body: JSON.stringify(options),
      },
    );
    if (!response.ok) {
      await this.raiseSignalError(response);
    }
    return response.json() as Promise<Signal>;
  }

  /** Deletes the signal, its triggers, its alerts, and its ClickHouse events. */
  public async delete(signalId: string): Promise<Signal> {
    const response = await fetch(
      `${this.baseHttpUrl}${this.apiPrefix}/signals/${signalId}`,
      { method: "DELETE", headers: this.headers() },
    );
    if (!response.ok) {
      await this.raiseSignalError(response);
    }
    return response.json() as Promise<Signal>;
  }
}
