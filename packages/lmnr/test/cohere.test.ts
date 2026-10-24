import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import { context, SpanStatusCode } from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import * as cohere from "cohere-ai";
import {
  _resetConfiguration,
  initializeTracing,
} from "../src/opentelemetry-lib/configuration";
import { CohereInstrumentation } from "../src/opentelemetry-lib/instrumentation/cohere";

const MODEL = "command-a-03-2025";

const USAGE_V1 = {
  billed_units: { input_tokens: 9, output_tokens: 19 },
  tokens: { input_tokens: 10, output_tokens: 20 },
};

const V1_CHAT_RESPONSE = {
  response_id: "resp_v1",
  generation_id: "gen_v1",
  text: "It is sunny in Paris.",
  finish_reason: "COMPLETE",
  tool_calls: [{ name: "get_weather", parameters: { city: "Paris" } }],
  meta: USAGE_V1,
};

const V1_STREAM_EVENTS = [
  { event_type: "stream-start", generation_id: "gen_s1", is_finished: false },
  { event_type: "text-generation", text: "Sunny ", is_finished: false },
  { event_type: "text-generation", text: "today.", is_finished: false },
  {
    event_type: "stream-end",
    finish_reason: "COMPLETE",
    is_finished: true,
    response: {
      response_id: "resp_s1",
      generation_id: "gen_s1",
      text: "Sunny today.",
      finish_reason: "COMPLETE",
      meta: { billed_units: { input_tokens: 4, output_tokens: 3 } },
    },
  },
];

const GENERATE_RESPONSE = {
  id: "gen_resp",
  prompt: "Once upon a time",
  generations: [
    { id: "g1", text: " there was a fox.", finish_reason: "COMPLETE" },
  ],
  meta: USAGE_V1,
};

const RERANK_RESPONSE = {
  id: "rerank_resp",
  results: [
    { index: 1, relevance_score: 0.9 },
    { index: 0, relevance_score: 0.1 },
  ],
  meta: { billed_units: { search_units: 1 } },
};

const V1_EMBED_RESPONSE = {
  response_type: "embeddings_floats",
  id: "embed_v1",
  embeddings: [[0.1, 0.2]],
  texts: ["hello"],
  meta: { billed_units: { input_tokens: 2 } },
};

const V2_CHAT_RESPONSE = {
  id: "chat_v2",
  finish_reason: "TOOL_CALL",
  message: {
    role: "assistant",
    tool_plan: "I will check the weather.",
    tool_calls: [
      {
        id: "call_1",
        type: "function",
        function: { name: "get_weather", arguments: '{"city":"Paris"}' },
      },
    ],
  },
  usage: {
    billed_units: { input_tokens: 11, output_tokens: 21 },
    tokens: { input_tokens: 12, output_tokens: 22 },
    cached_tokens: 5,
  },
};

const V2_STREAM_EVENTS = [
  {
    type: "message-start",
    id: "chat_s2",
    delta: { message: { role: "assistant" } },
  },
  {
    type: "content-start",
    index: 0,
    delta: { message: { content: { type: "text", text: "" } } },
  },
  {
    type: "content-delta",
    index: 0,
    delta: { message: { content: { text: "Hello " } } },
  },
  {
    type: "content-delta",
    index: 0,
    delta: { message: { content: { text: "there." } } },
  },
  { type: "content-end", index: 0 },
  {
    type: "tool-call-start",
    index: 0,
    delta: {
      message: {
        tool_calls: {
          id: "call_s",
          type: "function",
          function: { name: "get_weather", arguments: "" },
        },
      },
    },
  },
  {
    type: "tool-call-delta",
    index: 0,
    delta: {
      message: { tool_calls: { function: { arguments: '{"city":' } } },
    },
  },
  {
    type: "tool-call-delta",
    index: 0,
    delta: { message: { tool_calls: { function: { arguments: '"Rome"}' } } } },
  },
  { type: "tool-call-end", index: 0 },
  {
    type: "message-end",
    delta: {
      finish_reason: "TOOL_CALL",
      usage: {
        billed_units: { input_tokens: 6, output_tokens: 7 },
        tokens: { input_tokens: 8, output_tokens: 9 },
        cached_tokens: 2,
      },
    },
  },
];

