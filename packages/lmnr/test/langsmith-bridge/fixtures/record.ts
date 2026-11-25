/**
 * Re-records `js-sdk-payloads.json`: what the pinned langsmith hands to
 * `Client.createRun` / `updateRun` for each workload below. Providers and
 * LangSmith's API are mocked, so no keys are needed:
 *
 *   npx tsx test/langsmith-bridge/fixtures/record.ts
 *   pnpm exec biome check --write test/langsmith-bridge/fixtures   # from the repo root
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { awaitAllCallbacks } from "@langchain/core/callbacks/promises";
import { RunnableLambda } from "@langchain/core/runnables";
import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons";
import { tool } from "@langchain/core/tools";
import { LangChainTracer } from "@langchain/core/tracers/tracer_langchain";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import { Client } from "langsmith";
import { traceable } from "langsmith/traceable";
import { wrapOpenAI } from "langsmith/wrappers";
import OpenAI from "openai";
import { z } from "zod";

AsyncLocalStorageProviderSingleton.initializeGlobalInstance(
  new AsyncLocalStorage(),
);

type Record_ = { op: "create" | "update"; args: unknown };
const records: Record_[] = [];
const clone = (value: unknown) =>
  JSON.parse(
    JSON.stringify(value, (_k, v) =>
      typeof v === "bigint"
        ? String(v)
        : v instanceof Date
          ? v.toISOString()
          : v,
    ),
  );
const proto = Client.prototype as any;
const createRun = proto.createRun;
const updateRun = proto.updateRun;
proto.createRun = function (run: unknown, options: unknown) {
  records.push({ op: "create", args: clone({ run }) });
  return createRun.call(this, run, options);
};
proto.updateRun = function (runId: string, run: unknown, options: unknown) {
  records.push({ op: "update", args: clone({ runId, run }) });
  return updateRun.call(this, runId, run, options);
};

const client = new Client({
  apiUrl: "http://langsmith.test",
  apiKey: "ls-test",
  fetchImplementation: (async (url: any) =>
    Response.json(
      String(url).endsWith("/info")
        ? { batch_ingest_config: { use_multipart_endpoint: true } }
        : {},
    )) as typeof fetch,
});

const usage = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 };
const llmFetch = (async (_url: any, init?: any) => {
  const body = JSON.parse(String(init?.body ?? "{}"));
  const lastIsTool = body.messages?.at(-1)?.role === "tool";
  if (body.stream) {
    const base = {
      id: "chatcmpl-stream1",
      object: "chat.completion.chunk",
      created: 1700000000,
      model: body.model,
    };
    const chunks = [
      {
        ...base,
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "" },
            finish_reason: null,
          },
        ],
      },
      ...["Hel", "lo", " world"].map((content) => ({
        ...base,
        choices: [{ index: 0, delta: { content }, finish_reason: null }],
      })),
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { ...base, choices: [], usage },
    ];
    const sse = `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`;
    return new Response(sse, {
      headers: { "content-type": "text/event-stream" },
    });
  }
  const message =
    body.tools?.length && !lastIsTool
      ? {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_abc123",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"Paris"}' },
            },
          ],
        }
      : {
          role: "assistant",
          content: lastIsTool ? "It is sunny in Paris." : "Hello there!",
        };
  return Response.json({
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 1700000000,
    model: body.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: "tool_calls" in message ? "tool_calls" : "stop",
      },
    ],
    usage,
  });
}) as typeof fetch;

const weatherTool = {
  type: "function" as const,
  function: {
    name: "get_weather",
    description: "Get weather",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
};

const out: Record<string, Record_[]> = {};
const grab = async (name: string) => {
  await awaitAllCallbacks();
  await client.awaitPendingTraceBatches();
  out[name] = records.splice(0);
};

const main = async () => {
  const traced = { client, tracingEnabled: true };
  const llm = traceable(
    async (_messages: unknown) => ({
      role: "assistant",
      content: "Paris is sunny",
      usage_metadata: { input_tokens: 12, output_tokens: 4, total_tokens: 16 },
    }),
    {
      ...traced,
      name: "fake_llm",
      run_type: "llm",
      metadata: {
        ls_provider: "openai",
        ls_model_name: "gpt-4o-mini",
        ls_temperature: 0.2,
      },
    },
  );
  const chain = traceable(
    async (question: string) => {
      const reply = await llm([{ role: "user", content: question }]);
      return { answer: reply.content };
    },
    {
      ...traced,
      name: "qa_chain",
      run_type: "chain",
      tags: ["prod", "qa"],
      metadata: {
        session_id: "sess-123",
        thread_id: "thread-9",
        user_id: "u1",
      },
    },
  );
  await chain("Weather in Paris?");
  await grab("a_traceable_nested_llm");

  const openai = wrapOpenAI(
    new OpenAI({ apiKey: "sk-fake", fetch: llmFetch, maxRetries: 0 }),
    traced,
  );
  const agent = traceable(
    async () => {
      const messages: any[] = [
        { role: "user", content: "What's the weather in Paris?" },
      ];
      const first = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages,
        tools: [weatherTool],
      });
      const call = first.choices[0].message.tool_calls![0];
      messages.push(first.choices[0].message, {
        role: "tool",
        tool_call_id: call.id,
        content: "sunny, 22C",
      });
      const second = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages,
        tools: [weatherTool],
      });
      return second.choices[0].message.content;
    },
    { ...traced, name: "tool_agent" },
  );
  await agent();
  await grab("b_wrap_openai_tools");

  const stream = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "Say hello" }],
    stream: true,
    stream_options: { include_usage: true },
  });
  for await (const _chunk of stream) {
    // Drain.
  }
  await grab("c_wrap_openai_stream");

  const tracer = new LangChainTracer({ client });
  const getWeather = tool(async ({ city }) => `sunny in ${city}`, {
    name: "get_weather",
    description: "Get weather",
    schema: z.object({ city: z.string() }),
  });
  const model = new ChatOpenAI({
    model: "gpt-4o-mini",
    apiKey: "sk-fake",
    configuration: { baseURL: "http://mock-llm.test/v1", fetch: llmFetch },
  }).bindTools([getWeather]);
  const lambda = RunnableLambda.from(
    async (q: string) => (await model.invoke(q)).tool_calls,
  ).withConfig({
    runName: "lc_lambda",
    tags: ["lc"],
    metadata: { thread_id: "lc-thread" },
  });
  await lambda.invoke("Weather in Paris?", { callbacks: [tracer] });
  await grab("d1_langchain_chatopenai_tools");

  const State = Annotation.Root({
    n: Annotation<number>(),
    log: Annotation<string[]>({
      reducer: (a, b) => a.concat(b),
      default: () => [],
    }),
  });
  const graph = new StateGraph(State)
    .addNode("inc", async (s) => ({ n: s.n + 1, log: ["inc"] }))
    .addNode("dbl", async (s) => ({ n: s.n * 2, log: ["dbl"] }))
    .addEdge(START, "inc")
    .addEdge("inc", "dbl")
    .addEdge("dbl", END)
    .compile();
  await graph.invoke({ n: 1 }, { callbacks: [tracer] });
  await grab("d2_langgraph_two_nodes");

  const boom = traceable(
    async (x: string) => {
      throw new Error(`kaboom: ${x}`);
    },
    { ...traced, name: "boom" },
  );
  await boom("y").catch(() => undefined);
  await grab("e_traceable_throws");

  writeFileSync(
    join(__dirname, "js-sdk-payloads.json"),
    JSON.stringify(out, null, 2),
  );
  for (const [name, recorded] of Object.entries(out)) {
    console.log(
      name,
      recorded.map((r) => `${r.op}:${(r.args as any).run.name}`).join(" "),
    );
  }
};

void main();
