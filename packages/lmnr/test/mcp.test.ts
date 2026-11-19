import assert from "node:assert/strict";
import { createServer, type Server as HttpServer } from "node:http";
import { type AddressInfo } from "node:net";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import { Client as ClientV2 } from "@modelcontextprotocol/client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  InMemoryTransport as InMemoryTransportV2,
  McpServer as McpServerV2,
  Server as ServerV2,
} from "@modelcontextprotocol/server";
import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace";
import { z } from "zod";

import { Laminar, wrapMcpServer } from "../src/index";
import { CONTEXT_DESCRIPTION } from "../src/integrations/mcp/attributes";
import {
  resetMcpState,
  resolveMcpOptions,
} from "../src/integrations/mcp/index";
import { isSecretKey, redact } from "../src/integrations/mcp/redact";
import { traceIdForTurn } from "../src/integrations/mcp/turns";
import {
  _resetConfiguration,
  initializeTracing,
} from "../src/opentelemetry-lib/configuration";
import { getTracer } from "../src/opentelemetry-lib/tracing";
import { getParentSpanId } from "../src/opentelemetry-lib/tracing/compat";
import { withForcedTraceId } from "../src/opentelemetry-lib/tracing/id-generator";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const CLIENT_INFO = { name: "claude-code", version: "2.0.1" };

const textOf = (result: any): string => result.content?.[0]?.text;

