// The trajectory writer (`LMNR_TRAJECTORY_PATH`): live spans to lmnr-atif
// files. Port of lmnr-python's `tests/test_trajectory_writer.py`, plus the
// TS-only checks (exit hook, unref'd timer, shutdown → initialize).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  Attributes,
  Context,
  ROOT_CONTEXT,
  Span,
  SpanStatusCode,
  Tracer,
  trace,
} from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";

import { Laminar } from "../src/laminar";
import { getSpanProcessor } from "../src/opentelemetry-lib/tracing";
import { LaminarSpanProcessor } from "../src/opentelemetry-lib/tracing/processor";
import {
  spanType,
  TrajectoryCollector,
} from "../src/opentelemetry-lib/tracing/trajectory";
import { SpanRecord } from "../src/trajectory/builder";
import {
  mediaSink,
  renderPath,
  writeJsonAtomic,
} from "../src/trajectory/writer";
import { schemaErrors } from "./trajectory-helpers";

const dirname =
  typeof __dirname !== "undefined"
    ? __dirname
    : path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(dirname, "../src");
const PNG_BYTES = Buffer.from("\x89PNG\r\n\x1a\n-not-really-a-png", "latin1");
const PNG = PNG_BYTES.toString("base64");

const assertValid = (trajectory: unknown) => {
  assert.deepEqual(schemaErrors(trajectory), []);
};

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "lmnr-atif-"));

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));

// -- writer --------------------------------------------------------------------

void describe("trajectory writer", () => {
  void it("renderPath fills placeholders", () => {
    const home = process.env.HOME;
    process.env.HOME = "/home/agent";
    try {
      assert.equal(
        renderPath("~/runs/{trace_id}/{pid}.json", "abc", 7),
        "/home/agent/runs/abc/7.json",
      );
      assert.equal(renderPath("run.json", "abc"), "run.json");
      assert.equal(renderPath("{pid}.json"), `${process.pid}.json`);
    } finally {
      process.env.HOME = home;
    }
  });

  void it("atomic write creates directories and leaves no temp files", () => {
    const file = path.join(tmpDir(), "a", "b", "trajectory.json");
    writeJsonAtomic(file, { x: 1 });
    writeJsonAtomic(file, { x: 2, text: "café" });
    assert.deepEqual(readJson(file), { x: 2, text: "café" });
    // Two-space indent, non-ASCII kept as is (`ensure_ascii=False`).
    assert.equal(
      fs.readFileSync(file, "utf8"),
      '{\n  "x": 2,\n  "text": "café"\n}',
    );
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ["trajectory.json"]);
  });

  void it("media sink stores images by content hash", () => {
    const dir = tmpDir();
    const store = mediaSink(dir);
    const first = store(PNG, "image/png");
    assert.ok(first !== null);
    assert.match(first, /^images\/[0-9a-f]{32}\.png$/);
    assert.deepEqual(fs.readFileSync(path.join(dir, first)), PNG_BYTES);
    assert.equal(store(PNG, "image/png"), first);
    assert.equal(store(PNG, "image/tiff"), null); // not an ATIF image type
    assert.equal(store("not base64!", "image/png"), null);
    assert.deepEqual(fs.readdirSync(path.join(dir, "images")), [
      first.slice("images/".length),
    ]);
  });
});

// -- collector -----------------------------------------------------------------

/** A private provider with a `LaminarSpanProcessor` writing a trajectory. */
class Harness {
  readonly exporter = new InMemorySpanExporter();
  readonly processor: LaminarSpanProcessor;
  readonly provider: TracerProvider;
  readonly tracer: Tracer;

  constructor(
    readonly file: string,
    exportSpans: boolean,
    options: { spanProcessor?: any; snapshotIntervalMs?: number } = {},
  ) {
    this.processor = new LaminarSpanProcessor({
      exporter: this.exporter,
      disableBatch: true,
      trajectoryPath: file,
      exportSpans,
      spanProcessor: options.spanProcessor,
    });
    // No background snapshots unless a test asks for them.
    this.collector.snapshotIntervalMs = options.snapshotIntervalMs ?? 0;
    this.provider = new TracerProvider({
      spanProcessors: [this.processor],
    });
    this.tracer = this.provider.getTracer("test");
  }

