import { afterEach, describe, expect, it, vi } from "vitest";
import { checkProjectKey } from "./client";

const client = vi.hoisted(() => ({
  ctor: vi.fn(),
  listDatasets: vi.fn(),
}));
vi.mock("@lmnr-ai/client", () => ({
  LaminarClient: class {
    datasets = { listDatasets: client.listDatasets };
    constructor(args: unknown) {
      client.ctor(args);
    }
  },
}));

const ENV = {
  APP_KEY: "app",
  LMNR_PROJECT_API_KEY: "proj-key",
  LMNR_BASE_URL: "http://localhost:8000",
};

afterEach(() => {
  client.ctor.mockReset();
  client.listDatasets.mockReset();
});

void describe("checkProjectKey", () => {
  void it("asks Laminar with the run's key and URL", async () => {
    client.listDatasets.mockResolvedValue([]);
    await checkProjectKey(ENV);
    expect(client.ctor).toHaveBeenCalledWith({
      baseUrl: "http://localhost:8000",
      auth: { type: "apiKey", key: "proj-key" },
    });
    expect(client.listDatasets).toHaveBeenCalledTimes(1);
  });

  void it("fails with laminar_key_rejected on a rejected key", async () => {
    for (const status of [401, 403]) {
      client.listDatasets.mockRejectedValue(
        new Error(`${status} {"error":"invalid key"}`),
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
    client.listDatasets.mockRejectedValue(
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

    client.listDatasets.mockRejectedValue(new Error("502 Bad Gateway"));
    await expect(checkProjectKey(ENV)).rejects.toMatchObject({
      code: "laminar_unreachable",
      message: expect.stringMatching(/GET \/v1\/datasets: 502 Bad Gateway/),
    });

    // Never settles: a server that takes the connection but never answers.
    client.listDatasets.mockReturnValue(new Promise(() => undefined));
    await expect(checkProjectKey(ENV, 10)).rejects.toMatchObject({
      code: "laminar_unreachable",
      message: expect.stringMatching(/^No answer from Laminar at .* in 0.01 s/),
    });
  });
});
