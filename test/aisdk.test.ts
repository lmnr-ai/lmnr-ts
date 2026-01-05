import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { openai } from "@ai-sdk/openai";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { generateText, streamText } from "ai";
import nock from "nock";

import { observe } from "../src/decorators";
import { Laminar } from "../src/laminar";
import { _resetConfiguration, initializeTracing } from "../src/opentelemetry-lib/configuration";
import { getTracer } from "../src/opentelemetry-lib/tracing";
import { getParentSpanId } from "../src/opentelemetry-lib/tracing/compat";
import { decompressRecordingResponse } from "./utils";

void describe("aisdk instrumentation", () => {
  const model = openai("gpt-4.1-nano");
  const exporter = new InMemorySpanExporter();
  const dirname = typeof __dirname !== 'undefined'
    ? __dirname
    : path.dirname(fileURLToPath(import.meta.url));
  const recordingsDir = path.join(dirname, "recordings");

  // Function to get test-specific recording file
  const getRecordingFile = (testName: string) => {
    const sanitizedName = testName.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
    return path.join(recordingsDir, `aisdk-${sanitizedName}.json`);
  };

  void beforeEach(async (t) => {
    _resetConfiguration();
    initializeTracing({
      exporter,
      disableBatch: true,
    });

    const recordingsFile = getRecordingFile(t.name);

    if (process.env.LMNR_TEST_RECORD_VCR) {
      // Record mode - enable real HTTP requests and recording
      nock.cleanAll();
      nock.restore();
      nock.recorder.rec({
        dont_print: true,
        enable_reqheaders_recording: false,
        output_objects: true,
      });
    } else if (fs.existsSync(recordingsFile)) {
      // Replay mode - load recorded responses
      nock.cleanAll();
      const OLD_OPENAI_API_KEY = process.env.OPENAI_API_KEY;
      const recordings = JSON.parse(await fs.promises.readFile(recordingsFile, "utf8"));
      recordings.forEach((recording: nock.Definition) => {
        const response = decompressRecordingResponse(recording);

        nock(recording.scope)
          .intercept(recording.path, recording.method ?? 'POST', recording.body)
          .reply(recording.status, response, recording.headers);
        process.env.OPENAI_API_KEY = OLD_OPENAI_API_KEY;
      });
    } else {
      throw new Error(
        `LMNR_TEST_RECORD_VCR variable is false and no recordings file exists: ${recordingsFile}`,
      );
    }
  });

  void afterEach((t) => {
    exporter.reset();

    if (process.env.LMNR_TEST_RECORD_VCR) {
      // Save recorded interactions
      const recordings = nock.recorder.play();
      if (!fs.existsSync(recordingsDir)) {
        fs.mkdirSync(recordingsDir, { recursive: true });
      }
      const recordingsFile = getRecordingFile(t.name);
      fs.writeFileSync(recordingsFile, JSON.stringify(recordings, null, 2));
      nock.restore(); // Clean up nock
    }
  });

  void after(async () => {
    await exporter.shutdown();
    nock.cleanAll();
  });

  void it("creates AI SDK spans", async () => {
    await generateText({
      model,
      prompt: "What is the capital of France?",
      experimental_telemetry: {
        isEnabled: true,
        tracer: getTracer(),
      },
    });

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 2);
    const outerSpan = spans.find(
      span => !span.name.includes("doGenerate") && span.name !== "test",
    )!;
    const innerSpan = spans.find(span => span.name.includes("doGenerate"))!;
    assert.strictEqual(outerSpan.spanContext().traceId, innerSpan.spanContext().traceId);
    assert.strictEqual(getParentSpanId(outerSpan), undefined);
    assert.strictEqual(getParentSpanId(innerSpan), outerSpan.spanContext().spanId);

    assert.strictEqual((innerSpan.attributes['lmnr.span.path']! as string[]).length, 2);
    assert.strictEqual(
      outerSpan.attributes['ai.prompt'],
      '{"prompt":"What is the capital of France?"}',
    );
    assert.strictEqual(
      outerSpan.attributes['ai.response.text'],
      "The capital of France is Paris.",
    );
    assert.deepStrictEqual(JSON.parse(innerSpan.attributes['ai.prompt.messages']! as string), [{
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "What is the capital of France?",
        },
      ],
    }]);
    assert.strictEqual(innerSpan.attributes['ai.response.text'], "The capital of France is Paris.");
  });

  void it("creates AI SDK spans inside observe", async () => {
    await observe({ name: "test" }, async () => {
      await generateText({
        model,
        prompt: "What is the capital of France?",
        experimental_telemetry: {
          isEnabled: true,
          tracer: getTracer(),
        },
      });
    });

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 3);
    const observeSpan = spans.find(span => span.name === "test")!;
    const outerAiSDKSpan = spans.find(
      span => !span.name.includes("doGenerate") && span.name !== "test",
    )!;
    const innerSpan = spans.find(span => span.name.includes("doGenerate"))!;
    assert.strictEqual(getParentSpanId(outerAiSDKSpan), observeSpan.spanContext().spanId);
    assert.strictEqual(observeSpan.spanContext().traceId, outerAiSDKSpan.spanContext().traceId);
    assert.strictEqual((innerSpan.attributes['lmnr.span.path']! as string[]).length, 3);
    assert.strictEqual(
      outerAiSDKSpan.attributes['ai.prompt'],
      '{"prompt":"What is the capital of France?"}',
    );
    assert.strictEqual(
      outerAiSDKSpan.attributes['ai.response.text'],
      "The capital of France is Paris.",
    );
    assert.deepStrictEqual(JSON.parse(innerSpan.attributes['ai.prompt.messages']! as string), [{
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "What is the capital of France?",
        },
      ],
    }]);
    assert.strictEqual(innerSpan.attributes['ai.response.text'], "The capital of France is Paris.");
  });

  void it("creates AI SDK spans inside withSpan", async () => {
    const span = Laminar.startSpan({ name: "test" });
    await Laminar.withSpan(span, async () => {
      await generateText({
        model,
        prompt: "What is the capital of France?",
        experimental_telemetry: {
          isEnabled: true,
          tracer: getTracer(),
        },
      });
    });
    span.end();

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 3);
    const testSpan = spans.find(span => span.name === "test")!;
    const outerAiSDKSpan = spans.find(
      span => !span.name.includes("doGenerate") && span.name !== "test",
    )!;
    const innerSpan = spans.find(span => span.name.includes("doGenerate"))!;
    assert.strictEqual(getParentSpanId(outerAiSDKSpan), testSpan.spanContext().spanId);
    assert.strictEqual(testSpan.spanContext().traceId, outerAiSDKSpan.spanContext().traceId);
    assert.strictEqual((innerSpan.attributes['lmnr.span.path']! as string[]).length, 3);
    assert.strictEqual(
      outerAiSDKSpan.attributes['ai.prompt'],
      '{"prompt":"What is the capital of France?"}',
    );
    assert.strictEqual(
      outerAiSDKSpan.attributes['ai.response.text'],
      "The capital of France is Paris.",
    );
    assert.deepStrictEqual(JSON.parse(innerSpan.attributes['ai.prompt.messages']! as string), [{
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "What is the capital of France?",
        },
      ],
    }]);
    assert.strictEqual(
      innerSpan.attributes['ai.response.text'],
      "The capital of France is Paris.",
    );
  });

  void it("creates AI SDK spans inside startActiveSpan", async () => {
    const span = Laminar.startActiveSpan({ name: "test" });

    await generateText({
      model,
      prompt: "What is the capital of France?",
      experimental_telemetry: {
        isEnabled: true,
        tracer: getTracer(),
      },
    });
    span.end();

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 3);
    const testSpan = spans.find(span => span.name === "test")!;
    const outerAiSDKSpan = spans.find(
      span => !span.name.includes("doGenerate") && span.name !== "test",
    )!;
    const innerSpan = spans.find(span => span.name.includes("doGenerate"))!;
    assert.strictEqual(getParentSpanId(outerAiSDKSpan), testSpan.spanContext().spanId);
    assert.strictEqual(testSpan.spanContext().traceId, outerAiSDKSpan.spanContext().traceId);
    assert.strictEqual((innerSpan.attributes['lmnr.span.path']! as string[]).length, 3);
  });

  void it("creates AI SDK spans outside startSpan (inactive)", async () => {
    const span = Laminar.startSpan({ name: "test" });

    await generateText({
      model,
      prompt: "What is the capital of France?",
      experimental_telemetry: {
        isEnabled: true,
        tracer: getTracer(),
      },
    });
    span.end();

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 3);
    const testSpan = spans.find(span => span.name === "test")!;
    const outerAiSDKSpan = spans.find(
      span => !span.name.includes("doGenerate") && span.name !== "test",
    )!;
    const innerSpan = spans.find(span => span.name.includes("doGenerate"))!;
    assert.strictEqual(getParentSpanId(outerAiSDKSpan), undefined);
    assert.notStrictEqual(testSpan.spanContext().traceId, outerAiSDKSpan.spanContext().traceId);
    assert.strictEqual((innerSpan.attributes['lmnr.span.path']! as string[]).length, 2);
    assert.strictEqual(
      outerAiSDKSpan.attributes['ai.prompt'],
      '{"prompt":"What is the capital of France?"}',
    );
    assert.strictEqual(
      outerAiSDKSpan.attributes['ai.response.text'],
      "The capital of France is Paris.",
    );
    assert.deepStrictEqual(JSON.parse(innerSpan.attributes['ai.prompt.messages']! as string), [{
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "What is the capital of France?",
        },
      ],
    }]);
    assert.strictEqual(innerSpan.attributes['ai.response.text'], "The capital of France is Paris.");
  });

  void it("keeps the AI SDK stream spans inside the same span", async () => {
    const stream = observe({ name: "test" }, () => {
      const stream = streamText({
        model,
        prompt: "What is the capital of France?",
        experimental_telemetry: {
          isEnabled: true,
          tracer: getTracer(),
        },
      });
      return stream.toUIMessageStreamResponse();
    });

    // consume the stream elsewhere
    const reader = stream.body!.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 3);
    const observeSpan = spans.find(span => span.name === "test")!;
    const outerAiSDKSpan = spans.find(
      span => !span.name.includes("doStream") && span.name !== "test",
    )!;
    const innerSpan = spans.find(span => span.name.includes("doStream"))!;
    assert.strictEqual(getParentSpanId(outerAiSDKSpan), observeSpan.spanContext().spanId);
    assert.strictEqual(observeSpan.spanContext().traceId, outerAiSDKSpan.spanContext().traceId);
    assert.strictEqual((innerSpan.attributes['lmnr.span.path']! as string[]).length, 3);
    assert.strictEqual(
      outerAiSDKSpan.attributes['ai.prompt'],
      '{"prompt":"What is the capital of France?"}',
    );
    assert.strictEqual(
      outerAiSDKSpan.attributes['ai.response.text'],
      "The capital of France is Paris.",
    );
    assert.deepStrictEqual(JSON.parse(innerSpan.attributes['ai.prompt.messages']! as string), [{
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "What is the capital of France?",
        },
      ],
    }]);
    assert.strictEqual(innerSpan.attributes['ai.response.text'], "The capital of France is Paris.");
  });
});