  get collector(): TrajectoryCollector {
    assert.ok(this.processor.trajectory);
    return this.processor.trajectory;
  }

  get records(): SpanRecord[] {
    return [...(this.collector as any).records.values()];
  }

  /** Run `body` inside a span, ending it afterwards. */
  span(
    name: string,
    attributes: Attributes,
    parent: Context,
    body?: (span: Span, context: Context) => void,
  ): Span {
    const span = this.tracer.startSpan(name, { attributes }, parent);
    try {
      body?.(span, trace.setSpan(parent, span));
    } finally {
      span.end();
    }
    return span;
  }

  read(file?: string) {
    return readJson(file ?? this.file);
  }
}

const harnesses: Harness[] = [];
const harness = (...args: ConstructorParameters<typeof Harness>) => {
  const h = new Harness(...args);
  harnesses.push(h);
  return h;
};

const llmCall = (
  h: Harness,
  parent: Context,
  messages: unknown[],
  output: unknown[],
  attributes: Attributes = {},
) => {
  h.span(
    "openai.chat",
    {
      "lmnr.span.type": "LLM",
      "gen_ai.system": "openai",
      "gen_ai.request.model": "gpt-5.5",
      "gen_ai.input.messages": JSON.stringify(messages),
      "gen_ai.output.messages": JSON.stringify(output),
      "lmnr.span.input": JSON.stringify(messages),
      ...attributes,
    },
    parent,
  );
};

const TOOL_CALL = {
  role: "assistant",
  content: null,
  tool_calls: [
    {
      id: "c1",
      type: "function",
      function: { name: "lookup", arguments: '{"q":"x"}' },
    },
  ],
};

class RuntimeError extends Error {
  override name = "RuntimeError";
}

const toolLoop = (h: Harness, root = "agent", failTool = false): Span => {
  const ask = { role: "user", content: "Look up x" };
  return h.span(root, {}, ROOT_CONTEXT, (_, ctx) => {
    llmCall(h, ctx, [ask], [TOOL_CALL]);
    h.span(
      "lookup",
      { "lmnr.span.type": "TOOL", "lmnr.span.input": '{"q":"x"}' },
      ctx,
      (tool) => {
        if (failTool) {
          tool.recordException(new RuntimeError("no x"));
          tool.setStatus({ code: SpanStatusCode.ERROR });
        } else {
          tool.setAttribute("lmnr.span.output", '"found x"');
        }
      },
    );
    const result = { role: "tool", tool_call_id: "c1", content: "found x" };
    llmCall(
      h,
      ctx,
      [ask, TOOL_CALL, result],
      [{ role: "assistant", content: "x is found" }],
    );
  });
};

const uuidOf = (traceId: string) =>
  traceId.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");

