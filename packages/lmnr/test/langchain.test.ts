import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import { ChatAnthropic } from "@langchain/anthropic";
import * as CallbackManagerModule from "@langchain/core/callbacks/manager";
import { Document } from "@langchain/core/documents";
import * as ChatModelsModule from "@langchain/core/language_models/chat_models";
import * as LlmsModule from "@langchain/core/language_models/llms";
import { BaseRetriever } from "@langchain/core/retrievers";
import { RunnableLambda } from "@langchain/core/runnables";
import * as SingletonsModule from "@langchain/core/singletons";
import { tool } from "@langchain/core/tools";
import { FakeListChatModel, FakeLLM } from "@langchain/core/utils/testing";
import * as LanggraphModule from "@langchain/langgraph";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import { SpanStatusCode } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import OpenAI from "openai";
import { z } from "zod";

import { observe } from "../src/decorators";
import { Laminar } from "../src/laminar";
import {
  _resetConfiguration,
  initializeTracing,
} from "../src/opentelemetry-lib/configuration";

// @langchain/anthropic depends on its own copy of the Anthropic SDK, and
// that copy is the one that has to be instrumented
const Anthropic = createRequire(require.resolve("@langchain/anthropic"))(
  "@anthropic-ai/sdk",
);

const LANGCHAIN_MODULES = {
  callbackManagerModule: CallbackManagerModule,
  singletonsModule: SingletonsModule,
  chatModelsModule: ChatModelsModule,
  llmsModule: LlmsModule,
  langgraphModule: LanggraphModule,
};

const CHAT_COMPLETION = {
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 1,
  model: "gpt-4o-mini-2024-07-18",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "Hello from OpenAI" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 },
};

const CHAT_CHUNKS = [
  {
    id: "chatcmpl-2",
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-4o-mini-2024-07-18",
    choices: [{ index: 0, delta: { role: "assistant", content: "Hel" } }],
  },
  {
    id: "chatcmpl-2",
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-4o-mini-2024-07-18",
    choices: [{ index: 0, delta: { content: "lo" }, finish_reason: "stop" }],
  },
  {
    id: "chatcmpl-2",
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-4o-mini-2024-07-18",
    choices: [],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  },
];

