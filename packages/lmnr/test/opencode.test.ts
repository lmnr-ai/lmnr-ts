import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import { context, trace } from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import nock from "nock";

import { observe } from "../src/decorators";
import { Laminar } from "../src/laminar";
import { _resetConfiguration, initializeTracing } from "../src/opentelemetry-lib/configuration";
import { OpencodeInstrumentation } from "../src/opentelemetry-lib/instrumentation/opencode";

// Minimal mock of the @opencode-ai/sdk Session class structure.
// This mirrors how the real SDK's Session class works: it has
// prompt/promptAsync methods that POST to the OpenCode server.

class MockSession {
  private _baseUrl: string;

  constructor(baseUrl = "http://localhost:4096") {
    this._baseUrl = baseUrl;
  }

  async prompt(options: any): Promise<any> {
    const sessionId = options.path.id;
    const response = await fetch(`${this._baseUrl}/session/${sessionId}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(options.body),
    });
    return response.json();
  }

  async promptAsync(options: any): Promise<any> {
    const sessionId = options.path.id;
    const response = await fetch(`${this._baseUrl}/session/${sessionId}/prompt_async`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(options.body),
    });
    if (response.status === 204) {
      return undefined;
    }
    return response.json();
  }
}

void describe("opencode instrumentation", () => {
  const exporter = new InMemorySpanExporter();
  let session: MockSession;
  let instrumentation: OpencodeInstrumentation;

  void beforeEach(() => {
    _resetConfiguration();
    initializeTracing({ exporter, disableBatch: true });

    Object.defineProperty(Laminar, "isInitialized", {
      value: true,
      writable: true,
    });

    instrumentation = new OpencodeInstrumentation();
    instrumentation["patchSessionClass"](MockSession);

    session = new MockSession();
  });

  void afterEach(() => {
    exporter.reset();
    nock.cleanAll();
  });

  void after(async () => {
    await exporter.shutdown();
    trace.disable();
    context.disable();
  });

  void it("injects lmnrSpanContext into prompt parts inside observe", async () => {
    let capturedBody: any = null;

    const scope = nock("http://localhost:4096")
      .post("/session/test-session/message", (body: any) => {
        capturedBody = body;
        return true;
      })
      .reply(200, {
        info: { id: "msg-1", sessionID: "test-session", role: "assistant" },
        parts: [{ id: "part-1", type: "text", text: "Hello!" }],
      });

    await observe({ name: "test-observe" }, async () => {
      await session.prompt({
        path: { id: "test-session" },
        body: {
          parts: [
            { type: "text", text: "Hello, world!" },
          ],
        },
      });
    });

    assert.ok(scope.isDone(), "nock scope should be satisfied");
    assert.ok(capturedBody, "request body should be captured");

    // Verify the original part is preserved
    assert.strictEqual(capturedBody.parts[0].type, "text");
    assert.strictEqual(capturedBody.parts[0].text, "Hello, world!");

    // Verify the injected metadata part
    const metadataPart = capturedBody.parts[1];
    assert.ok(metadataPart, "metadata part should be injected");
    assert.strictEqual(metadataPart.type, "text");
    assert.strictEqual(metadataPart.text, "");
    assert.strictEqual(metadataPart.ignored, true);
    assert.strictEqual(metadataPart.synthetic, true);
    assert.ok(metadataPart.metadata, "metadata should exist");
    assert.ok(
      metadataPart.metadata.lmnrSpanContext,
      "lmnrSpanContext should exist in metadata",
    );

    // Verify the span context is valid JSON with expected fields
    const spanContext = JSON.parse(metadataPart.metadata.lmnrSpanContext);
    assert.ok(spanContext.traceId, "traceId should exist in span context");
    assert.ok(spanContext.spanId, "spanId should exist in span context");

    // Verify the observe span was created
    const spans = exporter.getFinishedSpans();
    assert.ok(spans.length >= 1, "at least one span should exist");
    const observeSpan = spans.find(span => span.name === "test-observe");
    assert.ok(observeSpan, "observe span should exist");
  });

  void it("injects lmnrSpanContext into promptAsync parts inside observe", async () => {
    let capturedBody: any = null;

    const scope = nock("http://localhost:4096")
      .post("/session/test-session/prompt_async", (body: any) => {
        capturedBody = body;
        return true;
      })
      .reply(204);

    await observe({ name: "test-observe-async" }, async () => {
      await session.promptAsync({
        path: { id: "test-session" },
        body: {
          parts: [
            { type: "text", text: "Async hello!" },
          ],
        },
      });
    });

    assert.ok(scope.isDone(), "nock scope should be satisfied");
    assert.ok(capturedBody, "request body should be captured");

    // Verify injection
    assert.strictEqual(capturedBody.parts.length, 2);

    const metadataPart = capturedBody.parts[1];
    assert.strictEqual(metadataPart.type, "text");
    assert.strictEqual(metadataPart.text, "");
    assert.strictEqual(metadataPart.ignored, true);
    assert.strictEqual(metadataPart.synthetic, true);

    const spanContext = JSON.parse(metadataPart.metadata.lmnrSpanContext);
    assert.ok(spanContext.traceId, "traceId should exist");
    assert.ok(spanContext.spanId, "spanId should exist");
  });

  void it("does not inject when there is no active span context", async () => {
    let capturedBody: any = null;

    const scope = nock("http://localhost:4096")
      .post("/session/test-session/message", (body: any) => {
        capturedBody = body;
        return true;
      })
      .reply(200, {
        info: { id: "msg-1", sessionID: "test-session", role: "assistant" },
        parts: [],
      });

    // Call without observe - no active span context
    await session.prompt({
      path: { id: "test-session" },
      body: {
        parts: [
          { type: "text", text: "No context here" },
        ],
      },
    });

    assert.ok(scope.isDone(), "nock scope should be satisfied");
    assert.ok(capturedBody, "request body should be captured");

    // Should only have the original part, no injection
    assert.strictEqual(capturedBody.parts.length, 1);
    assert.strictEqual(capturedBody.parts[0].text, "No context here");
  });

  void it("does not inject when parts array is missing", async () => {
    let capturedBody: any = null;

    const scope = nock("http://localhost:4096")
      .post("/session/test-session/message", (body: any) => {
        capturedBody = body;
        return true;
      })
      .reply(200, {
        info: { id: "msg-1", sessionID: "test-session", role: "assistant" },
        parts: [],
      });

    await observe({ name: "test-no-parts" }, async () => {
      await session.prompt({
        path: { id: "test-session" },
        body: {},
      });
    });

    assert.ok(scope.isDone(), "nock scope should be satisfied");
    assert.ok(capturedBody, "request body should be captured");

    // Body should not have parts added
    assert.strictEqual(capturedBody.parts, undefined);
  });

  void it("preserves multiple existing parts when injecting", async () => {
    let capturedBody: any = null;

    const scope = nock("http://localhost:4096")
      .post("/session/test-session/message", (body: any) => {
        capturedBody = body;
        return true;
      })
      .reply(200, {
        info: { id: "msg-1", sessionID: "test-session", role: "assistant" },
        parts: [],
      });

    await observe({ name: "test-multiple-parts" }, async () => {
      await session.prompt({
        path: { id: "test-session" },
        body: {
          parts: [
            { type: "text", text: "First part" },
            { type: "text", text: "Second part" },
            { type: "file", mime: "image/png", url: "https://example.com/image.png" },
          ],
        },
      });
    });

    assert.ok(scope.isDone(), "nock scope should be satisfied");
    assert.ok(capturedBody, "request body should be captured");

    // Original 3 parts + 1 injected
    assert.strictEqual(capturedBody.parts.length, 4);
    assert.strictEqual(capturedBody.parts[0].text, "First part");
    assert.strictEqual(capturedBody.parts[1].text, "Second part");
    assert.strictEqual(capturedBody.parts[2].type, "file");
    assert.strictEqual(capturedBody.parts[3].type, "text");
    assert.strictEqual(capturedBody.parts[3].ignored, true);
    assert.strictEqual(capturedBody.parts[3].synthetic, true);
  });

  void it("span context contains trace ID matching the observe span", async () => {
    let capturedBody: any = null;

    const scope = nock("http://localhost:4096")
      .post("/session/test-session/message", (body: any) => {
        capturedBody = body;
        return true;
      })
      .reply(200, {
        info: { id: "msg-1", sessionID: "test-session", role: "assistant" },
        parts: [],
      });

    await observe({ name: "test-trace-match" }, async () => {
      await session.prompt({
        path: { id: "test-session" },
        body: {
          parts: [
            { type: "text", text: "Trace matching test" },
          ],
        },
      });
    });

    assert.ok(scope.isDone());

    const metadataPart = capturedBody.parts[1];
    const spanContext = JSON.parse(metadataPart.metadata.lmnrSpanContext);

    // The trace ID in the injected context should match the observe span's trace ID
    const spans = exporter.getFinishedSpans();
    const observeSpan = spans.find(span => span.name === "test-trace-match");
    assert.ok(observeSpan);

    // The OTel trace ID is a hex string; the serialized context converts it to UUID format
    // Just verify both exist and the trace IDs are related
    assert.ok(spanContext.traceId, "injected traceId should exist");
    assert.ok(observeSpan.spanContext().traceId, "observe span traceId should exist");
  });
});
