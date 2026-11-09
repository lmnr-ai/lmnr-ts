/**
 * Langfuse → Laminar bridge (`Laminar.initialize({ bridges: ["langfuse"] })`)
 * against the real Langfuse SDKs: `@langfuse/tracing`, `@langfuse/otel`'s
 * `LangfuseSpanProcessor` (with an in-memory exporter), `@langfuse/openai`
 * and `@langfuse/langchain`, with LLM HTTP mocked through a custom `fetch`.
 *
 * Runs against @langfuse/* 6.x by default; CI's `langfuse-bridge-compat` job
 * reruns this file against 5.x and 4.x, so only use APIs all three have.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { ChatOpenAI } from "@langchain/openai";
import { propagateAttributes } from "@langfuse/core";
import { CallbackHandler } from "@langfuse/langchain";
import { observeOpenAI } from "@langfuse/openai";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import {
  getLangfuseTracerProvider,
  observe as lfObserve,
  setLangfuseTracerProvider,
  startActiveObservation,
  startObservation,
} from "@langfuse/tracing";
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import OpenAI from "openai";

import { Laminar, LaminarSpanProcessor, observe } from "../src/index";
import { LLM_INSTRUMENTATIONS } from "../src/opentelemetry-lib/bridges";
import {
  costAttributes,
  translateLangfuseSpan,
  usageAttributes,
} from "../src/opentelemetry-lib/bridges/langfuse/translate";
import { _configuration } from "../src/opentelemetry-lib/configuration";
import { getPackageVersion } from "../src/opentelemetry-lib/instrumentation/shared/package-version";
import { LaminarContextManager } from "../src/opentelemetry-lib/tracing/context";
import { initializeLaminarInstrumentations } from "../src/opentelemetry-lib/tracing/instrumentations";

const noop = async () => undefined;

const LF_MAJOR = parseInt(
  (getPackageVersion("@langfuse/tracing") ?? "0").split(".")[0],
  10,
);

// ---------------------------------------------------------------------------
// Mock LLM HTTP
// ---------------------------------------------------------------------------

const weatherTool = {
  type: "function" as const,
  function: {
    name: "get_weather",
    description: "Get the weather",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
};

const chatCompletion = (withTools: boolean) => ({
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 1,
  model: "gpt-4o-2024-08-06",
  choices: [
    {
      index: 0,
      finish_reason: withTools ? "tool_calls" : "stop",
      message: withTools
        ? {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "get_weather",
                  arguments: '{"city":"Paris"}',
                },
              },
            ],
          }
        : { role: "assistant", content: "Hello!" },
    },
  ],
  usage: {
    prompt_tokens: 11,
    completion_tokens: 7,
    total_tokens: 18,
    prompt_tokens_details: { cached_tokens: 2 },
    completion_tokens_details: { reasoning_tokens: 3 },
  },
});

const mockFetch = async (_url: any, init?: any): Promise<Response> => {
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  return new Response(JSON.stringify(chatCompletion(Boolean(body.tools))), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

const openaiClient = () =>
  new OpenAI({ apiKey: "sk-test", fetch: mockFetch as any, maxRetries: 0 });

// ---------------------------------------------------------------------------
// Pipelines
// ---------------------------------------------------------------------------

const langfuseExporter = new InMemorySpanExporter();
const laminarExporter = new InMemorySpanExporter();

const langfuseProcessor = new LangfuseSpanProcessor({
  publicKey: "pk-lf-test",
  secretKey: "sk-lf-test",
  baseUrl: "http://127.0.0.1:9",
  exporter: langfuseExporter as any,
  exportMode: "immediate",
} as any);

const provider = new TracerProvider({
  spanProcessors: [langfuseProcessor as any],
});

const initLaminar = (props: Record<string, unknown> = {}) =>
  Laminar.initialize({
    projectApiKey: "test",
    spanProcessor: new LaminarSpanProcessor({
      exporter: laminarExporter,
      disableBatch: true,
    }),
    bridges: ["langfuse"],
    ...props,
  });

const flush = async () => {
  await langfuseProcessor.forceFlush();
  if (Laminar.initialized()) await Laminar.flush();
};

const reset = () => {
  langfuseExporter.reset();
  laminarExporter.reset();
};

const lfSpans = () => langfuseExporter.getFinishedSpans();
const lmSpans = () => laminarExporter.getFinishedSpans();
const byName = (spans: ReadableSpan[], name: string): ReadableSpan => {
  const span = spans.find((s) => s.name === name);
  assert.ok(span, `no span named ${name} in ${spans.map((s) => s.name)}`);
  return span;
};
const parentId = (span: ReadableSpan): string | undefined =>
  (span as any).parentSpanContext?.spanId ?? (span as any).parentSpanId;

/**
 * Everything Langfuse's exporter can see on a span, with ids replaced by
 * their order of appearance and wall-clock values dropped.
 */
