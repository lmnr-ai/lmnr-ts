import { BaseResource, type LaminarAuth } from "./index";

/** An eval dataset of the project. See {@link EvalDatasetsResource.list}. */
export interface EvalDataset {
  id: string;
  name: string;
  createdAt: string;
  /** Null until the first version is pushed. */
  latestVersion: number | null;
}

/** One immutable version of an eval dataset. */
export interface EvalDatasetVersion {
  datasetId: string;
  dataset: string;
  version: number;
  parentVersion: number | null;
  message: string | null;
  createdAt: string;
  /** Task name → task hash (`sha256:<64 hex>`). */
  tasks: Record<string, string>;
}

/** Body of {@link EvalDatasetsResource.createVersion}. */
export interface CreateEvalDatasetVersionOptions {
  /** The version this one was made from (the lockfile's), null for none. */
  parentVersion?: number | null;
  message?: string | null;
  /** Task name → task hash; every hash must be uploaded first. */
  tasks: Record<string, string>;
}

/** What {@link EvalDatasetsResource.createVersion} created. */
export interface CreatedEvalDatasetVersion {
  datasetId: string;
  dataset: string;
  version: number;
  /** The dataset's latest version before this one, null for a new dataset. */
  previousLatest: number | null;
}

/**
 * A failed eval datasets request. `status` is the HTTP status; `missing` is
 * set on a 409 from {@link EvalDatasetsResource.createVersion}: the hashes
 * with no uploaded task.
 */
export class EvalDatasetsError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly missing?: string[],
  ) {
    super(message);
    this.name = "EvalDatasetsError";
  }
}

/**
 * Eval datasets: Harbor tasks stored in Laminar as immutable, numbered
 * versions. Tasks are content-addressed by a hash lmnr-cli computes (the
 * server stores it as is): `missingTasks` → `uploadTask` + `uploadTaskIndex`
 * for each missing one → `createVersion`. `getVersion` + `downloadTask` read a
 * version back.
 */
export class EvalDatasetsResource extends BaseResource {
  constructor(baseHttpUrl: string, auth: LaminarAuth) {
    super(baseHttpUrl, auth);
  }

  /** The task hashes this project has no uploaded task for. */
  public async missingTasks(hashes: string[]): Promise<string[]> {
    const response = await fetch(this.url("/eval-dataset-tasks/missing"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ hashes }),
    });
    if (!response.ok) await this.fail(response);
    return ((await response.json()) as { missing: string[] }).missing;
  }

  /**
   * Upload a task's archive (`.tar.gz`, paths relative to the task dir). The
   * task counts as uploaded only once {@link uploadTaskIndex} succeeds.
   */
  public async uploadTask(hash: string, archive: Uint8Array): Promise<void> {
    const response = await fetch(this.taskUrl(hash, ""), {
      method: "PUT",
      headers: { ...this.headers(), "Content-Type": "application/gzip" },
      body: archive as Uint8Array<ArrayBuffer>,
    });
    if (!response.ok) await this.fail(response);
  }

  /** Upload the file index of a task uploaded with {@link uploadTask}. */
  public async uploadTaskIndex(hash: string, index: object): Promise<void> {
    const response = await fetch(this.taskUrl(hash, "/index"), {
      method: "PUT",
      headers: this.headers(),
      body: JSON.stringify(index),
    });
    if (!response.ok) await this.fail(response);
  }

  /** A task's archive (`.tar.gz`), streamed. */
  public async downloadTask(hash: string): Promise<ReadableStream<Uint8Array>> {
    const response = await fetch(this.taskUrl(hash, ""), {
      headers: { ...this.headers(), Accept: "application/gzip" },
    });
    if (!response.ok) await this.fail(response);
    if (!response.body) {
      throw new EvalDatasetsError(`Empty response for task ${hash}`, 502);
    }
    return response.body;
  }

  /** The project's eval datasets, sorted by name. */
  public async list(): Promise<EvalDataset[]> {
    const response = await fetch(this.url("/eval-datasets"), {
      headers: this.headers(),
    });
    if (!response.ok) await this.fail(response);
    return (await response.json()) as EvalDataset[];
  }

  /** One version of a dataset, or its latest. 404s when either doesn't exist. */
  public async getVersion(
    dataset: string,
    version: number | "latest",
  ): Promise<EvalDatasetVersion> {
    const response = await fetch(
      this.url(
        `/eval-datasets/${encodeURIComponent(dataset)}/versions/${version}`,
      ),
      { headers: this.headers() },
    );
    if (!response.ok) await this.fail(response);
    return (await response.json()) as EvalDatasetVersion;
  }

  /**
   * Create the dataset's next version (and the dataset, on its first push).
   * A 409 {@link EvalDatasetsError} lists the task hashes not uploaded yet.
   */
  public async createVersion(
    dataset: string,
    options: CreateEvalDatasetVersionOptions,
  ): Promise<CreatedEvalDatasetVersion> {
    const response = await fetch(
      this.url(`/eval-datasets/${encodeURIComponent(dataset)}/versions`),
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(options),
      },
    );
    if (!response.ok) await this.fail(response);
    return (await response.json()) as CreatedEvalDatasetVersion;
  }

  private url(path: string): string {
    return `${this.baseHttpUrl}${this.apiPrefix}${path}`;
  }

  private taskUrl(hash: string, suffix: string): string {
    return this.url(`/eval-dataset-tasks/${encodeURIComponent(hash)}${suffix}`);
  }

  /**
   * Raise the server's `{error}` message (falling back to the raw body) as an
   * {@link EvalDatasetsError}, keeping the status and a 409's `missing`.
   */
  private async fail(response: Response): Promise<never> {
    const body = await response.text();
    let message = body;
    let missing: string[] | undefined;
    try {
      const parsed = JSON.parse(body) as { error?: unknown; missing?: unknown };
      if (typeof parsed?.error === "string" && parsed.error.length > 0) {
        message = parsed.error;
      }
      if (Array.isArray(parsed?.missing)) {
        missing = parsed.missing.filter(
          (h): h is string => typeof h === "string",
        );
      }
    } catch {
      // Not JSON — use it as-is.
    }
    throw new EvalDatasetsError(
      `${response.status} ${message}`,
      response.status,
      missing,
    );
  }
}
