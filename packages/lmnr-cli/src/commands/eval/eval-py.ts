import { stat } from "node:fs/promises";
import path from "node:path";

import { errorMessage } from "@lmnr-ai/types";
import { parse as parseToml } from "smol-toml";

import { invalidEvalsDir } from "../../errors";
import { initializeLogger } from "../../utils/logger";
import type { JobConfig } from "./datasets";

const logger = initializeLogger();

/**
 * A dataset can be one Python file: `<folder>/agent/eval.py` with an
 * `EvalRunner` subclass (`lmnr.evals`). `python -m lmnr.evals.describe`
 * (`describe.ts`) turns it into an {@link EvalDescription}, and the job config
 * Harbor gets runs it through `lmnr`'s Harbor adapters.
 */
export const EVAL_PY = "agent/eval.py";
export const LAMINAR_AGENT_IMPORT_PATH =
  "lmnr.integrations.harbor.runner:LaminarAgent";
export const LAMINAR_VERIFIER_IMPORT_PATH =
  "lmnr.integrations.harbor.runner:LaminarVerifier";
/** The `version` of describe's JSON this CLI reads. */
const DESCRIBE_VERSION = 1;

/** One base, service or builder step of an image, and where it was declared. */
interface EvalImageStep {
  origin: string;
  step: string;
}

/**
 * A Dockerfile lmnr generated (builder steps, services): BuildKit syntax,
 * COPY / bind-mount sources relative to `context`, `#` comment lines naming
 * where each step was declared.
 */
export interface GeneratedImage {
  kind: "generated";
  dockerfile_text: string;
  context: string;
  /** The ignore file to build with instead of the context's `.dockerignore`. */
  ignore_file?: string;
  steps?: EvalImageStep[];
}

export type EvalImage =
  | {
      kind: "dockerfile";
      dockerfile: string;
      context: string;
      steps?: EvalImageStep[];
    }
  | { kind: "registry"; ref: string; steps?: EvalImageStep[] }
  | GeneratedImage;

/** A service the runner declares (`Postgres("16")`), started in its image. */
interface EvalService {
  name: string;
  kind: string;
  version: string;
  /** The image the service is installed from (none for an install-only custom service). */
  source: string | null;
  /** Env var names the service sets for the app. */
  env: string[];
  /** Where it was declared (none without a call site). */
  origin: string | null;
}

/** `python -m lmnr.evals.describe agent/eval.py`'s output. */
export interface EvalDescription {
  version: number;
  /** The `EvalRunner` subclass. */
  runner: string;
  /** By name; paths are absolute (resolved where describe ran). */
  images: Record<string, EvalImage>;
  default_image: string;
  model: string | null;
  /** The container env; secrets are `${NAME}` placeholders. */
  env: Record<string, string>;
  /** Env var names lmnr-cli must resolve, like a required `${VAR}`. */
  secrets: string[];
  /** `task.toml` tables written into tasks that have no `task.toml` yet. */
  new_task_toml: Record<string, unknown>;
  /**
   * Grade with Harbor's default verifier (each task's tests/test.sh, in the
   * container) instead of the runner's `verify()`.
   */
  grade_with_test_sh: boolean;
  warnings: string[];
  /**
   * The runner's module files, relative to the evals root (`eval.py` and any
   * shared module it imports, e.g. `_shared/support.py`). Optional: older lmnr
   * versions don't report it.
   */
  modules?: string[];
  /**
   * The runner's `artifacts`, as Harbor job config entries (container paths
   * or `{source, destination?, exclude?}`). Optional: older lmnr versions
   * don't report it.
   */
  artifacts?: EvalArtifact[];
  /** The runner's services. Optional, like the fields below: older lmnr versions don't report them. */
  services?: EvalService[];
  /**
   * The runner class, then its bases, with their files (relative to the evals
   * root, absolute outside it, null when unknown).
   */
  classes?: { name: string; file: string | null }[];
  /** The runner's mocks. Optional, like the fields below (lmnr phase 3). */
  mocks?: EvalMock[];
  /** pip requirements installed next to the mock server. */
  mock_dependencies?: string[];
  /** The Laminar layer every image gets (Python + lmnr in `/opt/lmnr`). */
  laminar_layer?: LaminarLayer;
}

/** A mock: `type` function (an observed function's mock key) or http. */
interface EvalMock {
  key: string;
  type: "function" | "http";
  /** `<module>:<function>`, `__runner__` being eval.py. */
  handler: string;
  /** HTTP mocks: the env var the app reads the mock's base URL from. */
  base_url_env?: string;
}

interface LaminarLayer {
  python: string;
  /** The lmnr requirement it installs; null for the `lmnr-dev` wheel. */
  lmnr: string | null;
  /** Named build contexts every generated image reads, and what goes there. */
  build_contexts: Record<string, string>;
}

