import { type CommandBlockContent, errorMessage } from "@lmnr-ai/types";
import type { Command } from "commander";

import { buildLaminarClient } from "../auth/client";
import type { GlobalOpts } from "../auth/with-client";
import { getCapturedOutput } from "./command-capture";
import { readDebugSessionFile, resolveDebugSessionDir } from "./debug-session-file";
import { initializeLogger } from "./logger";

const logger = initializeLogger();

/** Allowlist of commands recorded into an active debug session, by command path. */
const TRACKED_COMMANDS = new Set(["sql query", "ask"]);

// Best-effort tracking must never delay the command's exit. Cap the network
// round-trip so a stalled server can't hang an allowlisted command past its
// already-decided exit code; on timeout we abandon the request and move on.
const TRACKING_TIMEOUT_MS = 3_000;

/** Race `work` against a timer, clearing (and unref-ing) it so it never holds the loop. */
const withTimeout = async <T>(work: Promise<T>, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
};

/** Extra opts on tracked commands: `--no-track` → `track`, `--reasoning` → `reasoning`. */
type TrackOpts = GlobalOpts & { track?: boolean; reasoning?: string };

/**
 * Attach the `--no-track` and `--reasoning` flags shared by every tracked command.
 * One place keeps the flags in sync with the allowlist. Returns the command for chaining.
 */
export const withTrackingOptions = (cmd: Command): Command =>
  cmd
    .option(
      "--no-track",
      "Do not record this command into the active debug session " +
      "(also: LMNR_NO_COMMAND_TRACKING=1)",
    )
    .option(
      "--reasoning <text>",
      // "15 words maximum" is guidance only — any-length text is recorded verbatim.
      "Agent reasoning to track with the Debugger session. Why are you calling " +
      "this command? Limit 15 words maximum.",
    );

/** Space-joined command path (e.g. `"sql query"`), excluding the program root. */
export const commandPath = (cmd: Command): string => {
  const names: string[] = [];
  let cur: Command | undefined = cmd;
  // The parent-less command is the program root — stop before prepending it.
  while (cur && cur.parent) {
    names.unshift(cur.name());
    cur = cur.parent ?? undefined;
  }
  return names.join(" ");
};

/** Whether `path` is on the record-into-session allowlist. */
export const isTrackedCommand = (path: string): boolean => TRACKED_COMMANDS.has(path);

/** Opted out via `--no-track` or `LMNR_NO_COMMAND_TRACKING` (`1`/`true`/`yes`). */
export const trackingDisabled = (opts: TrackOpts): boolean => {
  if (opts.track === false) return true;
  const env = process.env.LMNR_NO_COMMAND_TRACKING?.trim().toLowerCase();
  return env === "1" || env === "true" || env === "yes";
};

/**
 * Best-effort: record an allowlisted command into the active debug session as a
 * `command` block. Called from the error envelope (`runWithEnvelope`) — the only
 * place that knows a command finished AND its real exit code (Commander has no
 * on-error hook, so a `postAction` hook would only see successes).
 *
 * Every failure is swallowed so tracking never changes the command's outcome or
 * exit code. The no-session path is silent EXCEPT when `--reasoning` was passed,
 * which the caller clearly expected to be recorded.
 *
 * The fatal error is logged AFTER this runs, so the tee doesn't have it — the
 * envelope passes it as `errorText`, appended to the teed output.
 *
 * @param exitCode resolved exit code of the wrapped command (0 = success).
 * @param errorText fatal error message on the failure path, else undefined.
 */
export const maybeTrackCommand = async (
  actionCommand: Command,
  exitCode: number,
  errorText?: string,
): Promise<void> => {
  try {
    const opts = actionCommand.optsWithGlobals();
    if (trackingDisabled(opts)) return;

    const path = commandPath(actionCommand);
    if (!isTrackedCommand(path)) return;

    const sessionId = readDebugSessionFile(resolveDebugSessionDir())?.session_id;
    if (!sessionId) {
      // No session is normal, so stay silent — unless reasoning was passed.
      if (opts.reasoning) {
        logger.warn(
          "--reasoning was provided but there is no active debug session in " +
          "this directory, so it was not recorded. Start one with " +
          "`lmnr-cli debug session new`.",
        );
      }
      return;
    }

    // Cap the whole round-trip so a stalled server can't delay the command's exit.
    await withTimeout(
      (async () => {
        const client = await buildLaminarClient({
          projectId: opts.projectId,
          baseUrl: opts.baseUrl,
          port: opts.port,
        });
        // Fold the fatal error into the teed diagnostics (either may be empty).
        const { stdout, stderr: capturedStderr } = getCapturedOutput();
        const stderr = [capturedStderr, errorText].filter(Boolean).join("\n") || null;

        // Typed against the shared contract so a field rename in @lmnr-ai/types
        // is a compile error, not a silent drop.
        const content: CommandBlockContent = {
          command: path,
          args: actionCommand.args ?? [],
          exitCode,
          output: stdout,
          stderr,
          reasoning: opts.reasoning ?? null,
        };

        await client.rolloutSessions.addBlock({
          sessionId,
          type: "command",
          content,
          // A 404 (unsupported endpoint) is swallowed, never thrown.
          failOnNotFound: false,
        });
      })(),
      TRACKING_TIMEOUT_MS,
    );
  } catch (err) {
    // Debug-level so tracking stays invisible on a normal run.
    logger.debug(`Command tracking skipped: ${errorMessage(err)}`);
  }
};
