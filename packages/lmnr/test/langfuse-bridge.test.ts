/**
 * Langfuse → Laminar bridge (`Laminar.initialize({ bridges: ["langfuse"] })`)
 * on the @langfuse/* 6.x devDependencies. The shared suite is in
 * `langfuse-bridge/suite.ts`; `langfuse-bridge-v5.test.ts` and
 * `langfuse-bridge-v4.test.ts` run it on the older majors. The translation
 * tests below need no SDK and run once.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as core from "@langfuse/core";
import * as langchain from "@langfuse/langchain";
import * as openai from "@langfuse/openai";
import * as otel from "@langfuse/otel";
import * as tracing from "@langfuse/tracing";
import OpenAI from "openai";

import { LLM_INSTRUMENTATIONS } from "../src/opentelemetry-lib/bridges";
import {
  costAttributes,
  translateLangfuseSpan,
  usageAttributes,
} from "../src/opentelemetry-lib/bridges/langfuse/translate";
import { initializeLaminarInstrumentations } from "../src/opentelemetry-lib/tracing/instrumentations";
import { langfuseBridgeSuite } from "./langfuse-bridge/suite";

langfuseBridgeSuite({ major: 6, core, tracing, otel, openai, langchain });

void describe("Langfuse bridge instrumentations", () => {
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
