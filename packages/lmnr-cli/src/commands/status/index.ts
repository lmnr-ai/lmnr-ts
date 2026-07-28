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
 * `lmnr-cli status` — report the signed-in user, linked project, and active
 * debug session, all from local state (works offline, no API call). Missing
 * fields render as "not set"; exits 0. Local-only handler (`withLocalOpts`).
 *
 * Session display NAME is omitted — it's not stored locally and there's no
 * endpoint to read it back, so we show session id + debugger URL only.
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
