import { BaseResource, type LaminarAuth } from "./index";

/** Starts a detached run. See {@link HostedEvalsResource.startRun}. */
export interface StartHostedEvalRunOptions {
  /** Id returned by {@link HostedEvalsResource.upload}. */
  uploadId: string;
  /** The orchestrator runs `lmnr-cli@<cliVersion>`, so the spec format matches. */
  cliVersion: string;
  /** Run spec written by lmnr-cli and read back by the same CLI version. */
  spec: Record<string, unknown>;
}

/**
 * Hosted evals: Harbor evals with trials in Laminar-managed sandboxes.
 *
 * - Build contexts: `contextExists` / `uploadContext` store a Docker build
 *   context (uncompressed tar, named by its md5) that trial images are built from.
 * - Detached runs: `upload` the `.tar.gz` of the evals folder, then `startRun`
 *   to orchestrate it in a Laminar sandbox. Results land in the project as
 *   regular evaluations; v0 returns no run status.
 */
export class HostedEvalsResource extends BaseResource {
  constructor(baseHttpUrl: string, auth: LaminarAuth) {
    super(baseHttpUrl, auth);
  }

  public async contextExists(hash: string): Promise<boolean> {
    const response = await fetch(this.url(`/contexts/${hash}`), {
      headers: this.headers(),
    });
    if (!response.ok) {
      await this.raiseError(response);
    }
    return ((await response.json()) as { exists: boolean }).exists;
  }

  /** `hash` must be the md5 of `tar`; the server verifies it. */
  public async uploadContext(hash: string, tar: Uint8Array): Promise<void> {
    const response = await fetch(this.url(`/contexts/${hash}`), {
      method: "PUT",
      headers: { ...this.headers(), "Content-Type": "application/x-tar" },
      body: tar as Uint8Array<ArrayBuffer>,
    });
    if (!response.ok) {
      await this.raiseError(response);
    }
  }

  /**
   * Upload a `.tar.gz` of the `evals/` folder's contents (suites at the archive
   * root). Sent as the raw request body; the server caps it at 100 MiB.
   */
  public async upload(archive: Uint8Array): Promise<{ uploadId: string }> {
    const response = await fetch(this.url("/uploads"), {
      method: "POST",
      headers: { ...this.headers(), "Content-Type": "application/gzip" },
      body: archive as Uint8Array<ArrayBuffer>,
    });
    if (!response.ok) {
      await this.raiseError(response);
    }
    return (await response.json()) as { uploadId: string };
  }

  /** Start a detached run. Returns once its orchestrator sandbox has started. */
  public async startRun(
    options: StartHostedEvalRunOptions,
  ): Promise<{ sandboxId: string }> {
    const response = await fetch(this.url("/runs"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(options),
    });
    if (!response.ok) {
      await this.raiseError(response);
    }
    return (await response.json()) as { sandboxId: string };
  }

  private url(path: string): string {
    return `${this.baseHttpUrl}${this.apiPrefix}/hosted-evals${path}`;
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
