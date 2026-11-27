import path from "node:path";

import { stringify as stringifyToml } from "smol-toml";

import type { GlobalOpts } from "../../auth/with-client";
import { emitData, outputJson } from "../../utils/output";
import { DEFAULT_EVALS_DIR } from "./dataset-command";
import { loadDatasetConfig } from "./datasets";
import { describeEvalPy } from "./describe";
import {
  EVAL_PY,
  type EvalDescription,
  type EvalImage,
  hasEvalPy,
  setEvalDescription,
} from "./eval-py";
import { GENERATED_UPLOAD_DIR, generatedDockerfileName } from "./images";
import { selectDatasets } from "./index";

interface EvalDescribeOpts extends GlobalOpts {
  dir?: string;
}

const list = (items: string[]) =>
  items.length > 0 ? items.join(", ") : "none";

const indent = (lines: string[], by = "  ") => lines.map((l) => by + l);

/** `steps` as aligned `<step>  <origin>` lines. */
const formatSteps = (steps: EvalImage["steps"] = []) => {
  const width = Math.max(0, ...steps.map((s) => s.step.length));
  return steps.map(({ step, origin }) => `${step.padEnd(width)}  ${origin}`);
};

const imageKind = (image: EvalImage): string => {
  switch (image.kind) {
    case "registry":
      return `registry ${image.ref}`;
    case "dockerfile":
      return `dockerfile ${image.dockerfile}, context ${image.context}`;
    case "generated":
      return (
        `generated, context ${image.context}` +
        (image.ignore_file ? `, ignore file ${image.ignore_file}` : "")
      );
  }
};

/**
 * One dataset's runner, human-readable. `jobsDir` is where its local runs
 * write jobs (shown relative to the cwd), for where generated Dockerfiles
 * are kept.
 */
const formatDescription = (
  folder: string,
  description: EvalDescription,
  jobsDir: string,
): string => {
  const body: string[] = [`runner: ${description.runner}`];
  if (description.classes?.length) {
    const width = Math.max(...description.classes.map((c) => c.name.length));
    body.push(
      ...indent(
        description.classes.map(
          (c) => `${c.name.padEnd(width)}  ${c.file ?? "(file unknown)"}`,
        ),
      ),
    );
  }
  body.push(`model: ${description.model ?? "none"}`);

  body.push("images:");
  for (const [name, image] of Object.entries(description.images)) {
    const tags = [
      ...(name === description.default_image ? ["default"] : []),
      imageKind(image),
    ];
    const entry = [`${name} (${tags.join("; ")})`];
    entry.push(...indent(formatSteps(image.steps)));
    if (image.kind === "generated") {
      const file = generatedDockerfileName(name);
      entry.push(
        ...indent([
          "generated Dockerfile, kept by each run that builds it:",
          `  local:  ${path.join(jobsDir, "<job>", file)}`,
          `  remote: ${folder}/${GENERATED_UPLOAD_DIR}/${file} in the run's files`,
        ]),
      );
    }
    body.push(...indent(entry));
  }

  const services = description.services ?? [];
  body.push(`services:${services.length > 0 ? "" : " none"}`);
  for (const s of services) {
    body.push(
      ...indent([
        `${s.name}: ${s.kind} ${s.version} from ${s.source}`,
        `  env: ${list(s.env)}`,
        `  declared at ${s.origin}`,
      ]),
    );
  }
  body.push("mocks: none");
  body.push(`secrets: ${list(description.secrets)}`);
  body.push(`env: ${list(Object.keys(description.env))}`);
  const toml = stringifyToml(description.new_task_toml).trimEnd();
  body.push(`new_task_toml:${toml ? "" : " none"}`);
  if (toml) body.push(...indent(toml.split("\n")));
  body.push(`grade_with_test_sh: ${description.grade_with_test_sh}`);
  body.push(`warnings:${description.warnings.length > 0 ? "" : " none"}`);
  body.push(...indent(description.warnings.map((w) => `- ${w}`)));
  return [`${folder}/${EVAL_PY}`, ...indent(body)].join("\n");
};

/**
 * `lmnr-cli eval describe [dataset]`: describe each selected eval.py dataset
 * (as `eval run` does first) and print its resolved runner: human-readable,
 * or with `--json` describe's JSON by dataset folder (`null` for a dataset
 * without an eval.py). Both are data, on stdout.
 */
export const handleEvalDescribe = async (
  dataset: string | undefined,
  opts: EvalDescribeOpts,
): Promise<void> => {
  const evalsDir = path.resolve(opts.dir ?? DEFAULT_EVALS_DIR);
  const datasets = await selectDatasets(evalsDir, dataset);
  const described: Record<string, EvalDescription | null> = {};
  for (const folder of datasets) {
    const datasetDir = path.join(evalsDir, folder);
    if (!(await hasEvalPy(datasetDir))) {
      described[folder] = null;
      continue;
    }
    // The output has the warnings; logging them too would print them twice.
    const description = await describeEvalPy(datasetDir, {
      logWarnings: false,
    });
    setEvalDescription(datasetDir, description);
    described[folder] = description;
  }
  if (opts.json) {
    outputJson(described);
    return;
  }

  const blocks: string[] = [];
  for (const [folder, description] of Object.entries(described)) {
    if (!description) {
      blocks.push(`${folder}: no ${EVAL_PY} (a harbor.yaml dataset)`);
      continue;
    }
    const datasetDir = path.join(evalsDir, folder);
    const jobsDir = (await loadDatasetConfig(datasetDir)).jobs_dir;
    blocks.push(
      formatDescription(
        folder,
        description,
        path.relative(
          process.cwd(),
          path.resolve(
            datasetDir,
            typeof jobsDir === "string" ? jobsDir : "jobs",
          ),
        ),
      ),
    );
  }
  emitData(`${blocks.join("\n\n")}\n`);
};
