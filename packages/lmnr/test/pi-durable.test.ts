import assert from "node:assert/strict";
import { afterEach, before, beforeEach, describe, it } from "node:test";

import type {
  Extension,
  HarnessOptions,
  Registry,
} from "@earendil-works/pi-durable";
import { context as otelContext } from "@opentelemetry/api";
import { isTracingSuppressed } from "@opentelemetry/core";
import {
  InMemorySpanExporter,
  type ReadableSpan,
  TracerProvider,
} from "@opentelemetry/sdk-trace";

import { Laminar } from "../src/laminar";
import {
  _resetConfiguration,
  initializeTracing,
} from "../src/opentelemetry-lib/configuration";
import {
  LAMINAR_PI_EXTENSION_NAME,
  laminarPiDurable,
  PiDurableInstrumentation,
} from "../src/opentelemetry-lib/instrumentation/pi-durable";
import {
  buildInputMessages,
  costAttributes,
  currentTools,
  lastUserText,
  usageAttributes,
} from "../src/opentelemetry-lib/instrumentation/pi-durable/messages";
import { LaminarSpanProcessor } from "../src/opentelemetry-lib/tracing/processor";
import { otelSpanIdToUUID } from "../src/utils";

// pi's packages are ESM-only (`import` condition only), and tsx runs this
// file as CommonJS, so they are loaded with dynamic import().
let ctx: any;
let piDurable: any;
let createModels: any;
let faux_: any;

const load = async () => {
  ({ BACKGROUND_CONTEXT: ctx } = await import("@earendil-works/chord/context"));
  ({ createModels } = await import("@earendil-works/pi-ai/models"));
  faux_ = await import("@earendil-works/pi-ai/providers/faux");
  piDurable = await import("@earendil-works/pi-durable");
};

const fauxAssistantMessage = (...args: any[]) =>
  faux_.fauxAssistantMessage(...args);
const fauxText = (text: string) => faux_.fauxText(text);
const fauxToolCall = (...args: any[]) => faux_.fauxToolCall(...args);

const weather = {
  name: "weather",
  description: "Get the weather in a city",
  parameters: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  },
  execute: async (args: any) => ({
    output: [{ type: "text", text: `Sunny in ${args.city}` }],
  }),
};

const broken = {
  name: "broken",
  description: "Always fails",
  parameters: { type: "object", properties: {} },
  execute: async () => {
    throw new Error("tool boom");
  },
};

// A replay-safe tool that blocks on its first call until the Harness closes,
// then completes when the reopened Harness runs it again.
let slowCalls = 0;
const slow = {
  name: "slow",
  description: "Takes a while",
  parameters: { type: "object", properties: {} },
  replay: "safe",
  execute: async (_args: any, _api: any, context: any) => {
    slowCalls++;
    if (slowCalls === 1) {
      await new Promise((_resolve, reject) => {
        context.abortSignal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      });
    }
    return { output: [{ type: "text", text: "slow done" }] };
  },
};

const App = {
  name: "app",
  tools: [weather, broken, slow],
  sections: [
    { key: "preamble", render: () => "You are a weather bot.", tag: false },
  ],
};

