import { LaminarClient } from "@lmnr-ai/client";
import { errorMessage } from "@lmnr-ai/types";
import type { Command } from "commander";

import { initializeLogger } from "../utils/logger";
import { outputJsonError } from "../utils/output";
import { buildLaminarClient } from "./client";
import { resolveUserToken } from "./resolve";

const logger = initializeLogger();

/**
 * Global options every wrapped command shares (from `cmd.optsWithGlobals()`).
 * `projectId` is consumed by the project-client path; discovery commands ignore
 * it (the user-token surface has no project to scope at discovery time).
 */
export interface GlobalOpts {
  projectId?: string;
  baseUrl?: string;
  port?: number;
  json?: boolean;
}

/**
 * Map a thrown error to a process exit code. The default is 1; pass a custom
 * mapper to a wrapper to surface distinct machine-readable codes (Phase 6).
 */
export type ExitCodeMapper = (error: unknown) => number;

const defaultExitCode: ExitCodeMapper = () => 1;

/**
 * Pull the commander positionals out of an `.action(...)` argument list.
 * Commander invokes the handler as `(arg1, ..., argN, options, command)`, so
 * the positionals are everything except the trailing `(options, command)`.
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
 * The error envelope shared by both wrappers: in `--json` mode emit a structured
 * error line and exit with the mapped code; otherwise log and exit. Owning this
 * here lets handlers stay pure `(client, ...args) => work` with no try/catch.
 */
function runWithEnvelope(
  work: () => Promise<void>,
  opts: GlobalOpts,
  exitCodeFor: ExitCodeMapper,
): Promise<void> {
  return work().catch((error: unknown) => {
    const code = exitCodeFor(error);
    if (opts.json) {
      // outputJsonError exits with `code` (never returns).
      outputJsonError(error, code);
    }
    logger.error(errorMessage(error));
    process.exit(code);
  });
}

/**
 * The handler shape both wrappers accept: a pure function of the resolved
 * client, the commander positionals, and the parsed options (so it can read
 * `--json` for output mode). All auth resolution + the error envelope live in
 * the wrapper, so handlers contain only the work.
 */
export type ClientAction<A extends unknown[]> = (
  client: LaminarClient,
  ...args: [...A, GlobalOpts]
) => Promise<void>;

/**
 * Wrap a project-scoped command handler. Resolves a user-token
 * {@link LaminarClient} (routes to `/v1/cli/*` with the resolved project),
 * threads the commander positionals + options through, and owns the error
 * envelope.
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
      const { positionals, opts } = splitCommanderArgs(cmdArgs);
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
      );
    };

/**
 * Wrap a discovery command handler. Resolves a user-token
 * {@link LaminarClient} with NO project (the discovery surface — e.g. listing
 * projects — runs before a project is selected), threads positionals +
 * options, and owns the error envelope.
 */
export const withUserToken =
  <A extends unknown[]>(
    action: ClientAction<A>,
    exitCodeFor: ExitCodeMapper = defaultExitCode,
  ) =>
    async (...cmdArgs: unknown[]): Promise<void> => {
      const { positionals, opts } = splitCommanderArgs(cmdArgs);
      await runWithEnvelope(
        async () => {
          const token = await resolveUserToken({
            baseUrl: opts.baseUrl,
            port: opts.port,
          });
          const client = new LaminarClient({
            baseUrl: token.baseUrl,
            port: opts.port,
            // Discovery: no project id yet. CliResource overrides its own
            // URL/headers, so the empty projectId is never sent.
            auth: { type: "userToken", token: token.bearer, projectId: "" },
          });
          await action(client, ...(positionals as A), opts);
        },
        opts,
        exitCodeFor,
      );
    };
