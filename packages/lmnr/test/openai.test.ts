import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { context, SpanStatusCode } from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import nock from "nock";
import OpenAI from "openai";

import {
  _resetConfiguration,
  initializeTracing,
} from "../src/opentelemetry-lib/configuration";
import { DISABLE_OPENAI_RESPONSES_INSTRUMENTATION_CONTEXT_KEY } from "../src/opentelemetry-lib/instrumentation/openai-agents/helpers";
import { decompressRecordingResponse, recordingReplyHeaders } from "./utils";

void describe("openai instrumentation (recorded)", () => {
  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || "dummy-key",
  });
  const exporter = new InMemorySpanExporter();
  const dirname =
    typeof __dirname !== "undefined"
      ? __dirname
      : path.dirname(fileURLToPath(import.meta.url));
  const recordingsDir = path.join(dirname, "recordings");

  // Function to get test-specific recording file
  const getRecordingFile = (testName: string) => {
    const sanitizedName = testName.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase();
    return path.join(recordingsDir, `openai-${sanitizedName}.json`);
  };

  void beforeEach(async (t) => {
    _resetConfiguration();
    initializeTracing({
      exporter,
      disableBatch: true,
      instrumentModules: {
        openAI: OpenAI,
      },
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
      const recordings = JSON.parse(
        await fs.promises.readFile(recordingsFile, "utf8"),
      );
      recordings.forEach((recording: nock.Definition) => {
        const response = decompressRecordingResponse(recording);

        nock(recording.scope)
          .intercept(recording.path, recording.method ?? "POST", recording.body)
          .reply(recording.status, response, recordingReplyHeaders(recording));
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

  void it("creates an openai span", async () => {
    await client.chat.completions.create({
      model: "gpt-4.1-nano",
      messages: [{ role: "user", content: "What is the capital of France?" }],
    });

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].name, "openai.chat");
    assert.strictEqual(
      spans[0].attributes["gen_ai.request.model"],
      "gpt-4.1-nano",
    );
  });
});

const MODEL = "gpt-4.1-nano";
const RESPONSE_MODEL = "gpt-4.1-nano-2025-04-14";

const TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "get_weather",
      description: "Get the weather for a city",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    },
  },
];

const CHAT_REQUEST = {
  model: MODEL,
  max_tokens: 256,
  temperature: 0.5,
  top_p: 0.9,
  messages: [
    { role: "system" as const, content: "You are a weather assistant." },
    { role: "user" as const, content: "Weather in Paris?" },
  ],
  tools: TOOLS,
};

const TOOL_CALL = {
  id: "call_1",
  type: "function",
  function: { name: "get_weather", arguments: '{"city":"Paris"}' },
};

const CHAT_RESPONSE = {
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 1,
  model: RESPONSE_MODEL,
  system_fingerprint: "fp_1",
  service_tier: "default",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: null,
        refusal: null,
        tool_calls: [TOOL_CALL],
      },
      finish_reason: "tool_calls",
      logprobs: null,
    },
  ],
  usage: {
    prompt_tokens: 20,
    completion_tokens: 10,
    total_tokens: 30,
    prompt_tokens_details: { cached_tokens: 4 },
    completion_tokens_details: { reasoning_tokens: 2 },
  },
};

const chunk = (choices: unknown[], extra: Record<string, unknown> = {}) => ({
  id: "chatcmpl-2",
  object: "chat.completion.chunk",
  created: 1,
  model: RESPONSE_MODEL,
  choices,
  ...extra,
});

const CHAT_STREAM_CHUNKS = [
  chunk([{ index: 0, delta: { role: "assistant", content: "" } }]),
  chunk([{ index: 0, delta: { content: "Sunny" } }]),
  chunk([{ index: 0, delta: { content: " in Paris." } }]),
  chunk([{ index: 0, delta: {}, finish_reason: "stop" }]),
  chunk([], {
    usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
  }),
];

const COMPLETION_RESPONSE = {
  id: "cmpl-1",
  object: "text_completion",
  created: 1,
  model: "gpt-3.5-turbo-instruct",
  choices: [
    { index: 0, text: "Paris.", finish_reason: "stop", logprobs: null },
  ],
  usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
};