const normalize = (spans: ReadableSpan[]) => {
  const ids = new Map<string, number>();
  const id = (v: string | undefined) => {
    if (v === undefined) return undefined;
    if (!ids.has(v)) ids.set(v, ids.size);
    return ids.get(v);
  };
  const stripTimes = (attrs: Record<string, unknown> = {}) =>
    Object.fromEntries(
      Object.entries(attrs).map(([k, v]) => [
        k,
        k.includes("time") ? "<time>" : v,
      ]),
    );
  return spans.map((s) => ({
    ownKeys: Object.keys(s).sort(),
    name: s.name,
    kind: s.kind,
    trace: id(s.spanContext().traceId),
    span: id(s.spanContext().spanId),
    parent: id(parentId(s)),
    scope: (s as any).instrumentationScope,
    resource: s.resource.attributes,
    status: s.status,
    attributes: stripTimes(s.attributes as Record<string, unknown>),
    events: s.events.map((e) => ({
      name: e.name,
      attributes: stripTimes(e.attributes as Record<string, unknown>),
    })),
    links: s.links,
  }));
};

// A Langfuse-only workload covering the span shapes the bridge sees.
const langfuseWorkload = async () => {
  await propagateAttributes(
    {
      userId: "u1",
      sessionId: "s1",
      tags: ["a", "b"],
      metadata: { tenant: "acme" },
    },
    async () => {
      await startActiveObservation("agent-root", async (root) => {
        root.update({ input: { q: "hi" }, metadata: { obs: "level" } });
        const gen = root.startObservation(
          "llm-call",
          {
            model: "gpt-4o",
            input: [{ role: "user", content: "hi" }],
          },
          { asType: "generation" },
        );
        gen
          .update({
            output: { role: "assistant", content: "yo" },
            usageDetails: { input: 10, output: 5, total: 15 },
            costDetails: { input: 0.001, output: 0.002, total: 0.003 },
          })
          .end();
        const tool = root.startObservation(
          "get_weather",
          { input: { city: "Paris" } },
          { asType: "tool" },
        );
        tool.update({ output: { temp: 20 } }).end();
        const client = observeOpenAI(openaiClient(), {
          generationName: "oai-plain",
        });
        await client.chat.completions.create({
          model: "gpt-4o",
          messages: [{ role: "user", content: "hi" }],
        });
        root.update({ output: "done" });
      });
    },
  );
};

