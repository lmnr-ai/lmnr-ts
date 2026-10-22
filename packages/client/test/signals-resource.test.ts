import * as assert from "node:assert";
import { describe, it, mock } from "node:test";

import { SignalsResource } from "../src/resources/signals";

const SIGNAL_ID = "29b937f1-7e3c-4768-a5e3-7e891c2d7d0a";
const TRACE_ID = "0198a7f2-0000-7000-8000-000000000001";

void describe("SignalsResource.backfill", () => {
  void it("posts traceIds to /v1/signals/{id}/backfill with a project key", async () => {
    const result = {
      jobId: "job-1",
      signalId: SIGNAL_ID,
      totalTraces: 1,
    };
    const mockFetch = mock.fn(() => ({ ok: true, json: () => result }));
    global.fetch = mockFetch as any;

    const signals = new SignalsResource("https://api.test.com:443", {
      type: "apiKey",
      key: "test-api-key",
    });
    assert.deepStrictEqual(
      await signals.backfill(SIGNAL_ID, [TRACE_ID]),
      result,
    );

    const [url, init] = (mockFetch.mock.calls[0] as any).arguments as [
      string,
      RequestInit,
    ];
    assert.strictEqual(
      url,
      `https://api.test.com:443/v1/signals/${SIGNAL_ID}/backfill`,
    );
    assert.strictEqual(init.method, "POST");
    assert.deepStrictEqual(JSON.parse(init.body as string), {
      traceIds: [TRACE_ID],
    });
  });

  void it("uses the /v1/cli prefix with a user token", async () => {
    const mockFetch = mock.fn(() => ({ ok: true, json: () => ({}) }));
    global.fetch = mockFetch as any;

    const signals = new SignalsResource("https://api.test.com:443", {
      type: "userToken",
      token: "jwt",
      projectId: "proj-1",
    });
    await signals.backfill(SIGNAL_ID, [TRACE_ID]);

    assert.strictEqual(
      (mockFetch.mock.calls[0] as any).arguments[0],
      `https://api.test.com:443/v1/cli/signals/${SIGNAL_ID}/backfill`,
    );
  });

  void it("surfaces the server's {error} message", async () => {
    global.fetch = mock.fn(() => ({
      ok: false,
      status: 404,
      text: () => JSON.stringify({ error: "Signal not found" }),
    })) as any;

    const signals = new SignalsResource("https://api.test.com:443", {
      type: "apiKey",
      key: "test-api-key",
    });
    await assert.rejects(signals.backfill(SIGNAL_ID, [TRACE_ID]), {
      message: "404 Signal not found",
    });
  });
});
