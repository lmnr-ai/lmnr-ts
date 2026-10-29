/**
 * The lmnr-atif writer's pure layer (`src/trajectory/normalize.ts`,
 * `builder.ts`) and the shared golden suite. Port of the Python SDK's
 * `tests/test_lmnr_atif_builder.py`; the golden files are never regenerated
 * here, only compared against.
 */

import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import { version as SDK_VERSION } from "../package.json";
import {
  BuildOptions,
  buildTrajectory,
  formatTime,
  parseTimeUs,
  SpanError,
  SpanRecord,
  spanRecordFromJson,
  spanRecordToJson,
} from "../src/trajectory/builder";
import {
  contentText,
  Message,
  normalizeCall,
  normalizeTools,
} from "../src/trajectory/normalize";
import {
  canonicalJson,
  pyEquals,
  pyJsonDumps,
  pyStr,
  truthy,
} from "../src/trajectory/py";
import * as reader from "../src/trajectory/reader";
import { TrajectoryExtension } from "../src/trajectory/reader";
import {
  CASES,
  GOLDEN_DIR,
  readJson,
  schemaErrors,
} from "./trajectory-helpers";

const GOLDEN_PRODUCER = { name: "lmnr-golden", version: "0" };

const loadCase = (name: string): [SpanRecord[], BuildOptions] => {
  const data = readJson(path.join(GOLDEN_DIR, name, "spans.json"));
  const options = data.options ?? {};
  return [
    data.spans.map(spanRecordFromJson),
    {
      producer: { ...GOLDEN_PRODUCER },
      release: options.release,
      projectId: options.project_id,
      exported: options.exported,
      complete: options.complete,
    },
  ];
};

const buildCase = (name: string): any => {
  const [records, options] = loadCase(name);
  const trajectory = buildTrajectory(records, options);
  assert.notEqual(trajectory, null);
  return trajectory;
};

/** What the model saw, for comparing a rebuilt input with the real one.
 *
 * The leading run of system messages is compared as joined text (an override
 * joins several system messages into one); reasoning is ignored. */
const comparable = (messages: Message[]): unknown[] => {
  const system: string[] = [];
  const rest = [...messages];
  while (rest.length > 0 && ["system", "developer"].includes(rest[0].role)) {
    system.push(contentText(rest.shift()!.content));
  }
  return [
    system.join("\n\n"),
    ...rest.map((m) => [
      m.role,
      m.content ?? "",
      (m.tool_calls ?? []).map((c: any) => [
        c.tool_call_id,
        c.function_name,
        c.arguments,
      ]),
      m.tool_call_id ?? null,
    ]),
  ];
};

void describe("lmnr-atif writer golden cases", () => {
  void it("has golden cases", () => {
    assert.ok(CASES.length >= 6);
  });

  for (const name of CASES) {
    void it(`${name}: builds exactly the golden trajectory`, () => {
      const expected = readJson(path.join(GOLDEN_DIR, name, "trajectory.json"));
      assert.deepStrictEqual(buildCase(name), expected);
    });

    void it(`${name}: output matches the schema`, () => {
      assert.deepEqual(schemaErrors(buildCase(name)), []);
    });

    void it(`${name}: reader rebuilds every call's input`, () => {
      // The strongest check of the writer: reading the trajectory back with
      // the spec's rules (§6.3, §6.4) gives each LLM call exactly the input
      // it had.
      const [records] = loadCase(name);
      const trajectory = buildCase(name);
      const bySpan = new Map(records.map((r) => [r.span_id, r]));
      let checked = 0;

      const check = (doc: any, parent: TrajectoryExtension | null) => {
        const ext = TrajectoryExtension.read(doc, parent);
        assert.notEqual(ext, null);
        const steps = reader.stepsOf(doc);
        steps.forEach((step, index) => {
          if (step.source !== "agent" || step.llm_call_count === 0) {
            return;
          }
          const record = bySpan.get(step.extra.lmnr.span_id)!;
          const rawInput = JSON.parse(
            record.attributes["gen_ai.input.messages"] as string,
          );
          let [actual] = normalizeCall(rawInput, null);
          if (
            record.attributes["gen_ai.prompt.0.role"] === "system" &&
            !actual.some((m) => m.role === "system")
          ) {
            actual = [
              {
                role: "system",
                content: record.attributes["gen_ai.prompt.0.content"],
              },
              ...actual,
            ];
          }
          const rebuilt = reader.inputMessages(steps, index, ext);
          assert.deepStrictEqual(
            comparable(rebuilt),
            comparable(actual),
            `${doc.agent.name} ${index}`,
          );
          checked += 1;
        });
        for (const sub of doc.subagent_trajectories ?? []) {
          check(sub, ext);
        }
      };

      check(trajectory, null);
      const llmRecords = records.filter((r) => r.span_type === "LLM");
      const nested = new Set(llmRecords.map((r) => r.parent_span_id));
      assert.equal(
        checked,
        llmRecords.filter((r) => !nested.has(r.span_id)).length,
      );
    });

    void it(`${name}: output is deterministic`, () => {
      const [records, options] = loadCase(name);
      assert.deepStrictEqual(
        buildTrajectory([...records].reverse(), options),
        buildCase(name),
      );
    });
  }
});