/** A MemoryStorage that survives `close()`, standing in for durable storage. */
const reopenableStorage = () => {
  const storage = new piDurable.MemoryStorage();
  return new Proxy(storage, {
    get: (target, property) => {
      if (property === "close") return async () => undefined;
      const value = (target as any)[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
};

// Compile-time only (tsc, not tsx): the README's wiring type-checks against
// Pi's own types, so hosts need no casts.
export const _readmeWiringTypeChecks = (
  lmnr: ReturnType<typeof laminarPiDurable>,
  registry: Registry,
): Pick<HarnessOptions, "telemetry"> => {
  registry.install(lmnr.extension satisfies Extension);
  return { telemetry: lmnr.telemetry };
};

const byName = (spans: ReadableSpan[], name: string) =>
  spans.filter((span) => span.name === name);

const parentId = (span: ReadableSpan): string | undefined =>
  (span as any).parentSpanContext?.spanId ?? (span as any).parentSpanId;

const idsPath = (span: ReadableSpan) =>
  span.attributes["lmnr.span.ids_path"] as string[];

const json = (span: ReadableSpan, key: string) =>
  JSON.parse(span.attributes[key] as string);

const exceptionMessage = (span: ReadableSpan) =>
  span.events.find((event) => event.name === "exception")?.attributes?.[
    "exception.message"
  ];

void describe("pi-durable", () => {
  let exporter: InMemorySpanExporter;
  let provider: TracerProvider;
  let faux: any;
  let models: any;
  let harnesses: any[];

  before(load);

  const open = async (
    options: Record<string, unknown>,
    storage: any = new piDurable.MemoryStorage(),
  ) => {
    const registry = piDurable.createRegistry();
    registry.install(App);
    if (options.extension) registry.install(options.extension as any);
    const harness = await piDurable.Harness.open(
      storage,
      { models, registry, settings: { retry: { maxRetries: 0 } }, ...options },
      ctx,
    );
    harnesses.push(harness);
    return harness;
  };

  const model = () => {
    const m = faux.getModel();
    return { provider: m.provider, modelId: m.id };
  };

  const ask = async (conversation: any, content: string) =>
    (await conversation.submit({ type: "input", content }, ctx)).wait(ctx);

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    provider = new TracerProvider({
      spanProcessors: [
        new LaminarSpanProcessor({ exporter, disableBatch: true }),
      ],
    });
    faux = faux_.fauxProvider();
    models = createModels();
    models.setProvider(faux.provider);
    harnesses = [];
    slowCalls = 0;
  });

  afterEach(async () => {
    for (const harness of harnesses) {
      await harness.close(ctx).catch(() => undefined);
    }
  });

  void it("traces a run as a root with LLM and TOOL children", async () => {
    const lmnr = laminarPiDurable({
      tracerProvider: provider,
      userId: "user-1",
      metadata: { env: "test" },
    });
    const harness = await open({
      telemetry: lmnr.telemetry,
      extension: lmnr.extension,
    });
    const conversation = await harness.root(ctx, { agent: { model: model() } });
    faux.setResponses([
      fauxAssistantMessage(
        [fauxText("Let me check."), fauxToolCall("weather", { city: "Paris" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("It is sunny in Paris."),
    ]);

    const settled = await ask(conversation, "Weather in Paris?");
    assert.equal(settled.status, "done");

    const spans = exporter.getFinishedSpans();
    // Pi's own spans are never exported.
    assert.deepEqual(
      spans.filter(
        (span) =>
          span.name.startsWith("pi.durable") || span.name.startsWith("pi.ai"),
      ),
      [],
    );
    const [root] = byName(spans, "pi.run");
    const llms = byName(spans, "pi.chat");
    const [tool] = byName(spans, "weather");
    assert.ok(root && tool);
    assert.equal(llms.length, 2);
    assert.equal(spans.length, 4);

    // One trace, the root first in every ids path.
    const traceId = root.spanContext().traceId;
    const rootUuid = otelSpanIdToUUID(root.spanContext().spanId);
    assert.equal(parentId(root), undefined);
    assert.deepEqual(idsPath(root), [rootUuid]);
    assert.deepEqual(root.attributes["lmnr.span.path"], ["pi.run"]);
    for (const child of [...llms, tool]) {
      assert.equal(child.spanContext().traceId, traceId);
      assert.equal(parentId(child), root.spanContext().spanId);
      assert.equal(idsPath(child)[0], rootUuid);
      assert.equal(idsPath(child).length, 2);
      assert.deepEqual(child.attributes["lmnr.span.path"], [
        "pi.run",
        child.name,
      ]);
    }

    // Root: DEFAULT span with the user's text in and the answer out.
    assert.equal(root.attributes["lmnr.span.type"], "DEFAULT");
    assert.equal(root.attributes["lmnr.span.input"], "Weather in Paris?");
    assert.equal(root.attributes["lmnr.span.output"], "It is sunny in Paris.");
    assert.equal(root.attributes["pi.conversation.id"], conversation.id);
    // Spans the whole run.
    for (const child of [...llms, tool]) {
      assert.ok(
        child.startTime[0] * 1e9 + child.startTime[1] >=
          root.startTime[0] * 1e9 + root.startTime[1],
      );
    }

    // Session (Pi's provider session id by default), user and metadata on every span.
    const sessionId = root.attributes["lmnr.association.properties.session_id"];
    assert.match(String(sessionId), /^[0-9a-f-]{36}$/);
    for (const span of spans) {
      assert.equal(
        span.attributes["lmnr.association.properties.session_id"],
        sessionId,
      );
      assert.equal(
        span.attributes["lmnr.association.properties.user_id"],
        "user-1",
      );
      assert.equal(
        span.attributes["lmnr.association.properties.metadata.env"],
        "test",
      );
      assert.equal(
        span.attributes["lmnr.span.instrumentation_scope.name"],
        "@earendil-works/pi-durable",
      );
    }

    // First LLM span: system prompt, tools, input, output, usage.
    const [first, second] = llms.sort(
      (a, b) =>
        a.startTime[0] - b.startTime[0] || a.startTime[1] - b.startTime[1],
    );
    assert.equal(first.attributes["lmnr.span.type"], "LLM");
    assert.equal(first.attributes["gen_ai.request.model"], model().modelId);
    assert.equal(first.attributes["gen_ai.provider.name"], model().provider);
    assert.deepEqual(first.attributes["gen_ai.response.finish_reasons"], [
      "toolUse",
    ]);
    assert.deepEqual(json(first, "gen_ai.input.messages"), [
      {
        role: "system",
        content: [{ type: "text", text: "You are a weather bot." }],
      },
      { role: "user", content: [{ type: "text", text: "Weather in Paris?" }] },
    ]);
    assert.deepEqual(
      json(first, "gen_ai.tool.definitions").map((t: any) => t.name),
      ["weather", "broken", "slow"],
    );
    assert.deepEqual(json(first, "gen_ai.output.messages"), [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check." },
          {
            type: "tool_use",
            id: json(first, "gen_ai.output.messages")[0].content[1].id,
            name: "weather",
            input: { city: "Paris" },
          },
        ],
      },
    ]);
    assert.ok((first.attributes["gen_ai.usage.output_tokens"] as number) > 0);
    // The faux model has no price: no cost, so Laminar prices from tokens.
    assert.equal(first.attributes["gen_ai.usage.cost"], undefined);

    // Second LLM span sees the tool result as an Anthropic user block.
    const input = json(second, "gen_ai.input.messages");
    assert.equal(input.at(-1).role, "user");
    assert.equal(input.at(-1).content[0].type, "tool_result");
    assert.deepEqual(input.at(-1).content[0].content, [
      { type: "text", text: "Sunny in Paris" },
    ]);

    // TOOL span: arguments in, result out.
    assert.equal(tool.attributes["lmnr.span.type"], "TOOL");
    assert.equal(
      tool.attributes["lmnr.span.input"],
      JSON.stringify({ city: "Paris" }),
    );
    assert.equal(tool.attributes["lmnr.span.output"], "Sunny in Paris");
    assert.equal(tool.attributes["gen_ai.tool.name"], "weather");
  });

  void it("marks tool errors and model errors", async () => {
    const lmnr = laminarPiDurable({ tracerProvider: provider });
    const harness = await open({
      telemetry: lmnr.telemetry,
      extension: lmnr.extension,
    });
    const conversation = await harness.root(ctx, { agent: { model: model() } });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("broken", {})], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage: "rate limited",
      }),
    ]);

    const settled = await ask(conversation, "break things");
    assert.equal(settled.status, "unanswered");

    const spans = exporter.getFinishedSpans();
    const [tool] = byName(spans, "broken");
    assert.equal(tool.status.code, 2);
    assert.equal(exceptionMessage(tool), "tool boom");

    const failed = byName(spans, "pi.chat").find(
      (span) =>
        span.attributes["gen_ai.response.finish_reasons"]?.toString() ===
        "error",
    );
    assert.ok(failed);
    assert.equal(failed.status.code, 2);
    assert.equal(exceptionMessage(failed), "rate limited");

    const [root] = byName(spans, "pi.run");
    assert.equal(root.status.code, 2);
    assert.equal(exceptionMessage(root), "rate limited");
    assert.equal(root.attributes["lmnr.span.output"], undefined);
  });

  void it("gives two runs two traces", async () => {
    const lmnr = laminarPiDurable({
      tracerProvider: provider,
      sessionId: "session-1",
      spanNames: {
        run: "agent",
        llm: ({ model }) => `chat ${model}`,
        tool: (n) => `tool ${n}`,
      },
    });
    const harness = await open({
      telemetry: lmnr.telemetry,
      extension: lmnr.extension,
    });
    const conversation = await harness.root(ctx, { agent: { model: model() } });
    faux.setResponses([
      fauxAssistantMessage("one"),
      fauxAssistantMessage("two"),
    ]);

    await ask(conversation, "first");
    await ask(conversation, "second");

    const spans = exporter.getFinishedSpans();
    const roots = byName(spans, "agent");
    assert.equal(roots.length, 2);
    assert.notEqual(
      roots[0].spanContext().traceId,
      roots[1].spanContext().traceId,
    );
    assert.deepEqual(
      roots.map((root) => [
        root.attributes["lmnr.span.input"],
        root.attributes["lmnr.span.output"],
      ]),
      [
        ["first", "one"],
        ["second", "two"],
      ],
    );
    const llms = byName(spans, `chat ${model().modelId}`);
    assert.equal(llms.length, 2);
    for (const root of roots) {
      assert.equal(
        llms.filter(
          (llm) => llm.spanContext().traceId === root.spanContext().traceId,
        ).length,
        1,
      );
    }
    for (const span of spans) {
      assert.equal(
        span.attributes["lmnr.association.properties.session_id"],
        "session-1",
      );
    }
  });

  void it("continues the trace of a run resumed in a new Harness", async () => {
    const storage = reopenableStorage();
    // Two adapters: nothing in memory carries over to the reopened Harness.
    const before = laminarPiDurable({ tracerProvider: provider });
    const first = await open(
      { telemetry: before.telemetry, extension: before.extension },
      storage,
    );
    const conversation = await first.root(ctx, { agent: { model: model() } });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("slow", {})], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("finished after restart"),
    ]);
    const submission = await conversation.submit(
      { type: "input", content: "do the slow thing" },
      ctx,
    );
    while (slowCalls === 0)
      await new Promise((resolve) => setTimeout(resolve, 5));
    await first.close(ctx);

    // Only the first request finished before the restart; the run is open.
    const beforeRestart = exporter.getFinishedSpans();
    assert.deepEqual(
      beforeRestart.map((span) => span.name),
      ["pi.chat"],
    );

    const after = laminarPiDurable({ tracerProvider: provider });
    const second = await open(
      { telemetry: after.telemetry, extension: after.extension },
      storage,
    );
    second.resume();
    const settled = await (await second.submission(submission.id, ctx))!.wait(
      ctx,
    );
    assert.equal(settled.status, "done");
    assert.equal(slowCalls, 2);

    const spans = exporter.getFinishedSpans();
    const roots = byName(spans, "pi.run");
    assert.equal(roots.length, 1);
    const [root] = roots;
    const traceId = root.spanContext().traceId;
    for (const span of spans) {
      assert.equal(span.spanContext().traceId, traceId);
    }
    const [tool] = byName(spans, "slow");
    assert.equal(tool.attributes["lmnr.span.output"], "slow done");
    assert.equal(parentId(tool), root.spanContext().spanId);
    assert.equal(byName(spans, "pi.chat").length, 2);
    // The root starts at the submission, before the first process's LLM span.
    const llm = beforeRestart[0];
    assert.ok(
      root.startTime[0] < llm.startTime[0] ||
        (root.startTime[0] === llm.startTime[0] &&
          root.startTime[1] <= llm.startTime[1]),
    );
    assert.equal(root.attributes["lmnr.span.output"], "finished after restart");
  });

  void it("runs pi-ai requests with tracing suppressed", async () => {
    _resetConfiguration();
    initializeTracing({ exporter, disableBatch: true });
    const lmnr = laminarPiDurable({ tracerProvider: provider });
    const harness = await open({
      telemetry: lmnr.telemetry,
      extension: lmnr.extension,
    });
    const conversation = await harness.root(ctx, { agent: { model: model() } });
    let suppressed: boolean | undefined;
    faux.setResponses([
      () => {
        suppressed = isTracingSuppressed(otelContext.active());
        return fauxAssistantMessage("hi");
      },
    ]);
    await ask(conversation, "hi");
    assert.equal(suppressed, true);
    _resetConfiguration();
  });

  void it("never throws into Pi when export fails", async () => {
    const throwing = {
      getTracer: () => {
        throw new Error("tracer boom");
      },
    };
    const lmnr = laminarPiDurable({ tracerProvider: throwing as any });
    const harness = await open({
      telemetry: lmnr.telemetry,
      extension: lmnr.extension,
    });
    const conversation = await harness.root(ctx, { agent: { model: model() } });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("weather", { city: "Oslo" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("Cold."),
    ]);
    const settled = await ask(conversation, "Weather in Oslo?");
    assert.equal(settled.status, "done");
  });

  void it("instruments Harness.open through the Laminar pipeline", async () => {
    _resetConfiguration();
    initializeTracing({ exporter, disableBatch: true });
    Object.defineProperty(Laminar, "isInitialized", {
      value: true,
      writable: true,
    });
    const instrumentation = new PiDurableInstrumentation();
    // The ESM namespace is frozen; patch the same shared `Harness` object.
    instrumentation.manuallyInstrument({ Harness: piDurable.Harness });
    try {
      const harness = await open({});
      const conversation = await harness.root(ctx, {
        agent: { model: model() },
      });
      faux.setResponses([fauxAssistantMessage("auto")]);
      await ask(conversation, "hello");
      const spans = exporter.getFinishedSpans();
      assert.deepEqual(spans.map((span) => span.name).sort(), [
        "pi.chat",
        "pi.run",
      ]);
      const [root] = byName(spans, "pi.run");
      assert.equal(root.attributes["lmnr.span.output"], "auto");
    } finally {
      instrumentation.disable();
      (instrumentation as any).unwrapMethod(piDurable.Harness, "open");
      _resetConfiguration();
    }
  });
});