const ANTHROPIC_MESSAGE = {
  id: "msg_01",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-4-5-20250929",
  content: [{ type: "text", text: "Hello from Anthropic" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 9, output_tokens: 3 },
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const chatSse = (chunks: unknown[]) =>
  new Response(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
      "data: [DONE]\n\n",
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

let openaiResponse: (body: any) => Response;
let openaiCalls: any[] = [];

const openaiFetch = async (_url: any, init: any) => {
  const body = JSON.parse(init.body);
  openaiCalls.push(body);
  return openaiResponse(body);
};

const anthropicFetch = async () => jsonResponse(ANTHROPIC_MESSAGE);

const chatOpenAI = (fields: Record<string, any> = {}) =>
  new ChatOpenAI({
    model: "gpt-4o-mini",
    apiKey: "test-key",
    maxRetries: 0,
    configuration: { fetch: openaiFetch },
    ...fields,
  });

// Reports itself as an OpenAI model, so its calls are handed off, but never
// calls the OpenAI SDK, so no provider span records them
class HandoffWithoutProvider extends FakeListChatModel {
  _llmType() {
    return "openai";
  }
}

class FailingHandoffWithoutProvider extends HandoffWithoutProvider {
  async _generate(): Promise<never> {
    throw new Error("provider down");
  }
}

class StubRetriever extends BaseRetriever {
  lc_namespace = ["test"];

  async _getRelevantDocuments(query: string): Promise<Document[]> {
    return [
      new Document({ pageContent: `About ${query}`, metadata: { id: 1 } }),
    ];
  }
}

const parentOf = (
  span: ReadableSpan,
  spans: ReadableSpan[],
): ReadableSpan | undefined => {
  const parentId =
    (span as any).parentSpanContext?.spanId ?? (span as any).parentSpanId;
  return spans.find((s) => s.spanContext().spanId === parentId);
};

const findSpan = (spans: ReadableSpan[], name: string): ReadableSpan => {
  const span = spans.find((s) => s.name === name);
  assert.ok(
    span,
    `no span named ${name} in ${spans.map((s) => s.name).join(", ")}`,
  );
  return span;
};

void describe("LangChain instrumentation", () => {
  const exporter = new InMemorySpanExporter();

  const reinitialize = ({
    traceContent = true,
    langchain = LANGCHAIN_MODULES as any,
    providers = { OpenAI, anthropic: Anthropic } as Record<string, any>,
  } = {}) => {
    _resetConfiguration();
    initializeTracing({
      exporter,
      disableBatch: true,
      traceContent,
      instrumentModules: { ...providers, langchain },
    });
  };

  void beforeEach(() => {
    Object.defineProperty(Laminar, "isInitialized", {
      value: true,
      writable: true,
    });
    openaiCalls = [];
    openaiResponse = (body) =>
      body.stream ? chatSse(CHAT_CHUNKS) : jsonResponse(CHAT_COMPLETION);
    reinitialize();
  });

  void afterEach(() => {
    exporter.reset();
  });

  void after(async () => {
    await exporter.shutdown();
  });

  void it("records a chain with its steps and LLM call", async () => {
    const model = new FakeListChatModel({ responses: ["Hi there"] });
    const chain = RunnableLambda.from((question: string) => [
      { role: "user", content: question },
    ]).pipe(model);

    const result = await chain.invoke("Hello?");
    assert.strictEqual(result.content, "Hi there");

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 3);
    const root = findSpan(spans, "RunnableSequence.workflow");
    const step = findSpan(spans, "execute_task RunnableLambda");
    const llm = findSpan(spans, "FakeListChatModel.chat");

    assert.strictEqual(parentOf(root, spans), undefined);
    assert.strictEqual(parentOf(step, spans), root);
    assert.strictEqual(parentOf(llm, spans), root);
    assert.strictEqual(root.spanContext().traceId, llm.spanContext().traceId);

    assert.strictEqual(
      root.attributes["gen_ai.operation.name"],
      "invoke_agent",
    );
    assert.strictEqual(
      root.attributes["gen_ai.agent.name"],
      "RunnableSequence",
    );
    assert.deepStrictEqual(
      JSON.parse(root.attributes["lmnr.span.input"] as string),
      { input: "Hello?" },
    );
    assert.strictEqual(
      step.attributes["gen_ai.operation.name"],
      "execute_task",
    );

    assert.strictEqual(llm.attributes["lmnr.span.type"], "LLM");
    assert.strictEqual(llm.attributes["gen_ai.operation.name"], "chat");
    assert.strictEqual(llm.attributes["gen_ai.system"], "langchain");
    const input = JSON.parse(llm.attributes["gen_ai.input.messages"] as string);
    assert.deepStrictEqual(input.at(-1).role, "user");
    assert.ok(JSON.stringify(input).includes("Hello?"));
    const output = JSON.parse(
      llm.attributes["gen_ai.output.messages"] as string,
    );
    assert.ok(JSON.stringify(output).includes("Hi there"));
  });

  void it("records a text completion LLM", async () => {
    const llm = new FakeLLM({ response: "Paris" });
    assert.strictEqual(await llm.invoke("Capital of France?"), "Paris");

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].name, "FakeLLM.completion");
    assert.strictEqual(spans[0].attributes["lmnr.span.type"], "LLM");
    assert.strictEqual(
      spans[0].attributes["gen_ai.operation.name"],
      "text_completion",
    );
  });

  void it("nests spans created inside a runnable under its run", async () => {
    const chain = RunnableLambda.from(async (x: string) =>
      observe({ name: "inner" }, async () => `${x}!`),
    ).pipe(RunnableLambda.from((x: string) => x.toUpperCase()));

    assert.strictEqual(await chain.invoke("hi"), "HI!");

    const spans = exporter.getFinishedSpans();
    const inner = findSpan(spans, "inner");
    const lambdas = spans.filter(
      (s) => s.name === "execute_task RunnableLambda",
    );
    assert.strictEqual(lambdas.length, 2);
    const parent = parentOf(inner, spans);
    assert.ok(parent && lambdas.includes(parent));
    assert.deepStrictEqual(inner.attributes["lmnr.span.path"], [
      "RunnableSequence.workflow",
      "execute_task RunnableLambda",
      "inner",
    ]);
  });

  void it("nests the chain under an enclosing observe span", async () => {
    const model = new FakeListChatModel({ responses: ["ok"] });
    await observe({ name: "outer" }, () => model.invoke("hi"));

    const spans = exporter.getFinishedSpans();
    const outer = findSpan(spans, "outer");
    const llm = findSpan(spans, "FakeListChatModel.chat");
    assert.strictEqual(parentOf(llm, spans), outer);
  });

  void it("records tools and retrievers", async () => {
    const weather = tool(async ({ city }) => `Sunny in ${city}`, {
      name: "get_weather",
      description: "Look up the weather",
      schema: z.object({ city: z.string() }),
    });
    const retriever = new StubRetriever();

    const chain = RunnableLambda.from(async (city: string) => {
      const docs = await retriever.invoke(city);
      return weather.invoke({ city: docs[0].pageContent });
    });
    assert.strictEqual(await chain.invoke("Paris"), "Sunny in About Paris");

    const spans = exporter.getFinishedSpans();
    const root = findSpan(spans, "RunnableLambda.workflow");
    const toolSpan = findSpan(spans, "execute_tool get_weather");
    const retrieverSpan = findSpan(spans, "vector_db_retrieve StubRetriever");

    assert.strictEqual(parentOf(toolSpan, spans), root);
    assert.strictEqual(parentOf(retrieverSpan, spans), root);
    assert.strictEqual(toolSpan.attributes["lmnr.span.type"], "TOOL");
    assert.strictEqual(toolSpan.attributes["gen_ai.tool.name"], "get_weather");
    assert.deepStrictEqual(
      JSON.parse(toolSpan.attributes["lmnr.span.input"] as string),
      { city: "About Paris" },
    );
    assert.ok(
      (toolSpan.attributes["lmnr.span.output"] as string).includes(
        "Sunny in About Paris",
      ),
    );
    assert.strictEqual(
      retrieverSpan.attributes["gen_ai.operation.name"],
      "vector_db_retrieve",
    );
    assert.ok(
      (retrieverSpan.attributes["lmnr.span.output"] as string).includes(
        "About Paris",
      ),
    );
  });

  void it("marks failed runs as errors", async () => {
    const chain = RunnableLambda.from((x: string) => x).pipe(
      RunnableLambda.from(() => {
        throw new TypeError("boom");
      }),
    );
    await assert.rejects(chain.invoke("x"), /boom/);

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 3);
    const root = findSpan(spans, "RunnableSequence.workflow");
    assert.strictEqual(root.status.code, SpanStatusCode.ERROR);
    const failed = spans.filter((s) => s.status.code === SpanStatusCode.ERROR);
    assert.strictEqual(failed.length, 2);
    const step = failed.find((s) => s !== root)!;
    assert.strictEqual(step.attributes["error.type"], "TypeError");
    assert.strictEqual(step.status.message, "boom");
  });

  void it("omits content when traceContent is off", async () => {
    reinitialize({ traceContent: false });
    const model = new FakeListChatModel({ responses: ["secret answer"] });
    await RunnableLambda.from((x: string) => x)
      .pipe(model)
      .invoke("secret question");

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 3);
    for (const span of spans) {
      const serialized = JSON.stringify(span.attributes);
      assert.ok(!serialized.includes("secret"), `${span.name} leaks content`);
    }
    const llm = findSpan(spans, "FakeListChatModel.chat");
    assert.strictEqual(llm.attributes["gen_ai.input.messages"], undefined);
    assert.strictEqual(llm.attributes["gen_ai.output.messages"], undefined);
  });

  void it("hands ChatOpenAI calls off to the OpenAI instrumentation", async () => {
    const result = await RunnableLambda.from((x: string) => x)
      .pipe(chatOpenAI())
      .invoke("Hi");
    assert.strictEqual(result.content, "Hello from OpenAI");
    assert.strictEqual(openaiCalls.length, 1);

    const spans = exporter.getFinishedSpans();
    const llmSpans = spans.filter(
      (s) => s.attributes["lmnr.span.type"] === "LLM",
    );
    assert.strictEqual(llmSpans.length, 1);
    const llm = llmSpans[0];
    assert.strictEqual(llm.name, "openai.chat");
    assert.strictEqual(
      parentOf(llm, spans),
      findSpan(spans, "RunnableSequence.workflow"),
    );
    assert.strictEqual(llm.attributes["gen_ai.usage.input_tokens"], 7);
    assert.ok(!spans.some((s) => s.name === "ChatOpenAI.chat"));
  });

  void it("hands streamed ChatOpenAI calls off", async () => {
    const chunks: string[] = [];
    for await (const chunk of await chatOpenAI().stream("Hi")) {
      chunks.push(chunk.content as string);
    }
    assert.strictEqual(chunks.join(""), "Hello");
    assert.strictEqual(openaiCalls[0].stream, true);

    const spans = exporter.getFinishedSpans();
    const llmSpans = spans.filter(
      (s) => s.attributes["lmnr.span.type"] === "LLM",
    );
    assert.strictEqual(llmSpans.length, 1);
    assert.strictEqual(llmSpans[0].name, "openai.chat");
  });

  void it("hands ChatAnthropic calls off to the Anthropic instrumentation", async () => {
    const model = new ChatAnthropic({
      model: "claude-sonnet-4-5",
      apiKey: "test-key",
      maxRetries: 0,
      clientOptions: { fetch: anthropicFetch },
    });
    const result = await model.invoke("Hi");
    assert.strictEqual(result.content, "Hello from Anthropic");

    const spans = exporter.getFinishedSpans();
    const llmSpans = spans.filter(
      (s) => s.attributes["lmnr.span.type"] === "LLM",
    );
    assert.strictEqual(llmSpans.length, 1);
    assert.strictEqual(llmSpans[0].name, "anthropic.chat");
    assert.strictEqual(llmSpans[0].attributes["gen_ai.usage.output_tokens"], 3);
  });

  void it("records a handed-off call that no provider span recorded", async () => {
    const model = new HandoffWithoutProvider({ responses: ["Fallback"] });
    await RunnableLambda.from((x: string) => x)
      .pipe(model)
      .invoke("Hi");

    const spans = exporter.getFinishedSpans();
    const llmSpans = spans.filter(
      (s) => s.attributes["lmnr.span.type"] === "LLM",
    );
    assert.strictEqual(llmSpans.length, 1);
    const llm = llmSpans[0];
    assert.strictEqual(llm.name, "HandoffWithoutProvider.chat");
    assert.strictEqual(
      parentOf(llm, spans),
      findSpan(spans, "RunnableSequence.workflow"),
    );
    assert.ok(
      (llm.attributes["gen_ai.output.messages"] as string).includes("Fallback"),
    );
    assert.ok(
      (llm.attributes["gen_ai.input.messages"] as string).includes("Hi"),
    );
  });

  void it("records a failed handed-off call that no provider span recorded", async () => {
    const model = new FailingHandoffWithoutProvider({ responses: ["x"] });
    await assert.rejects(model.invoke("Hi"), /provider down/);

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].name, "FailingHandoffWithoutProvider.chat");
    assert.strictEqual(spans[0].status.code, SpanStatusCode.ERROR);
  });

  void it("does not record a handed-off call twice when the provider fails", async () => {
    openaiResponse = () =>
      jsonResponse({ error: { message: "bad", type: "invalid" } }, 400);
    await assert.rejects(chatOpenAI().invoke("Hi"));

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].name, "openai.chat");
    assert.strictEqual(spans[0].status.code, SpanStatusCode.ERROR);
  });

  void it("records other models itself and suppresses provider spans", async () => {
    // Not a handoff type, though it calls the instrumented OpenAI client
    class CustomChat extends ChatOpenAI {
      _llmType() {
        return "custom";
      }
    }
    const model = new CustomChat({
      model: "gpt-4o-mini",
      apiKey: "test-key",
      maxRetries: 0,
      configuration: { fetch: openaiFetch },
    });
    await model.invoke("Hi");
    assert.strictEqual(openaiCalls.length, 1);

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].name, "CustomChat.chat");
    assert.strictEqual(spans[0].attributes["lmnr.span.type"], "LLM");
  });

  void it("records the LangGraph topology and thread id", async () => {
    const State = Annotation.Root({ value: Annotation<string> });
    const graph = new StateGraph(State)
      .addNode("first", (state) => ({ value: `${state.value}1` }))
      .addNode("second", async (state) => {
        await observe({ name: "in_node" }, async () => undefined);
        return { value: `${state.value}2` };
      })
      .addEdge(START, "first")
      .addConditionalEdges("first", () => "second", ["second", END])
      .addEdge("second", END)
      .compile();

    const result = await graph.invoke(
      { value: "" },
      { configurable: { thread_id: "thread-1" } },
    );
    assert.strictEqual(result.value, "12");

    const spans = exporter.getFinishedSpans();
    const roots = spans.filter((s) => parentOf(s, spans) === undefined);
    assert.strictEqual(roots.length, 1);
    const root = roots[0];
    assert.strictEqual(root.name, "LangGraph.workflow");
    assert.strictEqual(root.attributes["gen_ai.conversation.id"], "thread-1");

    const nodes = JSON.parse(
      root.attributes["lmnr.association.properties.langgraph.nodes"] as string,
    );
    assert.deepStrictEqual(nodes.map((n: any) => n.id).sort(), [
      "__end__",
      "__start__",
      "first",
      "second",
    ]);
    const edges = JSON.parse(
      root.attributes["lmnr.association.properties.langgraph.edges"] as string,
    );
    assert.ok(
      edges.some(
        (e: any) =>
          e.source === "__start__" && e.target === "first" && !e.conditional,
      ),
    );
    assert.ok(
      edges.some(
        (e: any) =>
          e.source === "first" && e.target === "second" && e.conditional,
      ),
    );

    // Only the graph's own run carries the topology
    const withTopology = spans.filter(
      (s) => s.attributes["lmnr.association.properties.langgraph.nodes"],
    );
    assert.deepStrictEqual(withTopology, [root]);

    const second = findSpan(spans, "execute_task second");
    assert.strictEqual(parentOf(second, spans), root);
    assert.strictEqual(parentOf(findSpan(spans, "in_node"), spans), second);
  });

  void it("nests provider calls made inside graph nodes", async () => {
    const model = chatOpenAI();
    const State = Annotation.Root({ value: Annotation<string> });
    const graph = new StateGraph(State)
      .addNode("call_model", async (state) => {
        const reply = await model.invoke(state.value);
        return { value: reply.content as string };
      })
      .addEdge(START, "call_model")
      .addEdge("call_model", END)
      .compile();

    await graph.invoke({ value: "Hi" });

    const spans = exporter.getFinishedSpans();
    const llm = findSpan(spans, "openai.chat");
    const node = findSpan(spans, "execute_task call_model");
    assert.strictEqual(parentOf(llm, spans), node);
    assert.deepStrictEqual(llm.attributes["lmnr.span.path"], [
      "LangGraph.workflow",
      "execute_task call_model",
      "openai.chat",
    ]);
  });

  void it("keeps concurrent graph runs apart", async () => {
    const State = Annotation.Root({ value: Annotation<string> });
    const build = (node: string) =>
      new StateGraph(State)
        .addNode(node, async (state) => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return { value: `${state.value}${node}` };
        })
        .addEdge(START, node)
        .addEdge(node, END)
        .compile();

    await Promise.all([
      build("alpha").invoke({ value: "" }),
      build("beta").invoke({ value: "" }),
    ]);

    const spans = exporter.getFinishedSpans();
    const roots = spans.filter((s) => s.name === "LangGraph.workflow");
    assert.strictEqual(roots.length, 2);
    for (const root of roots) {
      const nodeIds = JSON.parse(
        root.attributes[
          "lmnr.association.properties.langgraph.nodes"
        ] as string,
      ).map((n: any) => n.id);
      const task = spans.find(
        (s) =>
          parentOf(s, spans) === root && s.name !== "execute_task __start__",
      )!;
      const taskNode = task.name.replace("execute_task ", "");
      assert.ok(nodeIds.includes(taskNode));
      assert.strictEqual(
        root.spanContext().traceId,
        task.spanContext().traceId,
      );
    }
    assert.notStrictEqual(
      roots[0].spanContext().traceId,
      roots[1].spanContext().traceId,
    );
  });

  void it("does not double-wrap on repeated initialization", async () => {
    reinitialize();
    reinitialize();
    await RunnableLambda.from((x: string) => x)
      .pipe(chatOpenAI())
      .invoke("Hi");

    const spans = exporter.getFinishedSpans();
    assert.deepStrictEqual(spans.map((s) => s.name).sort(), [
      "RunnableSequence.workflow",
      "execute_task RunnableLambda",
      "openai.chat",
    ]);
  });

  void it("only patches the modules it is given", async () => {
    // Fresh shapes, so patch state from earlier tests does not interfere
    class CallbackManager {
      static _configureSync() {
        return undefined;
      }
    }
    const original = CallbackManager._configureSync;
    _resetConfiguration();
    initializeTracing({
      exporter,
      disableBatch: true,
      instrumentModules: {
        langchain: { callbackManagerModule: { CallbackManager } },
      },
    });
    assert.notStrictEqual(CallbackManager._configureSync, original);
    const manager: any = CallbackManager._configureSync();
    assert.ok(manager === undefined || manager.handlers);
  });
});
