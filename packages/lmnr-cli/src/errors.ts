import { emitError } from "./utils/output";

/**
 * A CLI error carrying its own machine-readable `code` and process `exitCode`.
 * Pairing them here keeps a catch site from drifting them apart.
 *
 * Two entry styles: wrapped commands `throw` it (the envelope's `ExitCodeMapper`
 * reads `.exitCode`); bare-action commands pass it to {@link failWith}.
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
 * Factories — the single source of truth pairing each wire `code` with its exit
 * code. The `code` strings are a wire contract (agents parse `{error: <code>}`),
 * so several distinct codes intentionally share an exit number (e.g. the exit-7
 * group below).
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
 * Render a {@link CliError} through the shared `emitError` envelope and exit.
 * For the bare-action onboarding commands that own their --json contract.
 *
 * A `function` declaration (not an arrow) on purpose: TS only applies
 * `never`-return narrowing to a call when the callee is a function declaration,
 * so `if (!creds) failWith(...)` narrows `creds` afterward.
 */
export function failWith(isJson: boolean, err: CliError): never {
  emitError(isJson, err.code, err.message);
  process.exit(err.exitCode);
}
