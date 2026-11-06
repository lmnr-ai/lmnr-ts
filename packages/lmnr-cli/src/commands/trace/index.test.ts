import type { LaminarClient } from "@lmnr-ai/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleTraceTagAdd } from "./index";

const mockTag = vi.fn();

// handleTraceTagAdd is a pure handler: the wrapper resolves the client and
// owns the error envelope. We pass a stub client with the tags surface directly.
const stubClient = { tags: { tag: mockTag } } as unknown as LaminarClient;

const baseOpts = {
  projectId: "fake-project",
  baseUrl: "http://localhost",
  port: 8080,
};

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {
    /* empty */
  });
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handleTraceTagAdd", () => {
  it("outputs JSON on success in json mode", async () => {
    mockTag.mockResolvedValue({ ok: true });

    await handleTraceTagAdd(stubClient, "abc-123", ["tag1", "tag2"], {
      ...baseOpts,
      json: true,
    });

    const output = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(output.traceId).toBe("abc-123");
    expect(output.tags).toEqual(["tag1", "tag2"]);
  });

  it("calls client.tags.tag with correct args", async () => {
    mockTag.mockResolvedValue({ ok: true });

    await handleTraceTagAdd(stubClient, "abc-123", ["tag1"], baseOpts);

    expect(mockTag).toHaveBeenCalledWith("abc-123", ["tag1"]);
  });

  it("propagates API errors for the wrapper to handle", async () => {
    mockTag.mockRejectedValue(new Error("unauthorized"));

    await expect(
      handleTraceTagAdd(stubClient, "abc-123", ["tag1"], {
        ...baseOpts,
        json: true,
      }),
    ).rejects.toThrow("unauthorized");
    expect(logSpy).not.toHaveBeenCalled();
  });
});
