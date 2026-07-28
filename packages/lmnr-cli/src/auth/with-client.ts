import { LaminarClient } from "@lmnr-ai/client";
import { errorMessage } from "@lmnr-ai/types";
import type { Command } from "commander";

import { CliError } from "../errors";
import { initializeLogger } from "../utils/logger";
import { outputJsonError } from "../utils/output";
import { maybeTrackCommand } from "../utils/track-command";
import { buildLaminarClient } from "./client";
import { resolveUserToken } from "./resolve";

const logger = initializeLogger();

/**
 * Global options every wrapped command shares (from `cmd.optsWithGlobals()`).
 * `projectId` is used by the project-client path; discovery commands ignore it.
 */
export interface GlobalOpts {
  projectId?: string;
  baseUrl?: string;
  port?: number;
  json?: boolean;
  // `--pretty` selects the human table over the default CSV output (only `sql
  // query` wires it today). On the shared type so handlers read it without a
  // per-command opts type.
  pretty?: boolean;
}

/**
 * Map a thrown error to a process exit code. The default reads
 * `CliError.exitCode` and falls back to 1; pass a custom mapper to override.
 */
export type ExitCodeMapper = (error: unknown) => number;

const defaultExitCode: ExitCodeMapper = (error) =>
  error instanceof CliError ? error.exitCode : 1;

/**
 * Pull the commander positionals out of an `.action(...)` argument list.
 * Commander calls the handler as `(arg1, ..., argN, options, command)`, so the
 * positionals are everything except the trailing `(options, command)`.
 */
function splitCommanderArgs(cmdArgs: unknown[]): {
  positionals: unknown[];
  command: Command;
  opts: GlobalOpts;
} {
  const command = cmdArgs.at(-1) as Command;
  const positionals = cmdArgs.slice(0, -2);
  const opts = command.optsWithGlobals();
  return { positionals, command, opts };
}

/**
 * The error envelope shared by every wrapper: in `--json` mode emit a structured
 * error line and exit with the mapped code, else log and exit. Keeps handlers
 * pure `(client, ...args) => work` with no try/catch.
 *
 * Also the one place that knows a command finished AND its exit code, so it
 * records the command into the active debug session (best-effort) — 0 on
 * success, the mapped code on failure. Commander has no on-error hook, so this
 * is the only spot that can track failures.
 */
function runWithEnvelope(
  work: () => Promise<void>,
  opts: GlobalOpts,
  exitCodeFor: ExitCodeMapper,
  command: Command,
): Promise<void> {
  return work().then(
    async () => {
      // Success — record with exit 0 (never throws).
      await maybeTrackCommand(command, 0);
    },
    async (error: unknown) => {
      const code = exitCodeFor(error);
      // Record the failure BEFORE exiting, passing the error text so it lands in
      // the block's stderr (the logger.error below runs after, too late to tee).
      await maybeTrackCommand(command, code, errorMessage(error));
      if (opts.json) {
        // outputJsonError exits with `code` (never returns).
        outputJsonError(error, code);
      }
      logger.error(errorMessage(error));
      process.exit(code);
    },
  );
}

/**
 * The handler shape both client wrappers accept: a pure function of the resolved
 * client, the commander positionals, and the parsed options. Auth resolution and
 * the error envelope live in the wrapper.
 */
export type ClientAction<A extends unknown[]> = (
  client: LaminarClient,
  ...args: [...A, GlobalOpts]
) => Promise<void>;

/**
 * The handler shape {@link withLocalOpts} accepts — no client, for commands that
 * only touch local state (e.g. `.lmnr/*` files) and never call the API.
 */
export type LocalAction<A extends unknown[]> = (
  ...args: [...A, GlobalOpts]
) => Promise<void>;

/**
 * Wrap a local-only command handler: no auth/client build, but the same
 * positionals + options threading and error envelope as the client wrappers.
 */
export const withLocalOpts =
  <A extends unknown[]>(
    action: LocalAction<A>,
    exitCodeFor: ExitCodeMapper = defaultExitCode,
  ) =>
    async (...cmdArgs: unknown[]): Promise<void> => {
      const { positionals, command, opts } = splitCommanderArgs(cmdArgs);
      await runWithEnvelope(
        () => action(...(positionals as A), opts),
        opts,
        exitCodeFor,
        command,
      );
    };

/**
 * Wrap a project-scoped command handler. Resolves a user-token
 * {@link LaminarClient} (routes to `/v1/cli/*` with the resolved project),
 * threads positionals + options, and owns the error envelope.
 *
 * @example
 *   sqlCmd.command("query")
 *     .argument("<query>")
 *     .action(withProjectClient(handleSqlQuery)); // (client, query, opts) => work
 */
export const withProjectClient =
  <A extends unknown[]>(
    action: ClientAction<A>,
    exitCodeFor: ExitCodeMapper = defaultExitCode,
  ) =>
    async (...cmdArgs: unknown[]): Promise<void> => {
      const { positionals, command, opts } = splitCommanderArgs(cmdArgs);
      await runWithEnvelope(
        async () => {
          const client = await buildLaminarClient({
            projectId: opts.projectId,
            baseUrl: opts.baseUrl,
            port: opts.port,
          });
          await action(client, ...(positionals as A), opts);
        },
        opts,
        exitCodeFor,
        command,
      );
    };

/**
 * Wrap a discovery command handler. Resolves a user-token
 * {@link LaminarClient} with NO project (discovery runs before a project is
 * selected), threads positionals + options, and owns the error envelope.
 */
export const withUserToken =
  <A extends unknown[]>(
    action: ClientAction<A>,
    exitCodeFor: ExitCodeMapper = defaultExitCode,
  ) =>
    async (...cmdArgs: unknown[]): Promise<void> => {
      const { positionals, command, opts } = splitCommanderArgs(cmdArgs);
      await runWithEnvelope(
        async () => {
          const token = await resolveUserToken({
            baseUrl: opts.baseUrl,
            port: opts.port,
          });
          const client = new LaminarClient({
            baseUrl: token.baseUrl,
            // token.port already folds in the LMNR_HTTP_PORT fallback; opts.port
            // would drop it.
            port: token.port,
            // No project id yet. CliResource overrides its own URL/headers, so
            // the empty projectId is never sent.
            auth: { type: "userToken", token: token.bearer, projectId: "" },
          });
          await action(client, ...(positionals as A), opts);
        },
        opts,
        exitCodeFor,
        command,
      );
    };