void describe("pi-durable extension install", () => {
  before(load);

  void it("names the extension after the package", () => {
    assert.equal(laminarPiDurable().extension.name, "@lmnr-ai/lmnr");
  });

  void it("never replaces a foreign extension of the same name", () => {
    const foreign = { name: LAMINAR_PI_EXTENSION_NAME };
    const registry = piDurable.createRegistry();
    registry.install(foreign);
    const instrumentation = new PiDurableInstrumentation();
    try {
      const options = instrumentation.instrumentOptions({ registry });
      assert.equal(
        registry.snapshot().extension(LAMINAR_PI_EXTENSION_NAME),
        foreign,
      );
      // Telemetry is still passed, so runs keep their root span.
      assert.ok(options.telemetry);
    } finally {
      instrumentation.disable();
    }
  });

  void it("replaces an extension from another laminarPiDurable()", () => {
    const registry = piDurable.createRegistry();
    registry.install(App);
    registry.install(laminarPiDurable().extension);
    const instrumentation = new PiDurableInstrumentation();
    try {
      instrumentation.instrumentOptions({ registry });
      const installed = registry.snapshot().installed();
      assert.deepEqual(
        installed.map((extension: any) => extension.name),
        ["app", LAMINAR_PI_EXTENSION_NAME],
      );
      assert.equal(
        installed[1],
        (instrumentation as any).integration.extension,
      );
    } finally {
      instrumentation.disable();
    }
  });
});

