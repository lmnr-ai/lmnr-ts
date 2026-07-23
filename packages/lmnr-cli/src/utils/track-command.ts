import { errorMessage } from "@lmnr-ai/types";
import type { Command } from "commander";

import { buildLaminarClient } from "../auth/client";
import type { GlobalOpts } from "../auth/with-client";
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

/** Extra opt the tracked commands carry (commander's `--no-track` → `track:false`). */
type TrackOpts = GlobalOpts & { track?: boolean };

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
 * code. On the no-session path it returns silently with no output at all.
 *
 * @param exitCode the resolved exit code of the wrapped command (0 = success).
 */
export const maybeTrackCommand = async (
  actionCommand: Command,
  exitCode: number,
): Promise<void> => {
  try {
    const opts = actionCommand.optsWithGlobals();
    if (trackingDisabled(opts)) return;

    const path = commandPath(actionCommand);
    if (!isTrackedCommand(path)) return;

    const sessionId = readDebugSessionFile(resolveDebugSessionDir())?.session_id;
    if (!sessionId) return;

    const client = await buildLaminarClient({
      projectId: opts.projectId,
      baseUrl: opts.baseUrl,
      port: opts.port,
    });
    await client.rolloutSessions.addBlock({
      sessionId,
      type: "command",
      content: { command: path, args: actionCommand.args ?? [], exitCode },
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