void describe("wrapMcpServer", () => {
  const exporter = new InMemorySpanExporter();

  void beforeEach(() => {
    _resetConfiguration();
    initializeTracing({ exporter, disableBatch: true });
    Object.defineProperty(Laminar, "isInitialized", {
      value: true,
      writable: true,
    });
  });

  void afterEach(() => {
    exporter.reset();
    resetMcpState();
  });

  void after(async () => {
    await exporter.shutdown();
    trace.disable();
    context.disable();
  });

  const mcpSpans = (): ReadableSpan[] =>
    exporter
      .getFinishedSpans()
      .filter((span) => span.attributes["mcp.method.name"] !== undefined);

  const onlySpan = (): ReadableSpan => {
    const spans = mcpSpans();
    assert.equal(spans.length, 1, `expected one MCP span, got ${spans.length}`);
    return spans[0];
  };

  // An McpServer (SDK 1.x) with a typical set of tools, wrapped.
  const buildServer = (
    options?: Parameters<typeof wrapMcpServer>[1],
    received: unknown[] = [],
  ) => {
    const server = wrapMcpServer(
      new McpServer({ name: "docs", version: "1.0.0" }),
      options,
    );
    server.registerTool(
      "search_docs",
      {
        description: "Search the docs",
        inputSchema: { query: z.string(), apiKey: z.string().optional() },
      },
      (args) => {
        received.push(args);
        return { content: [{ type: "text", text: `found ${args.query}` }] };
      },
    );
    server.registerTool(
      "strict_tool",
      {
        inputSchema: z.object({ id: z.number() }).strict(),
      },
      (args) => {
        received.push(args);
        return { content: [{ type: "text", text: `id ${args.id}` }] };
      },
    );
    server.registerTool(
      "own_context",
      { inputSchema: { context: z.string() } },
      (args) => {
        received.push(args);
        return { content: [{ type: "text", text: args.context }] };
      },
    );
    server.registerTool("fails", { inputSchema: {} }, () => ({
      content: [{ type: "text", text: "upstream is down" }],
      isError: true,
    }));
    server.registerTool("throws", { inputSchema: {} }, () => {
      throw new TypeError("boom");
    });
    server.registerPrompt(
      "summarize",
      { argsSchema: { topic: z.string() } },
      ({ topic }) => ({
        messages: [
          {
            role: "user",
            content: { type: "text", text: `Summarize ${topic}` },
          },
        ],
      }),
    );
    server.registerPrompt("broken", {}, () => {
      throw new RangeError("bad prompt");
    });
    server.registerResource(
      "readme",
      "docs://readme",
      { mimeType: "text/plain" },
      (uri) => ({ contents: [{ uri: uri.href, text: "hello" }] }),
    );
    return server;
  };

  const connect = async (
    server: { connect: (t: any) => Promise<void> },
    sessionId?: string,
  ) => {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    serverTransport.sessionId = sessionId;
    await server.connect(serverTransport);
    const client = new Client(CLIENT_INFO);
    await client.connect(clientTransport);
    return client;
  };

  void it("records a tools/call as a root SERVER span", async () => {
    const received: unknown[] = [];
    const client = await connect(buildServer({}, received));
    const result = await client.callTool({
      name: "search_docs",
      arguments: { query: "otel", context: "  Set up tracing for my app  " },
    });
    assert.equal(textOf(result), "found otel");
    assert.deepEqual(received, [{ query: "otel" }]);

    const span = onlySpan();
    assert.equal(span.name, "tools/call search_docs");
    assert.equal(span.kind, SpanKind.SERVER);
    assert.equal(getParentSpanId(span as any), undefined);
    const attrs = span.attributes;
    assert.equal(attrs["mcp.method.name"], "tools/call");
    assert.equal(attrs["gen_ai.operation.name"], "execute_tool");
    assert.equal(attrs["gen_ai.tool.name"], "search_docs");
    assert.equal(attrs["lmnr.span.type"], "TOOL");
    assert.equal(typeof attrs["jsonrpc.request.id"], "string");
    assert.equal(attrs["lmnr.mcp.client.name"], "claude-code");
    assert.equal(attrs["lmnr.mcp.client.version"], "2.0.1");
    assert.equal(typeof attrs["mcp.protocol.version"], "string");
    assert.equal(attrs["lmnr.mcp.context"], "Set up tracing for my app");
    assert.deepEqual(
      JSON.parse(attrs["gen_ai.tool.call.arguments"] as string),
      {
        query: "otel",
        context: "  Set up tracing for my app  ",
      },
    );
    assert.deepEqual(JSON.parse(attrs["gen_ai.tool.call.result"] as string), {
      content: [{ type: "text", text: "found otel" }],
    });
    assert.equal(attrs["lmnr.span.input"], undefined);
    assert.equal(attrs["lmnr.span.output"], undefined);
    assert.equal(attrs["error.type"], undefined);
    assert.equal(attrs["mcp.session.id"], undefined);
    assert.equal(span.status.code, SpanStatusCode.UNSET);
  });

  void it("does not trace initialize, ping or list requests", async () => {
    const client = await connect(buildServer());
    await client.ping();
    await client.listTools();
    await client.listPrompts();
    await client.listResources();
    assert.equal(mcpSpans().length, 0);
  });

  void it("injects an optional context field into every tool schema", async () => {
    const client = await connect(buildServer());
    const { tools } = await client.listTools();
    for (const tool of tools) {
      const properties = tool.inputSchema.properties as Record<string, any>;
      if (tool.name === "own_context") {
        assert.equal(properties.context.description, undefined);
        assert.deepEqual(tool.inputSchema.required, ["context"]);
        continue;
      }
      assert.deepEqual(properties.context, {
        type: "string",
        description: CONTEXT_DESCRIPTION,
      });
      assert.ok(!(tool.inputSchema.required ?? []).includes("context"));
    }
    // Listing twice does not stack anything (the SDK's schemas are not mutated).
    const again = await client.listTools();
    assert.deepEqual(again.tools, tools);
  });

  void it("strips context before strict schema validation", async () => {
    const received: unknown[] = [];
    const client = await connect(buildServer({}, received));
    const result = await client.callTool({
      name: "strict_tool",
      arguments: { id: 7, context: "debug a failing job" },
    });
    assert.equal(result.isError, undefined);
    assert.equal(textOf(result), "id 7");
    assert.deepEqual(received, [{ id: 7 }]);
    assert.equal(
      onlySpan().attributes["lmnr.mcp.context"],
      "debug a failing job",
    );
  });

  void it("works when the client sends no context", async () => {
    const received: unknown[] = [];
    const client = await connect(buildServer({}, received));
    const result = await client.callTool({
      name: "search_docs",
      arguments: { query: "x" },
    });
    assert.equal(textOf(result), "found x");
    assert.deepEqual(received, [{ query: "x" }]);
    assert.equal(onlySpan().attributes["lmnr.mcp.context"], undefined);
  });

  void it("leaves a tool with its own context argument alone", async () => {
    const received: unknown[] = [];
    const client = await connect(buildServer({}, received));
    const result = await client.callTool({
      name: "own_context",
      arguments: { context: "the tool's own value" },
    });
    assert.equal(textOf(result), "the tool's own value");
    assert.deepEqual(received, [{ context: "the tool's own value" }]);
    assert.equal(onlySpan().attributes["lmnr.mcp.context"], undefined);
  });

  void it("falls back to the aiInvocation userIntent", async () => {
    const client = await connect(buildServer());
    await client.callTool({
      name: "search_docs",
      arguments: { query: "x" },
      _meta: {
        "io.modelcontextprotocol/aiInvocation": { userIntent: "find docs" },
      },
    });
    assert.equal(onlySpan().attributes["lmnr.mcp.context"], "find docs");
  });

  void it("classifies argument validation failures as -32602", async () => {
    const client = await connect(buildServer());
    const result = await client.callTool({
      name: "strict_tool",
      arguments: { id: "not a number" },
    });
    assert.equal(result.isError, true);
    const span = onlySpan();
    assert.equal(span.attributes["error.type"], "-32602");
    // 1.x folds it into an isError result, not a JSON-RPC error.
    assert.equal(span.attributes["rpc.response.status_code"], undefined);
    assert.equal(span.status.code, SpanStatusCode.ERROR);
    const event = span.events.find((e) => e.name === "exception");
    assert.equal(event?.attributes?.["exception.type"], "-32602");
    assert.match(
      event?.attributes?.["exception.message"] as string,
      /Input validation error/,
    );
  });

  void it("classifies an unknown tool as -32602", async () => {
    const client = await connect(buildServer());
    const result = await client.callTool({ name: "nope", arguments: {} });
    assert.equal(result.isError, true);
    const span = onlySpan();
    assert.equal(span.name, "tools/call nope");
    assert.equal(span.attributes["error.type"], "-32602");
  });

  void it("classifies an isError result as tool_error", async () => {
    const client = await connect(buildServer());
    await client.callTool({ name: "fails", arguments: {} });
    const span = onlySpan();
    assert.equal(span.attributes["error.type"], "tool_error");
    assert.equal(span.status.code, SpanStatusCode.ERROR);
    const event = span.events.find((e) => e.name === "exception");
    assert.equal(event?.attributes?.["exception.type"], "tool_error");
    assert.equal(event?.attributes?.["exception.message"], "upstream is down");
    assert.deepEqual(
      JSON.parse(span.attributes["gen_ai.tool.call.result"] as string).isError,
      true,
    );
  });

  void it("records the class of an exception thrown by a tool", async () => {
    const client = await connect(buildServer());
    const result = await client.callTool({ name: "throws", arguments: {} });
    // The SDK still answers with its own isError result.
    assert.equal(result.isError, true);
    assert.equal(textOf(result), "boom");
    const span = onlySpan();
    assert.equal(span.attributes["error.type"], "TypeError");
    const event = span.events.find((e) => e.name === "exception");
    assert.equal(event?.attributes?.["exception.message"], "boom");
  });

  void it("records prompts/get and resources/read", async () => {
    const client = await connect(buildServer());
    await client.getPrompt({ name: "summarize", arguments: { topic: "otel" } });
    await client.readResource({ uri: "docs://readme" });
    const [prompt, resource] = mcpSpans();
    assert.equal(prompt.name, "prompts/get summarize");
    assert.equal(prompt.kind, SpanKind.SERVER);
    assert.equal(prompt.attributes["gen_ai.prompt.name"], "summarize");
    assert.equal(prompt.attributes["lmnr.span.type"], "DEFAULT");
    assert.equal(prompt.attributes["gen_ai.operation.name"], undefined);
    assert.deepEqual(
      JSON.parse(prompt.attributes["lmnr.span.input"] as string),
      {
        name: "summarize",
        arguments: { topic: "otel" },
      },
    );
    assert.match(
      prompt.attributes["lmnr.span.output"] as string,
      /Summarize otel/,
    );

    assert.equal(resource.name, "resources/read");
    assert.equal(resource.attributes["mcp.resource.uri"], "docs://readme");
    assert.match(resource.attributes["lmnr.span.output"] as string, /hello/);
    assert.equal(resource.attributes["error.type"], undefined);
  });

  void it("records JSON-RPC errors and handler exceptions of prompts", async () => {
    const client = await connect(buildServer());
    await assert.rejects(client.getPrompt({ name: "broken" }));
    await assert.rejects(client.readResource({ uri: "docs://missing" }));
    const [prompt, resource] = mcpSpans();
    assert.equal(prompt.attributes["error.type"], "RangeError");
    assert.equal(prompt.attributes["rpc.response.status_code"], "-32603");
    assert.equal(prompt.status.code, SpanStatusCode.ERROR);
    assert.equal(resource.attributes["error.type"], "-32602");
    assert.equal(resource.attributes["rpc.response.status_code"], "-32602");
  });

  void it("redacts secrets in arguments", async () => {
    const client = await connect(buildServer({ redactKeys: ["query"] }));
    await client.callTool({
      name: "search_docs",
      arguments: { query: "q", apiKey: "sk-123" },
    });
    assert.deepEqual(
      JSON.parse(onlySpan().attributes["gen_ai.tool.call.arguments"] as string),
      { query: "[REDACTED]", apiKey: "[REDACTED]" },
    );
  });

  void it("records only names, counts and errors without payloads", async () => {
    const received: unknown[] = [];
    const client = await connect(
      buildServer({ recordPayloads: false }, received),
    );
    const { tools } = await client.listTools();
    assert.equal(
      (tools[0].inputSchema.properties as Record<string, unknown>).context,
      undefined,
    );
    await client.callTool({
      name: "search_docs",
      arguments: { query: "q" },
      _meta: {
        "io.modelcontextprotocol/aiInvocation": { userIntent: "find docs" },
      },
    });
    await client.callTool({ name: "fails", arguments: {} });
    await client.readResource({ uri: "docs://readme" });
    const [ok, failed, resource] = mcpSpans();
    for (const span of [ok, failed, resource]) {
      for (const key of [
        "gen_ai.tool.call.arguments",
        "gen_ai.tool.call.result",
        "lmnr.span.input",
        "lmnr.span.output",
        "lmnr.mcp.context",
        "mcp.resource.uri",
      ]) {
        assert.equal(span.attributes[key], undefined, `${span.name} ${key}`);
      }
      assert.equal(span.attributes["lmnr.mcp.client.name"], "claude-code");
    }
    assert.equal(ok.attributes["gen_ai.tool.name"], "search_docs");
    assert.equal(failed.attributes["error.type"], "tool_error");
    const event = failed.events.find((e) => e.name === "exception");
    assert.equal(
      event?.attributes?.["exception.message"],
      "Tool returned an error",
    );
    assert.equal(failed.status.message, "Tool returned an error");
  });

  void it("does not inject context when switched off", async () => {
    const client = await connect(buildServer({ context: false }));
    const { tools } = await client.listTools();
    const search = tools.find((t) => t.name === "search_docs")!;
    assert.equal(
      (search.inputSchema.properties as Record<string, unknown>).context,
      undefined,
    );
  });

  void it("records the session and groups a turn into one trace", async () => {
    const client = await connect(buildServer({ turnGapMs: 100 }), "sess-1");
    await client.callTool({ name: "search_docs", arguments: { query: "a" } });
    await client.callTool({ name: "search_docs", arguments: { query: "b" } });
    await sleep(250);
    await client.callTool({ name: "search_docs", arguments: { query: "c" } });
    const [a, b, c] = mcpSpans();
    for (const span of [a, b, c]) {
      assert.equal(span.attributes["mcp.session.id"], "sess-1");
      assert.equal(
        span.attributes["lmnr.association.properties.session_id"],
        "sess-1",
      );
      assert.equal(getParentSpanId(span as any), undefined);
    }
    assert.equal(a.spanContext().traceId, b.spanContext().traceId);
    assert.notEqual(a.spanContext().spanId, b.spanContext().spanId);
    assert.notEqual(b.spanContext().traceId, c.spanContext().traceId);
  });

  void it("groups overlapping calls of a session into one trace", async () => {
    const server = wrapMcpServer(new McpServer({ name: "s", version: "1" }), {
      turnGapMs: 0,
    });
    server.registerTool("slow", { inputSchema: {} }, async () => {
      await sleep(60);
      return { content: [{ type: "text", text: "ok" }] };
    });
    const client = await connect(server, "sess-overlap");
    await Promise.all([
      client.callTool({ name: "slow", arguments: {} }),
      client.callTool({ name: "slow", arguments: {} }),
    ]);
    const [a, b] = mcpSpans();
    assert.equal(a.spanContext().traceId, b.spanContext().traceId);
  });

  void it("does not group calls without a session", async () => {
    const client = await connect(buildServer());
    await client.callTool({ name: "search_docs", arguments: { query: "a" } });
    await client.callTool({ name: "search_docs", arguments: { query: "b" } });
    const [a, b] = mcpSpans();
    assert.notEqual(a.spanContext().traceId, b.spanContext().traceId);
  });

  void it("uses the client's turn id for a deterministic trace id", async () => {
    const client = await connect(buildServer(), "sess-2");
    const meta = {
      "io.modelcontextprotocol/aiInvocation": { turnId: "turn-42" },
    };
    await client.callTool({
      name: "search_docs",
      arguments: { query: "a" },
      _meta: meta,
    });
    const span = onlySpan();
    assert.equal(
      span.spanContext().traceId,
      traceIdForTurn("sess-2", "turn-42"),
    );
    assert.equal(getParentSpanId(span as any), undefined);
    // sha256("sess-2\nturn-42"), first 16 bytes
    assert.equal(traceIdForTurn("sess-2", "turn-42").length, 32);
    assert.notEqual(traceIdForTurn(undefined, "t"), traceIdForTurn("s", "t"));
  });

  void it("without a session, reuses a traceparent's trace id with a link, as a root span", async () => {
    const client = await connect(buildServer());
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const spanId = "00f067aa0ba902b7";
    await client.callTool({
      name: "search_docs",
      arguments: { query: "a" },
      _meta: { traceparent: `00-${traceId}-${spanId}-01` },
    });
    const span = onlySpan();
    assert.equal(span.spanContext().traceId, traceId);
    assert.equal(getParentSpanId(span as any), undefined);
    assert.equal(span.links.length, 1);
    assert.equal(span.links[0].context.traceId, traceId);
    assert.equal(span.links[0].context.spanId, spanId);
  });

  void it("with a session, the turn tracker wins over per-call traceparents", async () => {
    const client = await connect(buildServer(), "sess-tp");
    const parents = [
      ["11111111111111111111111111111111", "1111111111111111"],
      ["22222222222222222222222222222222", "2222222222222222"],
    ];
    for (const [traceId, spanId] of parents) {
      await client.callTool({
        name: "search_docs",
        arguments: { query: "a" },
        _meta: { traceparent: `00-${traceId}-${spanId}-01` },
      });
    }
    const spans = mcpSpans();
    assert.equal(spans.length, 2);
    assert.equal(
      spans[0].spanContext().traceId,
      spans[1].spanContext().traceId,
    );
    spans.forEach((span, i) => {
      const [traceId, spanId] = parents[i];
      assert.notEqual(span.spanContext().traceId, traceId);
      assert.equal(getParentSpanId(span as any), undefined);
      assert.equal(span.links.length, 1);
      assert.equal(span.links[0].context.traceId, traceId);
      assert.equal(span.links[0].context.spanId, spanId);
    });
  });

  void it("ignores an invalid traceparent", async () => {
    const client = await connect(buildServer());
    await client.callTool({
      name: "search_docs",
      arguments: { query: "a" },
      _meta: { traceparent: `00-${"0".repeat(32)}-00f067aa0ba902b7-01` },
    });
    const span = onlySpan();
    assert.notEqual(span.spanContext().traceId, "0".repeat(32));
    assert.equal(span.links.length, 0);
  });

  void it("uses the ChatGPT session meta when there is no transport session", async () => {
    const client = await connect(buildServer());
    await client.callTool({
      name: "search_docs",
      arguments: { query: "a" },
      _meta: { "openai/session": "chatgpt-1" },
    });
    assert.equal(onlySpan().attributes["mcp.session.id"], "chatgpt-1");
  });

  void it("nests the handler's spans under the MCP span", async () => {
    const server = wrapMcpServer(new McpServer({ name: "s", version: "1" }));
    server.registerTool("nested", { inputSchema: {} }, async () => {
      const span = getTracer().startSpan("inner");
      await sleep(1);
      span.end();
      return { content: [{ type: "text", text: "ok" }] };
    });
    const client = await connect(server, "sess-nested");
    await client.callTool({ name: "nested", arguments: {} });
    const mcp = onlySpan();
    const inner = exporter.getFinishedSpans().find((s) => s.name === "inner")!;
    assert.equal(inner.spanContext().traceId, mcp.spanContext().traceId);
    assert.equal(getParentSpanId(inner as any), mcp.spanContext().spanId);
    assert.equal(
      inner.attributes["lmnr.association.properties.session_id"],
      "sess-nested",
    );
  });

  void it("is a no-op when wrapped twice", async () => {
    const server = wrapMcpServer(buildServer());
    assert.equal(wrapMcpServer(server), server);
    wrapMcpServer(server.server);
    const client = await connect(server);
    const { tools } = await client.listTools();
    const search = tools.find((t) => t.name === "search_docs")!;
    assert.ok((search.inputSchema.properties as any).context);
    await client.callTool({ name: "search_docs", arguments: { query: "a" } });
    assert.equal(mcpSpans().length, 1);
  });

  void it("leaves unsupported objects alone", () => {
    const value = { foo: 1 };
    assert.equal(wrapMcpServer(value), value);
    assert.equal(wrapMcpServer(null), null);
  });

  void it("traces a low-level Server", async () => {
    const received: unknown[] = [];
    const server = wrapMcpServer(
      new Server(
        { name: "low", version: "1.0.0" },
        { capabilities: { tools: {} } },
      ),
    );
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: [
        {
          name: "echo",
          inputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            additionalProperties: false,
          },
        },
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, (request) => {
      received.push(request.params.arguments);
      if (request.params.name !== "echo") {
        throw new Error(`unknown tool ${request.params.name}`);
      }
      return {
        content: [
          { type: "text", text: String(request.params.arguments?.text) },
        ],
      };
    });
    const client = await connect(server, "low-sess");
    const { tools } = await client.listTools();
    assert.equal(
      (tools[0].inputSchema.properties as any).context.description,
      CONTEXT_DESCRIPTION,
    );
    await client.callTool({
      name: "echo",
      arguments: { text: "hi", context: "testing echo" },
    });
    await assert.rejects(client.callTool({ name: "other", arguments: {} }));
    assert.deepEqual(received, [{ text: "hi" }, {}]);
    const [ok, failed] = mcpSpans();
    assert.equal(ok.name, "tools/call echo");
    assert.equal(ok.attributes["lmnr.mcp.context"], "testing echo");
    assert.equal(ok.attributes["mcp.session.id"], "low-sess");
    assert.equal(ok.attributes["lmnr.mcp.client.name"], "claude-code");
    assert.equal(failed.attributes["error.type"], "Error");
    assert.equal(failed.attributes["rpc.response.status_code"], "-32603");
  });

  void it("traces Streamable HTTP sessions", async () => {
    const transports = new Map<string, StreamableHTTPServerTransport>();
    const httpServer: HttpServer = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = chunks.length
        ? JSON.parse(Buffer.concat(chunks).toString())
        : undefined;
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let transport = sessionId ? transports.get(sessionId) : undefined;
      if (!transport) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => "http-session-1",
          onsessioninitialized: (id) => {
            transports.set(id, transport!);
          },
        });
        // One server per session, as the SDK examples do.
        await buildServer().connect(transport);
      }
      await transport.handleRequest(req, res, body);
    });
    await new Promise<void>((resolve) =>
      httpServer.listen(0, "127.0.0.1", resolve),
    );
    try {
      const { port } = httpServer.address() as AddressInfo;
      const client = new Client(CLIENT_INFO);
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL(`http://127.0.0.1:${port}/mcp`),
        ),
      );
      await client.callTool({ name: "search_docs", arguments: { query: "a" } });
      await client.callTool({ name: "search_docs", arguments: { query: "b" } });
      await client.close();
      const [a, b] = mcpSpans();
      assert.equal(a.attributes["mcp.session.id"], "http-session-1");
      assert.equal(a.attributes["network.transport"], "tcp");
      assert.equal(a.attributes["network.protocol.name"], "http");
      assert.equal(typeof a.attributes["mcp.protocol.version"], "string");
      assert.equal(a.attributes["lmnr.mcp.client.name"], "claude-code");
      assert.equal(a.spanContext().traceId, b.spanContext().traceId);
    } finally {
      for (const transport of transports.values()) await transport.close();
      await new Promise((resolve) => httpServer.close(resolve));
    }
  });

  void it("traces an McpServer of @modelcontextprotocol/server 2.x", async () => {
    const received: unknown[] = [];
    const server = wrapMcpServer(
      new McpServerV2({ name: "v2", version: "1.0.0" }),
    );
    server.registerTool(
      "search_docs",
      { inputSchema: z.object({ query: z.string() }).strict() },
      (args) => {
        received.push(args);
        return { content: [{ type: "text", text: `found ${args.query}` }] };
      },
    );
    server.registerTool(
      "own_context",
      { inputSchema: z.object({ context: z.string() }) },
      (args) => ({ content: [{ type: "text", text: args.context }] }),
    );
    server.registerTool("throws", { inputSchema: z.object({}) }, () => {
      throw new SyntaxError("bad");
    });
    const [clientTransport, serverTransport] =
      InMemoryTransportV2.createLinkedPair();
    (serverTransport as any).sessionId = "v2-sess";
    await server.connect(serverTransport);
    const client = new ClientV2(CLIENT_INFO);
    await client.connect(clientTransport);

    const { tools } = await client.listTools();
    const search = tools.find((t) => t.name === "search_docs")!;
    assert.equal(
      (search.inputSchema.properties as any).context.description,
      CONTEXT_DESCRIPTION,
    );
    const own = tools.find((t) => t.name === "own_context")!;
    assert.equal(
      (own.inputSchema.properties as any).context.description,
      undefined,
    );

    const result = await client.callTool({
      name: "search_docs",
      arguments: { query: "q", context: "learn v2" },
    });
    assert.equal(textOf(result), "found q");
    assert.deepEqual(received, [{ query: "q" }]);
    const ownResult = await client.callTool({
      name: "own_context",
      arguments: { context: "mine" },
    });
    assert.equal(textOf(ownResult), "mine");
    const invalid = await client.callTool({
      name: "search_docs",
      arguments: { query: 1 },
    });
    assert.equal(invalid.isError, true);
    await assert.rejects(client.callTool({ name: "nope", arguments: {} }));
    await client.callTool({ name: "throws", arguments: {} });

    const [ok, ownSpan, invalidSpan, unknown, thrown] = mcpSpans();
    assert.equal(ok.name, "tools/call search_docs");
    assert.equal(ok.attributes["lmnr.mcp.context"], "learn v2");
    assert.equal(ok.attributes["mcp.session.id"], "v2-sess");
    assert.equal(ok.attributes["lmnr.mcp.client.name"], "claude-code");
    assert.equal(typeof ok.attributes["mcp.protocol.version"], "string");
    assert.equal(ownSpan.attributes["lmnr.mcp.context"], undefined);
    assert.equal(invalidSpan.attributes["error.type"], "-32602");
    assert.equal(invalidSpan.attributes["rpc.response.status_code"], undefined);
    // 2.x answers an unknown tool with a JSON-RPC error.
    assert.equal(unknown.attributes["error.type"], "-32602");
    assert.equal(unknown.attributes["rpc.response.status_code"], "-32602");
    assert.equal(thrown.attributes["error.type"], "SyntaxError");
    assert.equal(ok.spanContext().traceId, thrown.spanContext().traceId);
  });

  void it("traces a low-level Server of @modelcontextprotocol/server 2.x", async () => {
    const received: unknown[] = [];
    const server = wrapMcpServer(
      new ServerV2(
        { name: "low2", version: "1.0.0" },
        { capabilities: { tools: {} } },
      ),
    );
    server.setRequestHandler("tools/list", () => ({
      tools: [{ name: "echo", inputSchema: { type: "object" as const } }],
    }));
    server.setRequestHandler("tools/call", (request) => {
      received.push(request.params.arguments);
      return { content: [{ type: "text" as const, text: "ok" }] };
    });
    const [clientTransport, serverTransport] =
      InMemoryTransportV2.createLinkedPair();
    await server.connect(serverTransport);
    const client = new ClientV2(CLIENT_INFO);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    assert.ok((tools[0].inputSchema.properties as any).context);
    await client.callTool({ name: "echo", arguments: { context: "goal" } });
    assert.deepEqual(received, [{}]);
    const span = onlySpan();
    assert.equal(span.name, "tools/call echo");
    assert.equal(span.attributes["lmnr.mcp.context"], "goal");
    assert.equal(span.attributes["lmnr.mcp.client.name"], "claude-code");
  });
});