// -- builder ----------------------------------------------------------------

const BASE_US = parseTimeUs("2026-10-28T09:00:00.000000Z");
const sid = (n: number) =>
  `00000000-0000-0000-0000-${n.toString(16).padStart(12, "0")}`;

const record = (
  spanId: number,
  parent: number | null,
  name: string,
  spanType: string,
  start: number,
  end: number,
  attributes: Record<string, unknown> = {},
  error: SpanError | null = null,
): SpanRecord => ({
  trace_id: "11111111-2222-4333-8444-555555555555",
  span_id: sid(spanId),
  parent_span_id: parent !== null ? sid(parent) : null,
  name,
  span_type: spanType,
  start_time: formatTime(BASE_US + Math.round(start * 1e6)),
  end_time: formatTime(BASE_US + Math.round(end * 1e6)),
  attributes,
  error,
});

const llm = (
  spanId: number,
  start: number,
  end: number,
  messages: unknown[],
  output: unknown,
  attrs: Record<string, unknown> = {},
): SpanRecord =>
  record(spanId, 1, "openai.chat", "LLM", start, end, {
    "gen_ai.system": "openai",
    "gen_ai.request.model": "gpt-5.5",
    "gen_ai.input.messages": JSON.stringify(messages),
    "gen_ai.output.messages": JSON.stringify(output),
    ...attrs,
  });

const toolCallOutput = (callId: string, name: string, args: object) => [
  {
    role: "assistant",
    tool_calls: [
      {
        id: callId,
        function: { name, arguments: pyJsonDumps(args) },
      },
    ],
  },
];

const resultsOf = (step: any): unknown[] =>
  (step.observation?.results ?? []).map((r: any) => r.content);

