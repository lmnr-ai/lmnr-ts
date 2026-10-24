import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import * as aiplatform from "@google-cloud/aiplatform";
import * as vertexai from "@google-cloud/vertexai";
import { context, SpanStatusCode } from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";

import {
  _resetConfiguration,
  initializeTracing,
} from "../src/opentelemetry-lib/configuration";
import { fromValue } from "../src/opentelemetry-lib/instrumentation/google-aiplatform/utils";

const { helpers } = aiplatform;
const PredictResponse =
  aiplatform.protos.google.cloud.aiplatform.v1.PredictResponse;

const ENDPOINT =
  "projects/test-project/locations/us-central1/publishers/google/models/text-bison@001";

const GENERATE_CONTENT_RESPONSE = {
  candidates: [
    {
      index: 0,
      content: {
        role: "model",
        parts: [{ text: "The capital of France is Paris." }],
      },
      finishReason: "STOP",
    },
  ],
  usageMetadata: {
    promptTokenCount: 9,
    candidatesTokenCount: 8,
    totalTokenCount: 17,
  },
  modelVersion: "gemini-2.0-flash-001",
};

const STREAM_CHUNKS = [
  {
    candidates: [
      {
        index: 0,
        content: { role: "model", parts: [{ text: "The capital" }] },
      },
    ],
    modelVersion: "gemini-2.0-flash-001",
  },
  {
    candidates: [
      {
        index: 0,
        content: { role: "model", parts: [{ text: " is Paris." }] },
        finishReason: "STOP",
      },
    ],
    usageMetadata: {
      promptTokenCount: 9,
      candidatesTokenCount: 5,
      totalTokenCount: 14,
    },
    modelVersion: "gemini-2.0-flash-001",
  },
];

const googleAuth = { getAccessToken: async () => "test-token" } as any;

const createModel = (
  ModelClass: typeof vertexai.GenerativeModel = vertexai.GenerativeModel,
  overrides: Record<string, unknown> = {},
) =>
  new ModelClass({
    model: "gemini-2.0-flash",
    project: "test-project",
    location: "us-central1",
    googleAuth,
    generationConfig: { maxOutputTokens: 256, temperature: 0.2, topP: 0.9 },
    systemInstruction: "You are a geography expert.",
    ...overrides,
  } as any);

const predictResponse = () =>
  PredictResponse.fromObject({
    predictions: [
      helpers.toValue({
        content: "Paris is the capital of France.",
        safetyAttributes: { blocked: false },
      }),
    ],
    metadata: helpers.toValue({
      tokenMetadata: {
        inputTokenCount: { totalTokens: 7, totalBillableCharacters: 30 },
        outputTokenCount: { totalTokens: 9, totalBillableCharacters: 31 },
      },
    }),
    model: "projects/123/locations/us-central1/models/text-bison",
  } as any);

const predictRequest = () => ({
  endpoint: ENDPOINT,
  instances: [
    helpers.toValue({
      context: "Answer briefly.",
      prompt: "What is the capital of France?",
    }),
  ],
  parameters: helpers.toValue({
    temperature: 0.2,
    maxOutputTokens: 256,
    topP: 0.95,
    topK: 40,
  }),
});

/**
 * A PredictionServiceClient that never touches the network: the gax stub is
 * pre-initialized and `innerApiCalls.predict` is replaced with a fake.
 */
const createPredictionClient = (
  ClientClass: any,
  fake: (request: any, options: any, callback?: any) => any,
) => {
  const client = new ClientClass({ fallback: true });
  client.predictionServiceStub = Promise.resolve({});
  client.innerApiCalls = { predict: fake };
  return client;
};

const successfulPredict = (_request: any, _options: any, callback?: any) => {
  const response = predictResponse();
  if (callback) {
    setImmediate(() => callback(null, response, {}, {}));
    return undefined;
  }
  return Promise.resolve([response, {}, {}]);
};