void describe("MCP redaction", () => {
  const SECRET = [
    "password",
    "user_password",
    "apiKey",
    "api_key",
    "X-API-Key",
    "client_secret",
    "access_token",
    "refreshToken",
    "githubToken",
    "Authorization",
    "auth",
    "session_cookie",
    "private_key",
    "aws_access_key_id",
    "credentials",
    "jwt",
  ];
  const NOT_SECRET = [
    "max_tokens",
    "tokens",
    "author",
    "query",
    "session_id",
    "token_count",
    "path",
    "keyword",
  ];

  for (const key of SECRET) {
    void it(`treats ${key} as secret`, () => {
      assert.equal(isSecretKey(key), true);
    });
  }
  for (const key of NOT_SECRET) {
    void it(`does not treat ${key} as secret`, () => {
      assert.equal(isSecretKey(key), false);
    });
  }

  void it("redacts recursively without mutating", () => {
    const value = {
      query: "q",
      nested: [{ password: { any: "shape" }, keep: 1 }],
      headers: { Authorization: "Bearer x" },
      custom_field: "v",
    };
    const copy = structuredClone(value);
    assert.deepEqual(redact(value, new Set(["customfield"])), {
      query: "q",
      nested: [{ password: "[REDACTED]", keep: 1 }],
      headers: { Authorization: "[REDACTED]" },
      custom_field: "[REDACTED]",
    });
    assert.deepEqual(value, copy);
  });

  void it("survives cycles", () => {
    const value: Record<string, unknown> = { a: 1 };
    value.self = value;
    assert.deepEqual(redact(value), { a: 1, self: "[Circular reference]" });
  });
});

