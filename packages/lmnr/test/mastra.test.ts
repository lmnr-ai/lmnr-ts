import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { SpanStatusCode } from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";

import { LaminarMastraExporter } from "../src/opentelemetry-lib/instrumentation/mastra";

// Shape matches `@mastra/core/observability` ExportedSpan without requiring
// the package to be installed for unit tests.
type MinimalSpan = {
  id: string;
  traceId: string;
  parentSpanId?: string;
  name: string;
  type: string;
  startTime: Date;
  endTime?: Date;
  attributes?: Record<string, any>;
  metadata?: Record<string, any>;
  tags?: string[];
  input?: unknown;
  output?: unknown;
  errorInfo?: { message: string; name?: string; stack?: string };
  isEvent: boolean;
  isRootSpan?: boolean;
};

const makeSpan = (overrides: Partial<MinimalSpan> & Pick<MinimalSpan,
  "id" | "traceId" | "name" | "type"
>): MinimalSpan => ({
  startTime: new Date("2024-01-01T00:00:00.000Z"),
  endTime: new Date("2024-01-01T00:00:01.000Z"),
  isEvent: false,
  isRootSpan: false,
  ...overrides,
});

// The exporter declares its event parameter as an internal MastraTracingEvent
// structural type; at runtime all the fields it reads also exist on MinimalSpan,
// so we cast through `unknown` to satisfy TS without pulling in @mastra/core.
const end = (span: MinimalSpan) =>
  ({ type: "span_ended" as const, exportedSpan: span }) as unknown as Parameters<
    LaminarMastraExporter["exportTracingEvent"]
  >[0];

const start = (span: MinimalSpan) =>
  ({ type: "span_started" as const, exportedSpan: span }) as unknown as Parameters<
    LaminarMastraExporter["exportTracingEvent"]
  >[0];

