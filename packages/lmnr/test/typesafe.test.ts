// No nock recordings here: Jev is early access, so cassettes cannot be
// recorded. Responses are injected through the SDK's documented test seam
// (the `fetch` client option) with bodies matching the `/v1/systemone` wire
// shape, which the SDK still parses and validates.
import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import { context, SpanStatusCode } from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import {
  BadRequestError,
  choice,
  noul,
  score,
  TypeSafeClient,
} from "@typesafe-ai/sdk";

import {
  _resetConfiguration,
  initializeTracing,
} from "../src/opentelemetry-lib/configuration";

const MODEL = "jev-1.13.0";
const STATE =
  "I was charged twice for my annual plan. Please refund one of the charges.";

const QUESTIONS = {
  wants_refund: noul("Does the customer ask for money back?"),
  queue: choice("Which team should handle this?", {
    billing: "Charges and refunds",
    other: null,
  }),
  urgency: score("How urgent is this message?", [
    "Can wait a week",
    "This week",
    "Today",
  ]),
};

const ANSWERS = {
  wants_refund: { type: "noul", noul: 0.98 },
  queue: {
    type: "choice",
    choice: "billing",
    confidence: 0.9,
    probabilities: { billing: 0.9, other: 0.1 },
  },
  urgency: {
    type: "score",
    score: 1.7,
    confidence: 0.8,
    legend: { 0: "Can wait a week", 1: "This week", 2: "Today" },
    probabilities: { 0: 0.1, 1: 0.2, 2: 0.7 },
  },
};

const OK_BODY = {
  model: MODEL,
  usage: { input_tokens: 312, output_tokens: 48 },
  answers: ANSWERS,
};

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * The wrapper records response attributes on its own microtask chain after
 * the caller's promise resolves, so tests flush a macrotask turn before
 * reading spans.
 */
const flush = () => new Promise((resolve) => setImmediate(resolve));

void describe("typesafe instrumentation", () => {
  const exporter = new InMemorySpanExporter();

  const reinitializeTracing = (traceContent = true) => {
    _resetConfiguration();
    initializeTracing({
      exporter,
      disableBatch: true,
      traceContent,
      instrumentModules: { typesafe: TypeSafeClient },
    });
  };

  const createClient = (
    fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>,
  ) =>
    new TypeSafeClient({
      apiKey: "test-key",
      defaultModel: MODEL,
      fetch: fetchImpl ?? (() => Promise.resolve(jsonResponse(200, OK_BODY))),
    });

  const assertSpanShape = (span: any) => {
    assert.strictEqual(span.name, "typesafe.system_one");
    assert.strictEqual(span.attributes["lmnr.span.type"], "LLM");
    assert.strictEqual(span.attributes["gen_ai.system"], "typesafe");
    assert.strictEqual(span.attributes["gen_ai.response.model"], MODEL);
    assert.strictEqual(span.attributes["gen_ai.usage.input_tokens"], 312);
    assert.strictEqual(span.attributes["gen_ai.usage.output_tokens"], 48);
    assert.deepStrictEqual(
      JSON.parse(span.attributes["gen_ai.input.messages"] as string),
      [{ role: "user", content: STATE }],
    );
    assert.deepStrictEqual(
      JSON.parse(
        span.attributes["gen_ai.request.structured_output_schema"] as string,
      ),
      JSON.parse(JSON.stringify(QUESTIONS)),
    );
    const outputMessages = JSON.parse(
      span.attributes["gen_ai.output.messages"] as string,
    );
    assert.strictEqual(outputMessages[0].role, "assistant");
    assert.deepStrictEqual(JSON.parse(outputMessages[0].content), ANSWERS);
  };

  void beforeEach(() => {
    reinitializeTracing();
  });

  void afterEach(() => {
    exporter.reset();
  });

  void after(async () => {
    await exporter.shutdown();
  });

  void it("creates a system_one span", async () => {
    const result = await createClient().systemOne({
      state: STATE,
      questions: QUESTIONS,
      model: MODEL,
    });
    await flush();

    assert.strictEqual(result.answers.queue.choice, "billing");
    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assertSpanShape(spans[0]);
    assert.strictEqual(spans[0].attributes["gen_ai.request.model"], MODEL);
  });

  void it("falls back to the client default model", async () => {
    await createClient().systemOne({ state: STATE, questions: QUESTIONS });
    await flush();

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].attributes["gen_ai.request.model"], MODEL);
  });

  void it("keeps asResponse() usable", async () => {
    const response = await createClient()
      .systemOne({ state: STATE, questions: QUESTIONS })
      .asResponse();
    // The wrapper reads a clone; the caller-owned body must stay readable.
    const body = await response.json();
    await flush();

    assert.deepStrictEqual(body.answers, ANSWERS);
    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assertSpanShape(spans[0]);
  });

  void it("records errors on the span", async () => {
    const client = createClient(() =>
      Promise.resolve(
        jsonResponse(400, { error: { message: "Unknown model: jev-1.13" } }),
      ),
    );

    await assert.rejects(
      client.systemOne({
        state: STATE,
        questions: QUESTIONS,
        model: "jev-1.13",
      }),
      BadRequestError,
    );
    await flush();

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    const span = spans[0];
    assert.strictEqual(span.name, "typesafe.system_one");
    assert.strictEqual(span.status.code, SpanStatusCode.ERROR);
    assert.strictEqual(span.attributes["error.type"], "BadRequestError");
    assert.strictEqual(span.attributes["gen_ai.request.model"], "jev-1.13");
    assert.strictEqual(span.attributes["gen_ai.response.model"], undefined);
  });

  void it("respects traceContent off", async () => {
    reinitializeTracing(false);
    await createClient().systemOne({
      state: STATE,
      questions: QUESTIONS,
      model: MODEL,
    });
    await flush();

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    const span = spans[0];
    assert.strictEqual(span.attributes["gen_ai.input.messages"], undefined);
    assert.strictEqual(span.attributes["gen_ai.output.messages"], undefined);
    assert.strictEqual(
      span.attributes["gen_ai.request.structured_output_schema"],
      undefined,
    );
    assert.strictEqual(span.attributes["gen_ai.request.model"], MODEL);
    assert.strictEqual(span.attributes["gen_ai.response.model"], MODEL);
    assert.strictEqual(span.attributes["gen_ai.usage.input_tokens"], 312);
    assert.strictEqual(span.attributes["gen_ai.usage.output_tokens"], 48);
  });

  void it("does not create spans when tracing is suppressed", async () => {
    await context.with(suppressTracing(context.active()), () =>
      createClient().systemOne({
        state: STATE,
        questions: QUESTIONS,
        model: MODEL,
      }),
    );
    await flush();

    assert.strictEqual(exporter.getFinishedSpans().length, 0);
  });
});