void describe("trajectory collector", () => {
  let dir: string;
  let exitListeners: number;

  void beforeEach(() => {
    dir = tmpDir();
    exitListeners = process.listenerCount("exit");
  });

  void afterEach(async () => {
    for (const h of harnesses.splice(0)) {
      await h.provider.shutdown();
    }
    // Every collector's exit hook is gone after shutdown.
    assert.equal(process.listenerCount("exit"), exitListeners);
  });

  void it("local-only writes the file and exports nothing", async () => {
    const h = harness(path.join(dir, "out", "trajectory.json"), false);
    toolLoop(h);
    assert.ok(!fs.existsSync(h.file)); // nothing until a flush or a snapshot
    await h.processor.forceFlush();

    const trajectory = h.read();
    assertValid(trajectory);
    assert.deepEqual(h.exporter.getFinishedSpans(), []);
    assert.equal((h.processor as any).instance, undefined);
    assert.equal((h.processor as any).exporter, undefined);
    const lmnr = trajectory.extra.lmnr;
    assert.equal(lmnr.exported, false);
    assert.equal(lmnr.complete, true);
    assert.equal(trajectory.agent.name, "agent");
    assert.equal(trajectory.extra.lmnr.producer.name, "lmnr-ts");
    assert.deepEqual(
      trajectory.steps.map((s: any) => s.source),
      ["user", "agent", "agent"],
    );
    const call = trajectory.steps[1];
    assert.ok(call.tool_calls[0].extra.lmnr.span_id);
    assert.equal(call.observation.results[0].content, "found x");
    assert.equal(call.observation.results[0].extra.lmnr.status, "ok");
  });

  void it("dual mode exports and marks the file exported", async () => {
    const h = harness(path.join(dir, "t.json"), true);
    toolLoop(h);
    await h.processor.forceFlush();
    assert.equal(h.exporter.getFinishedSpans().length, 4);
    assert.equal(h.read().extra.lmnr.exported, true);
  });

  void it("tool errors come from exception events", async () => {
    const h = harness(path.join(dir, "t.json"), false);
    toolLoop(h, "agent", true);
    await h.processor.forceFlush();
    const result = h.read().steps[1].observation.results[0];
    assert.equal(result.extra.lmnr.status, "error");
    assert.equal(result.extra.lmnr.error.type, "RuntimeError");
    assert.equal(result.extra.lmnr.error.message, "no x");
  });

  void it("a snapshot while spans are open is incomplete", async () => {
    const h = harness(path.join(dir, "t.json"), false);
    let snapshot: any;
    h.span("agent", {}, ROOT_CONTEXT, (_, ctx) => {
      llmCall(h, ctx, [{ role: "user", content: "hi" }], [TOOL_CALL]);
      h.span("lookup", { "lmnr.span.type": "TOOL" }, ctx, () => {
        assert.ok(h.collector.write());
        snapshot = h.read();
      });
    });
    assertValid(snapshot);
    assert.equal(snapshot.extra.lmnr.complete, false);
    // The open root still names the agent.
    assert.equal(snapshot.agent.name, "agent");
    await h.processor.forceFlush();
    assert.equal(h.read().extra.lmnr.complete, true);
  });

  void it("snapshots are written in the background", async () => {
    const h = harness(path.join(dir, "t.json"), false, {
      snapshotIntervalMs: 20,
    });
    const root = h.tracer.startSpan("agent", {}, ROOT_CONTEXT);
    llmCall(
      h,
      trace.setSpan(ROOT_CONTEXT, root),
      [{ role: "user", content: "hi" }],
      [{ role: "assistant", content: "yo" }],
    );
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(h.file) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(fs.existsSync(h.file));
    assert.equal(h.read().extra.lmnr.complete, false);
    root.end();
  });

  void it("a failed write is retried at the next snapshot", async () => {
    const blocker = path.join(dir, "not-a-dir");
    fs.writeFileSync(blocker, "");
    const h = harness(path.join(blocker, "trajectory.json"), false);
    toolLoop(h);
    assert.equal(h.collector.write(), false);
    assert.equal(h.collector.dirty, true); // the next snapshot tries again
    assert.equal(h.collector.write(), false); // still never throws
    fs.unlinkSync(blocker);
    assert.ok(h.collector.write());
    assert.equal(h.collector.dirty, false);
    assert.equal(h.read().extra.lmnr.complete, true);
  });

  void it("a collector with no spans writes nothing", () => {
    const collector = new TrajectoryCollector(path.join(dir, "t.json"), false);
    try {
      assert.ok(collector.write());
      assert.ok(!fs.existsSync(path.join(dir, "t.json")));
    } finally {
      collector.shutdown();
    }
  });

  void it("shutdown writes the final file", async () => {
    const h = new Harness(path.join(dir, "t.json"), false);
    toolLoop(h);
    await h.provider.shutdown();
    assert.equal(h.read().extra.lmnr.complete, true);
    // Safe to call again.
    assert.ok(h.collector.shutdown());
  });

  void it("one file per trace with a {trace_id} placeholder", async () => {
    const h = harness(path.join(dir, "{trace_id}.json"), false);
    toolLoop(h, "first");
    toolLoop(h, "second");
    await h.processor.forceFlush();
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    assert.equal(files.length, 2);
    const names = new Set(
      files.map((f) => h.read(path.join(dir, f)).agent.name),
    );
    assert.deepEqual(names, new Set(["first", "second"]));
    for (const file of files) {
      const trajectory = h.read(path.join(dir, file));
      assert.equal(path.basename(file, ".json"), trajectory.trajectory_id);
      assert.equal(
        trajectory.trajectory_id,
        trajectory.extra.lmnr.trace_ids[0],
      );
    }
  });

  void it("a finished trace stays complete while another runs", () => {
    const h = harness(path.join(dir, "{trace_id}.json"), false);
    toolLoop(h, "first");
    let complete: Record<string, boolean> = {};
    const second = h.span("second", {}, ROOT_CONTEXT, (_, ctx) => {
      llmCall(h, ctx, [{ role: "user", content: "hi" }], [TOOL_CALL]);
      assert.ok(h.collector.write());
      complete = Object.fromEntries(
        fs
          .readdirSync(dir)
          .map((f) => [f, h.read(path.join(dir, f)).extra.lmnr.complete]),
      );
    });
    const running = `${uuidOf(second.spanContext().traceId)}.json`;
    assert.equal(complete[running], false);
    delete complete[running];
    assert.deepEqual(Object.values(complete), [true]);
  });

  void it("without a placeholder every trace goes into one file", async () => {
    const h = harness(path.join(dir, "t.json"), false);
    toolLoop(h, "first");
    toolLoop(h, "second");
    await h.processor.forceFlush();
    const trajectory = h.read();
    assert.equal(trajectory.extra.lmnr.trace_ids.length, 2);
    assert.equal(
      trajectory.steps.filter((s: any) => s.source === "agent").length,
      4,
    );
  });

  void it("inline images are stored next to the file", async () => {
    const h = harness(path.join(dir, "out", "t.json"), false);
    const image = {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: PNG },
    };
    h.span("agent", {}, ROOT_CONTEXT, (_, ctx) => {
      llmCall(
        h,
        ctx,
        [
          {
            role: "user",
            content: [{ type: "text", text: "what is it?" }, image],
          },
        ],
        [{ role: "assistant", content: "a png" }],
      );
    });
    await h.processor.forceFlush();
    const part = h.read().steps[0].message[1];
    assert.equal(part.type, "image");
    assert.deepEqual(
      fs.readFileSync(path.join(path.dirname(h.file), part.source.path)),
      PNG_BYTES,
    );
  });

  void it("records keep only what the builder reads", () => {
    const h = harness(path.join(dir, "t.json"), false);
    const big = [{ role: "user", content: "x".repeat(1000) }];
    h.span("agent", {}, ROOT_CONTEXT, (_, ctx) => {
      llmCall(h, ctx, big, [{ role: "assistant", content: "y" }], {
        "gen_ai.prompt.3.content": "dup",
        "gen_ai.prompt.0.role": "system",
      });
    });
    const llm = h.records.find((r) => r.span_type === "LLM")!;
    assert.ok("gen_ai.input.messages" in llm.attributes);
    // Same as gen_ai.input.messages.
    assert.ok(!("lmnr.span.input" in llm.attributes));
    assert.ok(!("gen_ai.prompt.3.content" in llm.attributes));
    assert.ok("gen_ai.prompt.0.role" in llm.attributes);
    // Stamped by the processor, not read by the builder.
    assert.ok(!("lmnr.span.path" in llm.attributes));
    assert.ok(!("lmnr.span.sdk_version" in llm.attributes));
    // Records outlive the span: arrays are copies.
    const root = h.records.find((r) => r.name === "agent")!;
    assert.equal(root.parent_span_id, null);
    assert.equal(llm.parent_span_id, root.span_id);
  });

  void it("records keep the AI SDK tool call attributes", () => {
    const h = harness(path.join(dir, "t.json"), false);
    h.span("agent", {}, ROOT_CONTEXT, (_, ctx) => {
      h.span(
        "ai.tool lookup",
        {
          "lmnr.span.type": "TOOL",
          "ai.toolCall.id": "c1",
          "ai.toolCall.name": "lookup",
          "ai.toolCall.args": "{}",
        },
        ctx,
      );
    });
    const tool = h.records.find((r) => r.span_type === "TOOL")!;
    assert.equal(tool.attributes["ai.toolCall.id"], "c1");
    assert.equal(tool.attributes["ai.toolCall.name"], "lookup");
    assert.ok(!("ai.toolCall.args" in tool.attributes));
  });

  void it("records have sub-millisecond, consistent times", () => {
    // OTel JS starts spans at `Date.now()` (whole ms); fast calls would tie.
    const h = harness(path.join(dir, "t.json"), false);
    toolLoop(h, "first");
    toolLoop(h, "second");
    const byTrace = new Map<string, SpanRecord[]>();
    for (const r of h.records) {
      byTrace.set(r.trace_id, [...(byTrace.get(r.trace_id) ?? []), r]);
    }
    const [first, second] = [...byTrace.values()];
    const root = (rs: SpanRecord[]) => rs.find((r) => !r.parent_span_id)!;
    for (const records of [first, second]) {
      const parent = root(records);
      const children = records
        .filter((r) => r !== parent)
        .sort((a, b) => a.start_time.localeCompare(b.start_time));
      // Each child starts after the previous one ended, inside the root.
      let previousEnd = parent.start_time;
      for (const child of children) {
        assert.ok(child.start_time >= previousEnd, child.name);
        previousEnd = child.end_time;
      }
      assert.ok(previousEnd <= parent.end_time);
    }
    assert.ok(root(first).end_time <= root(second).start_time);
    // Not all whole milliseconds.
    assert.ok(h.records.some((r) => !r.start_time.endsWith("000Z")));
  });

  void it("an explicit start time is kept", () => {
    const h = harness(path.join(dir, "t.json"), false);
    const start = new Date("2026-10-28T10:00:00.123Z");
    h.tracer
      .startSpan("agent", { startTime: start }, ROOT_CONTEXT)
      .end(new Date("2026-10-28T10:00:01.5Z"));
    const [record] = h.records;
    assert.equal(record.start_time, "2026-10-28T10:00:00.123000Z");
    assert.equal(record.end_time, "2026-10-28T10:00:01.500000Z");
  });

  void it("records use Laminar's UUID ids and the release", () => {
    const h = harness(path.join(dir, "t.json"), false);
    const root = toolLoop(h);
    const record = h.records.find((r) => r.name === "agent")!;
    assert.equal(record.trace_id, uuidOf(root.spanContext().traceId));
    assert.equal(
      record.span_id,
      `00000000-0000-0000-${root.spanContext().spanId.slice(0, 4)}-${root.spanContext().spanId.slice(4)}`,
    );
    assert.equal(
      record.attributes["lmnr.span.release"],
      (h.processor as any).release,
    );
  });
});

