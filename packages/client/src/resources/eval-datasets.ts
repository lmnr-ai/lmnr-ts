import { BaseResource, type LaminarAuth } from "./index";

/**
 * One version of a task: its content hash (Harbor's), computed by lmnr-cli.
 * Dataset and task names are Harbor's `org/name`.
 */
export interface EvalTaskVersionRef {
  task: string;
  hash: string;
}

/**
 * A Harbor `org/name` name as two path segments: the routes take the org and
 * the name separately, so no encoded `/` ever reaches a proxy.
 */
const nameSegments = (name: string): string =>
  name.split("/").map(encodeURIComponent).join("/");

/** The server's cap on one `versions/missing` request. */
const MAX_VERSIONS_PER_REQUEST = 10_000;

/**
 * Eval datasets: Harbor tasks stored in Laminar as content-addressed versions
 * (lmnr-cli `eval dataset pull / push`).
 *
 * A version is uploaded with {@link uploadVersion} (the `.tar.gz` of the task
 * dir) then {@link uploadVersionIndex}, which makes it count. Versions are
 * independent: Laminar keeps no "latest", the dataset.toml in git pins which
 * ones a dataset uses.
 *
 * Errors are {@link LaminarApiError}s: branch on `code`
 * (`storage_not_configured`, `version_not_found`, ...), never on the message.
 */
export class EvalDatasetsResource extends BaseResource {
  constructor(baseHttpUrl: string, auth: LaminarAuth) {
    super(baseHttpUrl, auth);
  }

  /** The versions Laminar doesn't have (all of them for an unknown dataset). */
  public async missingVersions(
    dataset: string,
    versions: EvalTaskVersionRef[],
  ): Promise<EvalTaskVersionRef[]> {
    const missing: EvalTaskVersionRef[] = [];
    for (let i = 0; i < versions.length; i += MAX_VERSIONS_PER_REQUEST) {
      const batch = versions
        .slice(i, i + MAX_VERSIONS_PER_REQUEST)
        .map(({ task, hash }) => ({ task, hash }));
      const response = await fetch(this.url(dataset, "/versions/missing"), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ versions: batch }),
      });
      if (!response.ok) throw await this.apiError(response);
      missing.push(
        ...((await response.json()) as { missing: EvalTaskVersionRef[] })
          .missing,
      );
    }
    return missing;
  }

  /**
   * Upload a task version's archive (the task dir as a `.tar.gz`, as lmnr-cli
   * packs it). It counts only once its index is uploaded too.
   */
  public async uploadVersion(
    dataset: string,
    task: string,
    hash: string,
    archive: Uint8Array | ReadableStream<Uint8Array>,
  ): Promise<void> {
    const response = await fetch(this.versionUrl(dataset, task, hash, ""), {
      method: "PUT",
      headers: { ...this.headers(), "Content-Type": "application/gzip" },
      body: archive as Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>,
      // Required by Node's fetch for a streamed request body.
      ...(archive instanceof ReadableStream ? { duplex: "half" } : {}),
    } as RequestInit);
    if (!response.ok) throw await this.apiError(response);
  }

  /**
   * Upload the index of an uploaded version archive (`{files: [...]}`). The
   * version then counts. Uploading a version Laminar has is a no-op.
   */
  public async uploadVersionIndex(
    dataset: string,
    task: string,
    hash: string,
    index: object,
  ): Promise<void> {
    const response = await fetch(
      this.versionUrl(dataset, task, hash, "/index"),
      {
        method: "PUT",
        headers: this.headers(),
        body: JSON.stringify(index),
      },
    );
    if (!response.ok) throw await this.apiError(response);
  }

  /**
   * A task version's archive, streamed. A missing version throws a
   * `LaminarApiError` with code `version_not_found`.
   */
  public async downloadVersion(
    dataset: string,
    task: string,
    hash: string,
  ): Promise<ReadableStream<Uint8Array>> {
    const response = await fetch(this.versionUrl(dataset, task, hash, ""), {
      headers: { ...this.headers(), Accept: "application/gzip" },
    });
    if (!response.ok) throw await this.apiError(response);
    if (!response.body) {
      throw new Error(`Empty response for ${dataset}/${task}@${hash}`);
    }
    return response.body;
  }

  private url(dataset: string, path: string): string {
    return (
      `${this.baseHttpUrl}${this.apiPrefix}/eval-datasets/` +
      `${nameSegments(dataset)}${path}`
    );
  }

  private versionUrl(
    dataset: string,
    task: string,
    hash: string,
    suffix: string,
  ): string {
    return this.url(
      dataset,
      `/tasks/${nameSegments(task)}/versions/` +
        `${encodeURIComponent(hash)}${suffix}`,
    );
  }
}
