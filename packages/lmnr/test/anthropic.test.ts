import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import Anthropic from "@anthropic-ai/sdk";
import { context, SpanStatusCode } from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";

import {
  _resetConfiguration,
  initializeTracing,
} from "../src/opentelemetry-lib/configuration";

const MODEL = "claude-sonnet-4-5";

// `@anthropic-ai/sdk`'s `exports` map hides package.json from `require`.
const ANTHROPIC_VERSION = JSON.parse(
  readFileSync(
    join(__dirname, "../node_modules/@anthropic-ai/sdk/package.json"),
    "utf8",
  ),
).version;

const MESSAGE_RESPONSE = {
  id: "msg_01",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-4-5-20250929",
  content: [
    { type: "text", text: "Let me check the weather." },
    {
      type: "tool_use",
      id: "toolu_01",
      name: "get_weather",
      input: { city: "Paris" },
    },
  ],
  stop_reason: "tool_use",
  stop_sequence: null,
  usage: {
    input_tokens: 10,
    output_tokens: 20,
    cache_read_input_tokens: 5,
    cache_creation_input_tokens: 3,
    service_tier: "standard",
  },
};

const STREAM_EVENTS = [
  {
    type: "message_start",
    message: {
      id: "msg_02",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-5-20250929",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 12,
        output_tokens: 1,
        cache_read_input_tokens: 4,
        cache_creation_input_tokens: 0,
        service_tier: "standard",
      },
    },
  },
  {
    type: "content_block_start",
    index: 0,
    content_block: { type: "thinking", thinking: "", signature: "" },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "thinking_delta", thinking: "The user wants " },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "thinking_delta", thinking: "the weather." },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "signature_delta", signature: "sig" },
  },
  { type: "content_block_stop", index: 0 },
  {
    type: "content_block_start",
    index: 1,
    content_block: { type: "text", text: "" },
  },
  {
    type: "content_block_delta",
    index: 1,
    delta: { type: "text_delta", text: "Checking " },
  },
  {
    type: "content_block_delta",
    index: 1,
    delta: { type: "text_delta", text: "now." },
  },
  { type: "content_block_stop", index: 1 },
  {
    type: "content_block_start",
    index: 2,
    content_block: {
      type: "tool_use",
      id: "toolu_02",
      name: "get_weather",
      input: {},
    },
  },
  {
    type: "content_block_delta",
    index: 2,
    delta: { type: "input_json_delta", partial_json: '{"city": ' },
  },
  {
    type: "content_block_delta",
    index: 2,
    delta: { type: "input_json_delta", partial_json: '"Paris"}' },
  },
  { type: "content_block_stop", index: 2 },
  {
    type: "message_delta",
    delta: { stop_reason: "tool_use", stop_sequence: null },
    usage: { output_tokens: 30, cache_creation_input_tokens: null },
  },
  { type: "message_stop" },
];