void describe("lmnr-atif builder", () => {
  void it("no LLM or tool spans means no trajectory", () => {
    assert.equal(
      buildTrajectory([record(1, null, "root", "DEFAULT", 0, 1)]),
      null,
    );
    assert.equal(buildTrajectory([]), null);
  });

  void it("span records round-trip through JSON", () => {
    const value = record(
      2,
      1,
      "x",
      "TOOL",
      0,
      1,
      { a: 1 },
      {
        type: "E",
        message: "m",
      },
    );
    assert.deepStrictEqual(spanRecordFromJson(spanRecordToJson(value)), value);
    assert.deepStrictEqual(
      spanRecordFromJson(JSON.parse(JSON.stringify(spanRecordToJson(value)))),
      value,
    );
  });

  void it("time formatting keeps microseconds", () => {
    const value = "2026-10-28T09:00:01.123456Z";
    assert.equal(formatTime(parseTimeUs(value)), value);
    assert.equal(
      parseTimeUs("2026-10-28T09:00:01.123456+00:00"),
      parseTimeUs(value),
    );
    // Like Python's `format_time`, extra precision is truncated, not rounded.
    assert.equal(
      formatTime(parseTimeUs("2026-10-28T11:00:01.1234569+02:00")),
      value,
    );
  });

  void it("the default producer is this SDK", () => {
    const trajectory = buildTrajectory([
      record(1, null, "root", "DEFAULT", 0, 2),
      llm(
        2,
        0,
        1,
        [{ role: "user", content: "hi" }],
        [{ role: "assistant", content: "yo" }],
      ),
    ]);
    assert.deepEqual(trajectory!.extra.lmnr.producer, {
      name: "lmnr-ts",
      version: SDK_VERSION,
    });
  });

  void it("a failed agent that no tool spawned counts as an error", () => {
    const hi = [{ role: "user", content: "hi" }];
    const yo = [{ role: "assistant", content: "yo" }];
    const helperCall = llm(4, 2, 3, hi, yo);
    const trajectory = buildTrajectory([
      record(1, null, "root", "DEFAULT", 0, 5),
      llm(2, 0, 1, hi, yo),
      record(
        3,
        1,
        "helper",
        "DEFAULT",
        2,
        4,
        { "gen_ai.agent.name": "helper" },
        { type: "RuntimeError", message: "boom" },
      ),
      record(4, 3, helperCall.name, "LLM", 2, 3, helperCall.attributes),
    ]);
    const results = trajectory!.steps.at(-1).observation.results;
    assert.equal(results.length, 1);
    assert.equal(results[0].extra.lmnr.status, "error");
    assert.equal(trajectory!.final_metrics.extra.lmnr.errors, 1);
  });

  void it("concurrent calls keep their own inputs", () => {
    // Two calls of one agent started at the same time: each step is followed
    // by its own new messages' call, and the second gets the exact input.
    const first = [{ role: "user", content: "Summarize A" }];
    const second = [{ role: "user", content: "Summarize B" }];
    const trajectory = buildTrajectory([
      record(1, null, "fanout", "DEFAULT", 0, 3),
      llm(2, 1, 2, first, [{ role: "assistant", content: "A is..." }]),
      llm(3, 1, 2.5, second, [{ role: "assistant", content: "B is..." }]),
    ]);
    const steps = trajectory!.steps;
    assert.deepEqual(
      steps.map((s: any) => [s.source, s.message]),
      [
        ["user", "Summarize A"],
        ["agent", "A is..."],
        ["user", "Summarize B"],
        ["agent", "B is..."],
      ],
    );
    assert.deepEqual(steps[3].extra.lmnr.input_messages, second);
    const ext = TrajectoryExtension.read(trajectory);
    assert.deepEqual(reader.inputMessages(steps, 3, ext), second);
  });

  void it("a tool span is matched by its tool call id attribute", () => {
    const output = [
      {
        role: "assistant",
        tool_calls: [
          { id: "c1", function: { name: "search", arguments: '{"q": "a"}' } },
          { id: "c2", function: { name: "search", arguments: '{"q": "b"}' } },
        ],
      },
    ];
    const trajectory = buildTrajectory([
      record(1, null, "root", "DEFAULT", 0, 5),
      llm(2, 0, 1, [{ role: "user", content: "go" }], output),
      // Started in the opposite order; the call id decides.
      record(3, 1, "search", "TOOL", 1.1, 1.5, {
        "gen_ai.tool.call.id": "c2",
        "lmnr.span.output": '"B"',
      }),
      record(4, 1, "search", "TOOL", 1.2, 1.6, {
        "gen_ai.tool.call.id": "c1",
        "lmnr.span.output": '"A"',
      }),
    ]);
    const step = trajectory!.steps[1];
    const results = Object.fromEntries(
      step.observation.results.map((r: any) => [r.source_call_id, r.content]),
    );
    assert.deepEqual(results, { c1: "A", c2: "B" });
    const spans = Object.fromEntries(
      step.tool_calls.map((c: any) => [c.tool_call_id, c.extra.lmnr.span_id]),
    );
    assert.ok(spans.c1.endsWith("4") && spans.c2.endsWith("3"));
  });

  void it("a tool result from a span only forces an exact next input", () => {
    // The next call didn't receive the tool result, so rebuilding its input
    // from the observation would be wrong; the writer writes it out.
    const call = { id: "c1", function: { name: "lookup", arguments: "{}" } };
    const assistant = { role: "assistant", content: null, tool_calls: [call] };
    const trajectory = buildTrajectory([
      record(1, null, "root", "DEFAULT", 0, 5),
      llm(2, 0, 1, [{ role: "user", content: "go" }], [assistant]),
      record(3, 1, "lookup", "TOOL", 1.1, 1.2, {
        "lmnr.span.output": '"found"',
      }),
      llm(
        4,
        2,
        3,
        [
          { role: "user", content: "go" },
          assistant,
          { role: "user", content: "and?" },
        ],
        [{ role: "assistant", content: "done" }],
      ),
    ]);
    const steps = trajectory!.steps;
    assert.equal(steps[1].observation.results[0].content, "found");
    assert.ok("input_messages" in steps[3].extra.lmnr);
    const ext = TrajectoryExtension.read(trajectory);
    assert.deepEqual(
      reader.inputMessages(steps, 3, ext).map((m) => m.role),
      ["user", "assistant", "user"],
    );
  });

  void it("concurrent calls keep their own tool spans", () => {
    // The second call starts before the first one's tool runs; that must not
    // cut the first call's window, nor let it take the second call's tool.
    const trajectory = buildTrajectory([
      record(1, null, "root", "DEFAULT", 0, 10),
      llm(
        2,
        0,
        1,
        [{ role: "user", content: "A" }],
        toolCallOutput("a", "s", { q: 1 }),
      ),
      llm(
        3,
        0.5,
        1.5,
        [{ role: "user", content: "B" }],
        toolCallOutput("b", "s", { q: 2 }),
      ),
      record(4, 1, "s", "TOOL", 1.6, 2, {
        "lmnr.span.input": '{"q": 2}',
        "lmnr.span.output": '"B"',
      }),
      record(5, 1, "s", "TOOL", 1.7, 2, {
        "lmnr.span.input": '{"q": 1}',
        "lmnr.span.output": '"A"',
      }),
    ]);
    assert.deepEqual(
      trajectory!.steps.map((s: any) => [s.source, resultsOf(s)]),
      [
        ["user", []],
        ["agent", ["A"]],
        ["user", []],
        ["agent", ["B"]],
      ],
    );
  });

  void it("a later system prompt without a first one is an override", () => {
    // With no system prompt on the first call, a later call's leading system
    // message is that call's system prompt, not a message in the history.
    const hi = { role: "user", content: "hi" };
    const yo = { role: "assistant", content: "yo" };
    const second = [
      { role: "system", content: "S" },
      hi,
      yo,
      { role: "user", content: "more" },
    ];
    const trajectory = buildTrajectory([
      record(1, null, "root", "DEFAULT", 0, 10),
      llm(2, 0, 1, [hi], [yo]),
      llm(3, 2, 3, second, [{ role: "assistant", content: "ok" }]),
    ]);
    const steps = trajectory!.steps;
    assert.deepEqual(
      steps.map((s: any) => s.source),
      ["user", "agent", "user", "agent"],
    );
    assert.equal(steps[3].extra.lmnr.system_prompt, "S");
    assert.equal("input_messages" in steps[3].extra.lmnr, false);
    const ext = TrajectoryExtension.read(trajectory);
    assert.deepEqual(reader.inputMessages(steps, 3, ext), second);
  });

  void it("repeated generated tool call ids keep their own results", () => {
    // Two Gemini conversations in one agent both generate `convert_1`; each
    // call's observation is the result its own next call received.
    const content = (role: string, ...parts: object[]) => ({ role, parts });
    const call = (x: number) =>
      content("model", { function_call: { name: "convert", args: { x } } });
    const result = (value: string) =>
      content("user", {
        function_response: { name: "convert", response: { output: value } },
      });

    const records = [record(1, null, "root", "DEFAULT", 0, 20)];
    [
      ["one", "ONE"],
      ["two", "TWO"],
    ].forEach(([prompt, value], n) => {
      const ask = content("user", { text: prompt });
      const done = content("model", { text: `done ${prompt}` });
      records.push(
        llm(10 * n + 2, 10 * n, 10 * n + 1, [ask], [{ content: call(n) }]),
        llm(
          10 * n + 3,
          10 * n + 2,
          10 * n + 3,
          [ask, call(n), result(value)],
          [{ content: done }],
        ),
      );
    });
    const trajectory = buildTrajectory(records);
    const observed = trajectory!.steps
      .filter((s: any) => s.source === "agent")
      .map(resultsOf);
    assert.deepEqual(observed, [["ONE"], [], ["TWO"], []]);
  });

  void it("inline images go through the media sink", () => {
    const stored: [string, string][] = [];
    const sink = (data: string, mediaType: string) => {
      stored.push([data, mediaType]);
      return "images/abc.png";
    };
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "What is this?" },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,iVBORw0KGgo=" },
          },
        ],
      },
    ];
    const records = [
      record(1, null, "root", "DEFAULT", 0, 2),
      llm(2, 0, 1, messages, [{ role: "assistant", content: "A cat." }]),
    ];
    const trajectory = buildTrajectory(records, { media: sink });
    assert.deepEqual(stored, [["iVBORw0KGgo=", "image/png"]]);
    assert.deepEqual(trajectory!.steps[0].message, [
      { type: "text", text: "What is this?" },
      {
        type: "image",
        source: { media_type: "image/png", path: "images/abc.png" },
      },
    ]);
    // Without a sink, a placeholder keeps the message readable.
    const plain = buildTrajectory(records);
    assert.deepEqual(plain!.steps[0].message[1], {
      type: "text",
      text: "[image: image/png]",
    });
  });

  void it("options are written to the root", () => {
    const trajectory = buildTrajectory(
      [
        record(1, null, "root", "DEFAULT", 0, 2),
        llm(
          2,
          0,
          1,
          [{ role: "user", content: "hi" }],
          [{ role: "assistant", content: "yo" }],
        ),
      ],
      {
        producer: { ...GOLDEN_PRODUCER },
        release: "abc123",
        projectId: "proj-1",
        exported: true,
        complete: false,
      },
    );
    assert.equal(trajectory!.agent.version, "abc123");
    const lmnr = trajectory!.extra.lmnr;
    assert.deepEqual(
      [lmnr.project_id, lmnr.exported, lmnr.complete],
      ["proj-1", true, false],
    );
  });
});

