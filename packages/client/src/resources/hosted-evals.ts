import { BaseResource, type LaminarAuth } from "./index";

/** Starts a remote run. See {@link HostedEvalsResource.startRun}. */
export interface StartHostedEvalRunOptions {
  /** The orchestrator runs `lmnr-cli@<cliVersion>`, so the spec format matches. */
  cliVersion: string;
  /**
   * Run spec written by lmnr-cli and read back by the same CLI version. Sent
   * as JSON; the server passes it through without reading it.
   */
  spec: object;
}

/**
 * A copy of an agent's scripts that a run used. Scripts live in the user's
 * repo; Laminar keeps one copy per distinct content, not versions.
 */
export interface EvalAgentVersion {
  id: string;
  /** Content hash of the scripts; also the id of their blob. */
  hash: string;
  gitSha: string | null;
  createdAt: string;
  /** When a run last used this copy. */
  lastUsedAt: string;
}

/**
 * One version of a task set. `number` is null for a run snapshot (a version a
 * run used that was never pushed).
 */
export interface TaskSetVersion {
  id: string;
  number: number | null;
  /** Content hash of the version's files; also the id of its blob. */
  hash: string;
  parentId: string | null;
  createdAt: string;
}

/** An agent in Laminar: its task sets, and the scripts its last run used. */
export interface EvalAgent {
  id: string;
  name: string;
  latestScripts: EvalAgentVersion | null;
  taskSets: { id: string; name: string; head: TaskSetVersion | null }[];
}

/** A task of a task-set version: its directory name and content digest. */
export interface TaskSetTask {
  name: string;
  digest: string;
  /** The task.toml `[metadata]` table. */
  metadata?: object;
}

export interface CreateTaskSetVersionOptions {
  hash: string;
  /** Make it the task set's head (otherwise a run snapshot). */
  push: boolean;
  /** The version the local copy started from (null for a new task set). */
  base: string | null;
  tasks: TaskSetTask[];
}

/**
 * {@link HostedEvalsResource.createTaskSetVersion}'s result: the version, or,
 * for a push, the task set's head when it moved on from `base`.
 */
export type CreateTaskSetVersionResult =
  | { version: TaskSetVersion }
  | { headMoved: TaskSetVersion | null };

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

const segment = (value: string) => encodeURIComponent(value);

