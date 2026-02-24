import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { GoogleGenAI } from "@google/genai";
import { SpanStatusCode } from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import nock from "nock";

import { _resetConfiguration, initializeTracing } from "../src/opentelemetry-lib/configuration";

void describe("google-genai instrumentation", () => {
  const exporter = new InMemorySpanExporter();
  const dirname = typeof __dirname !== "undefined"
    ? __dirname
    : path.dirname(fileURLToPath(import.meta.url));
  const recordingsDir = path.join(dirname, "recordings");

  // Create a mutable module-like object for manual instrumentation.
  // _wrap uses Object.defineProperty which fails on frozen ES module namespaces.
  let genaiModule: { GoogleGenAI: typeof GoogleGenAI };

  const getRecordingFile = (testName: string) => {
    const sanitizedName = testName
      .replace(/[^a-zA-Z0-9]/g, "-")
      .toLowerCase();
    return path.join(recordingsDir, `google-genai-${sanitizedName}.json`);
  };

  const setupNock = async (testName: string) => {
    const recordingsFile = getRecordingFile(testName);

    if (process.env.LMNR_TEST_RECORD_VCR) {
      nock.cleanAll();
      nock.restore();
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
          .reply(recording.status, recording.response, recording.headers as Record<string, string>);
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
      const recordingsFile = getRecordingFile(testName);
      fs.writeFileSync(
        recordingsFile,
        JSON.stringify(recordings, null, 2),
      );
      nock.restore();
    }
  };

  const withVertexDisabled = async (fn: () => Promise<void>) => {
    const origVertexEnv = process.env.GOOGLE_GENAI_USE_VERTEXAI;
    process.env.GOOGLE_GENAI_USE_VERTEXAI = "false";
    try {
      await fn();
    } finally {
      if (origVertexEnv !== undefined) {
        process.env.GOOGLE_GENAI_USE_VERTEXAI = origVertexEnv;
      } else {
        delete process.env.GOOGLE_GENAI_USE_VERTEXAI;
      }
    }
  };

  void beforeEach(async (t) => {
    _resetConfiguration();
    genaiModule = { GoogleGenAI };
    initializeTracing({
      exporter,
      disableBatch: true,
      instrumentModules: {
        google_genai: genaiModule,
      },
    });
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

  void it("creates a genai span", async () => {
    await withVertexDisabled(async () => {
      const client = new genaiModule.GoogleGenAI({ apiKey: "dummy-key" });
      const response = await client.models.generateContent({
        model: "gemini-2.0-flash",
        contents: "What is the capital of France?",
      });

      // Verify response is returned correctly
      assert.ok(response.candidates);
      assert.ok(response.candidates[0]?.content?.parts?.[0]?.text);

      const spans = exporter.getFinishedSpans();
      assert.strictEqual(spans.length, 1);

      const span = spans[0];
      assert.strictEqual(span.name, "gemini.generate_content");
      assert.strictEqual(span.attributes["gen_ai.system"], "gemini");
      assert.strictEqual(
        span.attributes["gen_ai.request.model"],
        "gemini-2.0-flash",
      );
      assert.strictEqual(span.attributes["llm.request.type"], "completion");

      // Usage tokens
      assert.strictEqual(span.attributes["gen_ai.usage.input_tokens"], 8);
      assert.strictEqual(span.attributes["gen_ai.usage.output_tokens"], 10);
      assert.strictEqual(span.attributes["llm.usage.total_tokens"], 18);

      // Response model
      assert.strictEqual(
        span.attributes["gen_ai.response.model"],
        "gemini-2.0-flash",
      );

      // Content tracing (enabled by default)
      assert.ok(span.attributes["gen_ai.input.messages"]);
      assert.ok(span.attributes["gen_ai.output.messages"]);
      assert.ok(span.attributes["gen_ai.completion.0.role"]);
      assert.ok(span.attributes["gen_ai.completion.0.content"]);
    });
  });

  void it("creates a streaming genai span", async () => {
    await withVertexDisabled(async () => {
      const client = new genaiModule.GoogleGenAI({ apiKey: "dummy-key" });
      const stream = await client.models.generateContentStream({
        model: "gemini-2.0-flash",
        contents: "What is the capital of France?",
      });

      // Consume all chunks
      const chunks: any[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }

      assert.ok(chunks.length > 0, "Should receive at least one chunk");

      const spans = exporter.getFinishedSpans();
      assert.strictEqual(spans.length, 1);

      const span = spans[0];
      assert.strictEqual(span.name, "gemini.generate_content_stream");
      assert.strictEqual(span.attributes["gen_ai.system"], "gemini");
      assert.strictEqual(
        span.attributes["gen_ai.request.model"],
        "gemini-2.0-flash",
      );

      // Usage should be aggregated from last chunk
      assert.ok(
        span.attributes["gen_ai.usage.input_tokens"] !== undefined,
        "input_tokens should be set",
      );
      assert.ok(
        span.attributes["gen_ai.usage.output_tokens"] !== undefined,
        "output_tokens should be set",
      );

      // Response model from stream
      assert.strictEqual(
        span.attributes["gen_ai.response.model"],
        "gemini-2.0-flash",
      );
    });
  });

  void it("records error on api failure", async () => {
    await withVertexDisabled(async () => {
      const client = new genaiModule.GoogleGenAI({ apiKey: "dummy-key" });

      await assert.rejects(async () => {
        await client.models.generateContent({
          model: "gemini-2.0-flash",
          contents: "What is the capital of France?",
        });
      });

      const spans = exporter.getFinishedSpans();
      assert.strictEqual(spans.length, 1);

      const span = spans[0];
      assert.strictEqual(span.name, "gemini.generate_content");
      assert.strictEqual(span.status.code, SpanStatusCode.ERROR);
      assert.ok(span.attributes["error.type"]);

      // Should still have request attributes
      assert.strictEqual(span.attributes["gen_ai.system"], "gemini");
      assert.strictEqual(
        span.attributes["gen_ai.request.model"],
        "gemini-2.0-flash",
      );

      // Should have recorded the exception
      assert.ok(span.events.length > 0, "Should have exception event");
      assert.strictEqual(span.events[0].name, "exception");
    });
  });

  void it("respects traceContent off", async () => {
    // Reinitialize with traceContent disabled
    _resetConfiguration();
    genaiModule = { GoogleGenAI };
    initializeTracing({
      exporter,
      disableBatch: true,
      traceContent: false,
      instrumentModules: {
        google_genai: genaiModule,
      },
    });

    await withVertexDisabled(async () => {
      const client = new genaiModule.GoogleGenAI({ apiKey: "dummy-key" });
      await client.models.generateContent({
        model: "gemini-2.0-flash",
        contents: "What is the capital of France?",
      });

      const spans = exporter.getFinishedSpans();
      assert.strictEqual(spans.length, 1);

      const span = spans[0];
      assert.strictEqual(span.name, "gemini.generate_content");

      // Model and usage should still be present
      assert.strictEqual(
        span.attributes["gen_ai.request.model"],
        "gemini-2.0-flash",
      );
      assert.strictEqual(span.attributes["gen_ai.usage.input_tokens"], 8);

      // Content attributes should NOT be present
      assert.strictEqual(
        span.attributes["gen_ai.input.messages"],
        undefined,
      );
      assert.strictEqual(
        span.attributes["gen_ai.output.messages"],
        undefined,
      );
      assert.strictEqual(
        span.attributes["gen_ai.completion.0.content"],
        undefined,
      );
      assert.strictEqual(
        span.attributes["gen_ai.completion.0.role"],
        undefined,
      );
    });
  });
});