void describe("MCP options and forced trace ids", () => {
  void it("clamps turnGapMs to 25 s", () => {
    assert.equal(resolveMcpOptions({ turnGapMs: 60_000 }).turnGapMs, 25_000);
    assert.equal(resolveMcpOptions({ turnGapMs: 5_000 }).turnGapMs, 5_000);
    assert.equal(resolveMcpOptions({}).turnGapMs, 20_000);
    assert.equal(resolveMcpOptions({ turnGapMs: -1 }).turnGapMs, 20_000);
  });

  void it("turns context off with recordPayloads", () => {
    assert.equal(resolveMcpOptions({}).context, true);
    assert.equal(resolveMcpOptions({ context: false }).context, false);
    assert.equal(resolveMcpOptions({ recordPayloads: false }).context, false);
  });

  void it("forces the trace id of a root span only", () => {
    const exporter = new InMemorySpanExporter();
    _resetConfiguration();
    initializeTracing({ exporter, disableBatch: true });
    const forced = "1234567890abcdef1234567890abcdef";
    const root = withForcedTraceId(forced, () => getTracer().startSpan("root"));
    assert.equal(root.spanContext().traceId, forced);
    const other = getTracer().startSpan("other");
    assert.notEqual(other.spanContext().traceId, forced);
    root.end();
    other.end();
  });
});
