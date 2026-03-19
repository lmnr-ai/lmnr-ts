import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import Anthropic from "@anthropic-ai/sdk";

import { _resetConfiguration, initializeTracing } from "../src/opentelemetry-lib/configuration";

interface MockRecording {
  path: string;
  method: string;
  status: number;
  response: unknown;
  rawHeaders?: Record<string, string>;
}

const TOOLS: Anthropic.Tool[] = [
  {
    name: "get_weather",
    description: "Get the current weather in a given location",
    input_schema: {
      type: "object" as const,
      properties: {
        location: {
          type: "string",
          description: "The city and state, e.g. San Francisco, CA",
        },
        unit: {
          type: "string",
          enum: ["celsius", "fahrenheit"],
          description: "The unit of temperature",
        },
      },
      required: ["location"],
    },
  },
  {
    name: "get_time",
    description: "Get the current time in a given time zone",
    input_schema: {
      type: "object" as const,
      properties: {
        timezone: {
          type: "string",
          description: "The IANA time zone name, e.g. America/Los_Angeles",
        },
      },
      required: ["timezone"],
    },
  },
];

/**
 * Create a mock fetch function that intercepts requests and returns pre-recorded responses.
 * Supports both JSON responses and SSE streaming responses.
 */
const createMockFetch = (recordings: MockRecording[]) => {
  const pendingMocks = [...recordings];

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const method = init?.method || "GET";

    for (let i = 0; i < pendingMocks.length; i++) {
      const mock = pendingMocks[i];
      if (url.includes(mock.path) && method.toUpperCase() === mock.method.toUpperCase()) {
        pendingMocks.splice(i, 1);

        const contentType = mock.rawHeaders?.["content-type"] ?? "application/json";
        const isSSE = contentType === "text/event-stream";

        let body: string;
        if (isSSE && typeof mock.response === "string") {
          body = mock.response;
        } else if (typeof mock.response === "string") {
          body = mock.response;
        } else {
          body = JSON.stringify(mock.response);
        }

        const headers = new Headers({
          "content-type": contentType,
          ...(mock.rawHeaders ?? {}),
        });

        return new Response(body, {
          status: mock.status,
          statusText: "OK",
          headers,
        });
      }
    }

    throw new Error(`No mock found for ${method} ${url}. Pending mocks: ${pendingMocks.map((m) => `${m.method} ${m.path}`).join(", ")}`);
  };
};

