import { mkdtemp, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { dockerFailed, invalidEvalsDir } from "../../errors";
import { captureCommand } from "./run-command";

/**
 * The Laminar layer (lmnr-python `lmnr/evals/layer.py`): Python and `lmnr` in
 * `/opt/lmnr`, in every image of an eval.py runner. It installs the `lmnr`
 * describe runs as (`LMNR_PYTHON_VERSION`), unless `LMNR_EVAL_LMNR_SPEC` says
 * otherwise: a local checkout is built into a wheel here and passed to the
 * build as the `lmnr-dev` named context; any other spec (a git URL) is
 * installed as it is.
 */

/** The named build context describe asks for when the layer installs a wheel. */
const WHEEL_CONTEXT = "lmnr-dev";

/** `LMNR_EVAL_LMNR_SPEC`, when it is a directory (a checkout). */
const localSpec = async (): Promise<string | undefined> => {
  const spec = process.env.LMNR_EVAL_LMNR_SPEC?.trim();
  if (!spec) return undefined;
  const isDir = await stat(spec).then(
    (s) => s.isDirectory(),
    () => false,
  );
  return isDir ? path.resolve(spec) : undefined;
};

/**
 * describe's `--layer-lmnr=` argument: `wheel` for a local checkout, the spec
 * itself for anything else, none without `LMNR_EVAL_LMNR_SPEC`.
 */
export const layerLmnrArgs = async (): Promise<string[]> => {
  const spec = process.env.LMNR_EVAL_LMNR_SPEC?.trim();
  if (!spec) return [];
  return [`--layer-lmnr=${(await localSpec()) ? "wheel" : spec}`];
};

let wheel: Promise<string> | undefined;

/** The checkout's wheel, built once per process (`uv build --wheel`). */
const lmnrWheelDir = (): Promise<string> => {
  wheel ??= (async () => {
    const spec = await localSpec();
    if (!spec) {
      throw invalidEvalsDir(
        `An image needs the ${WHEEL_CONTEXT} build context (an lmnr wheel), but ` +
          "LMNR_EVAL_LMNR_SPEC is not a local lmnr-python checkout.",
      );
    }
    const out = await mkdtemp(path.join(tmpdir(), "lmnr-wheel-"));
    const { code, stderr } = await captureCommand("uv", [
      "build",
      "--wheel",
      "--out-dir",
      out,
      spec,
    ]);
    const built = (await readdir(out)).filter((f) => f.endsWith(".whl"));
    if (code !== 0 || built.length !== 1) {
      throw dockerFailed(
        `Building an lmnr wheel from ${spec} failed (exit ${code}):\n` +
          stderr.slice(-2000),
      );
    }
    return out;
  })();
  return wheel;
};

/** `--build-context` flags for the named contexts a generated image reads. */
export const buildContextArgs = async (names: string[]): Promise<string[]> => {
  const args: string[] = [];
  for (const name of names) {
    if (name !== WHEEL_CONTEXT) {
      throw invalidEvalsDir(
        `An image needs the build context ${name}, which this lmnr-cli doesn't know; ` +
          "use matching lmnr and lmnr-cli versions.",
      );
    }
    args.push("--build-context", `${name}=${await lmnrWheelDir()}`);
  }
  return args;
};