void describe("LaminarMastraExporter", () => {
  let inMemory: InMemorySpanExporter;
  let exporter: LaminarMastraExporter;

  void beforeEach(() => {
    inMemory = new InMemorySpanExporter();
    exporter = new LaminarMastraExporter({ exporter: inMemory });
  });

  void afterEach(async () => {
    await exporter.shutdown();
    inMemory.reset();
  });

  void it("maps MODEL_STEP spans to Laminar LLM span type", async () => {
    const span = makeSpan({
      id: "0000000000000001",
      traceId: "00000000000000000000000000000001",
      name: "openai:gpt-4o:step-0",
      type: "model_step",
      attributes: {
        stepIndex: 0,
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    });

    await exporter.exportTracingEvent(end(span));

    const finished = inMemory.getFinishedSpans();
    assert.equal(finished.length, 1);
    const [out] = finished;
    assert.equal(out.attributes["lmnr.span.type"], "LLM");
    assert.equal(out.attributes["mastra.span.original_type"], "model_step");
    assert.equal(out.attributes["gen_ai.usage.input_tokens"], 10);
    assert.equal(out.attributes["gen_ai.usage.output_tokens"], 5);
    assert.equal(out.attributes["llm.usage.total_tokens"], 15);
  });

  void it("maps TOOL_CALL spans to Laminar TOOL span type", async () => {
    const span = makeSpan({
      id: "0000000000000002",
      traceId: "00000000000000000000000000000002",
      name: "weather",
      type: "tool_call",
      attributes: { toolType: "function", success: true },
      input: { city: "Paris" },
      output: { temp: 20 },
    });

    await exporter.exportTracingEvent(end(span));

    const [out] = inMemory.getFinishedSpans();
    assert.equal(out.attributes["lmnr.span.type"], "TOOL");
    assert.equal(out.attributes["gen_ai.tool.name"], "weather");
    assert.equal(out.attributes["gen_ai.tool.type"], "function");
    assert.equal(out.attributes["gen_ai.tool.success"], true);
    assert.equal(out.attributes["lmnr.span.input"], '{"city":"Paris"}');
    assert.equal(out.attributes["lmnr.span.output"], '{"temp":20}');
  });

  void it("maps MCP_TOOL_CALL spans to Laminar TOOL with MCP server info", async () => {
    const span = makeSpan({
      id: "0000000000000003",
      traceId: "00000000000000000000000000000003",
      name: "fetch_docs",
      type: "mcp_tool_call",
      attributes: {
        mcpServer: "docs-server",
        serverVersion: "1.2.3",
        success: true,
      },
    });

    await exporter.exportTracingEvent(end(span));

    const [out] = inMemory.getFinishedSpans();
    assert.equal(out.attributes["lmnr.span.type"], "TOOL");
    assert.equal(out.attributes["gen_ai.tool.name"], "fetch_docs");
    assert.equal(out.attributes["gen_ai.tool.mcp.server"], "docs-server");
    assert.equal(out.attributes["gen_ai.tool.mcp.server_version"], "1.2.3");
  });

  void it("keeps MODEL_GENERATION as DEFAULT span type", async () => {
    const span = makeSpan({
      id: "0000000000000004",
      traceId: "00000000000000000000000000000004",
      name: "agent.run",
      type: "model_generation",
      attributes: {
        model: "gpt-4o",
        provider: "openai.chat",
        responseModel: "gpt-4o-2024-08-06",
        usage: { inputTokens: 100, outputTokens: 50 },
      },
    });

    await exporter.exportTracingEvent(end(span));

    const [out] = inMemory.getFinishedSpans();
    assert.equal(out.attributes["lmnr.span.type"], "DEFAULT");
    assert.equal(
      out.attributes["mastra.span.original_type"],
      "model_generation",
    );
    // GenAI attrs still flow through so Laminar can show the model/provider.
    assert.equal(out.attributes["gen_ai.system"], "openai");
    assert.equal(out.attributes["gen_ai.request.model"], "gpt-4o");
    assert.equal(out.attributes["gen_ai.response.model"], "gpt-4o-2024-08-06");
  });

  void it("drops MODEL_CHUNK spans entirely", async () => {
    const span = makeSpan({
      id: "0000000000000005",
      traceId: "00000000000000000000000000000005",
      name: "chunk-0",
      type: "model_chunk",
      isEvent: true,
      attributes: { chunkType: "text-delta", sequenceNumber: 0 },
    });

    await exporter.exportTracingEvent(start(span));
    await exporter.exportTracingEvent(end(span));

    assert.equal(inMemory.getFinishedSpans().length, 0);
  });

  void it("maps workflow and other Mastra span types to DEFAULT", async () => {
    const cases: Array<{ type: string; name: string }> = [
      { type: "agent_run", name: "root-agent" },
      { type: "workflow_run", name: "checkout-workflow" },
      { type: "workflow_step", name: "step-1" },
      { type: "memory_operation", name: "recall" },
      { type: "processor_run", name: "moderator" },
      { type: "generic", name: "custom" },
    ];

    let n = 0;
    for (const c of cases) {
      await exporter.exportTracingEvent(
        end(
          makeSpan({
            id: `00000000000001${String(n).padStart(2, "0")}`,
            traceId: `000000000000000000000000000010${String(n).padStart(2, "0")}`,
            name: c.name,
            type: c.type,
          }),
        ),
      );
      n++;
    }

    const finished = inMemory.getFinishedSpans();
    assert.equal(finished.length, cases.length);
    for (const span of finished) {
      assert.equal(span.attributes["lmnr.span.type"], "DEFAULT");
    }
  });

  void it("builds lmnr.span.path from parent hierarchy", async () => {
    const parent = makeSpan({
      id: "00000000000000a1",
      traceId: "000000000000000000000000000000aa",
      name: "agent.run",
      type: "agent_run",
      isRootSpan: true,
    });

    const child = makeSpan({
      id: "00000000000000a2",
      traceId: "000000000000000000000000000000aa",
      parentSpanId: "00000000000000a1",
      name: "openai:gpt-4o",
      type: "model_generation",
    });

    const grandchild = makeSpan({
      id: "00000000000000a3",
      traceId: "000000000000000000000000000000aa",
      parentSpanId: "00000000000000a2",
      name: "openai:gpt-4o:step-0",
      type: "model_step",
    });

    await exporter.exportTracingEvent(start(parent));
    await exporter.exportTracingEvent(start(child));
    await exporter.exportTracingEvent(start(grandchild));
    await exporter.exportTracingEvent(end(grandchild));
    await exporter.exportTracingEvent(end(child));
    await exporter.exportTracingEvent(end(parent));

    const finished = inMemory.getFinishedSpans();
    assert.equal(finished.length, 3);
    const byName = Object.fromEntries(finished.map((s) => [s.name, s]));

    assert.deepEqual(byName["agent.run"].attributes["lmnr.span.path"], [
      "agent.run",
    ]);
    assert.deepEqual(byName["openai:gpt-4o"].attributes["lmnr.span.path"], [
      "agent.run",
      "openai:gpt-4o",
    ]);
    assert.deepEqual(
      byName["openai:gpt-4o:step-0"].attributes["lmnr.span.path"],
      ["agent.run", "openai:gpt-4o", "openai:gpt-4o:step-0"],
    );
  });

  void it("extracts sessionId, userId, and metadata into association properties", async () => {
    const span = makeSpan({
      id: "00000000000000b1",
      traceId: "000000000000000000000000000000bb",
      name: "agent.run",
      type: "agent_run",
      isRootSpan: true,
      tags: ["prod", "alpha"],
      metadata: {
        sessionId: "sess-123",
        userId: "user-42",
        featureFlag: "enabled",
        rolloutPct: 25,
      },
    });

    await exporter.exportTracingEvent(end(span));

    const [out] = inMemory.getFinishedSpans();
    assert.equal(
      out.attributes["lmnr.association.properties.session_id"],
      "sess-123",
    );
    assert.equal(
      out.attributes["lmnr.association.properties.user_id"],
      "user-42",
    );
    assert.equal(
      out.attributes["lmnr.association.properties.metadata.featureFlag"],
      "enabled",
    );
    assert.equal(
      out.attributes["lmnr.association.properties.metadata.rolloutPct"],
      25,
    );
    assert.deepEqual(out.attributes["lmnr.association.properties.tags"], [
      "prod",
      "alpha",
    ]);
  });

  void it("reports errors with SpanStatusCode.ERROR and exception event", async () => {
    const span = makeSpan({
      id: "00000000000000c1",
      traceId: "000000000000000000000000000000cc",
      name: "broken-tool",
      type: "tool_call",
      errorInfo: {
        message: "boom",
        name: "TypeError",
        stack: "TypeError: boom\n    at <anonymous>",
      },
    });

    await exporter.exportTracingEvent(end(span));

    const [out] = inMemory.getFinishedSpans();
    assert.equal(out.status.code, SpanStatusCode.ERROR);
    assert.equal(out.status.message, "boom");
    assert.equal(out.events.length, 1);
    assert.equal(out.events[0].name, "exception");
    assert.equal(out.events[0].attributes?.["exception.type"], "TypeError");
    assert.equal(out.events[0].attributes?.["exception.message"], "boom");
  });

  void it("flattens MODEL_GENERATION input.messages into lmnr.span.input", async () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
    ];

    const span = makeSpan({
      id: "00000000000000d1",
      traceId: "000000000000000000000000000000dd",
      name: "openai:gpt-4o",
      type: "model_generation",
      input: { messages, other: "ignored" },
      output: "Hi there",
      attributes: { model: "gpt-4o", provider: "openai" },
    });

    await exporter.exportTracingEvent(end(span));

    const [out] = inMemory.getFinishedSpans();
    assert.equal(out.attributes["lmnr.span.input"], JSON.stringify(messages));
    assert.equal(out.attributes["lmnr.span.output"], "Hi there");
  });

  void it("preserves trace and span id hex formatting on export", async () => {
    const span = makeSpan({
      id: "abcdef0123456789",
      traceId: "0123456789abcdef0123456789abcdef",
      name: "root",
      type: "agent_run",
      isRootSpan: true,
    });

    await exporter.exportTracingEvent(end(span));

    const [out] = inMemory.getFinishedSpans();
    const ctx = out.spanContext();
    assert.equal(ctx.traceId, "0123456789abcdef0123456789abcdef");
    assert.equal(ctx.spanId, "abcdef0123456789");
  });
});