void describe("spanType matches app-server", () => {
  const cases: [Attributes, string, string?][] = [
    [{ "lmnr.span.type": "TOOL" }, "TOOL"],
    [{ "gen_ai.operation.name": "chat" }, "LLM"],
    [{ "gen_ai.operation.name": "embeddings" }, "LLM"],
    [{ "gen_ai.operation.name": "execute_tool" }, "TOOL"],
    [
      { "gen_ai.operation.name": "invoke_agent", "gen_ai.request.model": "m" },
      "DEFAULT",
    ],
    [{ "gen_ai.tool.call.arguments": "{}" }, "TOOL"],
    [{ "gen_ai.tool.call.result": "{}" }, "TOOL"],
    [{ "gen_ai.system": "openai" }, "LLM"],
    [{ "gen_ai.response.model": "m" }, "LLM"],
    [{}, "DEFAULT"],
    // An explicit type wins, and an unknown one is DEFAULT, not inferred.
    [{ "lmnr.span.type": "NOPE", "gen_ai.system": "openai" }, "DEFAULT"],
    [{ "lmnr.span.type": "EXECUTOR" }, "EXECUTOR"],
    // OpenRouter Broadcast types its own non-generation spans.
    [
      {
        "span.type": "span",
        "trace.metadata.openrouter.x": "1",
        "gen_ai.system": "openrouter",
      },
      "DEFAULT",
    ],
    [
      {
        "span.type": "generation",
        "trace.metadata.openrouter.x": "1",
        "gen_ai.system": "openrouter",
      },
      "LLM",
    ],
    [{ "span.type": "span", "gen_ai.system": "x" }, "LLM"],
    // `is_ai_sdk_tool_call_span`.
    [{ "ai.toolCall.id": "c1" }, "TOOL"],
    [{ "ai.toolCall.name": "lookup", "lmnr.span.type": "DEFAULT" }, "TOOL"],
    [{}, "TOOL", "ai.toolCall"],
    // A debug-replay hit is still an LLM call (`is_llm_span`).
    [{ "lmnr.span.type": "CACHED", "lmnr.span.original_type": "LLM" }, "LLM"],
    [{ "lmnr.span.type": "CACHED" }, "CACHED"],
  ];
  for (const [attributes, expected, name] of cases) {
    void it(`${JSON.stringify(attributes)} ${name ?? ""} -> ${expected}`, () => {
      assert.equal(spanType(attributes, name), expected);
    });
  }
});

