import { emitError } from "./utils/output";

/**
 * A CLI error that carries its own machine-readable `code` and process
 * `exitCode` — the "first-class error" shape shared by commander's
 * `CommanderError(exitCode, code, message)` and oclif's `CLIError` (`oclif.exit`
 * + `code`). Pairing the two here means a catch site can't drift them apart or
 * forget the mapping (the failure mode behind the SessionExpiredError bug).
 *
 * Two entry styles, one type:
 *  - wrapped commands (the with-client envelope) `throw` it — the envelope's
 *    `ExitCodeMapper` reads `.exitCode` (see `defaultExitCode`).
 *  - bare-action commands (`setup` / `plugin` / `link` / `mint-key`) pass it to
 *    {@link failWith}, which renders + exits inline — they own their own --json
 *    output contract and are not wrapped by the envelope.
 */
export class CliError extends Error {
  constructor(
    readonly code: string,
    readonly exitCode: number,
    message: string,
  ) {
    super(message);
    this.name = "CliError";
  }
}

/**
 * Factories — the SINGLE source of truth pairing each wire `code` with its exit
 * code. These numbers were previously duplicated across `plugin/index.ts` and
 * `project/link-core.ts` (already drifting in name: `EXIT_MINT_FAILED` vs
 * `EXIT_SETUP_KEY_FAILED`, both 9); they live here exactly once now.
 *
 * The `code` strings are a wire contract (agents parse `{error: <code>}`), so
 * several distinct codes intentionally share an exit number (e.g. `no_project`,
 * `no_projects`, `project_ambiguous`, `setup_invariant` are all exit 7).
 */
export const loginFailed = (m: string) => new CliError("login_failed", 6, m);
export const noAccess = (m: string) => new CliError("no_access", 4, m);
export const noProject = (m: string) => new CliError("no_project", 7, m);
export const noProjects = (m: string) => new CliError("no_projects", 7, m);
export const projectAmbiguous = (m: string) => new CliError("project_ambiguous", 7, m);
export const setupInvariant = (m: string) => new CliError("setup_invariant", 7, m);
export const listProjectsFailed = (m: string) => new CliError("list_projects_failed", 10, m);
export const keyProbeFailed = (m: string) => new CliError("key_probe_failed", 11, m);
export const keyMismatch = (m: string) => new CliError("key_mismatch", 12, m);
export const setupKeyFailed = (m: string) => new CliError("setup_key_failed", 9, m);
export const mintFailed = (m: string) => new CliError("mint_failed", 9, m);
export const configWriteFailed = (m: string) => new CliError("config_write_failed", 8, m);
export const unsupportedAgent = (m: string) => new CliError("unsupported_agent", 13, m);

/**
 * Render a {@link CliError} through the shared `{error, detail}` envelope
 * (`emitError`) and exit with its code. For the bare-action onboarding commands
 * that own their --json contract and are NOT wrapped by the with-client
 * envelope. Uses a direct `process.exit` — same control flow the audited
 * setup/link flows already rely on, so no exception unwinds through code that
 * wasn't written to catch it.
 */
export const failWith = (isJson: boolean, err: CliError): never => {
  emitError(isJson, err.code, err.message);
  process.exit(err.exitCode);
};
