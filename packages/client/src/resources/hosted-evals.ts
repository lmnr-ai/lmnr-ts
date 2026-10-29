import { BaseResource, type LaminarAuth } from "./index";

/** Starts a detached run. See {@link HostedEvalsResource.startRun}. */
export interface StartHostedEvalRunOptions {
  /** Id returned by {@link HostedEvalsResource.upload}. */
  uploadId: string;
  /** The orchestrator runs `lmnr-cli@<cliVersion>`, so the spec format matches. */
  cliVersion: string;
  /**
   * Run spec written by lmnr-cli and read back by the same CLI version. Sent
   * as JSON; the server passes it through without reading it.
   */
  spec: object;
}

/**
 * Hosted evals: Harbor evals with trials in Laminar-managed sandboxes.
 *
 * - Images: `missingLayers` / `uploadLayer` / `createImage` push an image built
 *   locally (layers named by their `diff_id`); trials start from it.
 * - Detached runs: `upload` the `.tar.gz` of the evals folder, then `startRun`
 *   to orchestrate it in a Laminar sandbox. Results land in the project as
 *   regular evaluations; v0 returns no run status.
 */
export class HostedEvalsResource extends BaseResource {
  constructor(baseHttpUrl: string, auth: LaminarAuth) {
    super(baseHttpUrl, auth);
  }

  /** The image layers (by `diff_id`) the project hasn't uploaded yet. */
  public async missingLayers(diffIds: string[]): Promise<string[]> {
    const response = await fetch(this.url("/images/layers/missing"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ diffIds }),
    });
    if (!response.ok) {
      await this.handleErrorMessage(response);
    }
    return ((await response.json()) as { missing: string[] }).missing;
  }

  /**
   * Upload one image layer, gzip-compressed. `diffId` is the digest of its
   * uncompressed tar, as listed in the image config's `rootfs.diff_ids`.
   */
  public async uploadLayer(
    diffId: string,
    gzipped: ReadableStream<Uint8Array>,
  ): Promise<{ digest: string; size: number }> {
    const response = await fetch(this.url(`/images/layers/${diffId}`), {
      method: "PUT",
      headers: { ...this.headers(), "Content-Type": "application/gzip" },
      body: gzipped,
      // Required by Node's fetch for a streamed request body.
      duplex: "half",
    } as RequestInit);
    if (!response.ok) {
      await this.handleErrorMessage(response);
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
      await this.handleErrorMessage(response);
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
      await this.handleErrorMessage(response);
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
      await this.handleErrorMessage(response);
    }
    return (await response.json()) as { sandboxId: string };
  }

  private url(path: string): string {
    return `${this.baseHttpUrl}${this.apiPrefix}/hosted-evals${path}`;
  }
}