// -- span processor wiring -------------------------------------------------------

void describe("LaminarSpanProcessor with a trajectory", () => {
  let dir: string;
  void beforeEach(() => {
    dir = tmpDir();
  });
  void afterEach(async () => {
    for (const h of harnesses.splice(0)) {
      await h.provider.shutdown();
    }
  });

  void it("local-only still runs a user's own span processor", async () => {
    const own = new InMemorySpanExporter();
    const h = harness(path.join(dir, "t.json"), false, {
      spanProcessor: new SimpleSpanProcessor({ exporter: own }),
    });
    toolLoop(h);
    await h.processor.forceFlush();
    assert.equal(own.getFinishedSpans().length, 4);
    assert.deepEqual(h.exporter.getFinishedSpans(), []);
    assert.equal(h.read().extra.lmnr.exported, false);
  });

  void it("local-only does not use a wrapped LaminarSpanProcessor's export", async () => {
    const inner = new InMemorySpanExporter();
    const wrapped = new LaminarSpanProcessor({
      exporter: inner,
      disableBatch: true,
    });
    const h = harness(path.join(dir, "t.json"), false, {
      spanProcessor: wrapped,
    });
    toolLoop(h);
    await h.processor.forceFlush();
    assert.deepEqual(inner.getFinishedSpans(), []);
    assert.equal(h.read().agent.name, "agent");
  });

  void it("a wrapping processor takes over the wrapped one's collector", async () => {
    const file = path.join(dir, "t.json");
    const inner = new InMemorySpanExporter();
    const wrapped = new LaminarSpanProcessor({
      exporter: inner,
      disableBatch: true,
      trajectoryPath: file,
      exportSpans: true,
    });
    const outer = new LaminarSpanProcessor({ spanProcessor: wrapped });
    assert.equal(outer.trajectory, wrapped.trajectory);
    const provider = new TracerProvider({ spanProcessors: [outer] });
    const tracer = provider.getTracer("test");
    const root = tracer.startSpan("agent", {}, ROOT_CONTEXT);
    tracer
      .startSpan(
        "openai.chat",
        {
          attributes: {
            "lmnr.span.type": "LLM",
            "gen_ai.input.messages": JSON.stringify([
              { role: "user", content: "hi" },
            ]),
            "gen_ai.output.messages": JSON.stringify([
              { role: "assistant", content: "yo" },
            ]),
          },
        },
        trace.setSpan(ROOT_CONTEXT, root),
      )
      .end();
    root.end();
    await outer.forceFlush();
    // Before shutdown, which clears an InMemorySpanExporter.
    assert.equal(inner.getFinishedSpans().length, 2);
    await provider.shutdown();
    const trajectory = readJson(file);
    assert.equal(trajectory.extra.lmnr.exported, true);
    assert.deepEqual(
      trajectory.steps.map((s: any) => s.message),
      ["hi", "yo"],
    );
  });
});

