import { BaseResource, type LaminarAuth } from "./index";

/** Starts a remote run. See {@link HostedEvalsResource.startRun}. */
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

/** One line of a remote run's log, numbered from 0 by the run's orchestrator. */
export interface HostedEvalRunLogLine {
  seq: number;
  /** Milliseconds since the epoch. */
  time: number;
  text: string;
}

/** A page of a remote run's log. See {@link HostedEvalsResource.getRunLogs}. */
export interface HostedEvalRunLogPage {
  lines: HostedEvalRunLogLine[];
  /** Pass as `from` for the lines after these. */
  next: number;
  /** The orchestrator's exit code, once it has exited; null while it runs. */
  exitCode: number | null;
}

/** A Laminar sandbox's state. */
export interface HostedEvalSandboxStatus {
  state: "pending" | "started" | "error" | "destroyed";
  errorReason?: string;
}

/**
 * Hosted evals: Harbor evals with trials in Laminar-managed sandboxes.
 *
 * - Images: `missingLayers` / `uploadLayer` / `createImage` push an image built
 *   locally (layers named by their `diff_id`); trials start from it.
 * - Remote runs: `upload` the `.tar.gz` of the evals folder and `uploadIndex`
 *   its file index, then `startRun` to orchestrate it in a Laminar sandbox. Results land in the project as
 *   regular evaluations. The orchestrator sends its output with
 *   `appendRunLogs` and each suite's Harbor job output with `uploadJob` /
 *   `uploadJobIndex`; `getRunLogs` follows the run until it exits.
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
   * root). Sent as the raw request body; the server caps it at 1 GiB.
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

  /**
   * Upload the index of an uploaded archive: where each file sits, so the
   * Laminar UI can show single files of the run's evals folder. Sent as JSON;
   * lmnr-cli writes it along with the archive.
   */
  public async uploadIndex(uploadId: string, index: object): Promise<void> {
    const response = await fetch(this.url(`/uploads/${uploadId}/index`), {
      method: "PUT",
      headers: this.headers(),
      body: JSON.stringify(index),
    });
    if (!response.ok) {
      await this.handleErrorMessage(response);
    }
  }

  /**
   * Upload a remote run's Harbor job output for one suite (its trial dirs as
   * a `.tar.gz`, packed like {@link upload}'s archive), for Laminar's trial log
   * view. Called from the run's orchestrator; the server caps it at 256 MiB.
   */
  public async uploadJob(
    uploadId: string,
    suite: string,
    archive: Uint8Array,
  ): Promise<void> {
    const response = await fetch(this.jobUrl(uploadId, suite, ""), {
      method: "PUT",
      headers: { ...this.headers(), "Content-Type": "application/gzip" },
      body: archive as Uint8Array<ArrayBuffer>,
    });
    if (!response.ok) {
      await this.handleErrorMessage(response);
    }
  }

  /** The index of an archive sent with {@link uploadJob}; upload it after the archive. */
  public async uploadJobIndex(
    uploadId: string,
    suite: string,
    index: object,
  ): Promise<void> {
    const response = await fetch(this.jobUrl(uploadId, suite, "/index"), {
      method: "PUT",
      headers: this.headers(),
      body: JSON.stringify(index),
    });
    if (!response.ok) {
      await this.handleErrorMessage(response);
    }
  }

  /**
   * Append lines to a remote run's log (run key, from its orchestrator). Send
   * one batch at a time: a batch is readable once this returns. Returns false
   * when the server doesn't keep run logs.
   */
  public async appendRunLogs(
    uploadId: string,
    lines: HostedEvalRunLogLine[],
  ): Promise<boolean> {
    const response = await fetch(this.url(`/runs/${uploadId}/logs`), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ lines }),
    });
    if (response.status === 404) return false;
    if (!response.ok) {
      await this.handleErrorMessage(response);
    }
    return true;
  }

  /**
   * A remote run's log from line `from` on (at most 1000 lines per page).
   * Null when the server doesn't keep run logs.
   */
  public async getRunLogs(
    uploadId: string,
    from = 0,
  ): Promise<HostedEvalRunLogPage | null> {
    const response = await fetch(
      this.url(`/runs/${uploadId}/logs?from=${from}`),
      { headers: this.headers() },
    );
    if (response.status === 404) return null;
    if (!response.ok) {
      await this.handleErrorMessage(response);
    }
    return (await response.json()) as HostedEvalRunLogPage;
  }

  /**
   * The state of a sandbox, e.g. a remote run's orchestrator. Null when the
   * project has no such sandbox (anymore).
   */
  public async getSandbox(
    sandboxId: string,
  ): Promise<HostedEvalSandboxStatus | null> {
    const response = await fetch(
      this.url(`/sandboxes/${encodeURIComponent(sandboxId)}`),
      { headers: this.headers() },
    );
    if (response.status === 404) return null;
    if (!response.ok) {
      await this.handleErrorMessage(response);
    }
    return (await response.json()) as HostedEvalSandboxStatus;
  }

  /** Start a remote run. Returns once its orchestrator sandbox has started. */
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

  private jobUrl(uploadId: string, suite: string, suffix: string): string {
    const query = new URLSearchParams({ suite });
    return this.url(`/uploads/${uploadId}/jobs${suffix}?${query}`);
  }
}
