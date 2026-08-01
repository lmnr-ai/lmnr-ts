import assert from "node:assert/strict";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import { test } from "node:test";
import * as zlib from "node:zlib";

// ---- OTLP capture server: collects exported spans as decoded objects ----
interface CapturedSpan {
  name: string;
  spanId: string;
  parentSpanId?: string;
  status?: { code?: number };
  attrs: Record<string, unknown>;
}

function decodeAttrValue(v: any): unknown {
  if (v == null) return undefined;
  if ("stringValue" in v) return v.stringValue;
  if ("intValue" in v) return Number(v.intValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("boolValue" in v) return v.boolValue;
  if ("arrayValue" in v) return (v.arrayValue.values ?? []).map(decodeAttrValue);
  return undefined;
}

function decodeSpans(body: any, out: CapturedSpan[]): void {
  for (const rs of body.resourceSpans ?? []) {
    for (const ss of rs.scopeSpans ?? []) {
      for (const s of ss.spans ?? []) {
        const attrs: Record<string, unknown> = {};
        for (const a of s.attributes ?? []) {
          attrs[a.key] = decodeAttrValue(a.value);
        }
        out.push({
          name: s.name,
          spanId: s.spanId,
          parentSpanId: s.parentSpanId || undefined,
          status: s.status,
          attrs,
        });
      }
    }
  }
}

async function startCaptureServer(
  spans: CapturedSpan[],
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        let buf = Buffer.concat(chunks);
        if (req.headers["content-encoding"] === "gzip") {
          buf = zlib.gunzipSync(buf);
        }
        decodeSpans(JSON.parse(buf.toString("utf8")), spans);
      } catch {
        // ignore malformed bodies in the test sink
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

// ---- Fake pi API ----
function makeFakePi() {
  const handlers = new Map<string, ((e: any, ctx: any) => unknown)[]>();
  const pi = {
    on(event: string, handler: (e: any, ctx: any) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  };
  const ctx = {
    mode: "print",
    hasUI: false,
    cwd: "/work",
    sessionManager: { getSessionId: () => "sess-123", getCwd: () => "/work" },
  };
  const emit = async (event: string, payload: any) => {
    for (const h of handlers.get(event) ?? []) {
      await h({ type: event, ...payload }, ctx);
    }
  };
  return { pi, emit };
}

async function waitForSpans(spans: CapturedSpan[], count: number, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (spans.length < count && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 20));
  }
}

const asstStart = {
  message: {
    role: "assistant", content: [],
    model: "us.anthropic.claude-opus-4-8", provider: "amazon-bedrock",
  },
};

void test("end-to-end: pi event stream produces the expected Laminar span tree", async () => {
  const spans: CapturedSpan[] = [];
  const sink = await startCaptureServer(spans);
  process.env.LMNR_PROJECT_API_KEY = "sk-test";
  process.env.LMNR_BASE_URL = sink.url;

  // Import AFTER env is set (config reads at call time, but be safe).
  const { default: laminar } = await import("../src/index.js");
  const { pi, emit } = makeFakePi();
  laminar(pi);

  await emit("before_agent_start", { prompt: "list the files" });
  await emit("turn_start", { turnIndex: 0, timestamp: Date.now() });
  await emit("message_start", asstStart);
  await emit("message_end", {
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "I'll list them." },
        { type: "toolCall", id: "tc1", name: "bash", arguments: { command: "ls" } },
      ],
      api: "bedrock-converse-stream",
      provider: "amazon-bedrock",
      model: "us.anthropic.claude-opus-4-8",
      stopReason: "toolUse",
      usage: {
        input: 2, output: 89, cacheRead: 0, cacheWrite: 8209, totalTokens: 8300,
        cost: { total: 0.0535 },
      },
    },
  });
  await emit("tool_execution_start", {
    toolCallId: "tc1", toolName: "bash", args: { command: "ls" },
  });
  await emit("tool_execution_end", {
    toolCallId: "tc1", toolName: "bash", result: "a.txt\nb.txt", isError: false,
  });
  await emit("turn_start", { turnIndex: 1, timestamp: Date.now() });
  await emit("message_start", asstStart);
  await emit("message_end", {
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Done — 2 files." }],
      provider: "amazon-bedrock",
      model: "us.anthropic.claude-opus-4-8",
      stopReason: "endTurn",
      usage: { input: 10, output: 20, totalTokens: 30, cost: { total: 0.001 } },
    },
  });
  await emit("agent_end", { messages: [] });

  await waitForSpans(spans, 4);
  await sink.close();

  assert.equal(spans.length, 4, `expected 4 spans, got ${spans.length}`);

  const root = spans.find((s) => s.attrs["lmnr.span.type"] === "DEFAULT");
  const llms = spans.filter((s) => s.attrs["lmnr.span.type"] === "LLM");
  const tools = spans.filter((s) => s.attrs["lmnr.span.type"] === "TOOL");

  assert.ok(root, "has a DEFAULT root span");
  assert.equal(root.name, "pi agent run");
  assert.equal(root.attrs["lmnr.association.properties.session_id"], "sess-123");
  assert.match(String(root.attrs["lmnr.span.input"]), /list the files/);
  assert.match(String(root.attrs["lmnr.span.output"]), /Done — 2 files/);

  assert.equal(llms.length, 2, "two LLM spans (one per turn)");
  const llm0 = llms.find((s) => s.attrs["pi.turn.index"] === 0)!;
  assert.equal(llm0.attrs["gen_ai.system"], "anthropic");
  assert.equal(llm0.attrs["gen_ai.provider.name"], "amazon-bedrock");
  assert.equal(llm0.attrs["gen_ai.usage.input_tokens"], 2);
  assert.equal(llm0.attrs["llm.usage.total_tokens"], 8300);
  assert.equal(llm0.attrs["gen_ai.usage.cost"], 0.0535);
  assert.equal(llm0.parentSpanId, root.spanId, "LLM span nests under root");
  const llm0Input = llm0.attrs["gen_ai.input.messages"] as string;
  assert.match(llm0Input, /list the files/, "turn 0 input is the user prompt");

  // Regression: every turn — not just turn 0 — reports its input. Turn 1's
  // input must include the prior assistant turn and the tool result it saw.
  const llm1 = llms.find((s) => s.attrs["pi.turn.index"] === 1)!;
  const llm1Input = llm1.attrs["gen_ai.input.messages"] as string;
  assert.ok(llm1Input, "turn 1 LLM span carries input messages");
  assert.match(llm1Input, /list the files/, "turn 1 input keeps the original prompt");
  assert.match(llm1Input, /a\.txt/, "turn 1 input includes the prior tool result");

  assert.equal(tools.length, 1, "one TOOL span");
  assert.equal(tools[0].name, "bash");
  assert.match(String(tools[0].attrs["lmnr.span.input"]), /ls/);
  assert.match(String(tools[0].attrs["lmnr.span.output"]), /a\.txt/);
  assert.equal(tools[0].parentSpanId, root.spanId, "TOOL span nests under root");
});