// -- Laminar.initialize ----------------------------------------------------------

const ENV_KEYS = [
  "LMNR_PROJECT_API_KEY",
  "LMNR_TRAJECTORY_PATH",
  "LMNR_TRAJECTORY_FORCE_EXPORT",
  "OTEL_ENDPOINT",
  "OTEL_HEADERS",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
];

const internals = () => {
  const processor = getSpanProcessor() as any;
  return {
    trajectory: processor.trajectory as TrajectoryCollector | undefined,
    instance: processor.instance,
    exporter: processor.exporter,
  };
};

void describe("Laminar.initialize trajectory modes", () => {
  const originalEnv = process.env;
  let dir: string;

  void beforeEach(() => {
    process.env = { ...originalEnv };
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }
    dir = tmpDir();
  });
  void afterEach(async () => {
    await Laminar.shutdown();
    process.env = originalEnv;
  });

  void it("a trajectory path means local-only without an API key", async () => {
    const file = path.join(dir, "t.json");
    process.env.LMNR_TRAJECTORY_PATH = file;
    Laminar.initialize();
    const { trajectory, instance, exporter } = internals();
    assert.ok(trajectory);
    assert.equal(trajectory.path, file);
    assert.equal(trajectory.exported, false);
    assert.equal(instance, undefined);
    assert.equal(exporter, undefined);

    await Laminar.withSpan(
      Laminar.startSpan({ name: "agent" }),
      async () => {
        const llm = Laminar.startSpan({ name: "llm", spanType: "LLM" });
        llm.setAttributes({
          "gen_ai.input.messages": JSON.stringify([
            { role: "user", content: "hi" },
          ]),
          "gen_ai.output.messages": JSON.stringify([
            { role: "assistant", content: "yo" },
          ]),
        });
        llm.end();
      },
      true,
    );
    await Laminar.flush();
    const written = readJson(file);
    assertValid(written);
    assert.equal(written.agent.name, "agent");
    assert.equal(written.extra.lmnr.exported, false);
  });

  void it("force-export needs an API key and exports too", () => {
    process.env.LMNR_TRAJECTORY_PATH = path.join(dir, "t.json");
    process.env.LMNR_TRAJECTORY_FORCE_EXPORT = "true";
    assert.throws(() => Laminar.initialize(), /project API key/);
    Laminar.initialize({ projectApiKey: "key" });
    const { trajectory, instance, exporter } = internals();
    assert.equal(trajectory?.exported, true);
    assert.ok(instance);
    assert.ok(exporter);
  });

  void it("a falsy LMNR_TRAJECTORY_FORCE_EXPORT is local-only", () => {
    process.env.LMNR_TRAJECTORY_PATH = path.join(dir, "t.json");
    process.env.LMNR_TRAJECTORY_FORCE_EXPORT = "false";
    Laminar.initialize();
    assert.equal(internals().trajectory?.exported, false);
    assert.equal(internals().exporter, undefined);
  });

  void it("writeTrajectory: false ignores the path", () => {
    process.env.LMNR_TRAJECTORY_PATH = path.join(dir, "t.json");
    assert.throws(
      () => Laminar.initialize({ writeTrajectory: false }),
      /project API key/,
    );
    Laminar.initialize({ projectApiKey: "key", writeTrajectory: false });
    assert.equal(internals().trajectory, undefined);
    assert.ok(internals().exporter);
  });

  void it("without a trajectory path nothing changes", () => {
    assert.throws(() => Laminar.initialize(), /project API key/);
    Laminar.initialize({ projectApiKey: "key" });
    assert.equal(internals().trajectory, undefined);
    assert.ok(internals().instance);
    assert.ok(internals().exporter);
  });

  void it("shutdown then initialize leaves no stale timer or exit hook", async () => {
    const file = path.join(dir, "t.json");
    process.env.LMNR_TRAJECTORY_PATH = file;
    const before = process.listenerCount("exit");
    const collectors: TrajectoryCollector[] = [];
    for (let i = 0; i < 12; i++) {
      Laminar.initialize();
      const { trajectory } = internals();
      assert.ok(trajectory);
      collectors.push(trajectory);
      const llm = Laminar.startSpan({ name: `llm-${i}`, spanType: "LLM" });
      llm.setAttributes({
        "gen_ai.input.messages": JSON.stringify([
          { role: "user", content: `hi ${i}` },
        ]),
      });
      llm.end();
      await Laminar.shutdown();
      assert.equal(readJson(file).steps[0].message, `hi ${i}`);
    }
    assert.equal(process.listenerCount("exit"), before);
    for (const collector of collectors) {
      assert.equal((collector as any).timer, undefined);
      assert.equal((collector as any).exitHook, undefined);
    }
  });
});

