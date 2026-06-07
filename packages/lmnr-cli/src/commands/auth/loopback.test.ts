import { describe, expect, it } from "vitest";

import { startLoopbackServer } from "./loopback";

describe("startLoopbackServer", () => {
  it("resolves with the code when state matches", async () => {
    const server = await startLoopbackServer({ state: "good-state", timeoutMs: 5000 });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/callback?code=abc123&state=good-state`);
      expect(res.status).toBe(200);
      const out = await server.result;
      expect(out.code).toBe("abc123");
    } finally {
      server.close();
    }
  });

  it("rejects a callback with a mismatched state (400, does not resolve)", async () => {
    const server = await startLoopbackServer({ state: "good-state", timeoutMs: 5000 });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/callback?code=abc&state=evil-state`);
      expect(res.status).toBe(400);
      // result must still be pending — race a short timer against it.
      const settled = await Promise.race([
        server.result.then(() => "resolved" as const),
        new Promise<"pending">((r) => setTimeout(() => r("pending"), 150)),
      ]);
      expect(settled).toBe("pending");
    } finally {
      server.close();
    }
  });

  it("404s non-callback paths", async () => {
    const server = await startLoopbackServer({ state: "s", timeoutMs: 5000 });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/other`);
      expect(res.status).toBe(404);
    } finally {
      server.close();
    }
  });
});