void test("debugger mode stamps rollout.session_id on every span", async () => {
  const spans: CapturedSpan[] = [];
  const sink = await startCaptureServer(spans);
  process.env.LMNR_PROJECT_API_KEY = "sk-test";
  process.env.LMNR_BASE_URL = sink.url;
  process.env.LMNR_DEBUG = "true";
  process.env.LMNR_DEBUG_SESSION_ID = "rollout-xyz";

  const { default: laminar } = await import("../src/index.js");
  const { pi, emit } = makeFakePi();
  laminar(pi);

  await emit("before_agent_start", { prompt: "hi" });
  await emit("message_start", asstStart);
  await emit("message_end", {
    message: {
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      provider: "amazon-bedrock",
      model: "us.anthropic.claude-opus-4-8",
      stopReason: "endTurn",
      usage: { input: 1, output: 1, totalTokens: 2 },
    },
  });
  await emit("agent_end", {});

  await waitForSpans(spans, 2);
  await sink.close();

  const key = "lmnr.association.properties.metadata.rollout.session_id";
  assert.ok(spans.length >= 2, `expected spans, got ${spans.length}`);
  for (const s of spans) {
    assert.equal(s.attrs[key], "rollout-xyz", `${s.name} carries the rollout session id`);
  }

  delete process.env.LMNR_DEBUG;
  delete process.env.LMNR_DEBUG_SESSION_ID;
});

void test("injected LMNR_SPAN_CONTEXT propagates trace_type onto every span", async () => {
  const spans: CapturedSpan[] = [];
  const sink = await startCaptureServer(spans);
  process.env.LMNR_PROJECT_API_KEY = "sk-test";
  process.env.LMNR_BASE_URL = sink.url;
  // Mirrors what Harbor injects for an eval trial: trace_type travels in the
  // same JSON as the ids (LaminarSpanContext.model_dump_json).
  process.env.LMNR_SPAN_CONTEXT = JSON.stringify({
    trace_id: "3dbfd1ba-ff43-9db7-b08f-6796af502e35",
    span_id: "00000000-0000-0000-1234-567890abcdef",
    is_remote: true,
    trace_type: "EVALUATION",
  });

  const { default: laminar } = await import("../src/index.js");
  const { pi, emit } = makeFakePi();
  laminar(pi);

  await emit("before_agent_start", { prompt: "hi" });
  await emit("message_start", asstStart);
  await emit("message_end", {
    message: {
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      provider: "amazon-bedrock",
      model: "us.anthropic.claude-opus-4-8",
      stopReason: "endTurn",
      usage: { input: 1, output: 1, totalTokens: 2 },
    },
  });
  await emit("agent_end", {});

  await waitForSpans(spans, 2);
  await sink.close();

  const key = "lmnr.association.properties.trace_type";
  assert.ok(spans.length >= 2, `expected spans, got ${spans.length}`);
  for (const s of spans) {
    assert.equal(s.attrs[key], "EVALUATION", `${s.name} carries trace_type=EVALUATION`);
  }

  delete process.env.LMNR_SPAN_CONTEXT;
});
