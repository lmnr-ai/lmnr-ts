import { BaseResource, type LaminarAuth } from ".";

/**
 * A signal's payload schema — the structured output the LLM must return. Every
 * field is required (the UI drawer marks them all required); enums are a string
 * field with an `enum` array.
 */
export interface SignalStructuredOutput {
  type: "object";
  properties: Record<string, { type: string; description: string; enum?: string[] }>;
  required: string[];
}

/**
 * A signal trigger. The two lists mean different things and are NOT
 * interchangeable:
 *
 * - `conditions` — WHEN the signal is evaluated. Decidable from one span batch
 *   (`root_span_finished`, `span_name`). An EMPTY list never fires.
 * - `filters` — WHETHER a fired trigger runs. Properties of the whole trace
 *   (`total_token_count`, `status`, `span_names`). An empty list passes.
 *
 * Note `span_name` (condition, this batch only) and `span_names` (filter,
 * anywhere in the trace) are DIFFERENT columns.
 */
export interface SignalTrigger {
  id?: string;
  conditions: SignalFilter[];
  filters: SignalFilter[];
  createdAt?: string;
  /** 0 = batch, 1 = realtime */
  mode?: number;
}

export interface SignalFilter {
  column: string;
  operator: string;
  value: string | number | string[];
}

export interface Signal {
  id: string;
  projectId: string;
  name: string;
  prompt: string;
  structuredOutput: SignalStructuredOutput;
  sampleRate: number | null;
  disabled: boolean;
  createdAt: string;
  triggers: SignalTrigger[];
}

export interface CreateSignalOptions {
  name: string;
  prompt: string;
  structuredOutput: SignalStructuredOutput;
  sampleRate?: number;
  disabled?: boolean;
  /** Omit to seed the UI's default trigger; `[]` creates an inert signal. */
  triggers?: SignalTrigger[];
}

/**
 * A partial patch. Every field is optional and an ABSENT field leaves the stored
 * value alone — so updating the prompt can't clear sampling or re-enable a
 * deactivated signal. `sampleRate: null` explicitly clears sampling, and
 * `triggers` replaces the signal's whole trigger set when present.
 */
export interface UpdateSignalOptions {
  prompt?: string;
  structuredOutput?: SignalStructuredOutput;
  sampleRate?: number | null;
  disabled?: boolean;
  triggers?: SignalTrigger[];
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
   * leaves everything else as stored. `sampleRate: null` must survive
   * serialization (it means "clear"), so it is NOT stripped here.
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
