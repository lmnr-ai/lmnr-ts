// cross-spawn: resolves Windows .cmd/.ps1 shims that node:child_process can't run by bare name.
import spawn from "cross-spawn";

import { missingTool } from "../../errors";

/** Exit code of `command`, with its output on our stderr (stdout stays data-only). */
export const runCommand = (
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<number> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["inherit", 2, 2],
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      reject(
        error.code === "ENOENT"
          ? missingTool(`\`${command}\` is not installed or not on PATH.`)
          : error,
      );
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
