import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// handleSetup wires together login, credentials, project discovery, key
// minting, env writing and skill install. We mock those seams and focus this
// suite on ONE behavior: an expired-but-valid-shaped session must be absorbed
// into the device-flow login, never surfaced as list_projects_failed (exit 10).

// vi.mock factories are hoisted above the module body, so the mock fns they
// reference must be created in a hoisted block too.
const h = vi.hoisted(() => ({
  handleLogin: vi.fn(),
  safeReadCredentials: vi.fn(),
  refreshIfNeeded: vi.fn(),
  readLocalProjectFile: vi.fn(),
  writeLocalProjectFile: vi.fn(),
  listProjects: vi.fn(),
  promptProjectChoice: vi.fn(),
  findEnvKey: vi.fn(),
  resolveEnvWriteTarget: vi.fn(),
  writeEnvFile: vi.fn(),
  isPathGitIgnored: vi.fn(),
  mintProjectApiKey: vi.fn(),
  installSkill: vi.fn(),
}));

vi.mock("../login", () => ({ handleLogin: h.handleLogin }));
vi.mock("../../auth/credentials", () => ({ safeReadCredentials: h.safeReadCredentials }));
vi.mock("../../auth/resolve", async (importActual) => {
  const actual = await importActual<typeof import("../../auth/resolve")>();
  return { ...actual, refreshIfNeeded: h.refreshIfNeeded, envHttpPort: () => undefined };
});
vi.mock("../../utils/local-project-file", () => ({
  readLocalProjectFile: h.readLocalProjectFile,
  writeLocalProjectFile: h.writeLocalProjectFile,
}));
vi.mock("../../utils/projects", () => ({
  listProjects: h.listProjects,
  promptProjectChoice: h.promptProjectChoice,
}));
vi.mock("../../utils/env-file", () => ({
  findEnvKey: h.findEnvKey,
  resolveEnvWriteTarget: h.resolveEnvWriteTarget,
  writeEnvFile: h.writeEnvFile,
  isPathGitIgnored: h.isPathGitIgnored,
}));
vi.mock("../../auth/api-key", () => ({ mintProjectApiKey: h.mintProjectApiKey }));
vi.mock("../../utils/install-skill", () => ({ installSkill: h.installSkill }));

import { SessionExpiredError } from "../../auth/resolve";
import { handleSetup } from "./index";

const VALID_CREDS = {
  version: 1,
  issuer: "https://laminar.sh",
  sessionToken: "sess",
  accessToken: "jwt",
  accessTokenExpiresAt: "2099-01-01T00:00:00.000Z",
  userId: "u1",
  userEmail: "dev@example.com",
  createdAt: "2026-01-01T00:00:00.000Z",
};

let exitSpy: ReturnType<typeof vi.spyOn>;
let stdoutSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  // process.exit must never be reached on the happy expiry-recovery path — make
  // it throw so an unexpected exit fails the test loudly instead of hanging.
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handleSetup — expired session recovery", () => {
  it("re-runs login (does not error) when refresh returns invalid_grant", async () => {
    // Valid-shaped creds on disk both before the gate and after re-login.
    h.safeReadCredentials.mockResolvedValue(VALID_CREDS);
    // The gate's refresh throws SessionExpiredError → the expiry is absorbed.
    h.refreshIfNeeded.mockRejectedValue(new SessionExpiredError("Session expired"));
    // No directory link yet; the browser hands back the chosen project.
    h.readLocalProjectFile.mockResolvedValue(null);
    h.handleLogin.mockResolvedValue({
      userId: "u1",
      userEmail: "dev@example.com",
      projectId: "proj-1",
    });
    h.listProjects.mockResolvedValue([
      { id: "proj-1", name: "Proj", workspaceId: "w1", workspaceName: "WS" },
    ]);
    h.writeLocalProjectFile.mockResolvedValue("/tmp/.lmnr/project.json");
    // No existing key → mint a fresh one; skip env write via writeEnv:false.
    h.findEnvKey.mockResolvedValue(null);
    h.mintProjectApiKey.mockResolvedValue({
      apiKey: "lmnr-key",
      projectName: "Proj",
      workspaceName: "WS",
      workspaceId: "w1",
    });
    h.installSkill.mockResolvedValue({ written: [], skipped: true });

    await handleSetup({ json: true, writeEnv: false, browser: false });

    // The expiry was absorbed into the device-flow login...
    expect(h.handleLogin).toHaveBeenCalledTimes(1);
    expect(h.handleLogin).toHaveBeenCalledWith(
      expect.objectContaining({ noBrowser: true }),
    );
    // ...and onboarding completed: a JSON result on stdout, no error exit.
    expect(exitSpy).not.toHaveBeenCalled();
    const out = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
    expect(out).toContain('"projectId":"proj-1"');
    expect(out).not.toContain("list_projects_failed");
  });
});