void describe("anthropic instrumentation", () => {
  const exporter = new InMemorySpanExporter();
  const dirname = typeof __dirname !== "undefined"
    ? __dirname
    : path.dirname(fileURLToPath(import.meta.url));
  const recordingsDir = path.join(dirname, "recordings");

  const getRecordingFile = (testName: string) => {
    const sanitizedName = testName.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase();
    return path.join(recordingsDir, `anthropic-${sanitizedName}.json`);
  };

  // We need to keep a mutable fetch reference so we can swap it per test.
  // The client is created once with a wrapper that delegates to whatever
  // the current mock fetch is.
  let currentMockFetch: ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) | null = null;

  const delegatingFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (currentMockFetch) {
      return currentMockFetch(input, init);
    }
    return globalThis.fetch(input, init);
  };

  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY || "test_api_key",
    fetch: delegatingFetch as any,
  });

  void beforeEach(async (t) => {
    _resetConfiguration();

    initializeTracing({
      exporter,
      disableBatch: true,
      instrumentModules: {
        anthropic: Anthropic as any,
      },
    });

    const recordingsFile = getRecordingFile(t.name);

    if (process.env.LMNR_TEST_RECORD_VCR) {
      // Record mode - use real API
      currentMockFetch = null;
    } else if (fs.existsSync(recordingsFile)) {
      const recordings = JSON.parse(
        await fs.promises.readFile(recordingsFile, "utf8"),
      ) as MockRecording[];
      currentMockFetch = createMockFetch(recordings);
    } else {
      throw new Error(
        `LMNR_TEST_RECORD_VCR variable is false and no recordings file exists: ${recordingsFile}`,
      );
    }
  });

  void afterEach(() => {
    exporter.reset();
  });

  void after(async () => {
    await exporter.shutdown();
  });

  // --- Non-streaming tests ---

  void it("creates a chat span", async () => {
    const response = await client.messages.create({
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: "Tell me a joke about OpenTelemetry",
        },
      ],
      model: "claude-3-5-haiku-20241022",
    });

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].name, "anthropic.chat");
    assert.strictEqual(spans[0].attributes["gen_ai.system"], "anthropic");
    assert.strictEqual(
      spans[0].attributes["gen_ai.request.model"],
      "claude-3-5-haiku-20241022",
    );

    // Verify input messages in new format
    const inputMessages = JSON.parse(
      spans[0].attributes["gen_ai.input.messages"] as string,
    );
    assert.strictEqual(inputMessages.length, 1);
    assert.strictEqual(inputMessages[0].role, "user");
    assert.strictEqual(
      inputMessages[0].content,
      "Tell me a joke about OpenTelemetry",
    );

    // Verify output messages in new format
    const outputMessages = JSON.parse(
      spans[0].attributes["gen_ai.output.messages"] as string,
    );
    assert.strictEqual(outputMessages.length, 1);
    assert.strictEqual(outputMessages[0].role, "assistant");
    assert.ok(
      outputMessages[0].content.some(
        (block: any) =>
          block.type === "text" &&
          typeof block.text === "string" &&
          block.text.length > 0,
      ),
    );

    // Verify usage
    assert.strictEqual(spans[0].attributes["gen_ai.usage.input_tokens"], 17);
    assert.strictEqual(
      spans[0].attributes["gen_ai.response.id"],
      "msg_01NgS2sXcQRKUKbwKFx1vVxC",
    );
  });

  void it("creates a chat span with system message", async () => {
    await client.messages.create({
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: "What is the weather in San Francisco?",
        },
      ],
      model: "claude-3-5-haiku-20241022",
      system: "You are a helpful assistant.",
    });

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].name, "anthropic.chat");

    // Verify input messages include system message
    const inputMessages = JSON.parse(
      spans[0].attributes["gen_ai.input.messages"] as string,
    );
    assert.strictEqual(inputMessages.length, 2);
    assert.strictEqual(inputMessages[0].role, "system");
    assert.strictEqual(
      inputMessages[0].content,
      "You are a helpful assistant.",
    );
    assert.strictEqual(inputMessages[1].role, "user");
    assert.strictEqual(
      inputMessages[1].content,
      "What is the weather in San Francisco?",
    );

    // Verify output messages
    const outputMessages = JSON.parse(
      spans[0].attributes["gen_ai.output.messages"] as string,
    );
    assert.strictEqual(outputMessages.length, 1);
    assert.strictEqual(outputMessages[0].role, "assistant");
  });

  void it("creates a chat span with tools", async () => {
    const response = await client.messages.create({
      model: "claude-3-5-sonnet-20240620",
      max_tokens: 1024,
      tools: TOOLS,
      messages: [
        {
          role: "user",
          content:
            "What is the weather like right now in New York? Also what time is it there now?",
        },
      ],
    });

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].name, "anthropic.chat");

    // Verify usage
    assert.strictEqual(spans[0].attributes["gen_ai.usage.input_tokens"], 514);

    // Verify input messages
    const inputMessages = JSON.parse(
      spans[0].attributes["gen_ai.input.messages"] as string,
    );
    assert.strictEqual(inputMessages.length, 1);
    assert.strictEqual(inputMessages[0].role, "user");
    assert.strictEqual(
      inputMessages[0].content,
      "What is the weather like right now in New York? Also what time is it there now?",
    );

    // Verify tool definitions
    const toolDefs = JSON.parse(
      spans[0].attributes["gen_ai.tool.definitions"] as string,
    );
    assert.strictEqual(toolDefs.length, 2);
    assert.strictEqual(toolDefs[0].name, "get_weather");
    assert.strictEqual(toolDefs[1].name, "get_time");

    // Verify output messages with tool_use blocks
    const outputMessages = JSON.parse(
      spans[0].attributes["gen_ai.output.messages"] as string,
    );
    assert.strictEqual(outputMessages.length, 1);
    assert.strictEqual(outputMessages[0].role, "assistant");
    assert.strictEqual(outputMessages[0].stop_reason, response.stop_reason);

    const contentBlocks = outputMessages[0].content;
    const textBlocks = contentBlocks.filter((b: any) => b.type === "text");
    const toolBlocks = contentBlocks.filter((b: any) => b.type === "tool_use");

    assert.ok(textBlocks.length >= 1);
    assert.ok(toolBlocks.length >= 2);
    assert.strictEqual(toolBlocks[0].name, "get_weather");
    assert.strictEqual(toolBlocks[1].name, "get_time");
  });

  void it("creates a chat span with tool history", async () => {
    await client.messages.create({
      model: "claude-3-5-haiku-20241022",
      max_tokens: 1024,
      tools: TOOLS,
      messages: [
        {
          role: "user",
          content: "What is the weather and current time in San Francisco?",
        },
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "I'll help you get the weather and current time in San Francisco.",
            },
            {
              id: "call_1",
              type: "tool_use",
              name: "get_weather",
              input: { location: "San Francisco, CA" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              content: "Sunny and 65 degrees Fahrenheit",
              tool_use_id: "call_1",
            },
          ],
        },
      ],
    });

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].name, "anthropic.chat");

    // Verify input messages
    const inputMessages = JSON.parse(
      spans[0].attributes["gen_ai.input.messages"] as string,
    );
    assert.strictEqual(inputMessages.length, 3);

    // First message: user
    assert.strictEqual(inputMessages[0].role, "user");
    assert.strictEqual(
      inputMessages[0].content,
      "What is the weather and current time in San Francisco?",
    );

    // Second message: assistant with text and tool_use
    assert.strictEqual(inputMessages[1].role, "assistant");
    assert.ok(Array.isArray(inputMessages[1].content));
    assert.strictEqual(inputMessages[1].content[0].type, "text");
    assert.strictEqual(
      inputMessages[1].content[0].text,
      "I'll help you get the weather and current time in San Francisco.",
    );
    assert.strictEqual(inputMessages[1].content[1].type, "tool_use");
    assert.strictEqual(inputMessages[1].content[1].id, "call_1");
    assert.strictEqual(inputMessages[1].content[1].name, "get_weather");

    // Third message: user with tool_result
    assert.strictEqual(inputMessages[2].role, "user");
    assert.ok(Array.isArray(inputMessages[2].content));
    assert.strictEqual(inputMessages[2].content[0].type, "tool_result");
    assert.strictEqual(
      inputMessages[2].content[0].content,
      "Sunny and 65 degrees Fahrenheit",
    );
    assert.strictEqual(inputMessages[2].content[0].tool_use_id, "call_1");
  });

  void it("creates a chat span with thinking", async () => {
    const response = await client.messages.create({
      model: "claude-3-7-sonnet-20250219",
      max_tokens: 2048,
      thinking: {
        type: "enabled",
        budget_tokens: 1024,
      },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "How many times does the letter 'r' appear in the word strawberry?",
            },
          ],
        },
      ],
    });

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].name, "anthropic.chat");

    // Verify input messages
    const inputMessages = JSON.parse(
      spans[0].attributes["gen_ai.input.messages"] as string,
    );
    assert.strictEqual(inputMessages[0].role, "user");
    assert.ok(Array.isArray(inputMessages[0].content));
    assert.strictEqual(inputMessages[0].content[0].type, "text");
    assert.strictEqual(
      inputMessages[0].content[0].text,
      "How many times does the letter 'r' appear in the word strawberry?",
    );

    // Verify output messages - should contain thinking and text blocks
    const outputMessages = JSON.parse(
      spans[0].attributes["gen_ai.output.messages"] as string,
    );
    assert.strictEqual(outputMessages.length, 1);
    assert.strictEqual(outputMessages[0].role, "assistant");

    const contentBlocks = outputMessages[0].content;
    const thinkingBlocks = contentBlocks.filter(
      (b: any) => b.type === "thinking",
    );
    const textBlocks = contentBlocks.filter((b: any) => b.type === "text");

    assert.ok(thinkingBlocks.length >= 1);
    assert.ok(textBlocks.length >= 1);

    const responseThinkingBlock = response.content.find(
      (b) => b.type === "thinking",
    );
    if (responseThinkingBlock && responseThinkingBlock.type === "thinking") {
      assert.strictEqual(
        thinkingBlocks[0].thinking,
        responseThinkingBlock.thinking,
      );
    }
  });

  // --- Streaming tests ---

  void it("creates a streaming chat span", async () => {
    const stream = await client.messages.create({
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: "Tell me a joke about OpenTelemetry",
        },
      ],
      model: "claude-3-5-haiku-20241022",
      stream: true,
    });

    let responseContent = "";
    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        responseContent += event.delta.text;
      }
    }

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].name, "anthropic.chat");

    // Verify input messages
    const inputMessages = JSON.parse(
      spans[0].attributes["gen_ai.input.messages"] as string,
    );
    assert.strictEqual(inputMessages.length, 1);
    assert.strictEqual(inputMessages[0].role, "user");
    assert.strictEqual(
      inputMessages[0].content,
      "Tell me a joke about OpenTelemetry",
    );

    // Verify output messages
    const outputMessages = JSON.parse(
      spans[0].attributes["gen_ai.output.messages"] as string,
    );
    assert.strictEqual(outputMessages.length, 1);
    assert.strictEqual(outputMessages[0].role, "assistant");
    assert.ok(
      outputMessages[0].content.some(
        (block: any) =>
          block.type === "text" && block.text === responseContent,
      ),
    );

    // Verify streaming accumulated usage
    assert.strictEqual(spans[0].attributes["gen_ai.usage.input_tokens"], 17);
    assert.strictEqual(
      spans[0].attributes["gen_ai.response.id"],
      "msg_05Streaming",
    );
  });

  void it("creates a streaming chat span with tools", async () => {
    const stream = await client.messages.create({
      model: "claude-3-5-sonnet-20240620",
      max_tokens: 1024,
      tools: TOOLS,
      messages: [
        {
          role: "user",
          content: "What is the weather and current time in San Francisco?",
        },
      ],
      stream: true,
    });

    // Consume the stream
    for await (const _event of stream) {
      // just consume
    }

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].name, "anthropic.chat");

    // Verify input messages
    const inputMessages = JSON.parse(
      spans[0].attributes["gen_ai.input.messages"] as string,
    );
    assert.strictEqual(inputMessages.length, 1);
    assert.strictEqual(inputMessages[0].role, "user");
    assert.strictEqual(
      inputMessages[0].content,
      "What is the weather and current time in San Francisco?",
    );

    // Verify output messages
    const outputMessages = JSON.parse(
      spans[0].attributes["gen_ai.output.messages"] as string,
    );
    assert.strictEqual(outputMessages.length, 1);
    assert.strictEqual(outputMessages[0].role, "assistant");

    const contentBlocks = outputMessages[0].content;
    const textBlocks = contentBlocks.filter((b: any) => b.type === "text");
    const toolBlocks = contentBlocks.filter((b: any) => b.type === "tool_use");

    assert.ok(textBlocks.length >= 1);
    assert.ok(toolBlocks.length >= 2);
    assert.strictEqual(
      toolBlocks[0].id,
      "toolu_014x5X91kx3fvdhpLvwXZWE2",
    );
    assert.strictEqual(toolBlocks[0].name, "get_weather");
    assert.strictEqual(
      toolBlocks[1].id,
      "toolu_0121kXsENLvoDZ72LCuAnCCz",
    );
    assert.strictEqual(toolBlocks[1].name, "get_time");
  });

  void it("creates a streaming chat span with thinking", async () => {
    const stream = await client.messages.create({
      model: "claude-3-7-sonnet-20250219",
      stream: true,
      max_tokens: 2048,
      thinking: {
        type: "enabled",
        budget_tokens: 1024,
      },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "How many times does the letter 'r' appear in the word strawberry?",
            },
          ],
        },
      ],
    });

    let text = "";
    let thinking = "";

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        text += event.delta.text;
      } else if (
        event.type === "content_block_delta" &&
        event.delta.type === "thinking_delta"
      ) {
        thinking += event.delta.thinking;
      }
    }

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].name, "anthropic.chat");

    // Verify input messages
    const inputMessages = JSON.parse(
      spans[0].attributes["gen_ai.input.messages"] as string,
    );
    assert.strictEqual(inputMessages[0].role, "user");

    // Verify output messages - should contain thinking and text blocks
    const outputMessages = JSON.parse(
      spans[0].attributes["gen_ai.output.messages"] as string,
    );
    assert.strictEqual(outputMessages.length, 1);
    assert.strictEqual(outputMessages[0].role, "assistant");

    const contentBlocks = outputMessages[0].content;
    const thinkingBlocks = contentBlocks.filter(
      (b: any) => b.type === "thinking",
    );
    const textBlocks = contentBlocks.filter((b: any) => b.type === "text");

    assert.ok(thinkingBlocks.length >= 1);
    assert.strictEqual(thinkingBlocks[0].thinking, thinking);
    assert.ok(textBlocks.length >= 1);
    assert.strictEqual(textBlocks[0].text, text);
  });
});
