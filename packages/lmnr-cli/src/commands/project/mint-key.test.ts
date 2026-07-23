import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  safeReadCredentials: vi.fn(),
  readLocalProjectFile: vi.fn(),
  mintProjectApiKey: vi.fn(),
}));

vi.mock("../../auth/credentials", () => ({ safeReadCredentials: h.safeReadCredentials }));
vi.mock("../../utils/local-project-file", () => ({ readLocalProjectFile: h.readLocalProjectFile }));
vi.mock("../../auth/api-key", () => ({ mintProjectApiKey: h.mintProjectApiKey }));

import { handleProjectMintKey } from "./mint-key";

const CREDS = { issuer: "https://laminar.sh", sessionToken: "sess", userEmail: "u@x.io" };

class ExitError extends Error {
  constructor(public code: number) {
    super(`exit ${code}`);
  }
}

let exitSpy: ReturnType<typeof vi.spyOn>;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
const out = (): string =>
  (stdoutSpy.mock.calls as unknown[][]).map((c) => String(c[0])).join("");

beforeEach(() => {
  vi.clearAllMocks();
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitError(code ?? 0);
  }) as never);
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  h.safeReadCredentials.mockResolvedValue(CREDS);
  h.readLocalProjectFile.mockResolvedValue({ projectId: "p1" });
  h.mintProjectApiKey.mockResolvedValue({ apiKey: "lmnr-minted", apiKeyId: "k1" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handleProjectMintKey", () => {
  it("mints via the shared minter for the linked project and prints the bare key", async () => {
    await handleProjectMintKey({});

    expect(h.mintProjectApiKey).toHaveBeenCalledWith(
      "https://laminar.sh",
      "sess",
      "p1",
      expect.any(String),
    );
    // Bare key on stdout (pipe/copy friendly), nothing else.
    expect(out()).toBe("lmnr-minted\n");
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("--project-id overrides the linked project", async () => {
    await handleProjectMintKey({ projectId: "p9" });

    expect(h.mintProjectApiKey).toHaveBeenCalledWith(
      "https://laminar.sh",
      "sess",
      "p9",
      expect.any(String),
    );
  });

  it("--json emits { projectId, apiKey, apiKeyId } and never writes .env", async () => {
    await handleProjectMintKey({ json: true });

    const parsed = JSON.parse(out().trim());
    expect(parsed).toEqual({ projectId: "p1", apiKey: "lmnr-minted", apiKeyId: "k1" });
  });

  it("not logged in exits login_failed (6)", async () => {
    h.safeReadCredentials.mockResolvedValue(null);

    await expect(handleProjectMintKey({ json: true })).rejects.toMatchObject({ code: 6 });
    expect(h.mintProjectApiKey).not.toHaveBeenCalled();
  });

  it("no project (no link, no --project-id) exits no_project (7)", async () => {
    h.readLocalProjectFile.mockResolvedValue(null);

    await expect(handleProjectMintKey({ json: true })).rejects.toMatchObject({ code: 7 });
    expect(h.mintProjectApiKey).not.toHaveBeenCalled();
  });

  it("mint failure exits setup_key_failed (9)", async () => {
    h.mintProjectApiKey.mockRejectedValue(new Error("api-key request failed (500)"));

    await expect(handleProjectMintKey({ json: true })).rejects.toMatchObject({ code: 9 });
  });
});