type EvalArtifact =
  | string
  | { source: string; destination?: string; exclude?: string[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const evalPyPath = (datasetDir: string): string =>
  path.join(datasetDir, ...EVAL_PY.split("/"));

export const hasEvalPy = (datasetDir: string): Promise<boolean> =>
  stat(evalPyPath(datasetDir)).then(
    (s) => s.isFile(),
    () => false,
  );

/** `agents[].kwargs.runner`: relative to Harbor's cwd, the dataset folder. */
const runnerRef = (description: EvalDescription): string =>
  `${EVAL_PY}:${description.runner}`;

/** What a task names in `docker_image` for an image: its name, or a registry image's ref. */
const taskImageName = (name: string, image: EvalImage | undefined): string =>
  image?.kind === "registry" ? image.ref : name;

export const defaultTaskImage = (description: EvalDescription): string =>
  taskImageName(
    description.default_image,
    description.images[description.default_image],
  );

/** Every `docker_image` a task of the dataset may name. */
export const taskImageNames = (description: EvalDescription): string[] =>
  Object.entries(description.images).map(([name, image]) =>
    taskImageName(name, image),
  );

const PEP_723_BLOCK =
  /^# \/\/\/ ([a-zA-Z0-9-]+)[ \t]*\r?\n((?:^#(?:| .*)\r?\n)*)^# \/\/\/[ \t]*$/gm;

/**
 * The `dependencies` of an inline script metadata block (PEP 723, `# ///
 * script`). They run `verify()` in the Harbor process, so they go to `uvx
 * --with`.
 */
export const parseScriptDependencies = (text: string, file: string) => {
  const blocks = [...text.matchAll(PEP_723_BLOCK)].filter(
    (m) => m[1] === "script",
  );
  if (blocks.length === 0) return [];
  if (blocks.length > 1) {
    throw invalidEvalsDir(`${file} has more than one \`# /// script\` block.`);
  }
  const toml = blocks[0][2]
    .split(/\r?\n/)
    .map((line) => (line.startsWith("# ") ? line.slice(2) : line.slice(1)))
    .join("\n");
  let metadata: Record<string, unknown>;
  try {
    metadata = parseToml(toml);
  } catch (error) {
    throw invalidEvalsDir(
      `${file}: can't parse its \`# /// script\` block: ${errorMessage(error)}`,
    );
  }
  const deps = metadata.dependencies ?? [];
  if (!Array.isArray(deps) || !deps.every((d) => typeof d === "string")) {
    throw invalidEvalsDir(
      `${file}: \`dependencies\` in its \`# /// script\` block must be a list ` +
        "of requirement strings.",
    );
  }
  return deps as string[];
};

const isImage = (image: unknown): image is EvalImage => {
  if (!isRecord(image)) return false;
  switch (image.kind) {
    case "registry":
      return typeof image.ref === "string";
    case "dockerfile":
      return (
        typeof image.dockerfile === "string" &&
        typeof image.context === "string"
      );
    case "generated":
      return (
        typeof image.dockerfile_text === "string" &&
        typeof image.context === "string" &&
        (image.ignore_file === undefined ||
          typeof image.ignore_file === "string")
      );
    default:
      return false;
  }
};

/** Check describe's JSON against what this CLI reads. */
export const parseDescription = (
  stdout: string,
  file: string,
): EvalDescription => {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch (error) {
    throw invalidEvalsDir(
      `Describing ${file} printed no JSON (${errorMessage(error)}): ` +
        stdout.slice(0, 500),
    );
  }
  if (!isRecord(raw) || typeof raw.version !== "number") {
    throw invalidEvalsDir(`Describing ${file} printed no versioned JSON.`);
  }
  if (raw.version !== DESCRIBE_VERSION) {
    throw invalidEvalsDir(
      `Describing ${file} printed version ${raw.version}, but this lmnr-cli ` +
        `reads version ${DESCRIBE_VERSION}. Use matching lmnr and lmnr-cli ` +
        "versions.",
    );
  }
  const description = raw as unknown as EvalDescription;
  if (
    typeof description.runner !== "string" ||
    !isRecord(description.images) ||
    !Object.values(description.images).every(isImage) ||
    !(description.default_image in description.images) ||
    !isRecord(description.env) ||
    !Array.isArray(description.secrets) ||
    !isRecord(description.new_task_toml) ||
    typeof description.grade_with_test_sh !== "boolean" ||
    (description.artifacts !== undefined &&
      !Array.isArray(description.artifacts)) ||
    (description.services !== undefined &&
      !Array.isArray(description.services)) ||
    (description.classes !== undefined &&
      !Array.isArray(description.classes)) ||
    (description.mocks !== undefined && !Array.isArray(description.mocks)) ||
    (description.laminar_layer !== undefined &&
      !(
        isRecord(description.laminar_layer) &&
        isRecord(description.laminar_layer.build_contexts)
      ))
  ) {
    throw invalidEvalsDir(`Describing ${file} printed an unexpected shape.`);
  }
  return description;
};

/**
 * Descriptions by dataset dir, filled once per run before any job config is
 * built (`describeDatasets`, or a remote run's spec in the orchestrator).
 */
const descriptions = new Map<string, EvalDescription>();

export const setEvalDescription = (
  datasetDir: string,
  description: EvalDescription,
): void => {
  descriptions.set(path.resolve(datasetDir), description);
};

/**
 * Log describe's warnings (e.g. a service on version "latest"). Every run
 * does, local or in a remote run's orchestrator, so they reach the run's log.
 */
export const logEvalWarnings = (
  folder: string,
  description: EvalDescription,
): void => {
  for (const warning of description.warnings) {
    logger.warn(`${folder}/${EVAL_PY}: ${warning}`);
  }
};

export const evalDescription = (datasetDir: string): EvalDescription => {
  const description = descriptions.get(path.resolve(datasetDir));
  if (!description) {
    throw new Error(
      `${evalPyPath(datasetDir)} was not described before its job config was built`,
    );
  }
  return description;
};

/**
 * The job config of an `eval.py` dataset: its harbor.yaml (if any) plus what
 * eval.py owns. eval.py owns the images, the agent (import path, kwargs, env)
 * the verifier's import path and the job-level `artifacts` (task.toml
 * `artifacts` still add to them); harbor.yaml defining one of them too is an
 * error, so nobody has to merge two lists in their head. harbor.yaml `agents`
 * entries without an import path each run the runner with their own
 * `model_name` / extra `kwargs` (a model sweep). eval.py's `model` is the
 * default model; harbor.yaml and `--model` win. Everything else (concurrency,
 * attempts, retries, environment, other `verifier` keys, `datasets`) is
 * harbor.yaml's, with `datasets: [{path: tasks}]` by default.
 */
export const applyEvalRunner = (
  config: JobConfig,
  description: EvalDescription,
  configFile: string,
): JobConfig => {
  const both = `${configFile} and ${EVAL_PY} both define`;
  const job: JobConfig = structuredClone(config);
  if (job.images != null) {
    throw invalidEvalsDir(
      `${both} images. Declare them only in ${EVAL_PY} (\`image = ...\`).`,
    );
  }
  if (job.artifacts != null) {
    throw invalidEvalsDir(
      `${configFile} sets artifacts, but ${EVAL_PY} owns them. Declare them ` +
        "on the runner (`artifacts = [...]`); a task.toml's `artifacts` " +
        "still add to them.",
    );
  }
  const kwargs = { runner: runnerRef(description) };
  const model = description.model ?? undefined;

  const entries = job.agents ?? [];
  if (!Array.isArray(entries) || !entries.every(isRecord)) {
    throw invalidEvalsDir(`${configFile}: agents must be a list of mappings.`);
  }
  const sweep = entries.length > 0 ? entries : [{}];
  job.agents = sweep.map((entry, i) => {
    const where = `${configFile} agents[${i}]`;
    for (const key of ["import_path", "name"] as const) {
      if (entry[key] != null) {
        throw invalidEvalsDir(
          `${where} sets ${key}, but ${EVAL_PY} is the agent. Remove it: an ` +
            "agents entry without one runs the runner with its own model_name.",
        );
      }
    }
    if (entry.env != null) {
      throw invalidEvalsDir(
        `${both} the agent env. Set it only in ${EVAL_PY} (\`env = {...}\`).`,
      );
    }
    const extra = entry.kwargs ?? {};
    if (!isRecord(extra) || "runner" in extra) {
      throw invalidEvalsDir(
        `${where}.kwargs must be a mapping without \`runner\`.`,
      );
    }
    const modelName = entry.model_name ?? model;
    return {
      ...entry,
      import_path: LAMINAR_AGENT_IMPORT_PATH,
      kwargs: { ...extra, ...kwargs },
      env: { ...description.env },
      ...(modelName != null ? { model_name: modelName } : {}),
    };
  });

  if (!description.grade_with_test_sh) {
    const verifier = job.verifier ?? {};
    if (!isRecord(verifier)) {
      throw invalidEvalsDir(`${configFile}: verifier must be a mapping.`);
    }
    if (verifier.import_path != null || verifier.kwargs != null) {
      throw invalidEvalsDir(
        `${both} the verifier. Remove verifier.import_path / kwargs, or set ` +
          `grade_with_test_sh = True in ${EVAL_PY} to grade with each task's ` +
          "tests/test.sh.",
      );
    }
    job.verifier = {
      ...verifier,
      import_path: LAMINAR_VERIFIER_IMPORT_PATH,
      kwargs,
    };
  }

  if (job.datasets === undefined && job.tasks === undefined) {
    job.datasets = [{ path: "tasks" }];
  }
  if (description.artifacts?.length) {
    job.artifacts = structuredClone(description.artifacts);
  }
  // The images are built from the description (`loadImageDefs`), not `images`.
  return job;
};