/**
 * Hosted evals: Harbor evals with trials in Laminar-managed sandboxes.
 *
 * - Images: `missingLayers` / `uploadLayer` / `createImage` push an image built
 *   locally (layers named by their `diff_id`); trials start from it.
 * - Blobs: the scripts a run used and each task set version are stored as one
 *   content-addressed `.tar.gz` plus its file index (`putBlob` /
 *   `putBlobIndex`, `getBlob` / `getBlobIndex`).
 * - Versions: `createTaskSetVersion` records a blob as a task set version (a
 *   push moves the head; otherwise it is a run snapshot); `createAgentVersion`
 *   records the scripts a run uses; `listAgents` / `listTaskSetVersions` read
 *   them back.
 * - Remote runs: `startRun` orchestrates a run in a Laminar sandbox. The
 *   orchestrator sends its output with `appendRunLogs` and each task set's
 *   Harbor job output with `uploadJob` / `uploadJobIndex`; `getRunLogs`
 *   follows the run until it exits.
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
   * Upload the `.tar.gz` of a version's files under its content hash. Sent as
   * the raw request body; the server caps it at 1 GiB.
   */
  public async putBlob(hash: string, archive: Uint8Array): Promise<void> {
    const response = await fetch(this.url(`/uploads/blobs/${segment(hash)}`), {
      method: "PUT",
      headers: { ...this.headers(), "Content-Type": "application/gzip" },
      body: archive as Uint8Array<ArrayBuffer>,
    });
    if (!response.ok) {
      await this.handleErrorMessage(response);
    }
  }

  /**
   * Upload a blob's file index (where each file sits in the archive). Upload it
   * after the archive: its presence is what marks the blob complete.
   */
  public async putBlobIndex(hash: string, index: object): Promise<void> {
    const response = await fetch(
      this.url(`/uploads/blobs/${segment(hash)}/index`),
      {
        method: "PUT",
        headers: this.headers(),
        body: JSON.stringify(index),
      },
    );
    if (!response.ok) {
      await this.handleErrorMessage(response);
    }
  }

  /** A blob's file index, or null when the blob isn't (completely) uploaded. */
  public async getBlobIndex(hash: string): Promise<object | null> {
    const response = await fetch(
      this.url(`/uploads/blobs/${segment(hash)}/index`),
      { headers: this.headers() },
    );
    if (response.status === 404) return null;
    if (!response.ok) {
      await this.handleErrorMessage(response);
    }
    return (await response.json()) as object;
  }

  /** A blob's `.tar.gz`, streamed. */
  public async getBlob(hash: string): Promise<ReadableStream<Uint8Array>> {
    const response = await fetch(this.url(`/uploads/blobs/${segment(hash)}`), {
      headers: { ...this.headers(), Accept: "application/gzip" },
    });
    if (!response.ok) {
      await this.handleErrorMessage(response);
    }
    if (!response.body) throw new Error("Empty blob response");
    return response.body;
  }

  /** The project's agents with their task sets, sorted by name. */
  public async listAgents(): Promise<EvalAgent[]> {
    const response = await fetch(this.url("/agents"), {
      headers: this.headers(),
    });
    if (!response.ok) {
      await this.handleErrorMessage(response);
    }
    return ((await response.json()) as { agents: EvalAgent[] }).agents;
  }

  /** A task set's versions, newest first. Null when there is no such task set. */
  public async listTaskSetVersions(
    agent: string,
    taskSet: string,
  ): Promise<TaskSetVersion[] | null> {
    const response = await fetch(
      this.url(
        `/agents/${segment(agent)}/task-sets/${segment(taskSet)}/versions`,
      ),
      { headers: this.headers() },
    );
    if (response.status === 404) return null;
    if (!response.ok) {
      await this.handleErrorMessage(response);
    }
    return ((await response.json()) as { versions: TaskSetVersion[] }).versions;
  }

  /**
   * Record an uploaded blob as the scripts a run uses (creating the agent if
   * needed); the same content returns the same record.
   */
  public async createAgentVersion(
    agent: string,
    options: { hash: string; gitSha?: string },
  ): Promise<EvalAgentVersion> {
    const response = await fetch(
      this.url(`/agents/${segment(agent)}/versions`),
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(options),
      },
    );
    if (!response.ok) {
      await this.handleErrorMessage(response);
    }
    return (await response.json()) as EvalAgentVersion;
  }

  /**
   * Record an uploaded blob as a version of a task set (creating the agent and
   * task set if needed). A push whose `base` isn't the current head returns
   * `{headMoved}` instead of failing.
   */
  public async createTaskSetVersion(
    agent: string,
    taskSet: string,
    options: CreateTaskSetVersionOptions,
  ): Promise<CreateTaskSetVersionResult> {
    const response = await fetch(
      this.url(
        `/agents/${segment(agent)}/task-sets/${segment(taskSet)}/versions`,
      ),
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(options),
      },
    );
    if (response.status === 409) {
      const body = (await response.json()) as { head?: TaskSetVersion | null };
      return { headMoved: body.head ?? null };
    }
    if (!response.ok) {
      await this.handleErrorMessage(response);
    }
    return { version: (await response.json()) as TaskSetVersion };
  }

  /**
   * Upload a remote run's Harbor job output for one task set (its trial dirs
   * as a `.tar.gz`, packed like a blob), for Laminar's trial log view. Called
   * from the run's orchestrator; the server caps it at 256 MiB.
   */
  public async uploadJob(
    runId: string,
    taskSet: string,
    archive: Uint8Array,
  ): Promise<void> {
    const response = await fetch(this.jobUrl(runId, taskSet, ""), {
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
    runId: string,
    taskSet: string,
    index: object,
  ): Promise<void> {
    const response = await fetch(this.jobUrl(runId, taskSet, "/index"), {
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
    runId: string,
    lines: HostedEvalRunLogLine[],
  ): Promise<boolean> {
    const response = await fetch(this.url(`/runs/${runId}/logs`), {
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
    runId: string,
    from = 0,
  ): Promise<HostedEvalRunLogPage | null> {
    const response = await fetch(this.url(`/runs/${runId}/logs?from=${from}`), {
      headers: this.headers(),
    });
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
  ): Promise<{ runId: string; sandboxId: string }> {
    const response = await fetch(this.url("/runs"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(options),
    });
    if (!response.ok) {
      await this.handleErrorMessage(response);
    }
    return (await response.json()) as { runId: string; sandboxId: string };
  }

  private url(path: string): string {
    return `${this.baseHttpUrl}${this.apiPrefix}/hosted-evals${path}`;
  }

  private jobUrl(runId: string, taskSet: string, suffix: string): string {
    const query = new URLSearchParams({ taskSet });
    return this.url(`/uploads/jobs/${runId}${suffix}?${query}`);
  }
}
