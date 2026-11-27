import path from "node:path";

import type { GlobalOpts } from "../../auth/with-client";
import { invalidEvalsDir } from "../../errors";
import { initializeLogger } from "../../utils/logger";
import { outputJson } from "../../utils/output";
import { describeEvalPy } from "./describe";
import { EVAL_PY, hasEvalPy } from "./eval-py";
import { selectDatasets } from "./index";
import {
  assertTaskDirName,
  logTaskFileChanges,
  writeNewTask,
} from "./task-files";

const logger = initializeLogger();

interface EvalTaskNewOpts extends GlobalOpts {
  dir: string;
}

/**
 * `lmnr-cli eval task new <dataset> <name>`: create `<dataset>/tasks/<name>`
 * (if needed) with the files Harbor needs, for a dataset with an
 * `agent/eval.py`. The dataset is named as for `eval run`: its folder or its
 * `[dataset] name`.
 */
export const handleEvalTaskNew = async (
  dataset: string,
  name: string,
  opts: EvalTaskNewOpts,
): Promise<void> => {
  assertTaskDirName(name);
  const evalsDir = path.resolve(opts.dir);
  const [folder] = await selectDatasets(evalsDir, dataset);
  const datasetDir = path.join(evalsDir, folder);
  if (!(await hasEvalPy(datasetDir))) {
    throw invalidEvalsDir(
      `Dataset ${folder} has no ${EVAL_PY}: \`eval task new\` writes the ` +
        `task files of eval.py datasets. Create a task of a harbor.yaml ` +
        `dataset as a dir in ${path.join(datasetDir, "tasks")}.`,
    );
  }
  const description = await describeEvalPy(datasetDir);
  const { taskDir, changes, missingTestSh } = await writeNewTask(
    datasetDir,
    name,
    description,
  );
  const shown = path.relative(process.cwd(), taskDir) || ".";
  // On stderr, so also with --json.
  if (missingTestSh) {
    logger.warn(
      `${shown} has no tests/test.sh, which grades it: ${EVAL_PY} sets ` +
        `grade_with_test_sh = True. Write one that writes /logs/verifier/reward.txt.`,
    );
  }
  if (opts.json) {
    outputJson({ dir: taskDir, files: changes });
    return;
  }
  logTaskFileChanges(folder, changes);
  if (changes.length === 0) {
    logger.info(`${shown} already has the files Harbor needs`);
  }
};