void describe("Langfuse bridge", () => {
  before(() => {
    // What NodeTracerProvider.register() did before the SDK moved to OTel 3.
    context.setGlobalContextManager(
      new AsyncLocalStorageContextManager().enable(),
    );
    trace.setGlobalTracerProvider(provider);
  });

  beforeEach(async () => {
    if (Laminar.initialized()) await Laminar.shutdown();
    setLangfuseTracerProvider(null);
    reset();
  });

  after(async () => {
    if (Laminar.initialized()) await Laminar.shutdown();
    await provider.shutdown();
    trace.disable();
    context.disable();
  });

  void it("leaves Langfuse's export identical", async () => {
    await langfuseWorkload();
    await flush();
    const without = normalize(lfSpans());
    assert.ok(without.length >= 4);
    reset();

    initLaminar();
    await langfuseWorkload();
    await flush();
    assert.deepStrictEqual(normalize(lfSpans()), without);
    for (const span of lfSpans()) {
      assert.deepStrictEqual(
        Object.keys(span.attributes).filter((k) => k.startsWith("lmnr.")),
        [],
      );
    }
    // And Laminar received the same spans.
    assert.deepStrictEqual(
      lmSpans()
        .map((s) => s.name)
        .sort(),
      lfSpans()
        .map((s) => s.name)
        .sort(),
    );
  });

  void it("keeps the same span ids, parents and names in Laminar", async () => {
    initLaminar();
    await langfuseWorkload();
    await flush();
    const lf = new Map(lfSpans().map((s) => [s.spanContext().spanId, s]));
    for (const span of lmSpans()) {
      const twin = lf.get(span.spanContext().spanId);
      assert.ok(twin, `${span.name} not exported to Langfuse`);
      assert.strictEqual(span.name, twin.name);
      assert.strictEqual(parentId(span), parentId(twin));
      assert.strictEqual(
        span.spanContext().traceId,
        twin.spanContext().traceId,
      );
    }
    const gen = byName(lmSpans(), "llm-call");
    assert.deepStrictEqual(gen.attributes["lmnr.span.path"], [
      "agent-root",
      "llm-call",
    ]);
    assert.strictEqual(
      (gen.attributes["lmnr.span.ids_path"] as string[]).length,
      2,
    );
  });

  void it("translates generation, tool and span observations", async () => {
    initLaminar();
    await langfuseWorkload();
    await flush();

    const gen = byName(lmSpans(), "llm-call").attributes;
    assert.strictEqual(gen["lmnr.span.type"], "LLM");
    assert.strictEqual(gen["gen_ai.request.model"], "gpt-4o");
    assert.strictEqual(gen["gen_ai.response.model"], "gpt-4o");
    assert.strictEqual(gen["gen_ai.usage.input_tokens"], 10);
    assert.strictEqual(gen["gen_ai.usage.output_tokens"], 5);
    assert.strictEqual(gen["llm.usage.total_tokens"], 15);
    assert.strictEqual(gen["gen_ai.usage.input_cost"], 0.001);
    assert.strictEqual(gen["gen_ai.usage.output_cost"], 0.002);
    assert.strictEqual(gen["gen_ai.usage.cost"], 0.003);
    assert.deepStrictEqual(JSON.parse(gen["gen_ai.input.messages"] as string), [
      { role: "user", content: "hi" },
    ]);
    assert.deepStrictEqual(
      JSON.parse(gen["gen_ai.output.messages"] as string),
      [{ role: "assistant", content: "yo" }],
    );
    assert.strictEqual(gen["lmnr.span.bridge.name"], "langfuse");
    // The span's instrumentation scope version (Langfuse's own SDK version
    // constant, which lags the package version in some 4.x releases).
    const scopeVersion = (byName(lmSpans(), "llm-call") as any)
      .instrumentationScope.version;
    assert.ok(scopeVersion);
    assert.strictEqual(gen["lmnr.span.bridge.version"], scopeVersion);
    // Raw Langfuse attributes stay.
    assert.strictEqual(gen["langfuse.observation.type"], "generation");

    const tool = byName(lmSpans(), "get_weather").attributes;
    assert.strictEqual(tool["lmnr.span.type"], "TOOL");
    assert.deepStrictEqual(JSON.parse(tool["lmnr.span.input"] as string), {
      city: "Paris",
    });
    assert.deepStrictEqual(JSON.parse(tool["lmnr.span.output"] as string), {
      temp: 20,
    });

    const root = byName(lmSpans(), "agent-root").attributes;
    assert.strictEqual(root["lmnr.span.type"], "DEFAULT");
    assert.deepStrictEqual(JSON.parse(root["lmnr.span.input"] as string), {
      q: "hi",
    });
    assert.strictEqual(root["lmnr.span.output"], "done");
  });

  void it("promotes trace-level user, session, tags and metadata only", async () => {
    initLaminar();
    await langfuseWorkload();
    await flush();
    for (const span of lmSpans()) {
      const a = span.attributes;
      assert.strictEqual(a["lmnr.association.properties.user_id"], "u1");
      assert.strictEqual(a["lmnr.association.properties.session_id"], "s1");
      assert.deepStrictEqual(a["lmnr.association.properties.tags"], ["a", "b"]);
      // Raw in 4.x / 5.x, JSON-encoded in 6.x: decoded either way.
      assert.strictEqual(
        a["lmnr.association.properties.metadata.tenant"],
        "acme",
      );
    }
    const root = byName(lmSpans(), "agent-root").attributes;
    assert.strictEqual(
      root["lmnr.association.properties.metadata.obs"],
      undefined,
    );
  });

  void it("translates observeOpenAI calls with and without tools", async () => {
    initLaminar();
    const client = observeOpenAI(openaiClient(), {
      generationName: "oai-tools",
    });
    await client.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "weather in Paris?" }],
      tools: [weatherTool],
    });
    await startActiveObservation("parent", async () => {
      await observeOpenAI(openaiClient(), {
        generationName: "oai-plain",
      }).chat.completions.create({
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
      });
    });
    await flush();

    const withTools = byName(lmSpans(), "oai-tools").attributes;
    assert.strictEqual(withTools["lmnr.span.type"], "LLM");
    assert.deepStrictEqual(
      JSON.parse(withTools["gen_ai.input.messages"] as string),
      [{ role: "user", content: "weather in Paris?" }],
    );
    assert.deepStrictEqual(
      JSON.parse(withTools["gen_ai.tool.definitions"] as string),
      [weatherTool],
    );
    const out = JSON.parse(withTools["gen_ai.output.messages"] as string);
    assert.strictEqual(out.length, 1);
    assert.deepStrictEqual(out[0].message.tool_calls[0].function, {
      name: "get_weather",
      arguments: '{"city":"Paris"}',
    });
    // Langfuse reports input = 11 - 2 cached; Laminar wants the total.
    assert.strictEqual(withTools["gen_ai.usage.input_tokens"], 11);
    assert.strictEqual(withTools["gen_ai.usage.output_tokens"], 7);
    assert.strictEqual(withTools["llm.usage.total_tokens"], 18);
    assert.strictEqual(withTools["gen_ai.usage.cache_read.input_tokens"], 2);
    assert.strictEqual(withTools["gen_ai.usage.reasoning.output_tokens"], 3);
    assert.ok(String(withTools["gen_ai.request.model"]).startsWith("gpt-4o"));

    const plain = byName(lmSpans(), "oai-plain");
    assert.deepStrictEqual(
      JSON.parse(plain.attributes["gen_ai.output.messages"] as string),
      [{ role: "assistant", content: "Hello!" }],
    );
    assert.strictEqual(plain.attributes["gen_ai.tool.definitions"], undefined);
    assert.deepStrictEqual(plain.attributes["lmnr.span.path"], [
      "parent",
      "oai-plain",
    ]);
  });

  void it("translates @langfuse/langchain generations", async () => {
    initLaminar();
    const handler = new CallbackHandler();
    const model = new ChatOpenAI({
      model: "gpt-4o",
      apiKey: "sk-test",
      maxRetries: 0,
      configuration: { fetch: mockFetch as any },
    }).bindTools([weatherTool]);
    await model.invoke("weather in Paris?", { callbacks: [handler] });
    await flush();

    const llm = lmSpans().find((s) => s.attributes["lmnr.span.type"] === "LLM");
    assert.ok(llm, `no LLM span in ${lmSpans().map((s) => s.name)}`);
    const a = llm.attributes;
    const input = JSON.parse(a["gen_ai.input.messages"] as string);
    assert.strictEqual(input.at(-1).content, "weather in Paris?");
    // @langfuse/langchain 4.x does not record tool definitions at all.
    if (LF_MAJOR >= 5) {
      const tools = JSON.parse(a["gen_ai.tool.definitions"] as string);
      assert.ok(
        JSON.stringify(tools).includes("get_weather"),
        `tools: ${JSON.stringify(tools)}`,
      );
    }
    assert.strictEqual(a["gen_ai.usage.input_tokens"], 11);
    assert.strictEqual(a["gen_ai.usage.output_tokens"], 7);
    assert.strictEqual(a["gen_ai.usage.cache_read.input_tokens"], 2);
    assert.strictEqual(a["gen_ai.usage.reasoning.output_tokens"], 3);
  });

  void it("synthesizes an exception event for failed observations", async () => {
    initLaminar();
    await assert.rejects(
      startActiveObservation("fails-active", async () => {
        throw new Error("boom");
      }),
    );
    const failing = lfObserve(
      async () => {
        throw new Error("boom2");
      },
      { name: "fails-observe" },
    );
    await assert.rejects(failing());
    const warn = startObservation("warns");
    warn.update({ level: "WARNING", statusMessage: "careful" }).end();
    await flush();

    const active = byName(lmSpans(), "fails-active");
    const activeEvent = active.events.find((e) => e.name === "exception");
    assert.ok(activeEvent);
    assert.strictEqual(activeEvent.attributes?.["exception.message"], "boom");

    const observed = byName(lmSpans(), "fails-observe");
    const observedEvent = observed.events.find((e) => e.name === "exception");
    assert.ok(observedEvent);
    assert.strictEqual(
      observedEvent.attributes?.["exception.message"],
      "boom2",
    );

    const warned = byName(lmSpans(), "warns");
    assert.deepStrictEqual(warned.events, []);
    assert.strictEqual(
      warned.attributes["langfuse.observation.level"],
      "WARNING",
    );

    // Langfuse never sees the synthesized events.
    for (const span of lfSpans()) {
      assert.ok(!span.events.some((e) => e.name === "exception"));
    }
  });

  void it("nests Langfuse spans under Laminar spans", async () => {
    initLaminar();
    await observe({ name: "lmnr-outer" }, async () => {
      await startActiveObservation("lf-inner", async (span) => {
        span
          .startObservation(
            "lf-gen",
            { model: "gpt-4o" },
            { asType: "generation" },
          )
          .end();
      });
    });
    await flush();
    const outer = byName(lmSpans(), "lmnr-outer");
    const inner = byName(lmSpans(), "lf-inner");
    const gen = byName(lmSpans(), "lf-gen");
    assert.strictEqual(parentId(inner), outer.spanContext().spanId);
    assert.strictEqual(parentId(gen), inner.spanContext().spanId);
    assert.deepStrictEqual(gen.attributes["lmnr.span.path"], [
      "lmnr-outer",
      "lf-inner",
      "lf-gen",
    ]);
    // Laminar's own span never reaches Langfuse.
    assert.ok(!lfSpans().some((s) => s.name === "lmnr-outer"));
  });

  void it("nests Laminar spans under Langfuse spans", async () => {
    initLaminar();
    await startActiveObservation("lf-outer", async () => {
      await observe({ name: "lmnr-mid" }, async () => {
        await startActiveObservation("lf-leaf", noop);
      });
    });
    await flush();
    const outer = byName(lmSpans(), "lf-outer");
    const mid = byName(lmSpans(), "lmnr-mid");
    const leaf = byName(lmSpans(), "lf-leaf");
    assert.strictEqual(parentId(mid), outer.spanContext().spanId);
    assert.strictEqual(parentId(leaf), mid.spanContext().spanId);
    assert.deepStrictEqual(leaf.attributes["lmnr.span.path"], [
      "lf-outer",
      "lmnr-mid",
      "lf-leaf",
    ]);
    assert.strictEqual(
      (leaf.attributes["lmnr.span.ids_path"] as string[]).length,
      3,
    );
  });

  void it("turns on inheritGlobalContext and resets it on shutdown", async () => {
    initLaminar();
    assert.strictEqual(
      (LaminarContextManager as any)._inheritGlobalContext,
      true,
    );
    await Laminar.shutdown();
    assert.strictEqual(
      (LaminarContextManager as any)._inheritGlobalContext,
      false,
    );
  });

  void it("leaves inheritGlobalContext off for an unknown bridge", async () => {
    initLaminar({ bridges: ["langfsue"] });
    assert.strictEqual(
      (LaminarContextManager as any)._inheritGlobalContext,
      false,
    );
    await Laminar.shutdown();
  });

  void it("uninstalls on shutdown and reinstalls on initialize", async () => {
    const before = getLangfuseTracerProvider();
    initLaminar();
    assert.notStrictEqual(getLangfuseTracerProvider(), before);
    await Laminar.shutdown();
    assert.strictEqual(getLangfuseTracerProvider(), before);

    await startActiveObservation("after-shutdown", noop);
    await flush();
    assert.strictEqual(lfSpans().length, 1);
    assert.strictEqual(lmSpans().length, 0);

    initLaminar();
    await startActiveObservation("after-reinit", noop);
    await flush();
    assert.deepStrictEqual(
      lmSpans().map((s) => s.name),
      ["after-reinit"],
    );
  });

  void it("restores the app's own Langfuse provider on shutdown", async () => {
    const isolated = new TracerProvider({
      spanProcessors: [langfuseProcessor as any],
    });
    setLangfuseTracerProvider(isolated);
    initLaminar();
    await startActiveObservation("isolated", noop);
    await flush();
    assert.deepStrictEqual(
      lfSpans().map((s) => s.name),
      ["isolated"],
    );
    assert.deepStrictEqual(
      lmSpans().map((s) => s.name),
      ["isolated"],
    );
    await Laminar.shutdown();
    assert.strictEqual(getLangfuseTracerProvider(), isolated);
  });

  void it("keeps bridging when the app sets a Langfuse provider later", async () => {
    initLaminar();
    const isolatedExporter = new InMemorySpanExporter();
    const isolated = new TracerProvider({
      spanProcessors: [new SimpleSpanProcessor({ exporter: isolatedExporter })],
    });
    setLangfuseTracerProvider(isolated);
    await startActiveObservation("late-provider", noop);
    await flush();
    // The span came from the app's new provider, not the global one...
    assert.strictEqual(lfSpans().length, 0);
    const own = byName(isolatedExporter.getFinishedSpans(), "late-provider");
    // ...and still reached Laminar.
    const lm = byName(lmSpans(), "late-provider");
    assert.strictEqual(lm.spanContext().spanId, own.spanContext().spanId);
    await Laminar.shutdown();
    assert.strictEqual(getLangfuseTracerProvider(), isolated);
  });

  void it("initialize() disables the conflicting instrumentations only without instrumentModules", async () => {
    initLaminar();
    assert.deepStrictEqual(
      _configuration?.disabledInstrumentations,
      LLM_INSTRUMENTATIONS,
    );
    await Laminar.shutdown();
    initLaminar({ instrumentModules: {} });
    assert.strictEqual(_configuration?.disabledInstrumentations, undefined);
  });

  void it("skips Laminar's LLM auto-instrumentations unless instrumentModules is passed", () => {
    const names = (instrumentations: { instrumentationName: string }[]) =>
      instrumentations.map((i) => i.instrumentationName);

    const all = names(
      initializeLaminarInstrumentations({ exportSpans: false }),
    );
    const bridged = names(
      initializeLaminarInstrumentations({
        exportSpans: false,
        disabledInstrumentations: LLM_INSTRUMENTATIONS,
      }),
    );
    for (const dropped of [
      "@lmnr/openai-instrumentation",
      "@lmnr/anthropic-instrumentation",
      "@lmnr/langchain-instrumentation",
    ]) {
      assert.ok(all.includes(dropped), dropped);
      assert.ok(!bridged.includes(dropped), dropped);
    }
    // Claude Agent SDK and non-LLM instrumentations stay.
    for (const kept of all.filter((n) =>
      /claude|kernel|opencode|pinecone|chroma|qdrant/i.test(n),
    )) {
      assert.ok(bridged.includes(kept), kept);
    }
    assert.ok(bridged.some((n) => /claude/i.test(n)));

    // Explicit instrumentModules are honored verbatim.
    const explicit = names(
      initializeLaminarInstrumentations({
        exportSpans: false,
        instrumentModules: { OpenAI: OpenAI as any },
        disabledInstrumentations: LLM_INSTRUMENTATIONS,
      }),
    );
    assert.deepStrictEqual(explicit, ["@lmnr/openai-instrumentation"]);
  });

  void it("is skipped when the bridge name is unknown", () => {
    initLaminar({ bridges: ["nope"] });
    assert.strictEqual(Laminar.initialized(), true);
  });
});

