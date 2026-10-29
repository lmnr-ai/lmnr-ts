// End to end: an OpenAI tool loop under `observe`, written as a trajectory
// file (and exported). Port of lmnr-python's
// `test_openai_tool_loop_end_to_end`. Record with LMNR_TEST_RECORD_VCR=1.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  InMemorySpanExporter,
  ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import nock from "nock";
import OpenAI from "openai";

import { Laminar, observe } from "../src/index";
import {
  _resetConfiguration,
  initializeTracing,
} from "../src/opentelemetry-lib/configuration";
import { contentText, normalizeCall } from "../src/trajectory/normalize";
import * as reader from "../src/trajectory/reader";
import { otelSpanIdToUUID, otelTraceIdToUUID } from "../src/utils";
import { schemaErrors } from "./trajectory-helpers";
import { decompressRecordingResponse, recordingReplyHeaders } from "./utils";

const dirname =
  typeof __dirname !== "undefined"
    ? __dirname
    : path.dirname(fileURLToPath(import.meta.url));
const RECORDING = path.join(
  dirname,
  "recordings",
  "trajectory-openai-tool-loop.json",
);

const WEATHER_TOOL = {
  type: "function" as const,
  function: {
    name: "get_weather",
    description: "Current weather in a city",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
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

void describe("trajectory file end to end", () => {
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
      instrumentModules: { openAI: OpenAI },
      trajectoryPath: file,
      exportSpans: true,
    });
    Object.defineProperty(Laminar, "isInitialized", {
      value: true,
      writable: true,
    });

    if (process.env.LMNR_TEST_RECORD_VCR) {
      nock.restore();
      nock.recorder.rec({
        dont_print: true,
        enable_reqheaders_recording: false,
        output_objects: true,
      });
      return;
    }
    nock.cleanAll();
    const recordings = JSON.parse(fs.readFileSync(RECORDING, "utf8"));
    for (const recording of recordings) {
      nock(recording.scope)
        .post(recording.path, recording.body)
        .reply(
          recording.status,
          decompressRecordingResponse(recording),
          recordingReplyHeaders(recording),
        );
    }
  });

  void after(async () => {
    if (process.env.LMNR_TEST_RECORD_VCR) {
      fs.writeFileSync(
        RECORDING,
        JSON.stringify(nock.recorder.play(), null, 2),
      );
      nock.restore();
    }
    nock.cleanAll();
    await Laminar.shutdown();
  });

  void it("writes an OpenAI tool loop under observe", async () => {
    const client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY || "test-key",
    });

    const getWeather = (city: string) =>
      observe(
        { name: "get_weather", spanType: "TOOL" },
        (c: string) => `Sunny, 21C in ${c}`,
        city,
      );

    const agent = (question: string) =>
      observe(
        { name: "weather-agent" },
        async (q: string) => {
          const messages: any[] = [
            { role: "system", content: "Answer with the get_weather tool." },
            { role: "user", content: q },
          ];
          for (;;) {
            const response = await client.chat.completions.create({
              model: "gpt-5.4-nano",
              messages,
              tools: [WEATHER_TOOL],
            });
            const message = response.choices[0].message;
            messages.push(message);
            if (!message.tool_calls?.length) {
              return message.content;
            }
            for (const call of message.tool_calls) {
              if (call.type !== "function") {
                continue;
              }
              const args = JSON.parse(call.function.arguments);
              messages.push({
                role: "tool",
                tool_call_id: call.id,
                content: await getWeather(args.city),
              });
            }
          }
        },
        question,
      );

    const answer = await agent("What's the weather in Paris?");
    await Laminar.flush();

    const trajectory = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(schemaErrors(trajectory), []);
    const spans = exporter.getFinishedSpans();
    const byName = (name: string) => spans.find((s) => s.name === name)!;
    const root = byName("weather-agent");
    assert.deepEqual(trajectory.extra.lmnr.trace_ids, [
      otelTraceIdToUUID(root.spanContext().traceId),
    ]);
    assert.equal(trajectory.extra.lmnr.exported, true);
    assert.equal(trajectory.extra.lmnr.complete, true);
    assert.equal(trajectory.agent.name, "weather-agent");
    assert.ok(trajectory.agent.model_name.startsWith("openai/gpt-5.4-nano"));

    const steps = trajectory.steps;
    assert.deepEqual(
      steps.map((s: any) => s.source),
      ["system", "user", "agent", "agent"],
    );
    const [first, last] = [steps[2], steps[3]];
    const call = first.tool_calls[0];
    assert.equal(call.function_name, "get_weather");
    assert.deepEqual(call.arguments, { city: "Paris" });
    assert.equal(
      call.extra.lmnr.span_id,
      otelSpanIdToUUID(byName("get_weather").spanContext().spanId),
    );
    assert.equal(first.observation.results[0].content, "Sunny, 21C in Paris");
    assert.equal(last.message, answer);
    assert.ok(first.metrics.prompt_tokens > 0);

    // Reading the file back gives each call the exact input it had.
    const ext = reader.TrajectoryExtension.read(trajectory);
    const llmSpans = spans
      .filter((s) => s.name === "openai.chat")
      .sort((a: ReadableSpan, b: ReadableSpan) =>
        a.startTime[0] !== b.startTime[0]
          ? a.startTime[0] - b.startTime[0]
          : a.startTime[1] - b.startTime[1],
      );
    assert.equal(llmSpans.length, 2);
    llmSpans.forEach((span, i) => {
      const [actual] = normalizeCall(
        JSON.parse(span.attributes["gen_ai.input.messages"] as string),
        null,
      );
      const rebuilt = reader.inputMessages(steps, i + 2, ext);
      assert.deepEqual(comparable(rebuilt), comparable(actual));
    });
  });
});
