/**
 * LLM message shapes on Laminar's copy of a Langfuse span.
 *
 * `langfuse-bridge/fixtures/js-sdk-payloads.json` holds the attributes
 * `@langfuse/openai` / `@langfuse/langchain` 6.x recorded for a real two-call
 * tool loop (a call that answers with a tool call only, then a call with the
 * tool result in its history) per integration. Encrypted reasoning blobs are
 * shortened. Same cases as lmnr-python's `test_message_shapes.py`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { translateLangfuseSpan } from "../src/opentelemetry-lib/bridges/langfuse/translate";

const PAYLOADS: Record<string, Record<string, string>[]> = JSON.parse(
  readFileSync(
    join(__dirname, "langfuse-bridge", "fixtures", "js-sdk-payloads.json"),
    "utf8",
  ),
);

const ROLES = new Set(["system", "user", "assistant", "tool"]);
const TOOL_CALL = {
  type: "tool_call",
  id: "call_1",
  name: "get_weather",
  arguments: '{"city":"Paris"}',
};

/** Laminar's copy of a generation: translation applied, removals done. */
const generation = (attrs: Record<string, string>): Record<string, any> => {
  const out: Record<string, any> = {
    "langfuse.observation.type": "generation",
    ...attrs,
  };
  const { attributes } = translateLangfuseSpan(out, undefined, "6.0.0");
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined) delete out[key];
    else out[key] = value;
  }
  return out;
};

const messages = (attrs: Record<string, any>, key: string): any[] =>
  JSON.parse(attrs[key] as string);

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : v,
  );

void describe("Langfuse bridge LLM messages", () => {
  for (const scenario of Object.keys(PAYLOADS).sort()) {
    void it(`turns the recorded ${scenario} tool loop into Laminar messages`, () => {
      const [first, second] = PAYLOADS[scenario].map(generation);
      for (const attrs of [first, second]) {
        assert.strictEqual(attrs["lmnr.span.input"], undefined);
        assert.strictEqual(attrs["lmnr.span.output"], undefined);
        assert.ok(attrs["gen_ai.tool.definitions"]);
        for (const key of ["gen_ai.input.messages", "gen_ai.output.messages"]) {
          for (const message of messages(attrs, key)) {
            assert.ok(ROLES.has(message.role), JSON.stringify(message));
            const parts = Array.isArray(message.content) ? message.content : [];
            for (const part of parts) {
              assert.ok(
                ["text", "reasoning", "tool_call"].includes(part.type),
                JSON.stringify(part),
              );
              if (part.type === "tool_call") {
                assert.deepStrictEqual(Object.keys(part).sort(), [
                  "arguments",
                  "id",
                  "name",
                  "type",
                ]);
              }
            }
          }
        }
      }

      // The first call answers with a tool call only.
      const output = messages(first, "gen_ai.output.messages");
      assert.strictEqual(output.length, 1);
      assert.strictEqual(output[0].role, "assistant");
      assert.deepStrictEqual(
        output[0].content
          .filter((p: any) => p.type !== "reasoning")
          .map((p: any) => p.type),
        ["tool_call"],
      );
      if (scenario === "openai_chat_stream") {
        // `@langfuse/openai` drops the id of a streamed tool call, so this
        // output can't match the next call's history.
        assert.strictEqual(output[0].content[0].id, null);
        return;
      }
      // ... and its output is repeated verbatim in the second call's
      // history, so app-server stores the assistant turn once.
      const history = messages(second, "gen_ai.input.messages");
      assert.ok(history.map(canonical).includes(canonical(output[0])));
      const result = history.find((m) => m.role === "tool");
      assert.strictEqual(result.tool_call_id, output[0].content.at(-1).id);
    });
  }

  void it("takes Responses API instructions and tools from the metadata", () => {
    const raw = PAYLOADS.openai_responses[0];
    const attrs = generation(raw);
    assert.deepStrictEqual(messages(attrs, "gen_ai.input.messages"), [
      { role: "system", content: "Be brief." },
      { role: "user", content: "What's the weather in Paris? Use the tool." },
    ]);
    assert.deepStrictEqual(
      messages(attrs, "gen_ai.tool.definitions"),
      JSON.parse(raw["langfuse.observation.metadata.tools"]),
    );
    for (const key of [
      "langfuse.observation.input",
      "langfuse.observation.metadata.tools",
      "langfuse.observation.metadata.instructions",
    ]) {
      assert.strictEqual(attrs[key], undefined, key);
    }
  });

  void it("merges the Responses API items of one turn", () => {
    const attrs = generation({
      "langfuse.observation.output": JSON.stringify([
        {
          id: "rs_1",
          type: "reasoning",
          summary: [{ type: "summary_text", text: "Call the tool." }],
          content: [],
          encrypted_content: "gAAAA",
        },
        {
          id: "fc_1",
          type: "function_call",
          call_id: "call_1",
          name: "get_weather",
          arguments: '{"city":"Paris"}',
          status: "completed",
        },
      ]),
    });
    assert.deepStrictEqual(messages(attrs, "gen_ai.output.messages"), [
      {
        role: "assistant",
        content: [{ type: "reasoning", text: "Call the tool." }, TOOL_CALL],
      },
    ]);
  });

  void it("turns a string output (Responses output_text, streamed text) into a message", () => {
    const attrs = generation({ "langfuse.observation.output": "Sunny." });
    assert.deepStrictEqual(messages(attrs, "gen_ai.output.messages"), [
      { role: "assistant", content: "Sunny." },
    ]);
    assert.strictEqual(attrs["langfuse.observation.output"], undefined);
  });

  void it("converts Anthropic tool_use, thinking and tool_result blocks", () => {
    const attrs = generation({
      "langfuse.observation.input": JSON.stringify([
        { role: "user", content: "weather?" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Use the tool.", signature: "s" },
            {
              type: "tool_use",
              id: "toolu_1",
              name: "get_weather",
              input: { city: "Paris" },
            },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "sunny" },
            { type: "text", text: "And tomorrow?" },
          ],
        },
      ]),
    });
    assert.deepStrictEqual(messages(attrs, "gen_ai.input.messages"), [
      { role: "user", content: "weather?" },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "Use the tool." },
          {
            type: "tool_call",
            id: "toolu_1",
            name: "get_weather",
            arguments: { city: "Paris" },
          },
        ],
      },
      { role: "tool", content: "sunny", tool_call_id: "toolu_1" },
      { role: "user", content: "And tomorrow?" },
    ]);
  });
});