const EMBEDDINGS_RESPONSE = {
  object: "list",
  model: "text-embedding-3-small",
  data: [
    { object: "embedding", index: 0, embedding: [0.1, 0.2] },
    { object: "embedding", index: 1, embedding: [0.3, 0.4] },
  ],
  usage: { prompt_tokens: 6, total_tokens: 6 },
};

const RESPONSES_REQUEST = {
  model: MODEL,
  instructions: "Be brief.",
  input: "Weather in Paris?",
  tools: [
    {
      type: "function" as const,
      name: "get_weather",
      parameters: { type: "object", properties: {} },
      strict: false,
    },
  ],
  reasoning: { effort: "low" as const },
};

const OUTPUT_MESSAGE = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: "Sunny.", annotations: [] }],
};

const response = (overrides: Record<string, unknown> = {}) => ({
  id: "resp_1",
  object: "response",
  created_at: 1,
  status: "completed",
  model: RESPONSE_MODEL,
  output: [OUTPUT_MESSAGE],
  service_tier: "default",
  usage: {
    input_tokens: 10,
    output_tokens: 5,
    total_tokens: 15,
    input_tokens_details: { cached_tokens: 2 },
    output_tokens_details: { reasoning_tokens: 1 },
  },
  ...overrides,
});

const RESPONSES_STREAM_EVENTS = [
  {
    type: "response.created",
    sequence_number: 0,
    response: response({ status: "in_progress", output: [], usage: null }),
  },
  {
    type: "response.output_text.delta",
    sequence_number: 1,
    item_id: "msg_1",
    output_index: 0,
    content_index: 0,
    delta: "Sunny",
  },
  {
    type: "response.output_text.delta",
    sequence_number: 2,
    item_id: "msg_1",
    output_index: 0,
    content_index: 0,
    delta: ".",
  },
  {
    type: "response.output_item.done",
    sequence_number: 3,
    output_index: 0,
    item: OUTPUT_MESSAGE,
  },
  { type: "response.completed", sequence_number: 4, response: response() },
];

const DECISION_REQUEST = {
  model: MODEL,
  input: "I want a refund for order 42.",
  questions: [
    {
      type: "predicate" as const,
      name: "is_refund",
      instructions: "Is this a refund request?",
    },
  ],
};

const DECISION_RESPONSE = {
  model: RESPONSE_MODEL,
  answers: [{ type: "predicate", name: "is_refund", probability: 0.97 }],
  usage: {
    input_tokens: 30,
    output_tokens: 1,
    total_tokens: 31,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  },
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-request-id": "req_1" },
  });

