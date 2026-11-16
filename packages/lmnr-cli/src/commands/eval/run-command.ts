// cross-spawn: resolves Windows .cmd/.ps1 shims that node:child_process can't run by bare name.
import spawn from "cross-spawn";

import { missingTool } from "../../errors";

/** Takes a stream's text as it comes, then `end` once the stream is done. */
export interface OutputSink {
  write: (chunk: string) => void;
  end: () => void;
}

/** Where a command's stdout and stderr also go. */
export interface CommandOutput {
  stdout: OutputSink;
  stderr: OutputSink;
}

/**
 * Exit code of `command`, with its output on our stderr (stdout stays
 * data-only). With `output`, each stream also goes to its sink, as text, and
 * both sinks have ended by the time this resolves.
 */
export const runCommand = (
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    output?: CommandOutput;
  } = {},
): Promise<number> =>
  new Promise((resolve, reject) => {
    const { output } = options;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: output ? ["inherit", "pipe", "pipe"] : ["inherit", 2, 2],
    });
    if (output) {
      for (const [sink, stream] of [
        [output.stdout, child.stdout],
        [output.stderr, child.stderr],
      ] as const) {
        stream?.setEncoding("utf8");
        stream?.on("data", (chunk: string) => {
          process.stderr.write(chunk);
          sink.write(chunk);
        });
        // Before "close", which fires once both streams have ended.
        stream?.on("end", sink.end);
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
