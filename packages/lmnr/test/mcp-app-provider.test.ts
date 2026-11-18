import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { InMemorySpanExporter, TracerProvider } from "@opentelemetry/sdk-trace";

import { LaminarSpanProcessor, wrapMcpServer } from "../src/index";
import { getParentSpanId } from "../src/opentelemetry-lib/tracing/compat";

// Laminar is NOT initialized here: it only runs as a LaminarSpanProcessor
// inside the app's own provider, whose IdGenerator is the app's.
void describe("wrapMcpServer inside an app-owned provider", () => {
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({
    spanProcessors: [
      new LaminarSpanProcessor({ exporter, disableBatch: true }),
    ],
  });
  context.setGlobalContextManager(
    new AsyncLocalStorageContextManager().enable(),
  );
  trace.setGlobalTracerProvider(provider);

  void after(async () => {
    await provider.shutdown();
    trace.disable();
    context.disable();
  });

  void it("still groups a session's turn into one root-span trace", async () => {
    const server = wrapMcpServer(new McpServer({ name: "app", version: "1" }));
    server.registerTool("ping_tool", { inputSchema: {} }, () => ({
      content: [{ type: "text", text: "pong" }],
    }));
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    serverTransport.sessionId = "app-sess";
    await server.connect(serverTransport);
    const client = new Client({ name: "cursor-vscode", version: "1.0.0" });
    await client.connect(clientTransport);

    await client.callTool({ name: "ping_tool", arguments: {} });
    await client.callTool({ name: "ping_tool", arguments: {} });
    // Unrelated root spans of the app keep random trace ids.
    trace.getTracer("app").startSpan("app-span").end();

    const spans = exporter.getFinishedSpans();
    const [a, b] = spans.filter((s) => s.name === "tools/call ping_tool");
    const appSpan = spans.find((s) => s.name === "app-span")!;
    assert.equal(a.spanContext().traceId, b.spanContext().traceId);
    assert.equal(getParentSpanId(b as any), undefined);
    assert.notEqual(appSpan.spanContext().traceId, a.spanContext().traceId);
    assert.equal(a.attributes["lmnr.mcp.client.name"], "cursor-vscode");
    assert.equal(a.attributes["mcp.session.id"], "app-sess");
  });
});
