import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { OpenRouter, ToolType } from "@openrouter/sdk-legacy";
import { SpanStatusCode } from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace";
import nock from "nock";
import { z } from "zod";

import {
  _resetConfiguration,
  initializeTracing,
} from "../src/opentelemetry-lib/configuration";
import { decompressRecordingResponse, recordingReplyHeaders } from "./utils";

const MODEL = "openai/gpt-4o-mini";
const _EMBEDDINGS_MODEL = "openai/text-embedding-3-small";
const _QUESTION = "What is the capital of France?";
const _CAPITAL_SCHEMA = {
  type: "object",
  properties: { capital: { type: "string" } },
  required: ["capital"],
  additionalProperties: false,
};

void describe("openrouter instrumentation (legacy SDK with callModel)", () => {
  const exporter = new InMemorySpanExporter();
  const dirname =
    typeof __dirname !== "undefined"
      ? __dirname
      : path.dirname(fileURLToPath(import.meta.url));
  const recordingsDir = path.join(dirname, "recordings");

  const getRecordingFile = (testName: string) => {
    const sanitizedName = testName.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase();
    return path.join(recordingsDir, `openrouter-${sanitizedName}.json`);
  };

  const setupNock = async (testName: string) => {
    const recordingsFile = getRecordingFile(testName);

    if (process.env.LMNR_TEST_RECORD_VCR) {
      nock.cleanAll();
      nock.restore();
      nock.recorder.clear();
      nock.recorder.rec({
        dont_print: true,
        enable_reqheaders_recording: false,
        output_objects: true,
      });
    } else if (fs.existsSync(recordingsFile)) {
      nock.cleanAll();
      const recordings = JSON.parse(
        await fs.promises.readFile(recordingsFile, "utf8"),
      );
      recordings.forEach((recording: nock.Definition) => {
        nock(recording.scope)
          .intercept(
            recording.path,
            recording.method ?? "POST",
            recording.body as nock.RequestBodyMatcher,
          )
          .reply(
            recording.status,
            decompressRecordingResponse(recording),
            recordingReplyHeaders(recording),
          );
      });
    } else {
      throw new Error(
        `LMNR_TEST_RECORD_VCR variable is false and no recordings file exists: ${recordingsFile}`,
      );
    }
  };

  const saveRecordings = (testName: string) => {
    if (process.env.LMNR_TEST_RECORD_VCR) {
      const recordings = nock.recorder.play();
      if (!fs.existsSync(recordingsDir)) {
        fs.mkdirSync(recordingsDir, { recursive: true });
      }
      fs.writeFileSync(
        getRecordingFile(testName),
        JSON.stringify(recordings, null, 2),
      );
      nock.restore();
    }
  };

  const reinitializeTracing = (traceContent = true) => {
    _resetConfiguration();
    initializeTracing({
      exporter,
      disableBatch: true,
      traceContent,
      instrumentModules: { openrouter: OpenRouter },
    });
  };

  const createClient = () =>
    new OpenRouter({
      apiKey: process.env.OPENROUTER_API_KEY ?? "dummy-key",
    });

  const assertUsage = (span: any) => {
    assert.ok((span.attributes["gen_ai.usage.input_tokens"] as number) > 0);
    assert.ok((span.attributes["gen_ai.usage.output_tokens"] as number) > 0);
    assert.ok((span.attributes["llm.usage.total_tokens"] as number) > 0);
    assert.ok((span.attributes["gen_ai.usage.cost"] as number) > 0);
    assert.ok((span.attributes["gen_ai.usage.input_cost"] as number) > 0);
    assert.ok((span.attributes["gen_ai.usage.output_cost"] as number) > 0);
  };

  void beforeEach(async (t) => {
    reinitializeTracing();
    await setupNock(t.name);
  });

  void afterEach((t) => {
    exporter.reset();
    saveRecordings(t.name);
  });

  void after(async () => {
    await exporter.shutdown();
    nock.cleanAll();
  });

  void it("traces callModel with tool execution", async () => {
    const weatherTool = {
      type: ToolType.Function,
      function: {
        name: "get_weather",
        description: "Get the weather in a city",
        inputSchema: z.object({ city: z.string() }),
        execute: async ({ city }: { city: string }) => ({
          city,
          forecast: "sunny",
        }),
      },
    };
    const result = createClient().callModel({
      model: MODEL,
      input: "What is the weather in Paris? Answer in one sentence.",
      tools: [weatherTool],
    });
    const text = await result.getText();
    assert.ok(text.toLowerCase().includes("sunny"));

    const spans = exporter.getFinishedSpans();
    const parent = spans.find((s) => s.name === "openrouter.call_model");
    const llmSpans = spans.filter((s) => s.name === "openrouter.responses");
    const toolSpan = spans.find((s) => s.name === "get_weather");
    assert.ok(parent);
    assert.strictEqual(spans.length, 4);
    assert.strictEqual(llmSpans.length, 2);
    assert.ok(toolSpan);

    const parentSpanId = parent.spanContext().spanId;
    for (const span of [...llmSpans, toolSpan]) {
      assert.strictEqual(span.parentSpanContext?.spanId, parentSpanId);
      assert.strictEqual(
        span.spanContext().traceId,
        parent.spanContext().traceId,
      );
    }

    assert.strictEqual(toolSpan.attributes["lmnr.span.type"], "TOOL");
    assert.deepStrictEqual(
      JSON.parse(toolSpan.attributes["lmnr.span.input"] as string),
      { city: "Paris" },
    );
    assert.deepStrictEqual(
      JSON.parse(toolSpan.attributes["lmnr.span.output"] as string),
      { city: "Paris", forecast: "sunny" },
    );

    for (const span of llmSpans) {
      assert.strictEqual(span.attributes["lmnr.span.type"], "LLM");
      assert.strictEqual(span.attributes["gen_ai.request.model"], MODEL);
      assert.ok(span.attributes["gen_ai.tool.definitions"]);
      assert.ok(span.attributes["gen_ai.input.messages"]);
      assert.ok(span.attributes["gen_ai.output.messages"]);
      assertUsage(span);
    }
    const firstOutput = JSON.parse(
      llmSpans[0].attributes["gen_ai.output.messages"] as string,
    );
    assert.strictEqual(firstOutput[0].type, "function_call");
    assert.strictEqual(firstOutput[0].name, "get_weather");

    assert.ok(parent.attributes["lmnr.span.input"]);
    const parentOutput = JSON.parse(
      parent.attributes["lmnr.span.output"] as string,
    );
    assert.strictEqual(parentOutput[0].type, "message");
  });

  void it("ends the call_model span when callModel throws", () => {
    // An invalid header name makes the SDK throw synchronously, before any request.
    assert.throws(() =>
      createClient().callModel(
        { model: MODEL, input: "Hello" },
        { headers: { "bad header": "value" } },
      ),
    );

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    const span = spans[0];
    assert.strictEqual(span.name, "openrouter.call_model");
    assert.strictEqual(span.status.code, SpanStatusCode.ERROR);
    assert.strictEqual(span.events[0]?.name, "exception");
  });
});