// -- normalizer -------------------------------------------------------------

void describe("lmnr-atif normalizer", () => {
  void it("splits Anthropic tool results out of user messages", () => {
    const [messages] = normalizeCall(
      [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hmm", signature: "s" },
            { type: "redacted_thinking", data: "x" },
            { type: "tool_use", id: "t1", name: "ls", input: { path: "." } },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: "a.txt",
              is_error: true,
            },
            {
              type: "text",
              text: "<system-reminder>be brief</system-reminder>",
            },
            {
              type: "text",
              text: "thanks",
              cache_control: { type: "ephemeral" },
            },
          ],
        },
      ],
      null,
    );
    assert.deepStrictEqual(messages, [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        reasoning_content: "hmm",
        tool_calls: [
          { tool_call_id: "t1", function_name: "ls", arguments: { path: "." } },
        ],
      },
      { role: "tool", tool_call_id: "t1", content: "a.txt", _is_error: true },
      {
        role: "user",
        content: [
          { type: "text", text: "<system-reminder>be brief</system-reminder>" },
          { type: "text", text: "thanks" },
        ],
      },
    ]);
  });

  void it("keeps the raw string of malformed OpenAI arguments", () => {
    const [, output, reason] = normalizeCall(
      [],
      [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "c1",
                type: "function",
                function: { name: "f", arguments: '{"a": ' },
              },
              {
                id: "c2",
                type: "function",
                function: { name: "g", arguments: "[1, 2]" },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
        { index: 1, message: { role: "assistant", content: "second choice" } },
      ],
    );
    assert.equal(reason, "tool_calls");
    assert.deepStrictEqual(output, {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          tool_call_id: "c1",
          function_name: "f",
          arguments: {},
          extra: { lmnr: { raw_arguments: '{"a": ' } },
        },
        {
          tool_call_id: "c2",
          function_name: "g",
          arguments: {},
          extra: { lmnr: { raw_arguments: "[1, 2]" } },
        },
      ],
    });
  });

  void it("merges Responses items into one assistant turn", () => {
    const [messages, output] = normalizeCall(
      [
        {
          role: "developer",
          content: [{ type: "input_text", text: "Be terse." }],
        },
        { role: "user", content: "weather?" },
        {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "look it up" }],
        },
        {
          type: "function_call",
          call_id: "c1",
          name: "weather",
          arguments: "{}",
        },
        { type: "function_call_output", call_id: "c1", output: "sunny" },
        { type: "web_search_call", id: "ws_1", status: "completed" },
      ],
      [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Sunny." }],
        },
      ],
    );
    assert.deepStrictEqual(messages, [
      { role: "developer", content: "Be terse." },
      { role: "user", content: "weather?" },
      {
        role: "assistant",
        content: "",
        reasoning_content: "look it up",
        tool_calls: [
          { tool_call_id: "c1", function_name: "weather", arguments: {} },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "sunny" },
    ]);
    assert.deepStrictEqual(output, { role: "assistant", content: "Sunny." });
  });

  void it("gives Gemini calls without ids stable ids", () => {
    const call = {
      role: "model",
      parts: [{ functionCall: { name: "add", args: { a: 1 } } }],
    };
    const response = {
      role: "user",
      parts: [{ functionResponse: { name: "add", response: { result: 2 } } }],
    };
    const [messages, output, reason] = normalizeCall(
      [{ role: "user", parts: [{ text: "add" }] }, call, response],
      [
        {
          content: {
            role: "model",
            parts: [{ function_call: { name: "add", args: { a: 2 } } }],
          },
          finishReason: "STOP",
        },
      ],
    );
    assert.equal(messages[1].tool_calls[0].tool_call_id, "add_1");
    assert.deepEqual(messages[1].tool_calls[0].extra, {
      lmnr: { synthetic_id: true },
    });
    assert.deepStrictEqual(messages[2], {
      role: "tool",
      tool_call_id: "add_1",
      content: "2",
    });
    assert.equal(output!.tool_calls[0].tool_call_id, "add_2");
    assert.equal(reason, "STOP");
  });

  void it("degrades plain strings and unknown shapes to text", () => {
    const [messages, output] = normalizeCall("just a prompt", "just an answer");
    assert.deepStrictEqual(messages, [
      { role: "user", content: "just a prompt" },
    ]);
    assert.deepStrictEqual(output, {
      role: "assistant",
      content: "just an answer",
    });
    assert.deepStrictEqual(normalizeCall(null, null), [[], null, null]);
    const [weird] = normalizeCall(
      [{ role: "user", content: { weird: true } }],
      null,
    );
    assert.deepStrictEqual(weird, [
      { role: "user", content: '{"weird": true}' },
    ]);
  });

  void it("keeps the output after a prefilled assistant turn separate", () => {
    const prefill = {
      role: "assistant",
      content: [{ type: "text", text: "{" }],
    };
    const out = {
      role: "assistant",
      content: [{ type: "text", text: '"a": 1}' }],
    };
    const [messages, message, reason] = normalizeCall(
      [{ role: "user", content: "json please" }, prefill],
      [{ ...out, stop_reason: "end_turn" }],
    );
    assert.deepStrictEqual(messages, [
      { role: "user", content: "json please" },
      { role: "assistant", content: "{" },
    ]);
    assert.deepStrictEqual(message, { role: "assistant", content: '"a": 1}' });
    assert.equal(reason, "end_turn");
  });

  void it("turns tool definitions in every shape into OpenAI functions", () => {
    const schema = { type: "object", properties: {} };
    const tools = normalizeTools([
      {
        type: "function",
        function: { name: "a", parameters: schema, strict: true },
      },
      { type: "function", name: "b", parameters: schema, strict: true },
      { name: "c", description: "C.", input_schema: schema, cache_control: {} },
      { function_declarations: [{ name: "d", parameters: schema }] },
      { name: "e", inputSchema: schema },
      { type: "web_search_20250305", name: "web_search", max_uses: 3 },
      { no: "name" },
    ]);
    assert.deepStrictEqual(tools, [
      { type: "function", function: { name: "a", parameters: schema } },
      { type: "function", function: { name: "b", parameters: schema } },
      {
        type: "function",
        function: { name: "c", description: "C.", parameters: schema },
      },
      { type: "function", function: { name: "d", parameters: schema } },
      { type: "function", function: { name: "e", parameters: schema } },
      { type: "web_search_20250305", name: "web_search", max_uses: 3 },
    ]);
    assert.deepStrictEqual(normalizeTools(null), []);
  });
});

