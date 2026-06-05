import { type ProfileEntry, readCredentials } from "../../auth/credentials";

export async function handleList(): Promise<void> {
  const creds = await readCredentials();
  if (!creds || Object.keys(creds.profiles).length === 0) {
    process.stderr.write(
      "Not logged in. Run `lmnr-cli login` or `lmnr-cli setup`.\n",
    );
    process.exit(6);
  }

  const profiles = Object.values(creds.profiles);
  const rows = profiles.map((p) => ({
    active: p.projectId === creds.active,
    project: p.projectName ?? p.projectId,
    workspace: p.workspaceName ?? "—",
    lastUsed: relativeTime(p.lastUsedAt ?? p.createdAt),
    sortKey: lastUsedMs(p),
  }));
  rows.sort((a, b) => b.sortKey - a.sortKey);

  const output = renderTable(rows);
  process.stdout.write(output);
}

interface Row {
  active: boolean;
  project: string;
  workspace: string;
  lastUsed: string;
}

function renderTable(rows: Row[]): string {
  const headers = { project: "PROJECT", workspace: "WORKSPACE", lastUsed: "LAST USED" };
  const projectW = Math.max(headers.project.length, ...rows.map((r) => r.project.length));
  const workspaceW = Math.max(headers.workspace.length, ...rows.map((r) => r.workspace.length));

  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - s.length));
  const lines: string[] = [];
  // 2-char active gutter, then columns separated by 2 spaces.
  const head =
    `  ${pad(headers.project, projectW)}  ` +
    `${pad(headers.workspace, workspaceW)}  ${headers.lastUsed}`;
  lines.push(head);
  for (const r of rows) {
    const marker = r.active ? "* " : "  ";
    const line =
      `${marker}${pad(r.project, projectW)}  ` +
      `${pad(r.workspace, workspaceW)}  ${r.lastUsed}`;
    lines.push(line);
  }
  return lines.join("\n") + "\n";
}

export function relativeTime(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return "never";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "never";
  const deltaSec = Math.floor((now - t) / 1000);
  if (deltaSec < 60) return "just now";
  if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)}m ago`;
  if (deltaSec < 86400) return `${Math.floor(deltaSec / 3600)}h ago`;
  return `${Math.floor(deltaSec / 86400)}d ago`;
}

function lastUsedMs(p: ProfileEntry): number {
  const v = p.lastUsedAt ?? p.createdAt;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : 0;
}
