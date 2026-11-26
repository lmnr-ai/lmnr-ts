import path from "node:path";

import { invalidEvalsDir } from "../../errors";
import {
  EVAL_PY,
  type EvalDescription,
  evalPyPath,
  hasEvalPy,
  logEvalWarnings,
  parseDescription,
  setEvalDescription,
} from "./eval-py";
import {
  LMNR_PYTHON_VERSION,
  lmnrSpec,
  PYTHON_VERSION,
  pythonRequirements,
} from "./harbor";
import { captureCommand } from "./run-command";

/** uv's own progress lines, which say nothing about the user's file. */
const UV_NOISE =
  /^\s*(Installed|Resolved|Prepared|Downloading|Downloaded|Built|Building|Uninstalled|Audited) /;

/**
 * The `uvx` arguments that describe a dataset's eval.py, from its folder.
 * `requirements` are `pythonRequirements`: importing eval.py needs them.
 */
export const describeArgs = (requirements: string[]): string[] => [
  "--python",
  PYTHON_VERSION,
  "--from",
  lmnrSpec(),
  ...requirements,
  "python",
  "-m",
  "lmnr.evals.describe",
  EVAL_PY,
];

/**
 * Import the dataset's `agent/eval.py` with `lmnr` and `pythonRequirements`,
 * and read its `EvalRunner`: images, env, secrets, task template. Its
 * warnings are logged unless `logWarnings` is false (`eval describe` prints
 * them); an import or configuration error is `invalid_evals_dir` with
 * Python's message.
 */
export const describeEvalPy = async (
  datasetDir: string,
  { logWarnings = true }: { logWarnings?: boolean } = {},
): Promise<EvalDescription> => {
  const file = evalPyPath(datasetDir);
  const { code, stdout, stderr } = await captureCommand(
    "uvx",
    describeArgs(await pythonRequirements(datasetDir)),
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
  if (logWarnings) logEvalWarnings(path.basename(datasetDir), description);
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
