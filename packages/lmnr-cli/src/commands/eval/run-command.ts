// cross-spawn: resolves Windows .cmd/.ps1 shims that node:child_process can't run by bare name.
import spawn from "cross-spawn";

import { missingTool } from "../../errors";

/**
 * Exit code of `command`, with its output on our stderr (stdout stays
 * data-only). With `onOutput`, the output also goes to it, as text, along
 * with the stream it came from.
 */
export type OutputListener = (
  chunk: string,
  stream: "stdout" | "stderr",
) => void;

export const runCommand = (
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    onOutput?: OutputListener;
  } = {},
): Promise<number> =>
  new Promise((resolve, reject) => {
    const { onOutput } = options;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: onOutput ? ["inherit", "pipe", "pipe"] : ["inherit", 2, 2],
    });
    if (onOutput) {
      for (const [name, stream] of [
        ["stdout", child.stdout],
        ["stderr", child.stderr],
      ] as const) {
        stream?.setEncoding("utf8");
        stream?.on("data", (chunk: string) => {
          process.stderr.write(chunk);
          onOutput(chunk, name);
        });
      }
    }
    child.on("error", (error: NodeJS.ErrnoException) => {
      reject(
        error.code === "ENOENT"
          ? missingTool(`\`${command}\` is not installed or not on PATH.`)
          : error,
      );
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
