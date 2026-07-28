import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  safeReadCredentials: vi.fn(),
  readLocalProjectFile: vi.fn(),
  readDebugSessionFile: vi.fn(),
  resolveDebugSessionDir: vi.fn(() => "/repo"),
}));

vi.mock("../../auth/credentials", () => ({ safeReadCredentials: h.safeReadCredentials }));
vi.mock("../../utils/local-project-file", () => ({ readLocalProjectFile: h.readLocalProjectFile }));
vi.mock("../../utils/debug-session-file", () => ({
  readDebugSessionFile: h.readDebugSessionFile,
  resolveDebugSessionDir: h.resolveDebugSessionDir,
}));

import { handleStatus } from "./index";

let stdoutSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

const out = (): string =>
  (stdoutSpy.mock.calls as unknown[][]).map((c) => String(c[0])).join("");

beforeEach(() => {
  vi.clearAllMocks();
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  // outputJson uses console.log.
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handleStatus", () => {
  it("renders user, project, workspace, and debug session in human mode", async () => {
    h.safeReadCredentials.mockResolvedValue({ userEmail: "dev@example.com" });
    h.readLocalProjectFile.mockResolvedValue({
      projectId: "p1",
      projectName: "Alpha",
      workspaceName: "Acme",
    });
    h.readDebugSessionFile.mockReturnValue({
      session_id: "sess-1",
      debugger_url: "https://laminar.sh/project/p1/debugger-sessions/sess-1",
    });

    await handleStatus({});

    const text = out();
    expect(text).toContain("dev@example.com");
    expect(text).toContain("Alpha");
    expect(text).toContain("p1");
    expect(text).toContain("Acme");
    expect(text).toContain("sess-1");
    expect(text).toContain("debugger-sessions/sess-1");
  });

  it("degrades gracefully when nothing is set (no error)", async () => {
    h.safeReadCredentials.mockResolvedValue(null);
    h.readLocalProjectFile.mockResolvedValue(null);
    h.readDebugSessionFile.mockReturnValue(null);

    await handleStatus({});

    const text = out();
    expect(text).toContain("not logged in");
    expect(text).toContain("no project linked here");
    expect(text).toContain("none active");
  });

  it("--json emits a single flat object with stable keys, no decorative text", async () => {
    h.safeReadCredentials.mockResolvedValue({ userEmail: "dev@example.com" });
    h.readLocalProjectFile.mockResolvedValue({
      projectId: "p1",
      projectName: "Alpha",
      workspaceId: "w1",
      workspaceName: "Acme",
    });
    h.readDebugSessionFile.mockReturnValue({
      session_id: "sess-1",
      debugger_url: "https://laminar.sh/x",
    });

    await handleStatus({ json: true });

    // JSON goes through outputJson (console.log); nothing decorative on stdout.
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledOnce();
    const parsed = JSON.parse(String(logSpy.mock.calls[0][0]));
    expect(parsed).toEqual({
      userEmail: "dev@example.com",
      projectId: "p1",
      projectName: "Alpha",
      workspaceId: "w1",
      workspaceName: "Acme",
      debugSessionId: "sess-1",
      debuggerUrl: "https://laminar.sh/x",
    });
  });

  it("--json uses null for every absent field", async () => {
    h.safeReadCredentials.mockResolvedValue(null);
    h.readLocalProjectFile.mockResolvedValue(null);
    h.readDebugSessionFile.mockReturnValue(null);

    await handleStatus({ json: true });

    const parsed = JSON.parse(String(logSpy.mock.calls[0][0]));
    expect(parsed).toEqual({
      userEmail: null,
      projectId: null,
      projectName: null,
      workspaceId: null,
      workspaceName: null,
      debugSessionId: null,
      debuggerUrl: null,
    });
  });
});
