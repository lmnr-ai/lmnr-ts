import { safeReadCredentials } from "../../auth/credentials";
import type { GlobalOpts } from "../../auth/with-client";
import { pc } from "../../utils/colors";
import { readDebugSessionFile, resolveDebugSessionDir } from "../../utils/debug-session-file";
import { readLocalProjectFile } from "../../utils/local-project-file";
import { outputJson } from "../../utils/output";

/** Flat, stable-keyed status object — the `--json` contract. */
interface StatusReport {
  userEmail: string | null;
  projectId: string | null;
  projectName: string | null;
  workspaceId: string | null;
  workspaceName: string | null;
  debugSessionId: string | null;
  debuggerUrl: string | null;
}

/** Fixed label column width so the human report lines up. */
const LABEL_WIDTH = 14;

const row = (label: string, value: string): string =>
  `  ${label.padEnd(LABEL_WIDTH)}${value}\n`;

/**
 * `lmnr-cli status` — report the CLI's current context: the signed-in user, the
 * project linked to this directory, and the active debug session. Everything is
 * read from local state (credentials.json, `.lmnr/project.json`,
 * `.lmnr/debug-session.json`), so it works offline and never makes an API call.
 *
 * Each field degrades gracefully to a "not set" line when absent rather than
 * erroring — the command exits 0 as long as it ran. Local-only handler
 * (registered via `withLocalOpts`): no auth resolution, no network.
 *
 * The debug session's display NAME is intentionally omitted: it is not stored
 * locally and there is no endpoint to read it back, so `status` shows the
 * session id + debugger URL only (a backend GET-session endpoint is the
 * follow-up that would let it show the name).
 */
export const handleStatus = async (opts: GlobalOpts): Promise<void> => {
  const creds = await safeReadCredentials();
  const link = await readLocalProjectFile();
  const session = readDebugSessionFile(resolveDebugSessionDir());

  const report: StatusReport = {
    userEmail: creds?.userEmail ?? null,
    projectId: link?.projectId ?? null,
    projectName: link?.projectName ?? null,
    workspaceId: link?.workspaceId ?? null,
    workspaceName: link?.workspaceName ?? null,
    debugSessionId: session?.session_id ?? null,
    debuggerUrl: session?.debugger_url ?? null,
  };

  if (opts.json) {
    outputJson(report);
    return;
  }

  const notSet = (msg: string) => pc.dim(msg);

  let out = "\n";
  out += row(
    "User",
    report.userEmail ?? notSet("not logged in — run `lmnr-cli login`"),
  );

  if (report.projectId) {
    const project = report.projectName
      ? `${report.projectName} ${pc.dim(`(${report.projectId})`)}`
      : report.projectId;
    out += row("Project", project);
    out += row("Workspace", report.workspaceName ?? notSet("unknown"));
  } else {
    out += row("Project", notSet("no project linked here — run `lmnr-cli project link`"));
  }

  if (report.debugSessionId) {
    out += row("Debug session", report.debugSessionId);
    if (report.debuggerUrl) out += row("Debugger URL", report.debuggerUrl);
  } else {
    out += row("Debug session", notSet("none active — run `lmnr-cli debug session new`"));
  }

  process.stdout.write(out);
};