const TOOLS = [
  {
    name: "get_weather",
    description: "Get the weather for a city",
    input_schema: {
      type: "object" as const,
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
];

const REQUEST = {
  model: MODEL,
  max_tokens: 1024,
  temperature: 0.5,
  top_p: 0.9,
  system: "You are a weather assistant.",
  messages: [{ role: "user" as const, content: "Weather in Paris?" }],
  tools: TOOLS,
};

const sseResponse = (events: unknown[]) =>
  new Response(
    events
      .map((e: any) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
      .join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "request-id": "req_01" },
  });

const parseJsonAttr = (span: any, key: string) => {
  const value = span.attributes[key];
  assert.strictEqual(typeof value, "string", `${key} should be set`);
  return JSON.parse(value as string);
};

void describe("anthropic instrumentation", () => {
  const exporter = new InMemorySpanExporter();
  let fetchCalls: { url: string; body: any }[] = [];
  let respond: (body: any) => Response = () => jsonResponse(MESSAGE_RESPONSE);

  const fakeFetch = (async (input: any, init?: any) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    fetchCalls.push({ url: String(input), body });
    return respond(body);
  }) as typeof fetch;

  const createClient = () =>
    new Anthropic({ apiKey: "test-key", fetch: fakeFetch, maxRetries: 0 });

  const reinitialize = ({
    traceContent = true,
    anthropic = Anthropic as any,
  }: {
    traceContent?: boolean;
    anthropic?: any;
  } = {}) => {
    _resetConfiguration();
    initializeTracing({
      exporter,
      disableBatch: true,
      traceContent,
      instrumentModules: { anthropic },
    });
  };

  void beforeEach(() => {
    fetchCalls = [];
    respond = (body) =>
      body.stream ? sseResponse(STREAM_EVENTS) : jsonResponse(MESSAGE_RESPONSE);
    reinitialize();
  });

  void afterEach(() => {
    exporter.reset();
  });

  void after(async () => {
    await exporter.shutdown();
  });

  void it("creates a span for messages.create", async () => {
    const message = await createClient().messages.create(REQUEST);
    assert.strictEqual(message.id, "msg_01");
    assert.strictEqual(fetchCalls.length, 1);

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    const span = spans[0];
    assert.strictEqual(span.name, "anthropic.chat");
    assert.strictEqual(span.attributes["lmnr.span.type"], "LLM");
    assert.strictEqual(
      span.attributes["lmnr.span.instrumentation_scope.name"],
      "@anthropic-ai/sdk",
    );
    assert.strictEqual(
      span.attributes["lmnr.span.instrumentation_scope.version"],
      ANTHROPIC_VERSION,
    );
    assert.strictEqual(span.attributes["gen_ai.system"], "anthropic");
    assert.strictEqual(span.attributes["gen_ai.request.model"], MODEL);
    assert.strictEqual(span.attributes["gen_ai.request.max_tokens"], 1024);
    assert.strictEqual(span.attributes["gen_ai.request.temperature"], 0.5);
    assert.strictEqual(span.attributes["gen_ai.request.top_p"], 0.9);
    assert.strictEqual(
      span.attributes["gen_ai.response.model"],
      "claude-sonnet-4-5-20250929",
    );
    assert.strictEqual(span.attributes["gen_ai.response.id"], "msg_01");
    assert.strictEqual(
      span.attributes["anthropic.response.service_tier"],
      "standard",
    );
    // Cached tokens count towards input tokens.
    assert.strictEqual(span.attributes["gen_ai.usage.input_tokens"], 18);
    assert.strictEqual(span.attributes["gen_ai.usage.output_tokens"], 20);
    assert.strictEqual(span.attributes["llm.usage.total_tokens"], 38);
    assert.strictEqual(
      span.attributes["gen_ai.usage.cache_read_input_tokens"],
      5,
    );
    assert.strictEqual(
      span.attributes["gen_ai.usage.cache_creation_input_tokens"],
      3,
    );
    assert.strictEqual(span.status.code, SpanStatusCode.OK);

    assert.deepStrictEqual(parseJsonAttr(span, "gen_ai.input.messages"), [
      { role: "system", content: "You are a weather assistant." },
      { role: "user", content: "Weather in Paris?" },
    ]);
    assert.deepStrictEqual(
      parseJsonAttr(span, "gen_ai.tool.definitions"),
      TOOLS,
    );
    assert.deepStrictEqual(parseJsonAttr(span, "gen_ai.output.messages"), [
      {
        role: "assistant",
        content: MESSAGE_RESPONSE.content,
        stop_reason: "tool_use",
      },
    ]);
  });

  void it("keeps the APIPromise helpers", async () => {
    const { data, response, request_id } = await createClient()
      .messages.create(REQUEST)
      .withResponse();
    assert.strictEqual(data.id, "msg_01");
    assert.strictEqual(response.status, 200);
    assert.strictEqual(request_id, "req_01");

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].attributes["gen_ai.response.id"], "msg_01");
  });

  void it("aggregates a streamed messages.create", async () => {
    const stream = await createClient().messages.create({
      ...REQUEST,
      stream: true,
    });
    // The span stays open until the caller drains the stream.
    assert.strictEqual(exporter.getFinishedSpans().length, 0);

    const events: string[] = [];
    for await (const event of stream) {
      events.push(event.type);
    }
    assert.strictEqual(events.length, STREAM_EVENTS.length);

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    const span = spans[0];
    assert.strictEqual(span.name, "anthropic.chat");
    assert.strictEqual(span.attributes["llm.is_streaming"], true);
    assert.strictEqual(span.attributes["gen_ai.response.id"], "msg_02");
    assert.strictEqual(
      span.attributes["gen_ai.response.model"],
      "claude-sonnet-4-5-20250929",
    );
    assert.strictEqual(
      span.attributes["anthropic.response.service_tier"],
      "standard",
    );
    assert.strictEqual(span.attributes["gen_ai.usage.input_tokens"], 16);
    assert.strictEqual(span.attributes["gen_ai.usage.output_tokens"], 30);
    assert.strictEqual(
      span.attributes["gen_ai.usage.cache_read_input_tokens"],
      4,
    );
    assert.strictEqual(span.attributes["llm.usage.total_tokens"], undefined);
    assert.strictEqual(span.status.code, SpanStatusCode.OK);
    assert.deepStrictEqual(parseJsonAttr(span, "gen_ai.output.messages"), [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "The user wants the weather." },
          { type: "text", text: "Checking now." },
          {
            type: "tool_use",
            id: "toolu_02",
            name: "get_weather",
            input: { city: "Paris" },
          },
        ],
        stop_reason: "tool_use",
      },
    ]);
  });

  void it("ends the span when the caller stops iterating early", async () => {
    const stream = await createClient().messages.create({
      ...REQUEST,
      stream: true,
    });
    for await (const event of stream) {
      if (event.type === "content_block_start") break;
    }

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].attributes["gen_ai.response.id"], "msg_02");
  });

  void it("traces messages.stream() as one span", async () => {
    const stream = createClient().messages.stream(REQUEST);
    const texts: string[] = [];
    stream.on("text", (text) => texts.push(text));
    const final = await stream.finalMessage();
    assert.strictEqual(texts.join(""), "Checking now.");
    assert.strictEqual(final.id, "msg_02");
    assert.strictEqual(fetchCalls[0].body.stream, true);

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    const span = spans[0];
    assert.strictEqual(span.name, "anthropic.chat");
    assert.strictEqual(span.attributes["llm.is_streaming"], true);
    assert.strictEqual(span.attributes["gen_ai.usage.output_tokens"], 30);
    const output = parseJsonAttr(span, "gen_ai.output.messages");
    assert.strictEqual(output[0].content.length, 3);
  });

  void it("traces messages.parse() with its output schema", async () => {
    const schema = {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
      additionalProperties: false,
    };
    respond = () =>
      jsonResponse({
        ...MESSAGE_RESPONSE,
        content: [{ type: "text", text: '{"answer": "sunny"}' }],
        stop_reason: "end_turn",
      });

    const message = await createClient().messages.parse({
      model: MODEL,
      max_tokens: 256,
      messages: [{ role: "user", content: "Weather in Paris?" }],
      output_config: { format: { type: "json_schema", schema } },
    });
    assert.deepStrictEqual(message.parsed_output, { answer: "sunny" });

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.deepStrictEqual(
      parseJsonAttr(spans[0], "gen_ai.request.structured_output_schema"),
      schema,
    );
  });

  void it("creates a span for beta.messages.create", async () => {
    await createClient().beta.messages.create(REQUEST);

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].name, "anthropic.chat");
    assert.strictEqual(spans[0].attributes["gen_ai.response.id"], "msg_01");
  });

  void it("records API errors on the span", async () => {
    respond = () =>
      jsonResponse(
        {
          type: "error",
          error: { type: "invalid_request_error", message: "bad request" },
        },
        400,
      );

    await assert.rejects(
      () => createClient().messages.create(REQUEST),
      (error: any) => error.status === 400,
    );

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].status.code, SpanStatusCode.ERROR);
    assert.strictEqual(spans[0].attributes["error.type"], "BadRequestError");
    assert.strictEqual(spans[0].events[0]?.name, "exception");
  });

  void it("omits content when traceContent is off", async () => {
    reinitialize({ traceContent: false });
    await createClient().messages.create(REQUEST);

    const span = exporter.getFinishedSpans()[0];
    assert.strictEqual(span.attributes["gen_ai.input.messages"], undefined);
    assert.strictEqual(span.attributes["gen_ai.tool.definitions"], undefined);
    assert.strictEqual(span.attributes["gen_ai.output.messages"], undefined);
    assert.strictEqual(span.attributes["llm.usage.total_tokens"], 38);
  });

  void it("does not create spans when tracing is suppressed", async () => {
    await context.with(suppressTracing(context.active()), () =>
      createClient().messages.create(REQUEST),
    );
    assert.strictEqual(exporter.getFinishedSpans().length, 0);
  });

  void it("does not double-wrap on re-initialization", async () => {
    reinitialize();
    reinitialize();
    await createClient().messages.create(REQUEST);
    assert.strictEqual(exporter.getFinishedSpans().length, 1);
  });

  void it("traces legacy completions.create", async () => {
    // `Completions` was removed in @anthropic-ai/sdk 1.x; mimic the 0.x shape.
    class Messages {}
    class Completions {
      create(params: any) {
        if (params.stream) {
          return Promise.resolve(
            (async function* () {
              yield { type: "completion", id: "c1", completion: "Hello" };
              yield {
                type: "completion",
                id: "c1",
                model: "claude-2.1",
                completion: " there",
                stop_reason: "stop_sequence",
              };
            })(),
          );
        }
        return Promise.resolve({
          type: "completion",
          id: "c0",
          model: "claude-2.1",
          completion: "Hello there",
          stop_reason: "stop_sequence",
        });
      }
    }
    reinitialize({ anthropic: { Anthropic: { Messages, Completions } } });

    const client = new Completions();
    const prompt = "\n\nHuman: Hi\n\nAssistant:";
    const completion: any = await client.create({
      model: "claude-2.1",
      prompt,
      max_tokens_to_sample: 64,
    });
    assert.strictEqual(completion.completion, "Hello there");

    const stream: any = await client.create({
      model: "claude-2.1",
      prompt,
      max_tokens_to_sample: 64,
      stream: true,
    });
    for await (const _chunk of stream) {
      // drain
    }

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 2);
    for (const span of spans) {
      assert.strictEqual(span.name, "anthropic.completion");
      assert.strictEqual(span.attributes["gen_ai.request.max_tokens"], 64);
      assert.strictEqual(
        span.attributes["gen_ai.response.model"],
        "claude-2.1",
      );
      assert.deepStrictEqual(parseJsonAttr(span, "gen_ai.input.messages"), [
        { role: "user", content: prompt },
      ]);
      assert.deepStrictEqual(parseJsonAttr(span, "gen_ai.output.messages"), [
        {
          role: "assistant",
          content: [{ type: "text", text: "Hello there" }],
          stop_reason: "stop_sequence",
        },
      ]);
    }
  });
});
