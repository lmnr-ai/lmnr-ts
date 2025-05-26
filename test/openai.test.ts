import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import nock from "nock";
import OpenAI from "openai";

import { _resetConfiguration, initializeTracing } from "../src/opentelemetry-lib/configuration";

void describe("openai instrumentation", () => {
  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || "dummy-key",
  });
  const exporter = new InMemorySpanExporter();
  const dirname = typeof __dirname !== 'undefined'
    ? __dirname
    : path.dirname(fileURLToPath(import.meta.url));
  const recordingsDir = path.join(dirname, "recordings");
  const recordingsFile = path.join(recordingsDir, "openai-test.json");

  void beforeEach(async () => {
    _resetConfiguration();
    initializeTracing({
      exporter,
      disableBatch: true,
      instrumentModules: {
        openAI: OpenAI,
      },
    });

    if (process.env.LMNR_TEST_RECORD_VCR) {
      // Record mode - enable real HTTP requests and recording
      nock.cleanAll();
      nock.restore();
      nock.recorder.rec({
        dont_print: true,
        enable_reqheaders_recording: true,
        output_objects: true,
      });
    } else if (fs.existsSync(recordingsFile)) {
      // Replay mode - load recorded responses
      nock.cleanAll();
      const recordings = JSON.parse(await fs.promises.readFile(recordingsFile, "utf8"));
      recordings.forEach((recording: nock.Definition) => {
        // TODO: extract this parsing from gzip encoded OpenAI responses to a separate function
        const isGzipped = (recording as any)?.rawHeaders
          && (recording as any)?.rawHeaders?.['content-encoding'] === 'gzip';
        const response = isGzipped ?
          // If response is an array with a hex string, extract it first
          (Array.isArray(recording.response)
            ? JSON.parse(zlib.gunzipSync(Buffer.from(recording.response[0], 'hex')).toString())
            : JSON.parse(
              zlib.gunzipSync(
                Buffer.from((recording.response ?? '') as string, 'hex'),
              ).toString(),
            )
          )
          : recording.response;

        nock(recording.scope)
          .intercept(recording.path, recording.method ?? 'POST', recording.body)
          .reply(recording.status, response, recording.headers);
      });
    } else {
      throw new Error("LMNR_TEST_RECORD_VCR variable is false and no recordings file exists");
    }
  });

  void afterEach(() => {
    exporter.reset();

    if (process.env.LMNR_TEST_RECORD_VCR) {
      // Save recorded interactions
      const recordings = nock.recorder.play();
      if (!fs.existsSync(recordingsDir)) {
        fs.mkdirSync(recordingsDir, { recursive: true });
      }
      fs.writeFileSync(recordingsFile, JSON.stringify(recordings, null, 2));
      nock.restore(); // Clean up nock
    }
  });

  void after(async () => {
    await exporter.shutdown();
    nock.cleanAll();
  });

  void it("creates an openai span", async () => {
    await client.chat.completions.create({
      model: "gpt-4.1-nano",
      messages: [
        { role: "user", content: "What is the capital of France?" },
      ],
    });

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].name, "openai.chat");
    assert.strictEqual(spans[0].attributes['gen_ai.request.model'], "gpt-4.1-nano");
  });
});
