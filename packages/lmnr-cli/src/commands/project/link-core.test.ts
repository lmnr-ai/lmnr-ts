import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ refreshIfNeeded: vi.fn() }));

// Keep the real SessionExpiredError (so `instanceof` works); stub only the probe
// so refreshIfNeeded throws before any network call.
vi.mock("../../auth/resolve", async (orig) => {
  const actual = await orig<typeof import("../../auth/resolve")>();
  return { ...actual, refreshIfNeeded: h.refreshIfNeeded };
});

import { SessionExpiredError } from "../../auth/resolve";
import { ensureProjectKey } from "./link-core";

const CREDS = {
  issuer: "https://laminar.sh",
  sessionToken: "sess",
  accessToken: "jwt",
} as unknown as Parameters<typeof ensureProjectKey>[0]["creds"];

class ExitError extends Error {
  constructor(public code: number) {
    super(`exit ${code}`);
  }
}

let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitError(code ?? 0);
  }) as never);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ensureProjectKey — session expiry during the key probe", () => {
  it("maps an expired grant to login_failed (6), not an uncoded exit 1", async () => {
    // The existing-key probe calls refreshIfNeeded, which reports expiry.
    h.refreshIfNeeded.mockRejectedValue(
      new SessionExpiredError("Session expired"),
    );

    await expect(
      ensureProjectKey({
        creds: CREDS,
        link: { projectId: "p1" },
        existingKey: { value: "lmnr-old", source: { type: "process-env" } },
        cwd: "/repo",
        issuer: "https://laminar.sh",
        userBaseUrl: "https://api.lmnr.ai",
        writeEnv: false,
        isJson: true,
      }),
    ).rejects.toMatchObject({ code: 6 });
    expect(exitSpy).toHaveBeenCalledWith(6);
  });
});
