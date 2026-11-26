import path from "node:path";

import { invalidEvalsDir } from "../../errors";
import { initializeLogger } from "../../utils/logger";
import {
  EVAL_PY,
  type EvalDescription,
  evalPyPath,
  hasEvalPy,
  parseDescription,
  setEvalDescription,
} from "./eval-py";
import {
  evalDependencies,
  LMNR_PYTHON_VERSION,
  lmnrSpec,
  PYTHON_VERSION,
} from "./harbor";
import { captureCommand } from "./run-command";

const logger = initializeLogger();

/** uv's own progress lines, which say nothing about the user's file. */
const UV_NOISE =
  /^\s*(Installed|Resolved|Prepared|Downloading|Downloaded|Built|Building|Uninstalled|Audited) /;

/** The `uvx` arguments that describe a dataset's eval.py, from its folder. */
export const describeArgs = (dependencies: string[]): string[] => [
  "--python",
  PYTHON_VERSION,
  "--from",
  lmnrSpec(),
  ...dependencies.flatMap((dep) => ["--with", dep]),
  "python",
  "-m",
  "lmnr.evals.describe",
  EVAL_PY,
];

/**
 * Import the dataset's `agent/eval.py` with `lmnr` (and its PEP 723
 * dependencies) and read its `EvalRunner`: images, env, secrets, task
 * template. Its warnings are logged; an import or configuration error is
 * `invalid_evals_dir` with Python's message.
 */
export const describeEvalPy = async (
  datasetDir: string,
): Promise<EvalDescription> => {
  const file = evalPyPath(datasetDir);
  const { code, stdout, stderr } = await captureCommand(
    "uvx",
    describeArgs(await evalDependencies(datasetDir)),
    { cwd: datasetDir, env: process.env },
  );
  if (code !== 0) {
    const message = stderr
      .split(/\r?\n/)
      .filter((line) => line.trim() && !UV_NOISE.test(line))
      .join("\n")
      .slice(-4000);
    const hint = /No module named '?lmnr\.evals/.test(stderr)
      ? `\n${lmnrSpec()} has no lmnr.evals; eval.py datasets need ` +
        `lmnr>=${LMNR_PYTHON_VERSION}.`
      : "";
    throw invalidEvalsDir(`Can't load ${file}:\n${message}${hint}`);
  }
  const description = parseDescription(stdout, file);
  const folder = path.basename(datasetDir);
  for (const warning of description.warnings) {
    logger.warn(`${folder}/${EVAL_PY}: ${warning}`);
  }
  return description;
};

/**
 * Describe the eval.py of each dataset that has one, so its job config can be
 * built (`loadDatasetConfig`). Returns the descriptions by dataset folder,
 * which a remote run ships to its orchestrator.
 */
export const describeDatasets = async (
  evalsDir: string,
  datasets: string[],
): Promise<Record<string, EvalDescription>> => {
  const described: Record<string, EvalDescription> = {};
  for (const dataset of datasets) {
    const datasetDir = path.join(evalsDir, dataset);
    if (!(await hasEvalPy(datasetDir))) continue;
    const description = await describeEvalPy(datasetDir);
    setEvalDescription(datasetDir, description);
    described[dataset] = description;
  }
  return described;
};
