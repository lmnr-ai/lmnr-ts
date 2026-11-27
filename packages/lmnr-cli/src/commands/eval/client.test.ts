import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkProjectKey } from "./client";

const fetchMock = vi.fn();

const ENV = {
  APP_KEY: "app",
  LMNR_PROJECT_API_KEY: "proj-key",
  LMNR_BASE_URL: "http://localhost:8000",
};

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

void describe("checkProjectKey", () => {
  void it("asks Laminar with the run's key and URL", async () => {
    fetchMock.mockResolvedValue(new Response("[]"));
    await checkProjectKey(ENV);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:8000/v1/datasets");
    expect(init.headers).toEqual({ Authorization: "Bearer proj-key" });
  });

  void it("fails with laminar_key_rejected on a rejected key", async () => {
    for (const status of [401, 403]) {
      fetchMock.mockResolvedValue(
        new Response('{"error":"invalid key"}', { status }),
      );
      await expect(checkProjectKey(ENV)).rejects.toMatchObject({
        code: "laminar_key_rejected",
        exitCode: 24,
        message: expect.stringMatching(
          new RegExp(
            `^Laminar at http://localhost:8000 rejected LMNR_PROJECT_API_KEY \\(${status}\\).*lmnr-cli setup`,
          ),
        ),
      });
    }
  });

  void it("fails with laminar_unreachable without a usable answer", async () => {
    fetchMock.mockRejectedValue(
      Object.assign(new TypeError("fetch failed"), {
        cause: new Error("connect ECONNREFUSED 127.0.0.1:8000"),
      }),
    );
    await expect(checkProjectKey(ENV)).rejects.toMatchObject({
      code: "laminar_unreachable",
      exitCode: 24,
      message: expect.stringMatching(
        /^Can't reach Laminar at http:\/\/localhost:8000 \(fetch failed: connect ECONNREFUSED 127\.0\.0\.1:8000\).*LMNR_BASE_URL/,
      ),
    });

    fetchMock.mockResolvedValue(new Response("Bad Gateway", { status: 502 }));
    await expect(checkProjectKey(ENV)).rejects.toMatchObject({
      code: "laminar_unreachable",
      message: expect.stringMatching(/GET \/v1\/datasets: 502 Bad Gateway/),
    });

    // A server that takes the connection but never answers: fetch rejects
    // with AbortSignal.timeout's TimeoutError.
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason),
          );
        }),
    );
    await expect(checkProjectKey(ENV, 10)).rejects.toMatchObject({
      code: "laminar_unreachable",
      message: expect.stringMatching(/^No answer from Laminar at .* in 0.01 s/),
    });
  });
});
