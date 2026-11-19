import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { errorMessage } from "@lmnr-ai/types";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

import { invalidEvalsDir } from "../../errors";
import {
  DATASET_TOML,
  isValidHash,
  isValidName,
  NAME_RULE,
  TASKS_DIR,
} from "./datasets";

/** A dataset's pins: task name → the version hash it runs. */
export type TaskPins = Record<string, string>;

/**
 * `<dataset>/tasks/dataset.toml`, Harbor's dataset manifest: `[dataset] name`
 * is the dataset's name in Laminar, `[[tasks]] {name, digest}` its pins
 * (`null` when it lists no tasks: pull then takes Laminar's latest). Every
 * other key is kept as it is when the pins are rewritten.
 */
export interface DatasetManifest {
  name: string;
  pins: TaskPins | null;
  /** Leading comment lines, kept on rewrite (Harbor does the same). */
  header: string;
  doc: Record<string, unknown>;
}

const DIGEST = /^sha256:([0-9a-f]{64})$/;

/** Bytewise (UTF-8) order, the way Laminar sorts task ids. */
export const compareBytes = (a: string, b: string): number =>
  Buffer.compare(Buffer.from(a), Buffer.from(b));

const isTable = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const manifestPath = (datasetDir: string): string =>
  path.join(datasetDir, TASKS_DIR, DATASET_TOML);

/** Parse a `dataset.toml`; `file` is only for messages. */
export const parseDatasetToml = (
  text: string,
  file: string,
): DatasetManifest => {
  let doc: Record<string, unknown>;
  try {
    doc = parseToml(text);
  } catch (error) {
    throw invalidEvalsDir(`Can't parse ${file}: ${errorMessage(error)}`);
  }
  const dataset = doc.dataset;
  if (!isTable(dataset) || !isValidName(dataset.name)) {
    throw invalidEvalsDir(
      `${file}: [dataset] name must be the dataset's name in Laminar, e.g. ` +
        `name = "my-org/support". ${NAME_RULE}`,
    );
  }
  let pins: TaskPins | null = null;
  if (doc.tasks !== undefined) {
    if (!Array.isArray(doc.tasks)) {
      throw invalidEvalsDir(`${file}: tasks must be a list of [[tasks]].`);
    }
    pins = {};
    for (const task of doc.tasks) {
      const name = isTable(task) ? task.name : undefined;
      if (!isValidName(name)) {
        throw invalidEvalsDir(
          `${file}: invalid task name ${JSON.stringify(name)}. ${NAME_RULE}`,
        );
      }
      const digest = DIGEST.exec(
        typeof task.digest === "string" ? task.digest : "",
      );
      if (!digest || !isValidHash(digest[1])) {
        throw invalidEvalsDir(
          `${file}: the digest of task ${name} must be "sha256:" and 64 ` +
            "lowercase hex characters.",
        );
      }
      if (name in pins) {
        throw invalidEvalsDir(`${file}: task ${name} is listed twice.`);
      }
      pins[name] = digest[1];
    }
  }
  const header = /^(?:[ \t]*(?:#[^\n]*)?\r?\n)*/.exec(text)?.[0] ?? "";
  return { name: dataset.name, pins, header, doc };
};

/**
 * The manifest's text with `pins` as its `[[tasks]]` (sorted by name):
 * top-level keys, `[dataset]`, `[[tasks]]`, `[[files]]`, `[metadata]`, then
 * any other table, the order Harbor writes.
 */
export const formatDatasetToml = (
  manifest: DatasetManifest,
  pins: TaskPins,
): string => {
  const { dataset, tasks: _tasks, files, metadata, ...rest } = manifest.doc;
  const scalars = Object.fromEntries(
    Object.entries(rest).filter(([, v]) => !isTable(v)),
  );
  const tables = Object.fromEntries(
    Object.entries(rest).filter(([, v]) => isTable(v)),
  );
  const names = Object.keys(pins).sort(compareBytes);
  const parts = [
    stringifyToml(names.length === 0 ? { ...scalars, tasks: [] } : scalars),
    stringifyToml({ dataset }),
    names.length > 0
      ? stringifyToml({
          tasks: names.map((name) => ({
            name,
            digest: `sha256:${pins[name]}`,
          })),
        })
      : "",
    Array.isArray(files) && files.length > 0 ? stringifyToml({ files }) : "",
    isTable(metadata) && Object.keys(metadata).length > 0
      ? stringifyToml({ metadata })
      : "",
    Object.keys(tables).length > 0 ? stringifyToml(tables) : "",
  ];
  return (
    manifest.header +
    parts
      .map((part) => part.trim())
      .filter(Boolean)
      .join("\n\n") +
    "\n"
  );
};

/** The dataset's manifest, or null when it has no `tasks/dataset.toml`. */
export const readDatasetToml = async (
  datasetDir: string,
): Promise<DatasetManifest | null> => {
  const file = manifestPath(datasetDir);
  const text = await readFile(file, "utf8").catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  return text === null ? null : parseDatasetToml(text, file);
};

export const writeDatasetToml = async (
  datasetDir: string,
  manifest: DatasetManifest,
  pins: TaskPins,
): Promise<void> => {
  await writeFile(manifestPath(datasetDir), formatDatasetToml(manifest, pins));
};
