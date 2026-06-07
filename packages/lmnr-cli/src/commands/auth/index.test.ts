import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `vi.mock` calls are hoisted above imports, so helpers they reference must be
// hoisted via `vi.hoisted`.
const {
  mockWriteCredentials,
  mockReadCredentials,
  mockWriteEnvFile,
  mockOpen,
  mockStartLoopbackServer,
  mockQuestion,
} = vi.hoisted(() => ({
  mockWriteCredentials: vi.fn(),
  mockReadCredentials: vi.fn(),
  mockWriteEnvFile: vi.fn(),
  mockOpen: vi.fn(),
  mockStartLoopbackServer: vi.fn(),
  mockQuestion: vi.fn(),
}));

vi.mock("./credentials", async () => {
  const actual = await vi.importActual<typeof import("./credentials")>("./credentials");
  return {
    ...actual,
    writeCredentials: mockWriteCredentials,
    readCredentials: mockReadCredentials,
    credentialsPath: () => "/tmp/test-credentials.json",
  };
});

vi.mock("../../utils/env-file", () => ({ writeEnvFile: mockWriteEnvFile }));
vi.mock("open", () => ({ default: mockOpen }));
vi.mock("./loopback", () => ({ startLoopbackServer: mockStartLoopbackServer }));
vi.mock("readline", () => ({
  default: { createInterface: () => ({ question: mockQuestion, close: vi.fn() }) },
  createInterface: () => ({ question: mockQuestion, close: vi.fn() }),
}));

import { handleSetup } from "./index";

const baseOpts = { dashboardUrl: "http://localhost:3020", baseUrl: "http://localhost:8020" };

const mockResponse = (body: unknown, status = 200): Promise<Response> =>
  Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response);

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.spyOn(process, "exit").mockImplementation((code?) => {
    throw new Error(`process.exit(${code})`);
  });
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  fetchSpy = vi.spyOn(globalThis, "fetch");
  mockWriteCredentials.mockReset();
  mockReadCredentials.mockReset();
  mockReadCredentials.mockResolvedValue(null);
  mockWriteEnvFile.mockReset();
  mockWriteEnvFile.mockResolvedValue({ path: "/tmp/.env", created: true, replaced: false });
  mockOpen.mockReset();
  mockOpen.mockResolvedValue(undefined);
  mockStartLoopbackServer.mockReset();
  mockQuestion.mockReset();
  // Default: a loopback server that immediately yields a code.
  mockStartLoopbackServer.mockResolvedValue({
    port: 54321,
    result: Promise.resolve({ code: "the-code" }),
    close: vi.fn(),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handleSetup (loopback + PKCE)", () => {
  it("exchanges the code, writes .env + credentials on success", async () => {
    fetchSpy.mockResolvedValue(
      await mockResponse({ apiKey: "abcd1234abcd1234", projectId: "p-1", projectName: "proj" }),
    );
    await handleSetup(baseOpts);

    // Token exchange POST carries the code + a verifier, never logs them.
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain("/api/cli-login/token");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.code).toBe("the-code");
    expect(typeof body.codeVerifier).toBe("string");

    expect(mockWriteEnvFile).toHaveBeenCalledWith(
      expect.stringMatching(/\.env$/),
      "abcd1234abcd1234",
    );
    const written = mockWriteCredentials.mock.calls[0][0];
    expect(written.projectApiKey).toBe("abcd1234abcd1234");
    expect(written.projectId).toBe("p-1");
  });

  it("exits 6 (auth failed) when token exchange fails", async () => {
    fetchSpy.mockResolvedValue(await mockResponse({ error: "challenge_mismatch" }, 400));
    await expect(handleSetup(baseOpts)).rejects.toThrow("process.exit(6)");
    expect(mockWriteCredentials).not.toHaveBeenCalled();
  });

  it("opens the dashboard with port + state + code_challenge params", async () => {
    fetchSpy.mockResolvedValue(
      await mockResponse({ apiKey: "abcd1234abcd1234", projectId: "p", projectName: "n" }),
    );
    await handleSetup(baseOpts);
    const opened = String(mockOpen.mock.calls[0][0]);
    expect(opened).toContain("/cli-login?port=54321");
    expect(opened).toContain("state=");
    expect(opened).toContain("code_challenge=");
  });

  it("does not run the loopback server in --no-browser mode", async () => {
    // Manual flow reads stdin; the mocked readline returns a pasted key.
    mockQuestion.mockImplementation((_q: string, cb: (a: string) => void) => cb("manualkey12345"));
    await handleSetup({ ...baseOpts, browser: false });
    expect(mockStartLoopbackServer).not.toHaveBeenCalled();
    expect(mockWriteCredentials).toHaveBeenCalled();
  });

  it("manual paste preserves prior projectId/projectName instead of blanking", async () => {
    // Manual paste carries no project metadata; a prior browser login's creds
    // should survive (only the api key changes).
    mockReadCredentials.mockResolvedValue({
      version: 1,
      baseUrl: "http://localhost:8020",
      dashboardUrl: "http://localhost:3020",
      projectId: "p-prior",
      projectName: "prior-proj",
      projectApiKey: "old-key",
    });
    mockQuestion.mockImplementation((_q: string, cb: (a: string) => void) => cb("manualkey12345"));
    await handleSetup({ ...baseOpts, browser: false });
    const written = mockWriteCredentials.mock.calls[0][0];
    expect(written.projectApiKey).toBe("manualkey12345");
    expect(written.projectId).toBe("p-prior");
    expect(written.projectName).toBe("prior-proj");
  });
});
