import { errorMessage } from "@lmnr-ai/types";
import type { Command } from "commander";

import { buildLaminarClient } from "../auth/client";
import type { GlobalOpts } from "../auth/with-client";
import { getCapturedOutput } from "./command-capture";
import { readDebugSessionFile, resolveDebugSessionDir } from "./debug-session-file";
import { initializeLogger } from "./logger";

const logger = initializeLogger();

/**
 * CLI commands worth recording into an active debug session — the investigative
 * ones a reviewer wants to see the agent ran, keyed by the space-joined command
 * path. Everything else is deliberately excluded as noise / self-referential:
 * `login`, `logout`, `setup`, `skill *`, `plugin *`, `project *`, `status`, and
 * all `debug session *` (including `add-note`).
 */
const TRACKED_COMMANDS = new Set(["sql query", "ask"]);

/**
 * Extra opts the tracked commands carry: commander's `--no-track` → `track:false`,
 * and `--reasoning <text>` → `reasoning`. Both are attached via
 * {@link withTrackingOptions} rather than per-command.
 */
type TrackOpts = GlobalOpts & { track?: boolean; reasoning?: string };

/**
 * Attach the flags shared by every tracked command (see {@link TRACKED_COMMANDS}):
 * the `--no-track` opt-out and `--reasoning` capture. Applying this in one place —
 * rather than re-declaring the flags per command — keeps the tracked-command flag
 * surface in sync with the allowlist it pairs with. Returns the same command for
 * chaining (`.action(...)`, `.addHelpText(...)`).
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
      // The "15 words maximum" is guidance to keep agents terse — it is NOT
      // enforced; any-length text is accepted and recorded verbatim.
      "Agent reasoning to track with the Debugger session. Why are you calling " +
      "this command? Limit 15 words maximum.",
    );

/**
 * The space-joined path of a command (e.g. `"sql query"`, `"ask"`), walking up
 * to — but not including — the program root, whose name isn't part of the path.
 */
export const commandPath = (cmd: Command): string => {
  const names: string[] = [];
  let cur: Command | undefined = cmd;
  // A command with no parent is the program root — stop before prepending it.
  while (cur && cur.parent) {
    names.unshift(cur.name());
    cur = cur.parent ?? undefined;
  }
  return names.join(" ");
};

/** Whether `path` is on the record-into-session allowlist. */
export const isTrackedCommand = (path: string): boolean => TRACKED_COMMANDS.has(path);

/**
 * Whether tracking is opted out — via the `--no-track` flag (`track === false`)
 * or the `LMNR_NO_COMMAND_TRACKING` env var (`1` / `true` / `yes`).
 */
export const trackingDisabled = (opts: TrackOpts): boolean => {
  if (opts.track === false) return true;
  const env = process.env.LMNR_NO_COMMAND_TRACKING?.trim().toLowerCase();
  return env === "1" || env === "true" || env === "yes";
};

/**
 * Best-effort: record an allowlisted CLI command into the active debug session
 * as a `command` block, so a reviewer sees which investigative commands the
 * agent ran — and how each one turned out. Called from the command error
 * envelope (`runWithEnvelope`), which is the one place that knows both that a
 * command finished AND its real exit code (0 on success, the mapped code on
 * failure) — Commander itself has no on-error hook, so a plain `postAction`
 * hook would only ever see successes.
 *
 * Every failure mode is swallowed — no active session, no linked project, a
 * network error, a 404 from a server that doesn't know the block type — because
 * tracking must NEVER change the wrapped command's outcome, output, or exit
 * code. On the no-session path it returns silently — EXCEPT when `--reasoning`
 * was supplied, where it warns that the reasoning went unrecorded (a caller that
 * bothered to pass reasoning expected it to land somewhere).
 *
 * Captured stdout/stderr (via the `emitData`/`emitErr` sinks + the logger tee)
 * ride along so a reviewer sees not just which command ran but what it produced.
 * The fatal error on a failure is logged AFTER this runs (the envelope's terminal
 * output is intentionally last), so the tee can't have it yet — the envelope
 * passes it explicitly as `errorText`, appended to whatever the tee captured.
 *
 * @param exitCode the resolved exit code of the wrapped command (0 = success).
 * @param errorText the fatal error message on the failure path, else undefined.
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
      // No session is the normal case, so stay silent — unless reasoning was
      // passed, which the caller clearly expected to be recorded somewhere.
      if (opts.reasoning) {
        logger.warn(
          "--reasoning was provided but there is no active debug session in " +
          "this directory, so it was not recorded. Start one with " +
          "`lmnr-cli debug session new`.",
        );
      }
      return;
    }

    const client = await buildLaminarClient({
      projectId: opts.projectId,
      baseUrl: opts.baseUrl,
      port: opts.port,
    });
    // Fold the explicit fatal error into the teed diagnostics (either may be
    // empty). `getCapturedOutput` already caps each field.
    const { stdout, stderr: capturedStderr } = getCapturedOutput();
    const stderr = [capturedStderr, errorText].filter(Boolean).join("\n") || null;

    await client.rolloutSessions.addBlock({
      sessionId,
      type: "command",
      content: {
        command: path,
        args: actionCommand.args ?? [],
        exitCode,
        output: stdout,
        stderr,
        reasoning: opts.reasoning ?? null,
      },
      // Best-effort: a missing session / unsupported endpoint (404) is logged and
      // swallowed, never thrown — an exit 0 from the real command stays exit 0.
      failOnNotFound: false,
    });
  } catch (err) {
    // Debug-level (below the default `info`) so tracking stays invisible unless
    // a user opts into verbose logs; it must never surface on a normal run.
    logger.debug(`Command tracking skipped: ${errorMessage(err)}`);
  }
};