// -- child processes ---------------------------------------------------------------

const TSX = pathToFileURL(createRequire(SRC).resolve("tsx")).href;

/** Run a TS script in a fresh Node process with `cwd` and `env`. */
const runScript = (
  source: string,
  cwd: string,
  env: Record<string, string>,
) => {
  // `.mts`: an ES module, so the script can use top-level await.
  const script = path.join(cwd, "script.mts");
  fs.writeFileSync(script, source);
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    ...env,
  };
  for (const key of ENV_KEYS) {
    if (!(key in env)) {
      delete childEnv[key];
    }
  }
  // The parent runs under `tsx --test`; don't make the child a test runner.
  delete childEnv.NODE_TEST_CONTEXT;
  const started = Date.now();
  const result = spawnSync(process.execPath, ["--import", TSX, script], {
    cwd,
    env: childEnv,
    encoding: "utf8",
    timeout: 60_000,
  });
  return { ...result, elapsedMs: Date.now() - started };
};

const AGENT_SCRIPT = (ending: string) => `
import { Laminar } from ${JSON.stringify(path.join(SRC, "index.ts"))};

Laminar.initialize();
const root = Laminar.startSpan({ name: "agent" });
await Laminar.withSpan(root, async () => {
  const llm = Laminar.startSpan({ name: "llm", spanType: "LLM" });
  llm.setAttributes({
    "gen_ai.input.messages": JSON.stringify([{ role: "user", content: "hi" }]),
    "gen_ai.output.messages": JSON.stringify([{ role: "assistant", content: "yo" }]),
  });
  llm.end();
}, true);
${ending}
`;