const chatSseResponse = (chunks: unknown[]) =>
  new Response(
    `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

const responsesSseResponse = (events: any[]) =>
  new Response(
    events
      .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
      .join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

const parseJsonAttr = (span: any, key: string) => {
  const value = span.attributes[key];
  assert.strictEqual(typeof value, "string", `${key} should be set`);
  return JSON.parse(value as string);
};

void describe("openai instrumentation", () => {
  const exporter = new InMemorySpanExporter();
  let fetchCalls: { url: string; method: string; body: any }[] = [];
  let respond: (url: string, method: string, body: any) => Response;

  const defaultRespond = (url: string, _method: string, body: any) => {
    const { pathname } = new URL(url);
    if (pathname.endsWith("/chat/completions")) {
      return body.stream
        ? chatSseResponse(CHAT_STREAM_CHUNKS)
        : jsonResponse(CHAT_RESPONSE);
    }
    if (pathname.endsWith("/completions")) {
      return jsonResponse(COMPLETION_RESPONSE);
    }
    if (pathname.endsWith("/embeddings")) {
      return jsonResponse(EMBEDDINGS_RESPONSE);
    }
    if (pathname.endsWith("/decisions")) {
      return jsonResponse(DECISION_RESPONSE);
    }
    if (pathname.endsWith("/responses")) {
      return body.stream
        ? responsesSseResponse(RESPONSES_STREAM_EVENTS)
        : jsonResponse(response());
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const fakeFetch = (async (input: any, init?: any) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body) : {};
    fetchCalls.push({ url, method, body });
    return respond(url, method, body);
  }) as typeof fetch;

  const createClient = () =>
    new OpenAI({ apiKey: "test-key", fetch: fakeFetch, maxRetries: 0 });

  const reinitialize = ({
    traceContent = true,
    openai = OpenAI as any,
  }: {
    traceContent?: boolean;
    openai?: any;
  } = {}) => {
    _resetConfiguration();
    initializeTracing({
      exporter,
      disableBatch: true,
      traceContent,
      instrumentModules: { OpenAI: openai },
    });
  };

  void beforeEach(() => {
    fetchCalls = [];
    respond = defaultRespond;
    reinitialize();
  });

  void afterEach(() => {
    exporter.reset();
  });

  void after(async () => {
    await exporter.shutdown();
  });

  void it("creates a span for chat.completions.create", async () => {
    const completion =
      await createClient().chat.completions.create(CHAT_REQUEST);
    assert.strictEqual(completion.id, "chatcmpl-1");
    assert.strictEqual(fetchCalls.length, 1);

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    const span = spans[0];
    assert.strictEqual(span.name, "openai.chat");
    assert.strictEqual(span.attributes["lmnr.span.type"], "LLM");
    assert.strictEqual(span.attributes["gen_ai.system"], "openai");
    assert.strictEqual(
      span.attributes["gen_ai.request.base_url"],
      "https://api.openai.com/v1",
    );
    assert.strictEqual(span.attributes["gen_ai.request.model"], MODEL);
    assert.strictEqual(span.attributes["gen_ai.request.max_tokens"], 256);
    assert.strictEqual(span.attributes["gen_ai.request.temperature"], 0.5);
    assert.strictEqual(span.attributes["gen_ai.request.top_p"], 0.9);
    assert.strictEqual(span.attributes["llm.is_streaming"], false);
    assert.strictEqual(
      span.attributes["gen_ai.response.model"],
      RESPONSE_MODEL,
    );
    assert.strictEqual(span.attributes["gen_ai.response.id"], "chatcmpl-1");
    assert.strictEqual(
      span.attributes["openai.response.system_fingerprint"],
      "fp_1",
    );
    assert.strictEqual(
      span.attributes["openai.response.service_tier"],
      "default",
    );
    assert.strictEqual(span.attributes["gen_ai.usage.input_tokens"], 20);
    assert.strictEqual(span.attributes["gen_ai.usage.output_tokens"], 10);
    assert.strictEqual(span.attributes["llm.usage.total_tokens"], 30);
    assert.strictEqual(
      span.attributes["gen_ai.usage.cache_read_input_tokens"],
      4,
    );
    assert.strictEqual(span.attributes["gen_ai.usage.reasoning_tokens"], 2);
    assert.strictEqual(span.status.code, SpanStatusCode.OK);

    assert.deepStrictEqual(
      parseJsonAttr(span, "gen_ai.input.messages"),
      CHAT_REQUEST.messages,
    );
    assert.deepStrictEqual(
      parseJsonAttr(span, "gen_ai.tool.definitions"),
      TOOLS,
    );
    assert.deepStrictEqual(
      parseJsonAttr(span, "gen_ai.output.messages"),
      CHAT_RESPONSE.choices,
    );
  });

  void it("keeps the APIPromise helpers", async () => {
    const { data, response: raw } = await createClient()
      .chat.completions.create(CHAT_REQUEST)
      .withResponse();
    assert.strictEqual(data.id, "chatcmpl-1");
    assert.strictEqual(raw.headers.get("x-request-id"), "req_1");

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].attributes["gen_ai.response.id"], "chatcmpl-1");
  });

  void it("records a structured output schema", async () => {
    const schema = {
      type: "object",
      properties: { city: { type: "string" } },
    };
    await createClient().chat.completions.create({
      ...CHAT_REQUEST,
      response_format: {
        type: "json_schema",
        json_schema: { name: "city", schema },
      },
    });

    const span = exporter.getFinishedSpans()[0];
    assert.deepStrictEqual(
      parseJsonAttr(span, "gen_ai.request.structured_output_schema"),
      schema,
    );
  });

  void it("accumulates a chat stream", async () => {
    const stream = await createClient().chat.completions.create({
      ...CHAT_REQUEST,
      stream: true,
      stream_options: { include_usage: true },
    });
    assert.strictEqual(exporter.getFinishedSpans().length, 0);

    const contents: string[] = [];
    for await (const event of stream) {
      contents.push(event.choices[0]?.delta?.content ?? "");
    }
    assert.strictEqual(contents.join(""), "Sunny in Paris.");

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    const span = spans[0];
    assert.strictEqual(span.name, "openai.chat");
    assert.strictEqual(span.attributes["llm.is_streaming"], true);
    assert.strictEqual(span.attributes["gen_ai.response.id"], "chatcmpl-2");
    assert.strictEqual(
      span.attributes["gen_ai.response.model"],
      RESPONSE_MODEL,
    );
    assert.strictEqual(span.attributes["gen_ai.usage.input_tokens"], 12);
    assert.strictEqual(span.attributes["gen_ai.usage.output_tokens"], 4);
    assert.strictEqual(span.attributes["llm.usage.total_tokens"], 16);
    assert.strictEqual(span.status.code, SpanStatusCode.OK);
    assert.deepStrictEqual(parseJsonAttr(span, "gen_ai.output.messages"), [
      {
        index: 0,
        message: { role: "assistant", content: "Sunny in Paris." },
        finish_reason: "stop",
      },
    ]);
  });

  void it("accumulates streamed tool calls", async () => {
    respond = () =>
      chatSseResponse([
        chunk([
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: "get_weather", arguments: "" },
                },
              ],
            },
          },
        ]),
        chunk([
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '{"city":' } }],
            },
          },
        ]),
        chunk([
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }],
            },
          },
        ]),
        chunk([{ index: 0, delta: {}, finish_reason: "tool_calls" }]),
      ]);

    const stream = await createClient().chat.completions.create({
      ...CHAT_REQUEST,
      stream: true,
    });
    for await (const _event of stream) {
      // drain
    }

    const span = exporter.getFinishedSpans()[0];
    assert.deepStrictEqual(parseJsonAttr(span, "gen_ai.output.messages"), [
      {
        index: 0,
        message: { role: "assistant", content: "", tool_calls: [TOOL_CALL] },
        finish_reason: "tool_calls",
      },
    ]);
  });

  void it("ends the span when a stream is abandoned early", async () => {
    const stream = await createClient().chat.completions.create({
      ...CHAT_REQUEST,
      stream: true,
    });
    for await (const _event of stream) {
      break;
    }

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].status.code, SpanStatusCode.OK);
    assert.strictEqual(spans[0].attributes["gen_ai.response.id"], "chatcmpl-2");
  });

  void it("traces a teed stream once", async () => {
    const stream = await createClient().chat.completions.create({
      ...CHAT_REQUEST,
      stream: true,
    });
    const [left, right] = stream.tee();
    for await (const _event of left) {
      // drain
    }
    for await (const _event of right) {
      // drain
    }

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(
      parseJsonAttr(spans[0], "gen_ai.output.messages")[0].message.content,
      "Sunny in Paris.",
    );
  });

  void it("creates a single span for chat.completions.parse", async () => {
    respond = () =>
      jsonResponse({
        ...CHAT_RESPONSE,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: '{"city":"Paris"}' },
            finish_reason: "stop",
          },
        ],
      });

    const parsed = await createClient().chat.completions.parse({
      model: MODEL,
      messages: [{ role: "user", content: "Which city?" }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "city",
          schema: { type: "object", properties: { city: { type: "string" } } },
        },
      },
    });
    assert.deepStrictEqual(parsed.choices[0].message.parsed, { city: "Paris" });

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].name, "openai.chat");
  });

  void it("records API errors on the span", async () => {
    respond = () =>
      jsonResponse(
        {
          error: {
            message: "bad request",
            type: "invalid_request_error",
            code: null,
          },
        },
        400,
      );

    await assert.rejects(
      () => createClient().chat.completions.create(CHAT_REQUEST),
      (error: any) => error.status === 400,
    );

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].status.code, SpanStatusCode.ERROR);
    assert.strictEqual(spans[0].attributes["error.type"], "BadRequestError");
    assert.strictEqual(spans[0].events[0]?.name, "exception");
  });

  void it("creates a span for completions.create", async () => {
    await createClient().completions.create({
      model: "gpt-3.5-turbo-instruct",
      prompt: "Capital of France?",
      max_tokens: 5,
    });

    const span = exporter.getFinishedSpans()[0];
    assert.strictEqual(span.name, "openai.completion");
    assert.strictEqual(span.attributes["gen_ai.request.max_tokens"], 5);
    assert.strictEqual(span.attributes["gen_ai.usage.input_tokens"], 7);
    assert.strictEqual(span.attributes["gen_ai.usage.output_tokens"], 2);
    assert.deepStrictEqual(parseJsonAttr(span, "gen_ai.input.messages"), [
      { role: "user", content: "Capital of France?" },
    ]);
    assert.deepStrictEqual(
      parseJsonAttr(span, "gen_ai.output.messages"),
      COMPLETION_RESPONSE.choices,
    );
  });

  void it("creates a span for embeddings.create", async () => {
    await createClient().embeddings.create({
      model: "text-embedding-3-small",
      input: ["hello", "world"],
    });

    const span = exporter.getFinishedSpans()[0];
    assert.strictEqual(span.name, "openai.embeddings");
    assert.strictEqual(
      span.attributes["gen_ai.request.model"],
      "text-embedding-3-small",
    );
    assert.strictEqual(span.attributes["gen_ai.usage.input_tokens"], 6);
    assert.strictEqual(span.attributes["llm.usage.total_tokens"], 6);
    assert.deepStrictEqual(parseJsonAttr(span, "gen_ai.input.messages"), [
      { content: "hello" },
      { content: "world" },
    ]);
    // Vectors are not recorded.
    assert.strictEqual(span.attributes["gen_ai.output.messages"], undefined);
  });

  void it("creates a span for decisions.create", async () => {
    const decision = await createClient().decisions.create(DECISION_REQUEST);
    assert.strictEqual(decision.answers.length, 1);

    const span = exporter.getFinishedSpans()[0];
    assert.strictEqual(span.name, "openai.decision");
    assert.strictEqual(span.attributes["lmnr.span.type"], "LLM");
    assert.strictEqual(span.attributes["gen_ai.request.model"], MODEL);
    assert.strictEqual(
      span.attributes["gen_ai.response.model"],
      RESPONSE_MODEL,
    );
    assert.strictEqual(span.attributes["gen_ai.usage.input_tokens"], 30);
    assert.strictEqual(span.attributes["gen_ai.usage.output_tokens"], 1);
    assert.deepStrictEqual(parseJsonAttr(span, "gen_ai.input.messages"), [
      { role: "user", content: DECISION_REQUEST.input },
    ]);
    assert.deepStrictEqual(
      parseJsonAttr(span, "gen_ai.request.structured_output_schema"),
      DECISION_REQUEST.questions,
    );
    assert.deepStrictEqual(parseJsonAttr(span, "gen_ai.output.messages"), [
      { role: "assistant", content: JSON.stringify(DECISION_RESPONSE.answers) },
    ]);
  });

  void it("creates a span for responses.create", async () => {
    const result = await createClient().responses.create(RESPONSES_REQUEST);
    assert.strictEqual(result.output_text, "Sunny.");

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    const span = spans[0];
    assert.strictEqual(span.name, "openai.response");
    assert.strictEqual(span.attributes["lmnr.span.type"], "LLM");
    assert.strictEqual(span.attributes["gen_ai.system"], "openai");
    assert.strictEqual(span.attributes["gen_ai.request.model"], MODEL);
    assert.strictEqual(
      span.attributes["gen_ai.response.model"],
      RESPONSE_MODEL,
    );
    assert.strictEqual(span.attributes["gen_ai.response.id"], "resp_1");
    assert.strictEqual(
      span.attributes["gen_ai.request.reasoning_effort"],
      "low",
    );
    assert.strictEqual(span.attributes["gen_ai.usage.input_tokens"], 10);
    assert.strictEqual(span.attributes["gen_ai.usage.output_tokens"], 5);
    assert.strictEqual(span.attributes["llm.usage.total_tokens"], 15);
    assert.strictEqual(
      span.attributes["gen_ai.usage.cache_read_input_tokens"],
      2,
    );
    assert.strictEqual(span.attributes["gen_ai.usage.reasoning_tokens"], 1);
    assert.strictEqual(span.status.code, SpanStatusCode.OK);
    assert.deepStrictEqual(parseJsonAttr(span, "gen_ai.input.messages"), [
      { role: "system", content: "Be brief." },
      { role: "user", content: "Weather in Paris?" },
    ]);
    assert.deepStrictEqual(parseJsonAttr(span, "gen_ai.output.messages"), [
      OUTPUT_MESSAGE,
    ]);
    assert.deepStrictEqual(
      parseJsonAttr(span, "gen_ai.tool.definitions"),
      RESPONSES_REQUEST.tools,
    );
  });

  void it("creates a span for a responses stream", async () => {
    const stream = await createClient().responses.create({
      ...RESPONSES_REQUEST,
      stream: true,
    });
    const deltas: string[] = [];
    for await (const event of stream) {
      if (event.type === "response.output_text.delta") deltas.push(event.delta);
    }
    assert.strictEqual(deltas.join(""), "Sunny.");

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    const span = spans[0];
    assert.strictEqual(span.name, "openai.response");
    assert.strictEqual(span.attributes["gen_ai.response.id"], "resp_1");
    assert.strictEqual(span.attributes["gen_ai.usage.output_tokens"], 5);
    assert.strictEqual(span.status.code, SpanStatusCode.OK);
    assert.deepStrictEqual(parseJsonAttr(span, "gen_ai.output.messages"), [
      OUTPUT_MESSAGE,
    ]);
  });

  void it("keeps partial output of an abandoned responses stream", async () => {
    const stream = await createClient().responses.create({
      ...RESPONSES_REQUEST,
      stream: true,
    });
    for await (const event of stream) {
      if (event.type === "response.output_text.delta") break;
    }

    const span = exporter.getFinishedSpans()[0];
    assert.deepStrictEqual(parseJsonAttr(span, "gen_ai.output.messages"), [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Sunny" }],
      },
    ]);
  });

  void it("marks a failed response as an error", async () => {
    respond = () =>
      jsonResponse(
        response({
          status: "failed",
          output: [],
          error: { code: "server_error", message: "boom" },
        }),
      );

    await createClient().responses.create(RESPONSES_REQUEST);

    const span = exporter.getFinishedSpans()[0];
    assert.strictEqual(span.status.code, SpanStatusCode.ERROR);
    assert.strictEqual(span.status.message, "boom");
    assert.strictEqual(span.events[0]?.name, "exception");
  });

  void it("records responses API errors", async () => {
    respond = () =>
      jsonResponse(
        { error: { message: "bad", type: "invalid_request_error" } },
        400,
      );

    await assert.rejects(() =>
      createClient().responses.create(RESPONSES_REQUEST),
    );

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].name, "openai.response");
    assert.strictEqual(spans[0].status.code, SpanStatusCode.ERROR);
    assert.strictEqual(spans[0].attributes["error.type"], "BadRequestError");
    assert.strictEqual(spans[0].attributes["gen_ai.request.model"], MODEL);
  });

  void it("spans a background response until retrieve sees it finish", async () => {
    respond = (url, method) => {
      if (method === "POST") {
        return jsonResponse(
          response({
            id: "resp_bg",
            status: "queued",
            output: [],
            usage: null,
          }),
        );
      }
      assert.ok(url.includes("/responses/resp_bg"));
      return jsonResponse(response({ id: "resp_bg" }));
    };

    const client = createClient();
    await client.responses.create({ ...RESPONSES_REQUEST, background: true });
    assert.strictEqual(exporter.getFinishedSpans().length, 0);

    await client.responses.retrieve("resp_bg");
    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    const span = spans[0];
    assert.strictEqual(span.attributes["gen_ai.response.id"], "resp_bg");
    // Request data comes from the original `create`.
    assert.strictEqual(span.attributes["gen_ai.request.model"], MODEL);
    assert.deepStrictEqual(parseJsonAttr(span, "gen_ai.input.messages"), [
      { role: "system", content: "Be brief." },
      { role: "user", content: "Weather in Paris?" },
    ]);
    assert.strictEqual(span.status.code, SpanStatusCode.OK);
  });

  void it("emits a failed span when a background response is cancelled", async () => {
    respond = (url, method) => {
      if (url.endsWith("/cancel")) {
        return jsonResponse(
          response({ id: "resp_bg2", status: "cancelled", output: [] }),
        );
      }
      assert.strictEqual(method, "POST");
      return jsonResponse(
        response({ id: "resp_bg2", status: "queued", output: [], usage: null }),
      );
    };

    const client = createClient();
    await client.responses.create({ ...RESPONSES_REQUEST, background: true });
    await client.responses.cancel("resp_bg2");

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].attributes["gen_ai.response.id"], "resp_bg2");
    assert.strictEqual(spans[0].status.code, SpanStatusCode.ERROR);
    assert.strictEqual(spans[0].status.message, "Response cancelled");

    // Cancelling an untracked response emits nothing.
    await client.responses.cancel("resp_bg2");
    assert.strictEqual(exporter.getFinishedSpans().length, 1);
  });

  void it("omits content when traceContent is off", async () => {
    reinitialize({ traceContent: false });
    const client = createClient();
    await client.chat.completions.create(CHAT_REQUEST);
    await client.responses.create(RESPONSES_REQUEST);

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 2);
    for (const span of spans) {
      assert.strictEqual(span.attributes["gen_ai.input.messages"], undefined);
      assert.strictEqual(span.attributes["gen_ai.output.messages"], undefined);
      assert.strictEqual(span.attributes["gen_ai.tool.definitions"], undefined);
      assert.strictEqual(span.attributes["gen_ai.request.model"], MODEL);
    }
    assert.strictEqual(spans[0].attributes["llm.usage.total_tokens"], 30);
  });

  void it("does not create spans when tracing is suppressed", async () => {
    await context.with(suppressTracing(context.active()), () =>
      createClient().chat.completions.create(CHAT_REQUEST),
    );
    assert.strictEqual(exporter.getFinishedSpans().length, 0);
  });

  void it("skips chat and responses inside an agents run", async () => {
    const client = createClient();
    const agentsContext = context
      .active()
      .setValue(DISABLE_OPENAI_RESPONSES_INSTRUMENTATION_CONTEXT_KEY, true);
    await context.with(agentsContext, async () => {
      await client.chat.completions.create(CHAT_REQUEST);
      await client.responses.create(RESPONSES_REQUEST);
      await client.embeddings.create({
        model: "text-embedding-3-small",
        input: "hello",
      });
    });

    const spans = exporter.getFinishedSpans();
    assert.deepStrictEqual(
      spans.map((span) => span.name),
      ["openai.embeddings"],
    );
  });

  void it("does not double-wrap on re-initialization", async () => {
    reinitialize();
    reinitialize();
    await createClient().chat.completions.create(CHAT_REQUEST);
    await createClient().responses.create(RESPONSES_REQUEST);
    assert.strictEqual(exporter.getFinishedSpans().length, 2);
  });

  void it("detects the vendor from the base URL", async () => {
    const client = new OpenAI({
      apiKey: "test-key",
      baseURL: "https://openrouter.ai/api/v1",
      fetch: fakeFetch,
      maxRetries: 0,
    });
    await client.chat.completions.create(CHAT_REQUEST);

    const span = exporter.getFinishedSpans()[0];
    assert.strictEqual(span.attributes["gen_ai.system"], "OpenRouter");
    assert.strictEqual(
      span.attributes["gen_ai.request.base_url"],
      "https://openrouter.ai/api/v1",
    );
  });

  void it("traces the openai v3 OpenAIApi", async () => {
    // openai v3 resolves to an axios response with the body in `data`.
    class OpenAIApi {
      basePath = "https://api.openai.com/v1";
      createChatCompletion(_params: any) {
        return Promise.resolve({ status: 200, data: CHAT_RESPONSE });
      }
      createCompletion(_params: any) {
        return Promise.resolve({ status: 200, data: COMPLETION_RESPONSE });
      }
    }
    reinitialize({ openai: { OpenAIApi } });

    const api = new OpenAIApi();
    const chat: any = await api.createChatCompletion(CHAT_REQUEST);
    assert.strictEqual(chat.data.id, "chatcmpl-1");
    await api.createCompletion({
      model: "text-davinci-003",
      prompt: "Capital of France?",
    });

    const spans = exporter.getFinishedSpans();
    assert.deepStrictEqual(
      spans.map((span) => span.name),
      ["openai.chat", "openai.completion"],
    );
    const [chatSpan, completionSpan] = spans;
    assert.strictEqual(chatSpan.attributes["gen_ai.request.model"], MODEL);
    assert.strictEqual(chatSpan.attributes["gen_ai.response.id"], "chatcmpl-1");
    assert.strictEqual(chatSpan.attributes["gen_ai.usage.input_tokens"], 20);
    assert.deepStrictEqual(
      parseJsonAttr(chatSpan, "gen_ai.output.messages"),
      CHAT_RESPONSE.choices,
    );
    assert.strictEqual(
      completionSpan.attributes["gen_ai.response.id"],
      "cmpl-1",
    );
  });

  void it("rejects passing both OpenAI and openAI", () => {
    _resetConfiguration();
    assert.throws(() =>
      initializeTracing({
        exporter,
        disableBatch: true,
        instrumentModules: { OpenAI, openAI: OpenAI },
      }),
    );
  });
});