void describe("google-aiplatform instrumentation", () => {
  const exporter = new InMemorySpanExporter();
  const originalFetch = globalThis.fetch;
  let fetchCalls: { url: string; body: any }[] = [];

  const mockFetch = (
    respond: (url: string) => Response = (url) =>
      url.includes("streamGenerateContent")
        ? new Response(
            STREAM_CHUNKS.map((c) => `data: ${JSON.stringify(c)}\r\n\r\n`).join(
              "",
            ),
            { status: 200, headers: { "content-type": "text/event-stream" } },
          )
        : Response.json(GENERATE_CONTENT_RESPONSE),
  ) => {
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(input);
      fetchCalls.push({ url, body: init?.body ? JSON.parse(init.body) : {} });
      return respond(url);
    }) as typeof fetch;
  };

  const reinitialize = ({
    traceContent = true,
    modules = [vertexai, aiplatform],
  }: {
    traceContent?: boolean;
    modules?: any;
  } = {}) => {
    _resetConfiguration();
    initializeTracing({
      exporter,
      disableBatch: true,
      traceContent,
      instrumentModules: { google_aiplatform: modules },
    });
  };

  void beforeEach(() => {
    fetchCalls = [];
    mockFetch();
    reinitialize();
  });

  void afterEach(() => {
    exporter.reset();
    globalThis.fetch = originalFetch;
  });

  void after(async () => {
    await exporter.shutdown();
  });

  void describe("fromValue", () => {
    void it("decodes plain and protobufjs Values", () => {
      const plain = helpers.toValue({
        a: "x",
        b: 1.5,
        c: true,
        d: [1, "y"],
        e: { f: null },
      });
      const expected = { a: "x", b: 1.5, c: true, d: [1, "y"], e: { f: null } };
      assert.deepStrictEqual(fromValue(plain), expected);

      const proto = PredictResponse.fromObject({
        predictions: [plain],
      } as any);
      assert.deepStrictEqual(fromValue(proto.predictions[0]), expected);
    });
  });

  void describe("@google-cloud/vertexai", () => {
    void it("creates a span for generateContent", async () => {
      const model = createModel();
      const result = await model.generateContent(
        "What is the capital of France?",
      );
      assert.strictEqual(
        result.response.candidates?.[0]?.content.parts[0]?.text,
        "The capital of France is Paris.",
      );
      assert.ok(fetchCalls[0].url.includes(":generateContent"));

      const spans = exporter.getFinishedSpans();
      assert.strictEqual(spans.length, 1);
      const span = spans[0];
      assert.strictEqual(span.name, "vertexai.generate_content");
      assert.strictEqual(span.attributes["lmnr.span.type"], "LLM");
      assert.strictEqual(span.attributes["gen_ai.system"], "vertex_ai");
      assert.strictEqual(
        span.attributes["gen_ai.request.model"],
        "gemini-2.0-flash",
      );
      assert.strictEqual(span.attributes["gen_ai.request.max_tokens"], 256);
      assert.strictEqual(span.attributes["gen_ai.request.temperature"], 0.2);
      assert.strictEqual(span.attributes["gen_ai.request.top_p"], 0.9);
      assert.strictEqual(
        span.attributes["gen_ai.response.model"],
        "gemini-2.0-flash-001",
      );
      assert.strictEqual(span.attributes["gen_ai.usage.input_tokens"], 9);
      assert.strictEqual(span.attributes["gen_ai.usage.output_tokens"], 8);
      assert.strictEqual(span.attributes["llm.usage.total_tokens"], 17);

      const input = JSON.parse(
        span.attributes["gen_ai.input.messages"] as string,
      );
      assert.deepStrictEqual(input, [
        { role: "system", parts: [{ text: "You are a geography expert." }] },
        { role: "user", content: "What is the capital of France?" },
      ]);
      const output = JSON.parse(
        span.attributes["gen_ai.output.messages"] as string,
      );
      assert.deepStrictEqual(output, [
        { role: "model", content: "The capital of France is Paris." },
      ]);
    });

    void it("uses request-level config over model-level config", async () => {
      const model = createModel(vertexai.GenerativeModel, {
        model: "projects/p/locations/l/publishers/google/models/gemini-1.5-pro",
      });
      await model.generateContent({
        contents: [{ role: "user", parts: [{ text: "Hi" }] }],
        systemInstruction: "Be terse.",
        generationConfig: { temperature: 0.7, candidateCount: 1 },
        tools: [
          {
            functionDeclarations: [
              { name: "get_weather", description: "Get the weather" },
            ],
          },
        ],
      });

      const span = exporter.getFinishedSpans()[0];
      assert.strictEqual(
        span.attributes["gen_ai.request.model"],
        "gemini-1.5-pro",
      );
      assert.strictEqual(span.attributes["gen_ai.request.temperature"], 0.7);
      assert.strictEqual(span.attributes["gen_ai.request.choice_count"], 1);
      assert.strictEqual(
        span.attributes["gen_ai.request.max_tokens"],
        undefined,
      );
      assert.deepStrictEqual(
        JSON.parse(span.attributes["gen_ai.tool.definitions"] as string),
        [{ name: "get_weather", description: "Get the weather" }],
      );
      const input = JSON.parse(
        span.attributes["gen_ai.input.messages"] as string,
      );
      assert.deepStrictEqual(input[0], {
        role: "system",
        content: "Be terse.",
      });
    });

    void it("falls back to the request model when modelVersion is missing", async () => {
      mockFetch(() =>
        Response.json({
          ...GENERATE_CONTENT_RESPONSE,
          modelVersion: undefined,
        }),
      );
      await createModel().generateContent("Hi");
      const span = exporter.getFinishedSpans()[0];
      assert.strictEqual(
        span.attributes["gen_ai.response.model"],
        "gemini-2.0-flash",
      );
    });

    void it("creates a span for generateContentStream", async () => {
      const model = createModel();
      const result = await model.generateContentStream(
        "What is the capital of France?",
      );
      const chunks: string[] = [];
      for await (const chunk of result.stream) {
        chunks.push(chunk.candidates?.[0]?.content.parts[0]?.text ?? "");
      }
      assert.strictEqual(chunks.join(""), "The capital is Paris.");
      await result.response;
      assert.ok(fetchCalls[0].url.includes(":streamGenerateContent"));

      const spans = exporter.getFinishedSpans();
      assert.strictEqual(spans.length, 1);
      const span = spans[0];
      assert.strictEqual(span.name, "vertexai.generate_content_stream");
      assert.strictEqual(span.attributes["gen_ai.system"], "vertex_ai");
      assert.strictEqual(span.attributes["gen_ai.usage.input_tokens"], 9);
      assert.strictEqual(span.attributes["gen_ai.usage.output_tokens"], 5);
      assert.strictEqual(span.attributes["llm.usage.total_tokens"], 14);
      assert.deepStrictEqual(
        JSON.parse(span.attributes["gen_ai.output.messages"] as string),
        [{ role: "model", content: "The capital is Paris." }],
      );
    });

    void it("ends the stream span even if the stream is never consumed", async () => {
      const result = await createModel().generateContentStream("Hi");
      await result.response;
      await new Promise((resolve) => setImmediate(resolve));
      const spans = exporter.getFinishedSpans();
      assert.strictEqual(spans.length, 1);
      assert.strictEqual(spans[0].attributes["llm.usage.total_tokens"], 14);
    });

    void it("records errors", async () => {
      mockFetch(() =>
        Response.json(
          {
            error: {
              code: 400,
              message: "Bad model",
              status: "INVALID_ARGUMENT",
            },
          },
          { status: 400 },
        ),
      );
      await assert.rejects(() => createModel().generateContent("Hi"));
      await assert.rejects(() => createModel().generateContentStream("Hi"));

      const spans = exporter.getFinishedSpans();
      assert.strictEqual(spans.length, 2);
      for (const span of spans) {
        assert.strictEqual(span.status.code, SpanStatusCode.ERROR);
        assert.strictEqual(span.attributes["error.type"], "ClientError");
        assert.ok(span.events.some((e) => e.name === "exception"));
      }
    });

    void it("instruments GenerativeModelPreview", async () => {
      await createModel(vertexai.GenerativeModelPreview as any).generateContent(
        "Hi",
      );
      const spans = exporter.getFinishedSpans();
      assert.strictEqual(spans.length, 1);
      assert.strictEqual(spans[0].name, "vertexai.generate_content");
    });

    void it("omits content when traceContent is false", async () => {
      reinitialize({ traceContent: false });
      await createModel().generateContent("Hi");
      const span = exporter.getFinishedSpans()[0];
      assert.strictEqual(span.attributes["gen_ai.input.messages"], undefined);
      assert.strictEqual(span.attributes["gen_ai.output.messages"], undefined);
      assert.strictEqual(span.attributes["llm.usage.total_tokens"], 17);
    });

    void it("does not create spans when tracing is suppressed", async () => {
      await context.with(suppressTracing(context.active()), () =>
        createModel().generateContent("Hi"),
      );
      assert.strictEqual(exporter.getFinishedSpans().length, 0);
    });

    void it("does not double-wrap on re-initialization", async () => {
      reinitialize();
      reinitialize();
      await createModel().generateContent("Hi");
      assert.strictEqual(exporter.getFinishedSpans().length, 1);
    });
  });

  void describe("@google-cloud/aiplatform", () => {
    const assertPredictSpan = () => {
      const spans = exporter.getFinishedSpans();
      assert.strictEqual(spans.length, 1);
      const span = spans[0];
      assert.strictEqual(span.name, "aiplatform.predict");
      assert.strictEqual(span.attributes["lmnr.span.type"], "LLM");
      assert.strictEqual(span.attributes["gen_ai.system"], "vertex_ai");
      assert.strictEqual(
        span.attributes["gen_ai.request.model"],
        "text-bison@001",
      );
      assert.strictEqual(span.attributes["gen_ai.request.temperature"], 0.2);
      assert.strictEqual(span.attributes["gen_ai.request.max_tokens"], 256);
      assert.strictEqual(span.attributes["gen_ai.request.top_p"], 0.95);
      assert.strictEqual(span.attributes["gen_ai.request.top_k"], 40);
      assert.strictEqual(
        span.attributes["gen_ai.response.model"],
        "text-bison",
      );
      assert.strictEqual(span.attributes["gen_ai.usage.input_tokens"], 7);
      assert.strictEqual(span.attributes["gen_ai.usage.output_tokens"], 9);
      assert.strictEqual(span.attributes["llm.usage.total_tokens"], 16);
      assert.deepStrictEqual(
        JSON.parse(span.attributes["gen_ai.input.messages"] as string),
        [
          { role: "system", content: "Answer briefly." },
          { role: "user", content: "What is the capital of France?" },
        ],
      );
      assert.deepStrictEqual(
        JSON.parse(span.attributes["gen_ai.output.messages"] as string),
        [{ role: "assistant", content: "Paris is the capital of France." }],
      );
      return span;
    };

    void it("creates a span for promise-style predict", async () => {
      const client = createPredictionClient(
        aiplatform.PredictionServiceClient,
        successfulPredict,
      );
      const [response] = await client.predict(predictRequest());
      assert.ok(response.predictions.length === 1);
      assertPredictSpan();
    });

    void it("creates a span for callback-style predict", async () => {
      const client = createPredictionClient(
        aiplatform.PredictionServiceClient,
        successfulPredict,
      );
      const response: any = await new Promise((resolve, reject) => {
        client.predict(predictRequest(), (err: unknown, resp: unknown) =>
          err ? reject(err) : resolve(resp),
        );
      });
      assert.ok(response.predictions.length === 1);
      assertPredictSpan();
    });

    void it("instruments the v1beta1 client", async () => {
      const client = createPredictionClient(
        aiplatform.v1beta1.PredictionServiceClient,
        successfulPredict,
      );
      await client.predict(predictRequest());
      assertPredictSpan();
    });

    void it("records chat-style messages", async () => {
      const client = createPredictionClient(
        aiplatform.PredictionServiceClient,
        successfulPredict,
      );
      await client.predict({
        endpoint: ENDPOINT,
        instances: [
          helpers.toValue({
            context: "Be nice.",
            messages: [
              { author: "user", content: "Hi" },
              { author: "bot", content: "Hello!" },
              { author: "user", content: "Capital of France?" },
            ],
          }),
        ],
      });
      const span = exporter.getFinishedSpans()[0];
      assert.deepStrictEqual(
        JSON.parse(span.attributes["gen_ai.input.messages"] as string),
        [
          { role: "system", content: "Be nice." },
          { role: "user", content: "Hi" },
          { role: "assistant", content: "Hello!" },
          { role: "user", content: "Capital of France?" },
        ],
      );
    });

    void it("records errors for promise and callback styles", async () => {
      const client = createPredictionClient(
        aiplatform.PredictionServiceClient,
        (_request: any, _options: any, callback?: any) => {
          const error = new TypeError("boom");
          if (callback) {
            setImmediate(() => callback(error));
            return undefined;
          }
          return Promise.reject(error);
        },
      );
      await assert.rejects(() => client.predict(predictRequest()), /boom/);
      await assert.rejects(
        () =>
          new Promise((resolve, reject) => {
            client.predict(
              predictRequest(),
              {},
              (err: unknown, resp: unknown) =>
                err ? reject(err) : resolve(resp),
            );
          }),
        /boom/,
      );

      const spans = exporter.getFinishedSpans();
      assert.strictEqual(spans.length, 2);
      for (const span of spans) {
        assert.strictEqual(span.status.code, SpanStatusCode.ERROR);
        assert.strictEqual(span.attributes["error.type"], "TypeError");
        assert.ok(span.events.some((e) => e.name === "exception"));
      }
    });

    void it("omits content when traceContent is false", async () => {
      reinitialize({ traceContent: false });
      const client = createPredictionClient(
        aiplatform.PredictionServiceClient,
        successfulPredict,
      );
      await client.predict(predictRequest());
      const span = exporter.getFinishedSpans()[0];
      assert.strictEqual(span.attributes["gen_ai.input.messages"], undefined);
      assert.strictEqual(span.attributes["gen_ai.output.messages"], undefined);
      assert.strictEqual(span.attributes["llm.usage.total_tokens"], 16);
    });

    void it("supports manually instrumenting a single module", async () => {
      reinitialize({ modules: aiplatform });
      const client = createPredictionClient(
        aiplatform.PredictionServiceClient,
        successfulPredict,
      );
      await client.predict(predictRequest());
      assertPredictSpan();
    });
  });
});
