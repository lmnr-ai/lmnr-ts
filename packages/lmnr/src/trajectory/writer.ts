/**
 * Write lmnr-atif trajectory files (`spec/lmnr-atif/lmnr-atif.md`).
 *
 * File handling on top of `builder.buildTrajectory`: where each file goes,
 * writing it atomically, and storing inline media next to it. Collecting the
 * spans is the tracing layer's job (`opentelemetry-lib/tracing/trajectory.ts`).
 *
 * Every write is synchronous: the final file is written from a process `exit`
 * handler, which can't wait for promises, and sync writes can't interleave.
 *
 * Port of the Python SDK's `lmnr/sdk/trajectory/writer.py`.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { BuildOptions, buildTrajectory, SpanRecord } from "./builder";
import { MediaSink } from "./normalize";

// Placeholders `LMNR_TRAJECTORY_PATH` may contain.
export const TRACE_ID = "{trace_id}";
export const PID = "{pid}";

// ATIF's media convention: an `images/` directory next to the trajectory file.
export const IMAGES_DIR = "images";
const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};
// `base64.b64decode(data, validate=True)`: the alphabet and padding only.
const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** The file path for a template, with `~` expanded and placeholders filled. */
export const renderPath = (
  template: string,
  traceId?: string,
  pid?: number,
): string => {
  let result = template.split(PID).join(String(pid ?? process.pid));
  if (traceId !== undefined) {
    result = result.split(TRACE_ID).join(traceId);
  }
  if (result === "~" || result.startsWith("~/")) {
    result = path.join(homedir(), result.slice(1));
  }
  return result;
};

/** Write JSON so a reader never sees a half-written file, even if the
 * process is killed mid-write: a temporary file in the same directory is
 * renamed over the target. */
export const writeJsonAtomic = (file: string, value: unknown): void => {
  const directory = path.dirname(file);
  mkdirSync(directory, { recursive: true });
  const tmp = path.join(
    directory,
    `.${path.basename(file)}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
    renameSync(tmp, file);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // Never created, or already renamed.
    }
    throw error;
  }
};

/** A `MediaSink` that stores images under `<directory>/images/`, named by
 * content hash, and returns their path relative to `directory`. */
export const mediaSink =
  (directory: string): MediaSink =>
  (data, mediaType) => {
    const extension = EXTENSIONS[mediaType];
    if (extension === undefined || !BASE64.test(data)) {
      return null;
    }
    const content = Buffer.from(data, "base64");
    const hash = createHash("sha256").update(content).digest("hex");
    const name = `${hash.slice(0, 32)}.${extension}`;
    const target = path.join(directory, IMAGES_DIR, name);
    if (!existsSync(target)) {
      mkdirSync(path.dirname(target), { recursive: true });
      const tmp = path.join(
        path.dirname(target),
        `.${name}.${process.pid}.tmp`,
      );
      writeFileSync(tmp, content);
      renameSync(tmp, target);
    }
    return `${IMAGES_DIR}/${name}`;
  };

/**
 * Build and write the trajectory files for `records`.
 *
 * With `{trace_id}` in the template, each trace gets its own file; otherwise
 * every trace goes into one. A file is a snapshot (`complete: false`) when a
 * trace it covers is in `openTraceIds`, so a finished trace's own file stays
 * complete while another trace runs. Returns the paths written (none when
 * there were no LLM or tool calls).
 */
export const writeTrajectories = (
  records: Iterable<SpanRecord>,
  template: string,
  options: BuildOptions,
  openTraceIds: ReadonlySet<string> = new Set(),
): string[] => {
  const groups = new Map<string | null, SpanRecord[]>();
  const perTrace = template.includes(TRACE_ID);
  for (const record of records) {
    const key = perTrace ? record.trace_id : null;
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }

  const written: string[] = [];
  for (const [traceId, group] of groups) {
    const file = renderPath(template, traceId ?? undefined);
    const isOpen =
      traceId !== null ? openTraceIds.has(traceId) : openTraceIds.size > 0;
    const trajectory = buildTrajectory(group, {
      ...options,
      media: mediaSink(path.dirname(file)),
      complete: (options.complete ?? true) && !isOpen,
    });
    if (trajectory === null) {
      continue;
    }
    writeJsonAtomic(file, trajectory);
    written.push(file);
  }
  return written;
};