// -- shapes only the TypeScript SDK records -----------------------------------

void describe("lmnr-atif TypeScript SDK shapes", () => {
  void it("ai sdk prompt parts", () => {
    const [messages, output] = normalizeCall(
      [
        { role: "system", content: "Be brief." },
        { role: "user", content: [{ type: "text", text: "weather?" }] },
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "use the tool" },
            {
              type: "tool-call",
              toolCallId: "c1",
              toolName: "weather",
              input: { city: "Paris" },
              providerOptions: { openai: {} },
            },
            {
              type: "tool-call",
              toolCallId: "c2",
              toolName: "weather",
              input: "{}",
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "c1",
              toolName: "weather",
              output: { type: "json", value: { temp_c: 18 } },
            },
            {
              type: "tool-result",
              toolCallId: "c2",
              toolName: "weather",
              output: { type: "error-text", value: "no city" },
            },
            {
              type: "tool-approval-response",
              approvalId: "a1",
              approved: true,
            },
          ],
        },
      ],
      [
        {
          role: "assistant",
          content: [
            { type: "source", sourceType: "url", id: "s1", url: "https://x" },
            { type: "text", text: "18C." },
          ],
        },
      ],
    );
    assert.deepStrictEqual(messages, [
      { role: "system", content: "Be brief." },
      { role: "user", content: "weather?" },
      {
        role: "assistant",
        content: "",
        reasoning_content: "use the tool",
        tool_calls: [
          {
            tool_call_id: "c1",
            function_name: "weather",
            arguments: { city: "Paris" },
          },
          { tool_call_id: "c2", function_name: "weather", arguments: {} },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: '{"temp_c": 18}' },
      { role: "tool", tool_call_id: "c2", content: "no city", _is_error: true },
    ]);
    assert.deepStrictEqual(output, { role: "assistant", content: "18C." });
  });

  const outputs: [object, unknown, boolean][] = [
    [{ type: "text", value: "done" }, "done", false],
    [{ type: "json", value: ["a", "é"] }, '["a", "é"]', false],
    [{ type: "json", value: "quoted" }, '"quoted"', false],
    [{ type: "error-json", value: { code: 1 } }, '{"code": 1}', true],
    [{ type: "execution-denied", reason: "not allowed" }, "not allowed", false],
    [
      {
        type: "content",
        value: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      },
      [
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ],
      false,
    ],
  ];
  for (const [toolOutput, content, isError] of outputs) {
    void it(`ai sdk tool result output ${JSON.stringify(toolOutput)}`, () => {
      const part = {
        type: "tool-result",
        toolCallId: "c1",
        toolName: "t",
        output: toolOutput,
      };
      const [messages] = normalizeCall(
        [{ role: "tool", content: [part] }],
        null,
      );
      const expected: Record<string, unknown> = {
        role: "tool",
        tool_call_id: "c1",
        content,
      };
      if (isError) {
        expected._is_error = true;
      }
      assert.deepStrictEqual(messages, [expected]);
    });
  }

  void it("ai sdk provider-executed tool result in output", () => {
    const [, output] = normalizeCall(
      [],
      [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "ws",
              toolName: "web_search",
              input: "{}",
              providerExecuted: true,
            },
            {
              type: "tool-result",
              toolCallId: "ws",
              toolName: "web_search",
              result: { hits: 0 },
              isError: true,
            },
          ],
        },
      ],
    );
    assert.deepStrictEqual(output, {
      role: "assistant",
      content: "",
      tool_calls: [
        { tool_call_id: "ws", function_name: "web_search", arguments: {} },
      ],
    });
  });

  void it("ai sdk file parts", () => {
    const stored: [string, string][] = [];
    const sink = (data: string, mediaType: string) => {
      stored.push([data, mediaType]);
      return "images/x.png";
    };
    const [messages] = normalizeCall(
      [
        {
          role: "user",
          content: [
            { type: "file", mediaType: "image/png", data: "iVBORw0KGgo=" },
            {
              type: "file",
              mediaType: "image/jpeg",
              data: { type: "url", url: "https://x/cat.jpg" },
            },
            {
              type: "file",
              mediaType: "image/png",
              data: { type: "data", data: "AA==" },
            },
            {
              type: "file",
              mediaType: "application/pdf",
              filename: "a.pdf",
              data: "x",
            },
          ],
        },
      ],
      null,
      sink,
    );
    assert.deepStrictEqual(stored, [
      ["iVBORw0KGgo=", "image/png"],
      ["AA==", "image/png"],
    ]);
    assert.deepStrictEqual(messages[0].content, [
      {
        type: "image",
        source: { media_type: "image/png", path: "images/x.png" },
      },
      {
        type: "image",
        source: { media_type: "image/jpeg", path: "https://x/cat.jpg" },
      },
      {
        type: "image",
        source: { media_type: "image/png", path: "images/x.png" },
      },
      { type: "text", text: "[file: a.pdf]" },
    ]);
  });

  void it("otel semconv parts", () => {
    const [messages, output, reason] = normalizeCall(
      [
        { role: "system", parts: [{ type: "text", content: "Be brief." }] },
        { role: "user", parts: [{ type: "text", content: "weather?" }] },
        {
          role: "assistant",
          parts: [
            { type: "reasoning", content: "use the tool" },
            {
              type: "tool_call",
              id: "c1",
              name: "weather",
              arguments: { city: "Paris" },
            },
          ],
        },
        {
          role: "tool",
          parts: [{ type: "tool_call_response", id: "c1", response: "18C" }],
        },
        {
          role: "user",
          parts: [
            { type: "uri", mime_type: "image/png", uri: "https://x/a.png" },
          ],
        },
      ],
      [
        {
          role: "assistant",
          parts: [{ type: "text", content: "18C." }],
          finish_reason: "stop",
        },
      ],
    );
    assert.deepStrictEqual(messages, [
      { role: "system", content: "Be brief." },
      { role: "user", content: "weather?" },
      {
        role: "assistant",
        content: "",
        reasoning_content: "use the tool",
        tool_calls: [
          {
            tool_call_id: "c1",
            function_name: "weather",
            arguments: { city: "Paris" },
          },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "18C" },
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { media_type: "image/png", path: "https://x/a.png" },
          },
        ],
      },
    ]);
    assert.deepStrictEqual(output, { role: "assistant", content: "18C." });
    assert.equal(reason, "stop");
  });

  void it("semconv tool results read result too", () => {
    // The Cohere instrumentations write `result` instead of `response`.
    const [messages] = normalizeCall(
      [
        {
          role: "tool",
          parts: [
            { type: "tool_call_response", id: "c1", result: { temp: 18 } },
          ],
        },
      ],
      null,
    );
    assert.deepStrictEqual(messages, [
      { role: "tool", tool_call_id: "c1", content: '{"temp": 18}' },
    ]);
  });

  void it("chat tool calls with top-level arguments", () => {
    const [, output] = normalizeCall(
      [],
      [
        {
          role: "model",
          content: "Checking.",
          tool_calls: [
            { id: "c1", name: "weather", arguments: '{"city": "Paris"}' },
          ],
        },
      ],
    );
    assert.ok(output !== null);
    assert.deepStrictEqual(output.tool_calls, [
      {
        tool_call_id: "c1",
        function_name: "weather",
        arguments: { city: "Paris" },
      },
    ]);
  });

  const toolAttributes: Record<string, unknown>[] = [
    { "ai.toolCall.id": "c1", "ai.toolCall.name": "lookup" },
    { "gen_ai.tool.call.id": "c1" },
    { "gen_ai.tool.name": "lookup" },
    { "ai.toolCall.name": "lookup" },
  ];
  for (const attributes of toolAttributes) {
    void it(`tool spans are matched by their tool name and call id ${JSON.stringify(attributes)}`, () => {
      // AI SDK (`ai.tool <name>`) and OTel GenAI (`execute_tool <name>`) TOOL
      // span names decorate the tool's name, so the attributes decide.
      const trajectory = buildTrajectory([
        record(1, null, "root", "DEFAULT", 0, 5),
        llm(
          2,
          0,
          1,
          [{ role: "user", content: "go" }],
          toolCallOutput("c1", "lookup", {}),
        ),
        record(3, 1, "ai.tool lookup", "TOOL", 1.1, 1.2, {
          "lmnr.span.output": '"found"',
          ...attributes,
        }),
      ]);
      assert.ok(trajectory !== null);
      assert.deepStrictEqual(
        trajectory.steps.map((s: any) => s.source),
        ["user", "agent"],
      );
      assert.deepStrictEqual(resultsOf(trajectory.steps[1]), ["found"]);
    });
  }

  void it("unmatched and implicit subagent tool spans use the tool name", () => {
    const hi = [{ role: "user", content: "hi" }];
    const yo = [{ role: "assistant", content: "yo" }];
    const helperCall = llm(5, 3, 4, hi, yo);
    const trajectory = buildTrajectory([
      record(1, null, "root", "DEFAULT", 0, 10),
      llm(2, 0, 1, hi, yo),
      record(3, 1, "execute_tool search", "TOOL", 2, 2.5, {
        "gen_ai.tool.name": "search",
      }),
      record(4, 1, "ai.tool research", "TOOL", 3, 5, {
        "ai.toolCall.name": "research",
      }),
      record(5, 4, helperCall.name, "LLM", 3, 4, helperCall.attributes),
    ]);
    assert.ok(trajectory !== null);
    const names = trajectory.steps
      .slice(2)
      .map((s: any) => s.tool_calls[0].function_name);
    assert.deepStrictEqual(names, ["search", "research"]);
    assert.equal(trajectory.subagent_trajectories[0].agent.name, "research");
  });

  void it("a failed call without output does not leak into the next input", () => {
    // A call with no output (it failed) is still an agent step, and a reader
    // adds its empty assistant message to the next call's input (§6.4). A
    // retry with the same input therefore needs an `input_messages` override.
    const ask = { role: "user", content: "What's the weather in Paris?" };
    const system = { role: "system", content: "Use the tools." };
    const error = { type: "NotFoundError", message: "404 no such model" };
    const failed = llm(2, 0, 1, [ask], null);
    delete failed.attributes["gen_ai.output.messages"];
    failed.error = error;
    const records = [
      record(1, null, "agent", "DEFAULT", 0, 5),
      failed,
      llm(3, 2, 3, [system, ask], [{ role: "assistant", content: "Sunny" }]),
      llm(4, 3, 4, [ask], [{ role: "assistant", content: "Sunny again" }]),
    ];
    const trajectory = buildTrajectory(records);
    assert.ok(trajectory !== null);
    const steps = trajectory.steps;
    const ext = TrajectoryExtension.read(trajectory);
    assert.deepStrictEqual(
      steps.map((s: any) => s.source),
      ["user", "agent", "agent", "agent"],
    );
    assert.deepStrictEqual(steps[1].extra.lmnr.error, error);
    [1, 2, 3].forEach((index, i) => {
      const [actual] = normalizeCall(
        JSON.parse(
          records[i + 1].attributes["gen_ai.input.messages"] as string,
        ),
        null,
      );
      const rebuilt = reader.inputMessages(steps, index, ext);
      assert.deepStrictEqual(
        comparable(rebuilt),
        comparable(actual),
        `${index}`,
      );
    });
  });
});