void describe("trajectory file from a child process", () => {
  void it("is written on exit, and snapshots don't keep the process alive", () => {
    const dir = tmpDir();
    const file = path.join(dir, "t.json");
    // No flush, no shutdown: the script just ends with the snapshot timer
    // armed (2s). An un-unref'd timer would keep it running forever.
    const result = runScript(AGENT_SCRIPT(""), dir, {
      LMNR_TRAJECTORY_PATH: file,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.elapsedMs < 30_000);
    const trajectory = readJson(file);
    assertValid(trajectory);
    assert.equal(trajectory.extra.lmnr.complete, true);
    assert.deepEqual(
      trajectory.steps.map((s: any) => s.message),
      ["hi", "yo"],
    );
  });

  void it("is written on process.exit() with spans still open", () => {
    const dir = tmpDir();
    const file = path.join(dir, "t.json");
    const result = runScript(
      AGENT_SCRIPT(
        'Laminar.startSpan({ name: "still-running" });\nprocess.exit(3);',
      ),
      dir,
      { LMNR_TRAJECTORY_PATH: file },
    );
    assert.equal(result.status, 3, result.stderr);
    const trajectory = readJson(file);
    assert.equal(trajectory.extra.lmnr.complete, false);
  });

  const DOTENV_SCRIPT = (props: string) => `
import { Laminar } from ${JSON.stringify(path.join(SRC, "index.ts"))};
import { getSpanProcessor } from ${JSON.stringify(path.join(SRC, "opentelemetry-lib/tracing/index.ts"))};

Laminar.initialize(${props});
const processor = getSpanProcessor() as any;
console.log("RESULT " + JSON.stringify({
  path: processor.trajectory?.path ?? null,
  exporter: processor.exporter !== undefined,
}));
await Laminar.shutdown();
`;

  const result = (stdout: string) =>
    JSON.parse(
      stdout
        .split("\n")
        .find((line) => line.startsWith("RESULT "))!
        .slice("RESULT ".length),
    );

  void it("writeTrajectory: false ignores the path even from .env", () => {
    // A host process (the Harbor plugin) whose env is meant for its agent.
    const dir = tmpDir();
    fs.writeFileSync(
      path.join(dir, ".env"),
      `LMNR_TRAJECTORY_PATH=${path.join(dir, "t.json")}\n`,
    );
    const run = runScript(
      DOTENV_SCRIPT('{ projectApiKey: "key", writeTrajectory: false }'),
      dir,
      {},
    );
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(result(run.stdout), { path: null, exporter: true });
  });

  void it("a .env trajectory path applies by default", () => {
    const dir = tmpDir();
    const file = path.join(dir, "t.json");
    fs.writeFileSync(path.join(dir, ".env"), `LMNR_TRAJECTORY_PATH=${file}\n`);
    const run = runScript(DOTENV_SCRIPT(""), dir, {});
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(result(run.stdout), { path: file, exporter: false });
  });
});
