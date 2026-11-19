import { BaseResource, type LaminarAuth } from "./index";

/** An eval dataset of the project. See {@link EvalDatasetsResource.list}. */
export interface EvalDataset {
  /** The dataset's name: its folder name in the evals folder. */
  name: string;
  createdAt: string;
  /** When a task version was last pushed (the dataset's `createdAt` before). */
  updatedAt: string;
  taskCount: number;
}

/** A task version: its content hash (64 lowercase hex chars). */
export interface EvalDatasetTask {
  name: string;
  hash: string;
  /** When this version became the task's latest. */
  createdAt: string;
}

/** Task name → task hash. */
export type EvalDatasetTaskHashes = Record<string, string>;

/**
 * A failed eval datasets request. `status` is the HTTP status. On a 409 from
 * {@link EvalDatasetsResource.pushTasks}, `missing` lists the tasks whose
 * version isn't uploaded, or `moved` the tasks another version became the
 * latest of since their base.
 */
export class EvalDatasetsError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly missing?: string[],
    readonly moved?: string[],
  ) {
    super(message);
    this.name = "EvalDatasetsError";
  }
}

/**
 * Eval datasets: Harbor tasks stored in Laminar, each task versioned on its
 * own by the content hash lmnr-cli computes (the server stores it as is).
 * Pushing: `missingTasks` → `uploadTask` + `uploadTaskIndex` for each missing
 * version → `pushTasks`. Pulling: `listTasks` (latest versions) and
 * `downloadTask`.
 */
export class EvalDatasetsResource extends BaseResource {
  constructor(baseHttpUrl: string, auth: LaminarAuth) {
    super(baseHttpUrl, auth);
  }

  /** The project's eval datasets, sorted by name. */
  public async list(): Promise<EvalDataset[]> {
    const response = await fetch(this.url("/eval-datasets"), {
      headers: this.headers(),
    });
    if (!response.ok) await this.fail(response);
    return (await response.json()) as EvalDataset[];
  }

  /** The latest version of every task of the dataset, sorted by name. 404s for an unknown dataset. */
  public async listTasks(dataset: string): Promise<EvalDatasetTask[]> {
    const response = await fetch(this.datasetUrl(dataset, "/tasks"), {
      headers: this.headers(),
    });
    if (!response.ok) await this.fail(response);
    return ((await response.json()) as { tasks: EvalDatasetTask[] }).tasks;
  }

  /**
   * The tasks of `tasks` whose version (hash) isn't in Laminar, in input
   * order. At most 10 000 tasks per call. An unknown dataset has every task
   * missing.
   */
  public async missingTasks(
    dataset: string,
    tasks: EvalDatasetTaskHashes,
  ): Promise<string[]> {
    const response = await fetch(this.datasetUrl(dataset, "/tasks/missing"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ tasks }),
    });
    if (!response.ok) await this.fail(response);
    return ((await response.json()) as { missing: string[] }).missing;
  }

  /**
   * Upload a task version's archive (`.tar.gz`, paths relative to the task
   * dir). The version exists only once {@link uploadTaskIndex} succeeds.
   */
  public async uploadTask(
    dataset: string,
    task: string,
    hash: string,
    archive: Uint8Array,
  ): Promise<void> {
    const response = await fetch(this.versionUrl(dataset, task, hash, ""), {
      method: "PUT",
      headers: { ...this.headers(), "Content-Type": "application/gzip" },
      body: archive as Uint8Array<ArrayBuffer>,
    });
    if (!response.ok) await this.fail(response);
  }

  /** Upload the file index of an archive uploaded with {@link uploadTask}; creates the version. */
  public async uploadTaskIndex(
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
    if (!response.ok) await this.fail(response);
  }

  /**
   * Make these versions their tasks' latest (the push). At most 10 000
   * tasks. `base` gives the version each change started from (`null`: the
   * task was never pulled); with it, the push is refused when any other
   * version became a task's latest since. A 409 {@link EvalDatasetsError}
   * lists the tasks whose version isn't uploaded (`missing`) or whose latest
   * moved (`moved`); nothing is changed then.
   */
  public async pushTasks(
    dataset: string,
    tasks: EvalDatasetTaskHashes,
    base?: Record<string, string | null>,
  ): Promise<EvalDatasetTask[]> {
    const response = await fetch(this.datasetUrl(dataset, "/tasks"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(base ? { tasks, base } : { tasks }),
    });
    if (!response.ok) await this.fail(response);
    return ((await response.json()) as { tasks: EvalDatasetTask[] }).tasks;
  }

  /** A task version's archive (`.tar.gz`), streamed. */
  public async downloadTask(
    dataset: string,
    task: string,
    hash: string,
  ): Promise<ReadableStream<Uint8Array>> {
    const response = await fetch(this.versionUrl(dataset, task, hash, ""), {
      headers: { ...this.headers(), Accept: "application/gzip" },
    });
    if (!response.ok) await this.fail(response);
    if (!response.body) {
      throw new EvalDatasetsError(
        `Empty response for task ${task} (${hash})`,
        502,
      );
    }
    return response.body;
  }

  private url(path: string): string {
    return `${this.baseHttpUrl}${this.apiPrefix}${path}`;
  }

  private datasetUrl(dataset: string, suffix: string): string {
    return this.url(`/eval-datasets/${encodeURIComponent(dataset)}${suffix}`);
  }

  private versionUrl(
    dataset: string,
    task: string,
    hash: string,
    suffix: string,
  ): string {
    return this.datasetUrl(
      dataset,
      `/tasks/${encodeURIComponent(task)}/versions/${encodeURIComponent(hash)}${suffix}`,
    );
  }

  /**
   * Raise the server's `{error}` message (falling back to the raw body) as an
   * {@link EvalDatasetsError}, keeping the status and a 409's `missing`.
   */
  private async fail(response: Response): Promise<never> {
    const body = await response.text();
    let message = body;
    let missing: string[] | undefined;
    let moved: string[] | undefined;
    const strings = (value: unknown[]) =>
      value.filter((h): h is string => typeof h === "string");
    try {
      const parsed = JSON.parse(body) as {
        error?: unknown;
        missing?: unknown;
        moved?: unknown;
      };
      if (typeof parsed?.error === "string" && parsed.error.length > 0) {
        message = parsed.error;
      }
      if (Array.isArray(parsed?.missing)) missing = strings(parsed.missing);
      if (Array.isArray(parsed?.moved)) moved = strings(parsed.moved);
    } catch {
      // Not JSON — use it as-is.
    }
    throw new EvalDatasetsError(
      `${response.status} ${message}`,
      response.status,
      missing,
      moved,
    );
  }
}