// -- Python semantics (TS only) ---------------------------------------------

void describe("lmnr-atif Python semantics", () => {
  void it("pyJsonDumps formats like json.dumps", () => {
    assert.equal(
      pyJsonDumps({ temp_c: 18, ok: true, none: null, list: [1, 2.5, "é"] }),
      '{"temp_c": 18, "ok": true, "none": null, "list": [1, 2.5, "é"]}',
    );
    assert.equal(pyJsonDumps("é", { ensureAscii: true }), '"\\u00e9"');
    assert.equal(
      pyJsonDumps("😀\u007f", { ensureAscii: true }),
      '"\\ud83d\\ude00\\u007f"',
    );
    assert.equal(pyJsonDumps("\u0001\n"), '"\\u0001\\n"');
    assert.equal(
      pyJsonDumps([1e-7, 0.0001, 1e21, 1e16]),
      "[1e-07, 0.0001, 1e+21, 10000000000000000]",
    );
    assert.equal(pyJsonDumps({}), "{}");
    assert.equal(pyJsonDumps([]), "[]");
  });

  void it("canonicalJson sorts keys by code point", () => {
    assert.equal(
      canonicalJson({ b: [1, { d: 1, c: 2 }], a: "x", "￿": 1, "😀": 2 }),
      '{"a":"x","b":[1,{"c":2,"d":1}],"￿":1,"😀":2}',
    );
  });

  void it("truthy, ==, and str follow Python", () => {
    for (const value of [null, undefined, false, 0, "", [], {}]) {
      assert.equal(truthy(value), false, JSON.stringify(value));
    }
    for (const value of [true, 1, "0", [0], { a: null }]) {
      assert.equal(truthy(value), true, JSON.stringify(value));
    }
    assert.ok(pyEquals({ a: [1, true] }, { a: [1.0, 1] }));
    assert.ok(pyEquals({ a: 1, b: 2 }, { b: 2, a: 1 }));
    assert.ok(!pyEquals("1", 1));
    assert.ok(!pyEquals(null, ""));
    assert.equal(pyStr(true), "True");
    assert.equal(pyStr(null), "None");
    assert.equal(pyStr({ a: "it's" }), `{'a': "it's"}`);
    assert.equal(pyStr([1, "x"]), "[1, 'x']");
  });
});
