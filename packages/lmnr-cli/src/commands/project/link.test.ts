import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  safeReadCredentials: vi.fn(),
  listProjects: vi.fn(),
  promptProjectChoice: vi.fn(),
  writeLocalProjectFile: vi.fn(),
  findEnvKey: vi.fn(),
  ensureProjectKey: vi.fn(),
}));

vi.mock("../../auth/credentials", () => ({ safeReadCredentials: h.safeReadCredentials }));
vi.mock("../../utils/projects", () => ({
  listProjects: h.listProjects,
  promptProjectChoice: h.promptProjectChoice,
}));
vi.mock("../../utils/local-project-file", () => ({
  writeLocalProjectFile: h.writeLocalProjectFile,
}));
vi.mock("../../utils/env-file", () => ({ findEnvKey: h.findEnvKey }));
// Keep the real EXIT_* constants; only stub the key-handling primitive.
vi.mock("./link-core", async (importActual) => {
  const actual = await importActual<typeof import("./link-core")>();
  return { ...actual, ensureProjectKey: h.ensureProjectKey };
});

import { handleProjectLink } from "./link";

const CREDS = { issuer: "https://laminar.sh", sessionToken: "s", userEmail: "u@x.io" };
const PROJECTS = [
  { id: "p1", name: "Alpha", workspaceId: "w1", workspaceName: "Acme" },
  { id: "p2", name: "Beta", workspaceId: "w1", workspaceName: "Acme" },
];

let exitSpy: ReturnType<typeof vi.spyOn>;
let stdoutSpy: ReturnType<typeof vi.spyOn>;

// process.exit is a hard failure in these flows — make it throw a tagged error
// so tests can assert the exit code without the process actually dying.
class ExitError extends Error {
  constructor(public code: number) {
    super(`exit ${code}`);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitError(code ?? 0);
  }) as never);
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  h.safeReadCredentials.mockResolvedValue(CREDS);
  h.listProjects.mockResolvedValue(PROJECTS);
  h.writeLocalProjectFile.mockResolvedValue("/repo/.lmnr/project.json");
  h.findEnvKey.mockResolvedValue(null);
  h.ensureProjectKey.mockResolvedValue({
    apiKey: "lmnr-new",
    envFileUpdated: "/repo/.env",
    keyMeta: null,
    mismatchProjectId: null,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handleProjectLink", () => {
  it("--project-id writes the link + ensures the key, emitting JSON", async () => {
    await handleProjectLink({ projectId: "p2", json: true });

    expect(h.writeLocalProjectFile).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "p2", projectName: "Beta" }),
    );
    // The key handling ran against the newly-linked project, in warn-on-mismatch mode.
    expect(h.ensureProjectKey).toHaveBeenCalledWith(
      expect.objectContaining({
        link: expect.objectContaining({ projectId: "p2" }),
        onKeyMismatch: "warn",
      }),
    );
    const out = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
    expect(out).toContain('"projectId":"p2"');
    expect(out).toContain('"apiKey":"lmnr-new"');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("still re-links (and surfaces the mismatch) when the key is for another project", async () => {
    // ensureProjectKey warns instead of exiting; it reports the other project id.
    h.ensureProjectKey.mockResolvedValue({
      apiKey: null,
      envFileUpdated: null,
      keyMeta: null,
      mismatchProjectId: "other-proj",
    });

    await handleProjectLink({ projectId: "p2", json: true });

    // The re-link went through despite the mismatch...
    expect(h.writeLocalProjectFile).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "p2" }),
    );
    // ...and the mismatch is surfaced (not a hard failure).
    expect(exitSpy).not.toHaveBeenCalled();
    const out = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
    expect(out).toContain('"keyMismatchProjectId":"other-proj"');
  });

  it("--project-id the user can't access exits no_access (4)", async () => {
    await expect(handleProjectLink({ projectId: "nope", json: true })).rejects.toMatchObject({
      code: 4,
    });
    expect(h.writeLocalProjectFile).not.toHaveBeenCalled();
    expect(h.ensureProjectKey).not.toHaveBeenCalled();
  });

  it("no arg with a single accessible project auto-selects it", async () => {
    h.listProjects.mockResolvedValue([PROJECTS[0]]);

    await handleProjectLink({});

    expect(h.promptProjectChoice).not.toHaveBeenCalled();
    expect(h.writeLocalProjectFile).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "p1" }),
    );
  });

  it("no arg with multiple projects opens the picker", async () => {
    h.promptProjectChoice.mockResolvedValue(PROJECTS[1]);

    await handleProjectLink({});

    expect(h.promptProjectChoice).toHaveBeenCalledOnce();
    expect(h.writeLocalProjectFile).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "p2" }),
    );
  });

  it("not logged in exits login_failed (6)", async () => {
    h.safeReadCredentials.mockResolvedValue(null);

    await expect(handleProjectLink({ json: true })).rejects.toMatchObject({ code: 6 });
    expect(h.listProjects).not.toHaveBeenCalled();
  });

  it("--json with multiple projects and no id exits (project_ambiguous)", async () => {
    await expect(handleProjectLink({ json: true })).rejects.toBeInstanceOf(Error);
    expect(h.promptProjectChoice).not.toHaveBeenCalled();
  });
});
