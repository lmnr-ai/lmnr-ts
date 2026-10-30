// End to end: an AI SDK v7 `generateText` agent with a tool, through the
// telemetry integration, written as a trajectory file. Mock models, no
// network.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { InMemorySpanExporter } from "@opentelemetry/sdk-trace";
import { generateText, jsonSchema, stepCountIs, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";

import { observe } from "../src/decorators";
import { Laminar } from "../src/laminar";
import {
  _resetConfiguration,
  initializeTracing,
} from "../src/opentelemetry-lib/configuration";
import { LaminarAiSdkTelemetry } from "../src/opentelemetry-lib/instrumentation/aisdk/v7-integration";
import { contentText, normalizeCall } from "../src/trajectory/normalize";
import * as reader from "../src/trajectory/reader";
import { otelSpanIdToUUID } from "../src/utils";
import { schemaErrors } from "./trajectory-helpers";

const usage = (input: number, output: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: output, text: output, reasoning: 0 },
});

const mockModel = (results: unknown[]) => {
  let i = 0;
  return new MockLanguageModelV4({
    provider: "openai.chat",
    modelId: "gpt-5.4-nano",
    doGenerate: async () => {
      const result = results[i++];
      if (result instanceof Error) {
        throw result;
      }
      return {
        warnings: [],
        response: { id: `resp_${i}`, modelId: "gpt-5.4-nano" },
        ...(result as object),
      } as any;
    },
  });
};

/** What the model saw: writer metadata on tool calls aside. */
const comparable = (messages: reader.Message[]): unknown[] =>
  messages.map((m: any) => [
    m.role,
    typeof m.content === "string" ? m.content : contentText(m.content ?? ""),
    (m.tool_calls ?? []).map((c: any) => [
      c.tool_call_id,
      c.function_name,
      c.arguments,
    ]),
    m.tool_call_id ?? null,
  ]);

void describe("trajectory file from an AI SDK v7 agent", () => {
  const exporter = new InMemorySpanExporter();
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "lmnr-atif-")),
    "trajectory.json",
  );

  void before(() => {
    _resetConfiguration();
    initializeTracing({
      exporter,
      disableBatch: true,
      trajectoryPath: file,
      exportSpans: true,
    });
    Object.defineProperty(Laminar, "isInitialized", {
      value: true,
      writable: true,
    });
  });

  void after(async () => {
    await Laminar.shutdown();
  });

  void it("writes generateText with a tool, and a failed model call", async () => {
    const model = mockModel([
      {
        content: [
          { type: "text", text: "Checking." },
          {
            type: "tool-call",
            toolCallId: "call_w1",
            toolName: "get_weather",
            input: JSON.stringify({ city: "Paris" }),
          },
        ],
        finishReason: { unified: "tool-calls", raw: "tool_calls" },
        usage: usage(50, 12),
      },
      {
        content: [{ type: "text", text: "Sunny, 21C in Paris." }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: usage(80, 8),
      },
      Object.assign(new Error("Rate limit exceeded"), { name: "APICallError" }),
    ]);
    const telemetry = {
      isEnabled: true,
      integrations: [new LaminarAiSdkTelemetry()],
    };
    const tools = {
      get_weather: tool({
        description: "Current weather in a city",
        inputSchema: jsonSchema<{ city: string }>({
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        }),
        execute: async ({ city }: { city: string }) => ({ city, temp_c: 21 }),
      }),
    };

    let answer = "";
    await observe({ name: "weather-agent" }, async () => {
      const result = await generateText({
        model,
        system: "Answer with the get_weather tool.",
        prompt: "What's the weather in Paris?",
        stopWhen: stepCountIs(3),
        tools,
        telemetry,
      } as any);
      answer = result.text;
      await assert.rejects(
        generateText({
          model,
          system: "Answer with the get_weather tool.",
          prompt: "And tomorrow?",
          tools,
          telemetry,
          maxRetries: 0,
        } as any),
      );
    });
    await Laminar.flush();

    const trajectory = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(schemaErrors(trajectory), []);
    assert.equal(trajectory.agent.name, "weather-agent");
    const steps = trajectory.steps;
    assert.deepEqual(
      steps.map((s: any) => s.source),
      ["system", "user", "agent", "agent", "user", "agent"],
    );

    // The tool call is matched to its `ai.tool` span by `ai.toolCall.id`.
    const [call] = steps[2].tool_calls;
    assert.equal(call.function_name, "get_weather");
    assert.deepEqual(call.arguments, { city: "Paris" });
    const spans = exporter.getFinishedSpans();
    const toolSpan = spans.find((s) => s.name === "ai.tool get_weather")!;
    assert.equal(
      call.extra.lmnr.span_id,
      otelSpanIdToUUID(toolSpan.spanContext().spanId),
    );
    const [result] = steps[2].observation.results;
    assert.equal(result.source_call_id, "call_w1");
    assert.equal(result.content, '{"city": "Paris", "temp_c": 21}');
    assert.equal(result.extra.lmnr.status, "ok");
    assert.equal(steps[3].message, answer);
    assert.equal(steps[2].metrics.prompt_tokens, 50);

    // The failed call is an error, with the exception's message.
    assert.equal(steps[5].extra.lmnr.status, "error");
    assert.equal(steps[5].extra.lmnr.error.message, "Rate limit exceeded");

    // Reading the file back gives each call the exact input it had.
    const ext = reader.TrajectoryExtension.read(trajectory);
    for (const [index, step] of steps.entries()) {
      if (step.source !== "agent") {
        continue;
      }
      const span = spans.find(
        (s) =>
          otelSpanIdToUUID(s.spanContext().spanId) === step.extra.lmnr.span_id,
      )!;
      const [actual] = normalizeCall(
        JSON.parse(span.attributes["gen_ai.input.messages"] as string),
        null,
      );
      const rebuilt = reader.inputMessages(steps, index, ext);
      assert.deepEqual(comparable(rebuilt), comparable(actual), `${index}`);
    }
  });
});
