import { BaseResource, type LaminarAuth } from "./index";

/** One version of a task: its content hash, computed by lmnr-cli. */
export interface EvalTaskVersionRef {
  task: string;
  hash: string;
}

/** A task of an eval dataset with its latest version. */
export interface EvalDatasetTask {
  id: string;
  /** The latest version: the one pushed (or uploaded) last. */
  hash: string;
  createdAt: string;
}

export interface EvalDataset {
  id: string;
  createdAt: string;
  /** One entry per task, its latest version, sorted by task id. */
  tasks: EvalDatasetTask[];
}

/** One task of a push: its new version and the version it was based on. */
export interface EvalDatasetPushTask {
  task: string;
  hash: string;
  /** The task's latest version when it was pulled; null for a new task. */
  base: string | null;
}

/** What {@link EvalDatasetsResource.push} ended with. */
export type EvalDatasetPushResult =
  | { status: "pushed"; tasks: EvalDatasetTask[] }
  /** Some tasks moved past their `base`; nothing was written. */
  | { status: "moved"; moved: { task: string; latest: string }[] }
  /** Some versions were never uploaded; nothing was written. */
  | { status: "versions_missing"; missing: EvalTaskVersionRef[] };

/** The server's cap on one `versions/missing` request. */
const MAX_VERSIONS_PER_REQUEST = 10_000;

/**
 * Eval datasets: Harbor tasks stored in Laminar as content-addressed versions
 * (lmnr-cli `eval dataset pull / push`).
 *
 * A version is uploaded with {@link uploadVersion} (the `.tar.gz` of the task
 * dir) then {@link uploadVersionIndex} (which makes it count, and latest);
 * {@link push} then records which versions the dataset points at, refusing
 * tasks that moved since they were pulled.
 *
 * Errors are {@link LaminarApiError}s: branch on `code`
 * (`storage_not_configured`, `version_not_found`, ...), never on the message.
 */
export class EvalDatasetsResource extends BaseResource {
  constructor(baseHttpUrl: string, auth: LaminarAuth) {
    super(baseHttpUrl, auth);
  }

  /** The dataset and each task's latest version; null if Laminar has none. */
  public async get(dataset: string): Promise<EvalDataset | null> {
    const response = await fetch(this.url(dataset, ""), {
      headers: this.headers(),
    });
    if (!response.ok) {
      const error = await this.apiError(response);
      if (error.code === "dataset_not_found") return null;
      throw error;
    }
    return (await response.json()) as EvalDataset;
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
   * version then counts and becomes the task's latest.
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

  /**
   * Point the dataset's tasks at the given (uploaded) versions, all or
   * nothing. A conflict (409) is returned, not thrown: `moved` lists the
   * tasks whose latest version moved past their `base`.
   */
  public async push(
    dataset: string,
    tasks: EvalDatasetPushTask[],
  ): Promise<EvalDatasetPushResult> {
    const response = await fetch(this.url(dataset, "/push"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ tasks }),
    });
    if (response.ok) {
      const { tasks: pushed } = (await response.json()) as {
        tasks: EvalDatasetTask[];
      };
      return { status: "pushed", tasks: pushed };
    }
    const error = await this.apiError(response);
    if (response.status === 409) {
      const body = (error.body ?? {}) as {
        moved?: { task: string; latest: string }[];
        missing?: EvalTaskVersionRef[];
      };
      if (error.code === "moved") {
        return { status: "moved", moved: body.moved ?? [] };
      }
      if (error.code === "versions_missing") {
        return { status: "versions_missing", missing: body.missing ?? [] };
      }
    }
    throw error;
  }

  private url(dataset: string, path: string): string {
    return (
      `${this.baseHttpUrl}${this.apiPrefix}/eval-datasets/` +
      `${encodeURIComponent(dataset)}${path}`
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
      `/tasks/${encodeURIComponent(task)}/versions/` +
        `${encodeURIComponent(hash)}${suffix}`,
    );
  }
}
