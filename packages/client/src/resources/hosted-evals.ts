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
 * - Prebuilt images: `missingLayers` / `uploadLayer` / `createImage` push an
 *   image built locally (layers named by their `diff_id`); trials start from it.
 * - Build contexts: `contextExists` / `uploadContext` store a Docker build
 *   context (uncompressed tar, named by its md5) that Laminar builds images from.
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

  /** The image layers (by `diff_id`) the project hasn't uploaded yet. */
  public async missingLayers(diffIds: string[]): Promise<string[]> {
    const response = await fetch(this.url("/images/layers/missing"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ diffIds }),
    });
    if (!response.ok) {
      await this.raiseError(response);
    }
    return ((await response.json()) as { missing: string[] }).missing;
  }

  /**
   * Upload one image layer, gzip-compressed. `diffId` is the digest of its
   * uncompressed tar, as listed in the image config's `rootfs.diff_ids`.
   */
  public async uploadLayer(
    diffId: string,
    gzipped: ReadableStream<Uint8Array> | Uint8Array,
  ): Promise<{ digest: string; size: number }> {
    const response = await fetch(this.url(`/images/layers/${diffId}`), {
      method: "PUT",
      headers: { ...this.headers(), "Content-Type": "application/gzip" },
      body: gzipped as BodyInit,
      // Required by Node's fetch for a streamed request body.
      duplex: "half",
    } as RequestInit);
    if (!response.ok) {
      await this.raiseError(response);
    }
    return (await response.json()) as { digest: string; size: number };
  }

  /**
   * Push the image described by `config` (its config JSON, byte for byte) once
   * its layers are uploaded. Returns the manifest digest trials start from.
   */
  public async createImage(config: string): Promise<{ image: string }> {
    const response = await fetch(this.url("/images"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ config }),
    });
    if (!response.ok) {
      await this.raiseError(response);
    }
    return (await response.json()) as { image: string };
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
