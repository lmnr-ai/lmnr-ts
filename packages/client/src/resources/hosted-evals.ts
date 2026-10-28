import { BaseResource, type LaminarAuth } from "./index";

/**
 * Run overrides for {@link HostedEvalsResource.startRun}. Everything except
 * `uploadId` defaults to each suite's `harbor.yaml`.
 */
export interface StartHostedEvalRunOptions {
  /** Id returned by {@link HostedEvalsResource.upload}. */
  uploadId: string;
  /** Suites (archive-root dirs with a `harbor.yaml`) to run. Omitted → all. */
  datasets?: string[];
  /** Task name globs to include. Omitted → every task. */
  tasks?: string[];
  nAttempts?: number;
  nConcurrent?: number;
  model?: string;
  /** Agent env vars (e.g. LLM API keys), merged over each agent's `env`. */
  env?: Record<string, string>;
}

/**
 * Hosted evals: run a Harbor `evals/` folder in Laminar-managed sandboxes.
 * Two steps — upload the `.tar.gz` of the folder's contents, then start a run
 * against the returned `uploadId`. The run reports into the project as regular
 * evaluations; v0 returns no run status or evaluation id.
 */
export class HostedEvalsResource extends BaseResource {
  constructor(baseHttpUrl: string, auth: LaminarAuth) {
    super(baseHttpUrl, auth);
  }

  /**
   * Upload a `.tar.gz` of the `evals/` folder's contents (suites at the archive
   * root, not under an `evals/` prefix). Sent as the raw request body; the
   * server caps it at 100 MiB.
   */
  public async upload(archive: Uint8Array): Promise<{ uploadId: string }> {
    const response = await fetch(
      `${this.baseHttpUrl}${this.apiPrefix}/hosted-evals/uploads`,
      {
        method: "POST",
        headers: { ...this.headers(), "Content-Type": "application/gzip" },
        body: archive,
      },
    );
    if (!response.ok) {
      await this.raiseError(response);
    }
    return (await response.json()) as { uploadId: string };
  }

  /** Start a run in a new sandbox. Returns once the sandbox has started. */
  public async startRun(
    options: StartHostedEvalRunOptions,
  ): Promise<{ sandboxId: string }> {
    const response = await fetch(
      `${this.baseHttpUrl}${this.apiPrefix}/hosted-evals/runs`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(options),
      },
    );
    if (!response.ok) {
      await this.raiseError(response);
    }
    return (await response.json()) as { sandboxId: string };
  }

  /** Surface the server's `{error}` message instead of the raw JSON body. */
  private async raiseError(response: Response): Promise<never> {
    const body = await response.text();
    let message = body;
    try {
      const parsed = JSON.parse(body) as { error?: unknown };
      if (typeof parsed?.error === "string" && parsed.error.length > 0) {
        message = parsed.error;
      }
    } catch {
      // Not JSON (a proxy error page, an nginx 413) — use it as-is.
    }
    throw new Error(`${response.status} ${message}`);
  }
}