void describe("pi-durable message mapping", () => {
  void it("replays system messages into one prompt and tool set", () => {
    const messages: any[] = [
      {
        role: "system",
        content: "Base.",
        sections: { a: "Section A", b: "Section B" },
        toolsAdded: [
          { name: "read", description: "Read", parameters: {} },
          { name: "bash", description: "Bash", parameters: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", data: "xx", mimeType: "image/png" },
        ],
      },
      {
        role: "system",
        content: "More.",
        sections: { a: null, b: "Section B2" },
        toolsRemoved: [{ name: "bash" }],
      },
      { role: "user", content: "next" },
    ];
    assert.deepEqual(buildInputMessages(messages), [
      {
        role: "system",
        content: [{ type: "text", text: "Base.\n\nMore.\n\nSection B2" }],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "text", text: "[image image/png]" },
        ],
      },
      { role: "user", content: [{ type: "text", text: "next" }] },
    ]);
    assert.deepEqual(
      currentTools(messages).map((tool) => tool.name),
      ["read"],
    );
    assert.equal(
      buildInputMessages(messages, "Override")[0].content[0].text,
      "Override",
    );
    assert.equal(lastUserText(messages), "next");
  });

  void it("takes the newest user turn before tool results", () => {
    const messages: any[] = [
      { role: "user", content: "old" },
      { role: "assistant", content: [{ type: "text", text: "a" }] },
      { role: "user", content: "new" },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "1", name: "t", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "1",
        toolName: "t",
        content: [],
        isError: false,
      },
    ];
    assert.equal(lastUserText(messages), "new");
  });

  void it("maps usage, and cost only when it is positive", () => {
    const usage = {
      input: 10,
      output: 5,
      cacheRead: 100,
      cacheWrite: 0,
      totalTokens: 115,
      cost: {
        input: 0.01,
        output: 0.02,
        cacheRead: 0.003,
        cacheWrite: 0.004,
        total: 0.037,
      },
    };
    assert.deepEqual(usageAttributes(usage), {
      "gen_ai.usage.input_tokens": 10,
      "gen_ai.usage.output_tokens": 5,
      "gen_ai.usage.cache_read.input_tokens": 100,
      "llm.usage.total_tokens": 115,
    });
    const cost = costAttributes(usage);
    assert.equal(cost["gen_ai.usage.cost"], 0.037);
    assert.ok(Math.abs(cost["gen_ai.usage.input_cost"] - 0.017) < 1e-12);
    assert.equal(cost["gen_ai.usage.output_cost"], 0.02);
    assert.deepEqual(
      costAttributes({ ...usage, cost: { ...usage.cost, total: 0 } }),
      {},
    );
  });
});
