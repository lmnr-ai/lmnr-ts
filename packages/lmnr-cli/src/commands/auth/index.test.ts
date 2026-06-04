import nacl from "tweetnacl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `vi.mock` calls are hoisted above imports, so any helpers they reference
// must also be hoisted via `vi.hoisted`.
const { mockWriteCredentials, mockOpen } = vi.hoisted(() => ({
  mockWriteCredentials: vi.fn(),
  mockOpen: vi.fn(),
}));

vi.mock("./credentials", async () => {
  const actual = await vi.importActual<typeof import("./credentials")>(
    "./credentials",
  );
  return {
    ...actual,
    writeCredentials: mockWriteCredentials,
    credentialsPath: () => "/tmp/test-credentials.json",
  };
});

vi.mock("open", () => ({ default: mockOpen }));

import {
  EXIT_ALREADY_CLAIMED,
  EXIT_EXPIRED,
  EXIT_GENERIC,
  EXIT_TIMED_OUT,
  handleAuthLogin,
} from "./index";

const baseOpts = {
  dashboardUrl: "http://localhost:3020",
  baseUrl: "http://localhost:8020",
};

// CLI generates an X25519 keypair internally; tests inspect the publicKey it
// posts to /api/cli/grants by capturing the first fetch call body.
const buildApprovedPayload = (cliPublicKeyB64: string) => {
  const ephemeral = nacl.box.keyPair();
  const nonce = nacl.randomBytes(24);
  const cliPub = new Uint8Array(Buffer.from(cliPublicKeyB64, "base64url"));
  const payload = {
    projectApiKey: "lmnr_pk_abcdef0123456789",
    projectId: "00000000-0000-0000-0000-000000000000",
    projectName: "test-project",
    workspaceId: "00000000-0000-0000-0000-000000000001",
    workspaceName: "Test Workspace",
    userEmail: "alice@example.com",
    createdAt: "2026-06-03T00:00:00.000Z",
  };
  const cipher = nacl.box(
    new TextEncoder().encode(JSON.stringify(payload)),
    nonce,
    cliPub,
    ephemeral.secretKey,
  );
  return {
    status: "approved" as const,
    encrypted: Buffer.from(cipher).toString("base64url"),
    nonce: Buffer.from(nonce).toString("base64url"),
    ephemeralPublicKey: Buffer.from(ephemeral.publicKey).toString("base64url"),
    payload,
  };
};

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
  // Avoid the 2s real-time sleep between poll attempts; resolve immediately.
  // setTimeout is what `sleep()` in auth/index.ts wraps.
  vi.spyOn(globalThis, "setTimeout").mockImplementation((fn) => {
    if (typeof fn === "function") fn();
    return 0 as unknown as NodeJS.Timeout;
  });
  fetchSpy = vi.spyOn(globalThis, "fetch");
  mockWriteCredentials.mockReset();
  mockOpen.mockReset();
  mockOpen.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handleAuthLogin", () => {
  it("writes credentials on the approved branch", async () => {
    // Capture publicKey from the create-grant request so the test can encrypt
    // a payload the CLI is actually able to decrypt with its in-memory secret.
    let capturedPublicKey = "";
    let pollCount = 0;
    fetchSpy.mockImplementation((url, init) => {
      if (typeof url === "string" && url.endsWith("/api/cli/grants")) {
        const body = JSON.parse((init?.body as string) ?? "{}") as {
          publicKey: string;
        };
        capturedPublicKey = body.publicKey;
        return mockResponse({ sessionId: "test-session-id" });
      }
      // First poll returns pending; second returns approved so we cover the
      // pending→approved transition.
      pollCount += 1;
      if (pollCount === 1) return mockResponse({ status: "pending" });
      const approved = buildApprovedPayload(capturedPublicKey);
      return mockResponse({
        status: "approved",
        encrypted: approved.encrypted,
        nonce: approved.nonce,
        ephemeralPublicKey: approved.ephemeralPublicKey,
      });
    });

    await handleAuthLogin(baseOpts);

    expect(mockOpen).toHaveBeenCalledTimes(1);
    expect(mockOpen.mock.calls[0][0]).toContain(
      "/cli-login?session_id=test-session-id",
    );
    expect(mockWriteCredentials).toHaveBeenCalledTimes(1);
    const creds = mockWriteCredentials.mock.calls[0][0];
    expect(creds.projectApiKey).toBe("lmnr_pk_abcdef0123456789");
    expect(creds.userEmail).toBe("alice@example.com");
    expect(creds.baseUrl).toBe("http://localhost:8020");
    expect(creds.dashboardUrl).toBe("http://localhost:3020");
  });

  it("exits EXIT_EXPIRED when the poll returns expired", async () => {
    fetchSpy.mockImplementation((url) => {
      if (typeof url === "string" && url.endsWith("/api/cli/grants")) {
        return mockResponse({ sessionId: "test-session-id" });
      }
      return mockResponse({ status: "expired" });
    });

    await expect(handleAuthLogin(baseOpts)).rejects.toThrow(
      `process.exit(${EXIT_EXPIRED})`,
    );
    expect(mockWriteCredentials).not.toHaveBeenCalled();
  });

  it("exits EXIT_ALREADY_CLAIMED when the poll returns already_claimed", async () => {
    fetchSpy.mockImplementation((url) => {
      if (typeof url === "string" && url.endsWith("/api/cli/grants")) {
        return mockResponse({ sessionId: "test-session-id" });
      }
      return mockResponse({ status: "already_claimed" });
    });

    await expect(handleAuthLogin(baseOpts)).rejects.toThrow(
      `process.exit(${EXIT_ALREADY_CLAIMED})`,
    );
    expect(mockWriteCredentials).not.toHaveBeenCalled();
  });

  it("exits EXIT_TIMED_OUT when the poll keeps returning pending past 150 attempts", async () => {
    fetchSpy.mockImplementation((url) => {
      if (typeof url === "string" && url.endsWith("/api/cli/grants")) {
        return mockResponse({ sessionId: "test-session-id" });
      }
      return mockResponse({ status: "pending" });
    });

    await expect(handleAuthLogin(baseOpts)).rejects.toThrow(
      `process.exit(${EXIT_TIMED_OUT})`,
    );
    expect(mockWriteCredentials).not.toHaveBeenCalled();
    // 1 create + 150 polls.
    expect(fetchSpy).toHaveBeenCalledTimes(151);
  });

  it("exits EXIT_GENERIC when create-grant returns non-OK", async () => {
    fetchSpy.mockImplementation(() => mockResponse({ error: "boom" }, 500));

    await expect(handleAuthLogin(baseOpts)).rejects.toThrow(
      `process.exit(${EXIT_GENERIC})`,
    );
    expect(mockOpen).not.toHaveBeenCalled();
    expect(mockWriteCredentials).not.toHaveBeenCalled();
  });

  it("exits EXIT_GENERIC when the approved payload is missing fields", async () => {
    fetchSpy.mockImplementation((url) => {
      if (typeof url === "string" && url.endsWith("/api/cli/grants")) {
        return mockResponse({ sessionId: "test-session-id" });
      }
      // approved without encrypted/nonce/ephemeralPublicKey → malformed.
      return mockResponse({ status: "approved" });
    });

    await expect(handleAuthLogin(baseOpts)).rejects.toThrow(
      `process.exit(${EXIT_GENERIC})`,
    );
    expect(mockWriteCredentials).not.toHaveBeenCalled();
  });

  it("exits EXIT_GENERIC when decryption fails (wrong ephemeral key)", async () => {
    fetchSpy.mockImplementation((url) => {
      if (typeof url === "string" && url.endsWith("/api/cli/grants")) {
        return mockResponse({ sessionId: "test-session-id" });
      }
      // Build payload encrypted to a random key the CLI doesn't hold.
      const bogusRecipient = nacl.box.keyPair();
      const ephemeral = nacl.box.keyPair();
      const nonce = nacl.randomBytes(24);
      const cipher = nacl.box(
        new TextEncoder().encode("{}"),
        nonce,
        bogusRecipient.publicKey,
        ephemeral.secretKey,
      );
      return mockResponse({
        status: "approved",
        encrypted: Buffer.from(cipher).toString("base64url"),
        nonce: Buffer.from(nonce).toString("base64url"),
        ephemeralPublicKey: Buffer.from(ephemeral.publicKey).toString(
          "base64url",
        ),
      });
    });

    await expect(handleAuthLogin(baseOpts)).rejects.toThrow(
      `process.exit(${EXIT_GENERIC})`,
    );
    expect(mockWriteCredentials).not.toHaveBeenCalled();
  });
});