void describe("Langfuse bridge translation", () => {
  void it("adds input_* / output_* details back into the token totals", () => {
    assert.deepStrictEqual(
      usageAttributes(
        JSON.stringify({
          input: 7,
          output: 3,
          total: 15,
          input_cache_read: 2,
          input_cache_creation: 1,
          output_reasoning: 2,
        }),
      ),
      {
        "gen_ai.usage.input_tokens": 10,
        "gen_ai.usage.output_tokens": 5,
        "llm.usage.total_tokens": 15,
        "gen_ai.usage.cache_read.input_tokens": 2,
        "gen_ai.usage.cache_write.input_tokens": 1,
        "gen_ai.usage.reasoning.output_tokens": 2,
      },
    );
  });

  void it("takes OpenAI-style usage shapes as totals", () => {
    assert.deepStrictEqual(
      usageAttributes({
        prompt_tokens: 11,
        completion_tokens: 7,
        prompt_tokens_details: { cached_tokens: 2 },
        completion_tokens_details: { reasoning_tokens: 1 },
      }),
      {
        "gen_ai.usage.input_tokens": 11,
        "gen_ai.usage.output_tokens": 7,
        "llm.usage.total_tokens": 18,
        "gen_ai.usage.cache_read.input_tokens": 2,
        "gen_ai.usage.reasoning.output_tokens": 1,
      },
    );
    assert.deepStrictEqual(
      usageAttributes({ input_tokens: 4, output_tokens: 1 }),
      {
        "gen_ai.usage.input_tokens": 4,
        "gen_ai.usage.output_tokens": 1,
        "llm.usage.total_tokens": 5,
      },
    );
  });

  void it("sets cost only when cost_details is present", () => {
    assert.deepStrictEqual(costAttributes(undefined), {});
    assert.deepStrictEqual(costAttributes('{"input":1,"output":2}'), {
      "gen_ai.usage.input_cost": 1,
      "gen_ai.usage.output_cost": 2,
      "gen_ai.usage.cost": 3,
    });
  });

  void it("decodes JSON metadata values and ignores observation metadata", () => {
    const { attributes } = translateLangfuseSpan(
      {
        "langfuse.trace.metadata.a": '"x"',
        "langfuse.trace.metadata.b": "raw",
        "langfuse.trace.metadata.c": '{"nested":1}',
        "langfuse.observation.metadata.d": "obs",
      },
      undefined,
      "6.1.1",
    );
    assert.strictEqual(
      attributes["lmnr.association.properties.metadata.a"],
      "x",
    );
    assert.strictEqual(
      attributes["lmnr.association.properties.metadata.b"],
      "raw",
    );
    assert.strictEqual(
      attributes["lmnr.association.properties.metadata.c"],
      '{"nested":1}',
    );
    assert.strictEqual(
      attributes["lmnr.association.properties.metadata.d"],
      undefined,
    );
  });

  void it("keeps raw metadata strings before 6.x", () => {
    for (const version of ["4.6.1", "5.14.0", undefined]) {
      const { attributes } = translateLangfuseSpan(
        {
          "langfuse.trace.metadata.id": "12345",
          "langfuse.trace.metadata.flag": "true",
          "langfuse.trace.metadata.quoted": '"x"',
        },
        undefined,
        version,
      );
      assert.strictEqual(
        attributes["lmnr.association.properties.metadata.id"],
        "12345",
      );
      assert.strictEqual(
        attributes["lmnr.association.properties.metadata.flag"],
        "true",
      );
      assert.strictEqual(
        attributes["lmnr.association.properties.metadata.quoted"],
        '"x"',
      );
    }
  });

  void it("folds input tool calls into content parts and drops Anthropic mirrors", () => {
    const { attributes } = translateLangfuseSpan(
      {
        "langfuse.observation.type": "generation",
        "langfuse.observation.input": JSON.stringify([
          {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "c1",
                type: "function",
                function: { name: "f", arguments: "{}" },
              },
            ],
          },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "t1", name: "f", input: {} }],
            tool_calls: [{ id: "t1", name: "f", args: {} }],
          },
        ]),
      },
      { code: 2, message: "bad" },
      undefined,
    );
    assert.deepStrictEqual(
      JSON.parse(attributes["gen_ai.input.messages"] as string),
      [
        {
          role: "assistant",
          content: [
            { id: "c1", type: "tool_call", name: "f", arguments: "{}" },
          ],
        },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "f", input: {} }],
        },
      ],
    );
  });
});