const V2_EMBED_RESPONSE = {
  id: "embed_v2",
  embeddings: { float: [[0.3, 0.4]] },
  texts: ["hello"],
  meta: { billed_units: { input_tokens: 3 } },
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const ndjsonResponse = (events: unknown[]) =>
  new Response(events.map((e) => `${JSON.stringify(e)}\n`).join(""), {
    status: 200,
    headers: { "content-type": "application/stream+json" },
  });

const sseResponse = (events: unknown[]) =>
  new Response(
    `${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")}data: [DONE]\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

const parseJsonAttr = (span: any, key: string) => {
  const value = span.attributes[key];
  assert.strictEqual(typeof value, "string", `${key} should be set`);
  return JSON.parse(value as string);
};

const route = (path: string, body: any): Response => {
  switch (path) {
    case "/v1/chat":
      return body.stream
        ? ndjsonResponse(V1_STREAM_EVENTS)
        : jsonResponse(V1_CHAT_RESPONSE);
    case "/v1/generate":
      return jsonResponse(GENERATE_RESPONSE);
    case "/v1/rerank":
    case "/v2/rerank":
      return jsonResponse(RERANK_RESPONSE);
    case "/v1/embed":
      return jsonResponse(V1_EMBED_RESPONSE);
    case "/v2/embed":
      return jsonResponse(V2_EMBED_RESPONSE);
    case "/v2/chat":
      return body.stream
        ? sseResponse(V2_STREAM_EVENTS)
        : jsonResponse(V2_CHAT_RESPONSE);
    default:
      return jsonResponse({ message: `unexpected path ${path}` }, 404);
  }
};

void describe("cohere instrumentation", () => {
  const exporter = new InMemorySpanExporter();
  let fetchCalls: { path: string; body: any }[] = [];
  let respond: (path: string, body: any) => Response = route;

  const fakeFetch = (async (input: any, init?: any) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    const path = new URL(String(input)).pathname;
    fetchCalls.push({ path, body });
    return respond(path, body);
  }) as typeof fetch;

  const options = { token: "test-key", fetch: fakeFetch, maxRetries: 0 };
  const createClient = () => new cohere.CohereClient(options);
  const createClientV2 = () => new cohere.CohereClientV2(options);

  const reinitialize = ({
    traceContent = true,
    module = cohere as any,
  }: {
    traceContent?: boolean;
    module?: any;
  } = {}) => {
    _resetConfiguration();
    initializeTracing({
      exporter,
      disableBatch: true,
      traceContent,
      instrumentModules: { cohere: module },
    });
  };

  const onlySpan = () => {
    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    return spans[0];
  };

  void beforeEach(() => {
    fetchCalls = [];
    respond = route;
    reinitialize();
  });

  void afterEach(() => {
    exporter.reset();
  });

  void after(async () => {
    await exporter.shutdown();
  });

  void it("traces v1 chat", async () => {
    const response = await createClient().chat({
      model: MODEL,
      message: "Weather in Paris?",
      preamble: "You are a weather bot.",
      chatHistory: [
        { role: "USER", message: "Hi" },
        { role: "CHATBOT", message: "Hello!" },
      ],
      tools: [
        {
          name: "get_weather",
          description: "Get the weather",
          parameterDefinitions: { city: { type: "str", required: true } },
        },
      ],
      maxTokens: 100,
      temperature: 0.3,
      p: 0.9,
      k: 40,
      frequencyPenalty: 0.1,
      presencePenalty: 0.2,
      seed: 7,
      stopSequences: ["END"],
    });
    assert.strictEqual(response.text, "It is sunny in Paris.");
    assert.strictEqual(fetchCalls[0].path, "/v1/chat");

    const span = onlySpan();
    assert.strictEqual(span.name, "cohere.chat");
    assert.strictEqual(span.attributes["lmnr.span.type"], "LLM");
    assert.strictEqual(span.attributes["gen_ai.system"], "cohere");
    assert.strictEqual(span.attributes["gen_ai.operation.name"], "chat");
    assert.strictEqual(span.attributes["gen_ai.request.model"], MODEL);
    assert.strictEqual(span.attributes["gen_ai.request.max_tokens"], 100);
    assert.strictEqual(span.attributes["gen_ai.request.temperature"], 0.3);
    assert.strictEqual(span.attributes["gen_ai.request.top_p"], 0.9);
    assert.strictEqual(span.attributes["gen_ai.request.top_k"], 40);
    assert.strictEqual(
      span.attributes["gen_ai.request.frequency_penalty"],
      0.1,
    );
    assert.strictEqual(span.attributes["gen_ai.request.presence_penalty"], 0.2);
    assert.strictEqual(span.attributes["gen_ai.request.seed"], 7);
    assert.deepStrictEqual(span.attributes["gen_ai.request.stop_sequences"], [
      "END",
    ]);
    assert.strictEqual(span.attributes["llm.is_streaming"], false);
    assert.strictEqual(span.attributes["gen_ai.response.id"], "resp_v1");
    // Actual tokens win over billed units.
    assert.strictEqual(span.attributes["gen_ai.usage.input_tokens"], 10);
    assert.strictEqual(span.attributes["gen_ai.usage.output_tokens"], 20);
    assert.strictEqual(span.attributes["llm.usage.total_tokens"], 30);
    assert.deepStrictEqual(span.attributes["gen_ai.response.finish_reasons"], [
      "COMPLETE",
    ]);

    assert.deepStrictEqual(parseJsonAttr(span, "gen_ai.input.messages"), [
      {
        role: "system",
        parts: [{ type: "text", content: "You are a weather bot." }],
      },
      { role: "user", parts: [{ type: "text", content: "Hi" }] },
      { role: "assistant", parts: [{ type: "text", content: "Hello!" }] },
      { role: "user", parts: [{ type: "text", content: "Weather in Paris?" }] },
    ]);
    assert.deepStrictEqual(parseJsonAttr(span, "gen_ai.output.messages"), [
      {
        role: "assistant",
        parts: [
          { type: "text", content: "It is sunny in Paris." },
          {
            type: "tool_call",
            name: "get_weather",
            arguments: { city: "Paris" },
          },
        ],
        finish_reason: "COMPLETE",
      },
    ]);
    assert.deepStrictEqual(parseJsonAttr(span, "gen_ai.tool.definitions"), [
      {
        name: "get_weather",
        description: "Get the weather",
        parameters: { city: { type: "str", required: true } },
      },
    ]);
  });

  void it("keeps withRawResponse() on the returned promise", async () => {
    const { data, rawResponse } = await createClient()
      .chat({ model: MODEL, message: "Hi" })
      .withRawResponse();
    assert.strictEqual(data.text, "It is sunny in Paris.");
    assert.strictEqual(rawResponse.status, 200);
    assert.strictEqual(onlySpan().attributes["gen_ai.response.id"], "resp_v1");
  });

  void it("aggregates a v1 chat stream", async () => {
    const stream = await createClient().chatStream({
      model: MODEL,
      message: "Weather?",
    });
    const texts: string[] = [];
    for await (const event of stream) {
      if (event.eventType === "text-generation") texts.push(event.text);
    }
    assert.deepStrictEqual(texts, ["Sunny ", "today."]);
    assert.strictEqual(fetchCalls[0].body.stream, true);

    const span = onlySpan();
    assert.strictEqual(span.name, "cohere.chat");
    assert.strictEqual(span.attributes["llm.is_streaming"], true);
    assert.strictEqual(span.status.code, SpanStatusCode.OK);
    assert.strictEqual(span.attributes["gen_ai.response.id"], "resp_s1");
    // Only billed units: they are the fallback.
    assert.strictEqual(span.attributes["gen_ai.usage.input_tokens"], 4);
    assert.strictEqual(span.attributes["gen_ai.usage.output_tokens"], 3);
    assert.deepStrictEqual(parseJsonAttr(span, "gen_ai.output.messages"), [
      {
        role: "assistant",
        parts: [{ type: "text", content: "Sunny today." }],
        finish_reason: "COMPLETE",
      },
    ]);
  });

  void it("ends an abandoned v1 stream with the partial output", async () => {
    const stream = await createClient().chatStream({
      model: MODEL,
      message: "Weather?",
    });
    for await (const event of stream) {
      if (event.eventType === "text-generation") break;
    }

    const span = onlySpan();
    assert.strictEqual(span.status.code, SpanStatusCode.OK);
    assert.deepStrictEqual(parseJsonAttr(span, "gen_ai.output.messages"), [
      { role: "assistant", parts: [{ type: "text", content: "Sunny " }] },
    ]);
  });

  void it("traces generate as a completion", async () => {
    await createClient().generate({
      model: MODEL,
      prompt: "Once upon a time",
    });

    const span = onlySpan();
    assert.strictEqual(span.name, "cohere.completion");
    assert.strictEqual(
      span.attributes["gen_ai.operation.name"],
      "text_completion",
    );
    assert.strictEqual(span.attributes["gen_ai.response.id"], "gen_resp");
    assert.deepStrictEqual(parseJsonAttr(span, "gen_ai.input.messages"), [
      { role: "user", parts: [{ type: "text", content: "Once upon a time" }] },
    ]);
    assert.deepStrictEqual(parseJsonAttr(span, "gen_ai.output.messages"), [
      {
        role: "assistant",
        parts: [{ type: "text", content: " there was a fox." }],
      },
    ]);
  });

  void it("traces v1 rerank and embed", async () => {
    const client = createClient();
    await client.rerank({
      model: "rerank-v3.5",
      query: "capital of France",
      documents: ["Berlin is in Germany", { text: "Paris is in France" }],
    });
    await client.embed({
      model: "embed-v4.0",
      texts: ["hello"],
      inputType: "search_document",
    });

    const [rerank, embed] = exporter.getFinishedSpans();
    assert.strictEqual(rerank.name, "cohere.rerank");
    assert.strictEqual(rerank.attributes["gen_ai.operation.name"], "rerank");
    assert.deepStrictEqual(parseJsonAttr(rerank, "gen_ai.input.messages"), [
      {
        role: "system",
        parts: [{ type: "text", content: "Berlin is in Germany" }],
      },
      {
        role: "system",
        parts: [{ type: "text", content: "Paris is in France" }],
      },
      { role: "user", parts: [{ type: "text", content: "capital of France" }] },
    ]);
    assert.deepStrictEqual(parseJsonAttr(rerank, "gen_ai.output.messages"), [
      {
        role: "assistant",
        parts: [
          { type: "text", content: "Doc 1, Score: 0.9" },
          { type: "text", content: "Doc 0, Score: 0.1" },
        ],
      },
    ]);

    assert.strictEqual(embed.name, "cohere.embed");
    assert.strictEqual(embed.attributes["gen_ai.operation.name"], "embeddings");
    assert.strictEqual(embed.attributes["gen_ai.response.id"], "embed_v1");
    assert.strictEqual(embed.attributes["gen_ai.usage.input_tokens"], 2);
    assert.deepStrictEqual(parseJsonAttr(embed, "gen_ai.input.messages"), [
      { role: "user", parts: [{ type: "text", content: "hello" }] },
    ]);
    assert.strictEqual(embed.attributes["gen_ai.output.messages"], undefined);
  });

  void it("traces v2 chat on CohereClientV2", async () => {
    const response = await createClientV2().chat({
      model: MODEL,
      messages: [
        { role: "system", content: "You are a weather bot." },
        {
          role: "user",
          content: [
            { type: "text", text: "What is in this image?" },
            {
              type: "image_url",
              imageUrl: { url: "data:image/png;base64,aGVsbG8=" },
            },
          ],
        },
        {
          role: "assistant",
          toolCalls: [
            {
              id: "call_0",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"Oslo"}' },
            },
          ],
        },
        { role: "tool", toolCallId: "call_0", content: "Snowing" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get the weather",
            parameters: { type: "object" },
          },
        },
      ],
    });
    assert.strictEqual(response.id, "chat_v2");
    assert.strictEqual(fetchCalls[0].path, "/v2/chat");

    const span = onlySpan();
    assert.strictEqual(span.name, "cohere.chat");
    assert.strictEqual(span.attributes["gen_ai.response.id"], "chat_v2");
    assert.strictEqual(span.attributes["gen_ai.usage.input_tokens"], 12);
    assert.strictEqual(span.attributes["gen_ai.usage.output_tokens"], 22);
    assert.strictEqual(
      span.attributes["gen_ai.usage.cache_read_input_tokens"],
      5,
    );
    assert.deepStrictEqual(parseJsonAttr(span, "gen_ai.input.messages"), [
      {
        role: "system",
        parts: [{ type: "text", content: "You are a weather bot." }],
      },
      {
        role: "user",
        parts: [
          { type: "text", content: "What is in this image?" },
          {
            type: "blob",
            modality: "image",
            mime_type: "image/png",
            content: "aGVsbG8=",
          },
        ],
      },
      {
        role: "assistant",
        parts: [
          {
            type: "tool_call",
            id: "call_0",
            name: "get_weather",
            arguments: { city: "Oslo" },
          },
        ],
      },
      {
        role: "tool",
        parts: [
          { type: "tool_call_response", id: "call_0", result: "Snowing" },
        ],
      },
    ]);
    assert.deepStrictEqual(parseJsonAttr(span, "gen_ai.output.messages"), [
      {
        role: "assistant",
        parts: [
          { type: "text", content: "I will check the weather." },
          {
            type: "tool_call",
            id: "call_1",
            name: "get_weather",
            arguments: { city: "Paris" },
          },
        ],
        finish_reason: "TOOL_CALL",
      },
    ]);
    assert.deepStrictEqual(parseJsonAttr(span, "gen_ai.tool.definitions"), [
      {
        name: "get_weather",
        description: "Get the weather",
        parameters: { type: "object" },
      },
    ]);
  });

  void it("traces v2 chat through CohereClient#v2", async () => {
    await createClient().v2.chat({
      model: MODEL,
      messages: [{ role: "user", content: "Hi" }],
    });
    const span = onlySpan();
    assert.strictEqual(span.attributes["gen_ai.response.id"], "chat_v2");
    assert.deepStrictEqual(parseJsonAttr(span, "gen_ai.input.messages"), [
      { role: "user", parts: [{ type: "text", content: "Hi" }] },
    ]);
  });

  void it("aggregates a v2 chat stream", async () => {
    const stream = await createClientV2().chatStream({
      model: MODEL,
      messages: [{ role: "user", content: "Hi" }],
    });
    const types: string[] = [];
    for await (const event of stream) {
      types.push(event.type);
    }
    assert.strictEqual(types.length, V2_STREAM_EVENTS.length);
    assert.strictEqual(fetchCalls[0].body.stream, true);

    const span = onlySpan();
    assert.strictEqual(span.attributes["llm.is_streaming"], true);
    assert.strictEqual(span.status.code, SpanStatusCode.OK);
    assert.strictEqual(span.attributes["gen_ai.response.id"], "chat_s2");
    assert.strictEqual(span.attributes["gen_ai.usage.input_tokens"], 8);
    assert.strictEqual(span.attributes["gen_ai.usage.output_tokens"], 9);
    assert.strictEqual(
      span.attributes["gen_ai.usage.cache_read_input_tokens"],
      2,
    );
    assert.deepStrictEqual(span.attributes["gen_ai.response.finish_reasons"], [
      "TOOL_CALL",
    ]);
    assert.deepStrictEqual(parseJsonAttr(span, "gen_ai.output.messages"), [
      {
        role: "assistant",
        parts: [
          { type: "text", content: "Hello there." },
          {
            type: "tool_call",
            id: "call_s",
            name: "get_weather",
            arguments: { city: "Rome" },
          },
        ],
        finish_reason: "TOOL_CALL",
      },
    ]);
  });

  void it("traces v2 rerank and embed", async () => {
    const client = createClientV2();
    await client.rerank({
      model: "rerank-v3.5",
      query: "capital of France",
      documents: ["Paris is in France"],
    });
    await client.embed({
      model: "embed-v4.0",
      inputType: "search_document",
      embeddingTypes: ["float"],
      inputs: [
        {
          content: [
            { type: "text", text: "a cat" },
            {
              type: "image_url",
              imageUrl: { url: "https://example.com/cat.png" },
            },
          ],
        },
      ],
    });

    const [rerank, embed] = exporter.getFinishedSpans();
    assert.strictEqual(rerank.name, "cohere.rerank");
    assert.strictEqual(fetchCalls[0].path, "/v2/rerank");
    assert.strictEqual(embed.name, "cohere.embed");
    assert.strictEqual(fetchCalls[1].path, "/v2/embed");
    assert.strictEqual(embed.attributes["gen_ai.response.id"], "embed_v2");
    assert.deepStrictEqual(parseJsonAttr(embed, "gen_ai.input.messages"), [
      {
        role: "user",
        parts: [
          { type: "text", content: "a cat" },
          {
            type: "uri",
            modality: "image",
            uri: "https://example.com/cat.png",
          },
        ],
      },
    ]);
  });

  void it("records API errors", async () => {
    respond = () => jsonResponse({ message: "invalid model" }, 400);
    await assert.rejects(
      createClient().chat({ model: "nope", message: "Hi" }),
      (error: any) => error instanceof cohere.Cohere.BadRequestError,
    );

    const span = onlySpan();
    assert.strictEqual(span.status.code, SpanStatusCode.ERROR);
    assert.strictEqual(span.attributes["error.type"], "BadRequestError");
    assert.ok(span.events.some((event) => event.name === "exception"));
  });

  void it("records stream errors raised before iteration", async () => {
    respond = () => jsonResponse({ message: "boom" }, 400);
    await assert.rejects(
      createClientV2().chatStream({
        model: MODEL,
        messages: [{ role: "user", content: "Hi" }],
      }),
    );
    const span = onlySpan();
    assert.strictEqual(span.status.code, SpanStatusCode.ERROR);
    assert.ok(span.events.some((event) => event.name === "exception"));
  });

  void it("omits content when traceContent is off", async () => {
    reinitialize({ traceContent: false });
    await createClientV2().chat({
      model: MODEL,
      messages: [{ role: "user", content: "secret" }],
      tools: [{ type: "function", function: { name: "t", parameters: {} } }],
    });

    const span = onlySpan();
    assert.strictEqual(span.attributes["gen_ai.request.model"], MODEL);
    assert.strictEqual(span.attributes["gen_ai.usage.input_tokens"], 12);
    assert.strictEqual(span.attributes["gen_ai.input.messages"], undefined);
    assert.strictEqual(span.attributes["gen_ai.output.messages"], undefined);
    assert.strictEqual(span.attributes["gen_ai.tool.definitions"], undefined);
  });

  void it("creates no span when tracing is suppressed", async () => {
    await context.with(suppressTracing(context.active()), () =>
      createClient().chat({ model: MODEL, message: "Hi" }),
    );
    assert.strictEqual(fetchCalls.length, 1);
    assert.strictEqual(exporter.getFinishedSpans().length, 0);
  });

  void it("does not double-wrap on repeated initialization", async () => {
    reinitialize();
    reinitialize({ module: { default: cohere } });
    await createClient().chat({ model: MODEL, message: "Hi" });
    await createClientV2().chat({
      model: MODEL,
      messages: [{ role: "user", content: "Hi" }],
    });
    assert.strictEqual(exporter.getFinishedSpans().length, 2);
  });

  void it("unpatches the SDK", async () => {
    const instrumentation = new CohereInstrumentation();
    const unpatch = (instrumentation as any).unpatch.bind(instrumentation);
    unpatch(cohere);
    try {
      await createClient().chat({ model: MODEL, message: "Hi" });
      await createClientV2().chat({
        model: MODEL,
        messages: [{ role: "user", content: "Hi" }],
      });
      assert.strictEqual(exporter.getFinishedSpans().length, 0);
    } finally {
      reinitialize();
    }
  });
});
