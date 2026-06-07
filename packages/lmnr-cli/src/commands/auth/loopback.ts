import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { type AddressInfo } from "node:net";

import { safeEqual } from "./pkce";

const SUCCESS_HTML = [
  "<!doctype html>",
  '<html><head><meta charset="utf-8"><title>Laminar CLI</title>',
  "<style>body{font-family:system-ui,sans-serif;display:flex;",
  "min-height:100vh;align-items:center;justify-content:center;",
  "margin:0;background:#0a0a0a;color:#fafafa}",
  ".card{text-align:center;padding:2rem}</style></head>",
  '<body><div class="card"><h1>&#10003; Authorized</h1>',
  "<p>You can return to your terminal.</p></div></body></html>",
].join("\n");

export interface CallbackResult {
  code: string;
}

export interface AwaitCallbackOptions {
  state: string;
  timeoutMs: number;
}

export interface LoopbackServer {
  port: number;
  // Resolves once the browser hits /callback with a matching state.
  result: Promise<CallbackResult>;
  close: () => void;
}

// Bind an ephemeral 127.0.0.1 server (port 0 → OS-assigned). NEVER bind
// 0.0.0.0. The returned `port` is read after listen; `result` resolves with the
// code once the browser redirects back. Caller MUST call close() in a finally.
export const startLoopbackServer = async (opts: AwaitCallbackOptions): Promise<LoopbackServer> => {
  let resolveResult: (r: CallbackResult) => void;
  let rejectResult: (e: Error) => void;
  const result = new Promise<CallbackResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      res.writeHead(404);
      res.end();
      return;
    }
    const state = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code") ?? "";
    if (!code || !safeEqual(state, opts.state)) {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("Invalid CLI login callback.");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(SUCCESS_HTML);
    resolveResult({ code });
  };

  const server = createServer(handler);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const timer = setTimeout(() => {
    rejectResult(new Error("Timed out waiting for browser authorization."));
  }, opts.timeoutMs);
  // Don't keep the event loop alive solely for the timeout.
  timer.unref?.();

  const close = () => {
    clearTimeout(timer);
    server.close();
  };
  // Stop blocking the loop on the timeout once we have a result either way.
  void result.finally(() => clearTimeout(timer)).catch(() => {});

  const { port } = server.address() as AddressInfo;
  return { port, result, close };
};
