import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { context, trace } from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace";
import * as aiV5 from "ai-v5";
import { MockLanguageModelV2 } from "ai-v5/test";
import * as aiV6 from "ai-v6";
import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai-v6/test";

import { Laminar } from "../src/laminar";
import {
  _resetConfiguration,
  initializeTracing,
} from "../src/opentelemetry-lib/configuration";
import { dropAiSdkWrapperContent } from "../src/opentelemetry-lib/tracing/ai-sdk-wrapper";
import { getTracer } from "../src/opentelemetry-lib/tracing/index";

const CONTENT_KEYS = [
  "ai.response.text",
  "ai.response.reasoning",
  "ai.response.toolCalls",
  "ai.response.object",
];

const v3Usage = {
  inputTokens: {
    total: 10,
    noCache: 10,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

const v6Model = () =>
  new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text", text: "hello" }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: v3Usage,
      warnings: [],
    }),
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: "hello" },
        { type: "text-end", id: "t" },
        {
          type: "finish",
          finishReason: { unified: "stop", raw: "stop" },
          usage: v3Usage,
        },
      ]),
    }),
  });

const v5Model = () =>
  new MockLanguageModelV2({
    doGenerate: async () => ({
      content: [{ type: "text", text: "hello" }],
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      warnings: [],
    }),
  });

void describe("AI SDK v5/v6 wrapper spans", () => {
  let exporter: InMemorySpanExporter;

  void beforeEach(() => {
    _resetConfiguration();
    exporter = new InMemorySpanExporter();
    initializeTracing({ exporter, disableBatch: true });
    Object.defineProperty(Laminar, "isInitialized", {
      value: true,
      writable: true,
    });
  });

  void afterEach(async () => {
    await exporter.shutdown();
  });

  void after(() => {
    trace.disable();
    context.disable();
  });

  const telemetry = () => ({
    isEnabled: true,
    tracer: getTracer(),
    functionId: "my-agent",
  });

  const assertWrapperStripped = (operation: string) => {
    const spans = exporter.getFinishedSpans();
    const wrapper = spans.find((s) => s.name === operation);
    const llm = spans.find(
      (s) =>
        s.name === `${operation}.doGenerate` ||
        s.name === `${operation}.doStream`,
    );
    assert.ok(wrapper, `missing ${operation} span`);
    assert.ok(llm, `missing ${operation} LLM span`);

    for (const key of CONTENT_KEYS) {
      assert.equal(wrapper.attributes[key], undefined, key);
    }
    assert.equal(wrapper.attributes["ai.prompt"], "_");
    assert.equal(wrapper.attributes["operation.name"], `${operation} my-agent`);
    assert.equal(wrapper.attributes["ai.response.finishReason"], "stop");

    assert.ok(llm.attributes["ai.prompt.messages"]);
    assert.equal(llm.attributes["ai.response.text"], "hello");
  };

  void it("strips v6 generateText wrapper content, keeps the LLM span", async () => {
    await aiV6.generateText({
      model: v6Model(),
      prompt: "hi",
      experimental_telemetry: telemetry(),
    });
    assertWrapperStripped("ai.generateText");
  });

  void it("strips v6 streamText wrapper content, keeps the LLM span", async () => {
    const result = aiV6.streamText({
      model: v6Model(),
      prompt: "hi",
      experimental_telemetry: telemetry(),
    });
    await result.consumeStream();
    await result.text;
    assertWrapperStripped("ai.streamText");
  });

  void it("strips v5 generateText wrapper content, keeps the LLM span", async () => {
    await aiV5.generateText({
      model: v5Model(),
      prompt: "hi",
      experimental_telemetry: telemetry(),
    });
    assertWrapperStripped("ai.generateText");
  });
});

void describe("dropAiSdkWrapperContent", () => {
  const content = {
    "ai.prompt": JSON.stringify({ system: "sys", messages: [] }),
    "ai.response.text": "hello",
    "ai.response.toolCalls": "[]",
    "ai.response.finishReason": "tool-calls",
  };

  void it("leaves provider call spans untouched", () => {
    const attributes = {
      "ai.operationId": "ai.streamText.doStream",
      "ai.prompt.messages": "[]",
      ...content,
    };
    const before = { ...attributes };
    dropAiSdkWrapperContent(attributes);
    assert.deepEqual(attributes, before);
  });

  void it("leaves spans typed LLM untouched", () => {
    const attributes = {
      "ai.operationId": "ai.generateText",
      "lmnr.span.type": "LLM",
      ...content,
    };
    const before = { ...attributes };
    dropAiSdkWrapperContent(attributes);
    assert.deepEqual(attributes, before);
  });

  void it("ignores spans that are not from the AI SDK", () => {
    const attributes = { "lmnr.span.input": "x", ...content };
    const before = { ...attributes };
    dropAiSdkWrapperContent(attributes);
    assert.deepEqual(attributes, before);
  });
});
