import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import { context, trace } from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";

import { Laminar } from "../src";
import { _resetConfiguration, initializeTracing } from "../src/opentelemetry-lib/configuration";
import { observeBase } from "../src/opentelemetry-lib/tracing/decorators";

void describe("Stream Handling in observeBase", () => {
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
  });

  void after(async () => {
    await exporter.shutdown();
    trace.disable();
    context.disable();
  });

  void it("handles ReadableStream and collects chunks", async () => {
    const chunks = ["chunk1", "chunk2", "chunk3"];
    const stream = new ReadableStream({
      start(controller) {
        chunks.forEach(chunk => controller.enqueue(chunk));
        controller.close();
      },
    });

    const fn = () => stream;
    const result = observeBase(
      { name: "testReadableStream" },
      fn,
      undefined,
    );

    assert.ok(result instanceof ReadableStream);

    // Consume the stream
    const reader = result.getReader();
    const collected: string[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      collected.push(value as string);
    }

    assert.deepStrictEqual(collected, chunks);

    // Wait a bit for background processing
    await new Promise(resolve => setTimeout(resolve, 100));

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].name, "testReadableStream");

    const output = JSON.parse(spans[0].attributes["lmnr.span.output"] as string);
    assert.strictEqual(output.type, "stream");
    assert.deepStrictEqual(output.chunks, chunks);
  });

  void it("handles AsyncIterable and collects items", async () => {
    const items = [1, 2, 3, 4, 5];

    // eslint-disable-next-line @typescript-eslint/require-await
    async function* generateItems() {
      for (const item of items) {
        yield item;
      }
    }

    const fn = () => generateItems();
    const result = observeBase(
      { name: "testAsyncIterable" },
      fn,
      undefined,
    );

    // Consume the iterable
    const collected: number[] = [];
    for await (const item of result) {
      collected.push(item);
    }

    assert.deepStrictEqual(collected, items);

    // Wait for background processing
    await new Promise(resolve => setTimeout(resolve, 100));

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].name, "testAsyncIterable");

    const output = JSON.parse(spans[0].attributes["lmnr.span.output"] as string);
    assert.strictEqual(output.type, "async-iterable");
    assert.deepStrictEqual(output.chunks, items);
  });

  void it("handles AI SDK-like result objects", async () => {
    const mockStreamTextResult = {
      textStream: new ReadableStream({
        start(controller) {
          controller.enqueue("Hello");
          controller.enqueue(" ");
          controller.enqueue("World");
          controller.close();
        },
      }),
      text: Promise.resolve("Hello World"),
      toolCalls: Promise.resolve([]),
      reasoning: Promise.resolve([]),
      finishReason: Promise.resolve("stop" as const),
      usage: Promise.resolve({
        promptTokens: 10,
        completionTokens: 20,
        totalTokens: 30,
      }),
      files: Promise.resolve([]),
      sources: Promise.resolve([]),
    };

    const fn = () => mockStreamTextResult;
    const result = observeBase(
      { name: "testAISDKResult" },
      fn,
      undefined,
    );

    // Result should be the original object
    assert.strictEqual(result, mockStreamTextResult);

    // Wait for background processing
    await new Promise(resolve => setTimeout(resolve, 200));

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].name, "testAISDKResult");

    const output = JSON.parse(spans[0].attributes["lmnr.span.output"] as string);
    assert.strictEqual(output.text, "Hello World");
    assert.strictEqual(output.finishReason, "stop");
    assert.deepStrictEqual(output.usage, {
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
    });
  });

  void it("handles Response objects", async () => {
    const responseBody = "Response content";
    const response = new Response(responseBody, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });

    const fn = () => response;
    const result = observeBase(
      { name: "testResponse" },
      fn,
      undefined,
    );

    assert.ok(result instanceof Response);

    // Consume the response
    const text = await result.text();
    assert.strictEqual(text, responseBody);

    // Wait for background processing
    await new Promise(resolve => setTimeout(resolve, 100));

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].name, "testResponse");

    const output = JSON.parse(spans[0].attributes["lmnr.span.output"] as string);
    assert.strictEqual(output.type, "response");
    assert.ok(Array.isArray(output.chunks));
  });

  void it("handles stream errors and records partial output", async () => {
    const chunks = ["chunk1", "chunk2"];
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(chunks[0]);
        controller.enqueue(chunks[1]);
        controller.error(new Error("Stream error"));
      },
    });

    const fn = () => stream;
    const result = observeBase(
      { name: "testStreamError" },
      fn,
      undefined,
    );

    // Try to consume the stream
    const reader = result.getReader();
    const collected: string[] = [];

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        collected.push(value as string);
      }
    } catch (error) {
      // Expected error
      assert.ok(error instanceof Error);
      assert.strictEqual((error).message, "Stream error");
    }

    // Wait for background processing
    await new Promise(resolve => setTimeout(resolve, 100));

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].name, "testStreamError");

    // Should have recorded the error
    assert.strictEqual(spans[0].events.length, 1);
    assert.strictEqual(spans[0].events[0].name, "exception");
  });

  void it("handles AI SDK result with promise rejection", async () => {
    const mockStreamTextResult = {
      textStream: new ReadableStream({
        start(controller) {
          controller.enqueue("Hello");
          controller.close();
        },
      }),
      text: Promise.resolve("Hello"),
      toolCalls: Promise.reject(new Error("Tool calls failed")),
      reasoning: Promise.resolve([]),
      finishReason: Promise.resolve("stop" as const),
      usage: Promise.resolve({
        promptTokens: 10,
        completionTokens: 20,
        totalTokens: 30,
      }),
      files: Promise.resolve([]),
      sources: Promise.resolve([]),
    };

    const fn = () => mockStreamTextResult;
    const result = observeBase(
      { name: "testAISDKError" },
      fn,
      undefined,
    );

    assert.strictEqual(result, mockStreamTextResult);

    // Wait for background processing
    await new Promise(resolve => setTimeout(resolve, 200));

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].name, "testAISDKError");

    // Should have captured partial output
    const output = JSON.parse(spans[0].attributes["lmnr.span.output"] as string);
    assert.strictEqual(output.text, "Hello");
    assert.strictEqual(output.finishReason, "stop");

    // Should have recorded errors
    assert.ok(output._errors);
    assert.ok(Array.isArray(output._errors));
    assert.strictEqual(output._errors.length, 1);
    assert.strictEqual(output._errors[0].field, "toolCalls");
  });

  void it("ignores stream output when ignoreOutput is true", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue("chunk1");
        controller.enqueue("chunk2");
        controller.close();
      },
    });

    const fn = () => stream;
    const result = observeBase(
      { name: "testIgnoreOutput", ignoreOutput: true },
      fn,
      undefined,
    );

    // Consume the stream
    const reader = result.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }

    // Wait for background processing
    await new Promise(resolve => setTimeout(resolve, 100));

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].name, "testIgnoreOutput");

    // Should not have output attribute
    assert.strictEqual(spans[0].attributes["lmnr.span.output"], undefined);
  });

  void it("handles non-stream results normally", () => {
    const fn = () => "regular string result";
    const result = observeBase(
      { name: "testNonStream" },
      fn,
      undefined,
    );

    assert.strictEqual(result, "regular string result");

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].name, "testNonStream");

    const output = spans[0].attributes["lmnr.span.output"] as string;
    assert.strictEqual(output, "regular string result");
  });
});
