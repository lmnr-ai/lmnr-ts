import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import { context, SpanStatusCode, trace } from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace";

import { Laminar } from "../src";
import {
  _resetConfiguration,
  initializeTracing,
} from "../src/opentelemetry-lib/configuration";
import {
  instrumentStream,
  recordSpanError,
  safely,
  safeSetAttribute,
  settle,
  traceAsyncIterable,
  traceCall,
} from "../src/opentelemetry-lib/instrumentation/shared/utils";

const exceptionEvents = (span: { events: { name: string }[] }) =>
  span.events.filter((event) => event.name === "exception");

async function* numbers(count: number, failAt?: number) {
  for (let i = 0; i < count; i++) {
    if (i === failAt) throw new Error("stream broke");
    yield i;
  }
}

void describe("instrumentation shared utils", () => {
  const exporter = new InMemorySpanExporter();

  void beforeEach(() => {
    _resetConfiguration();
    initializeTracing({ exporter, disableBatch: true });
    Object.defineProperty(Laminar, "isInitialized", {
      value: true,
      writable: true,
    });
  });

  void afterEach(() => {
    exporter.reset();
  });

  void after(async () => {
    await exporter.shutdown();
    trace.disable();
    context.disable();
  });

  void describe("recordSpanError", () => {
    void it("records an Error's type, exception and message", () => {
      class RateLimitError extends Error {}
      const span = Laminar.startSpan({ name: "call" });
      recordSpanError(span, new RateLimitError("slow down"));
      span.end();

      const [exported] = exporter.getFinishedSpans();
      assert.strictEqual(exported.attributes["error.type"], "RateLimitError");
      assert.deepStrictEqual(exported.status, {
        code: SpanStatusCode.ERROR,
        message: "slow down",
      });
      assert.strictEqual(exceptionEvents(exported).length, 1);
    });

    void it("turns non-Error values into an Error message", () => {
      for (const [error, message] of [
        [{ message: "from field", data: 1 }, "from field"],
        ["plain string", "plain string"],
        [{ code: 42 }, '{"code":42}'],
      ] as const) {
        const span = Laminar.startSpan({ name: "call" });
        recordSpanError(span, error);
        span.end();
        const [exported] = exporter.getFinishedSpans();
        assert.strictEqual(exported.attributes["error.type"], "Error");
        assert.strictEqual(exported.status.message, message);
        exporter.reset();
      }
    });
  });

  void it("safeSetAttribute skips empty values", () => {
    const span = Laminar.startSpan({ name: "call" });
    safeSetAttribute(span, "a", undefined);
    safeSetAttribute(span, "b", null);
    safeSetAttribute(span, "c", "");
    safeSetAttribute(span, "d", []);
    safeSetAttribute(span, "e", 0);
    span.end();
    const [exported] = exporter.getFinishedSpans();
    assert.deepStrictEqual(
      ["a", "b", "c", "d", "e"].filter((key) => key in exported.attributes),
      ["e"],
    );
  });

  void it("safely swallows errors", () => {
    assert.strictEqual(
      safely(() => {
        throw new Error("boom");
      }),
      undefined,
    );
    assert.strictEqual(
      safely(() => 1),
      1,
    );
  });

  void describe("traceCall", () => {
    void it("records a rejection exactly once", async () => {
      const span = Laminar.startSpan({ name: "call" });
      await assert.rejects(
        traceCall(
          span,
          () => Promise.reject(new Error("nope")),
          () => assert.fail("onSuccess must not run"),
        ),
        /nope/,
      );
      const [exported] = exporter.getFinishedSpans();
      assert.strictEqual(exceptionEvents(exported).length, 1);
      assert.strictEqual(exported.status.code, SpanStatusCode.ERROR);
    });

    void it("records a synchronous throw exactly once", () => {
      const span = Laminar.startSpan({ name: "call" });
      assert.throws(
        () =>
          traceCall(
            span,
            () => {
              throw new Error("sync");
            },
            (data) => data,
          ),
        /sync/,
      );
      const [exported] = exporter.getFinishedSpans();
      assert.strictEqual(exceptionEvents(exported).length, 1);
    });

    void it("runs the call with the span active", async () => {
      const span = Laminar.startSpan({ name: "call" });
      const spanId = await traceCall(
        span,
        async () => Laminar.getCurrentSpan()?.spanContext().spanId,
        (data) => {
          span.end();
          return data;
        },
      );
      assert.strictEqual(spanId, span.spanContext().spanId);
    });

    void it("hands back what onSuccess returns, and survives it throwing", async () => {
      const span = Laminar.startSpan({ name: "call" });
      assert.strictEqual(
        await traceCall(
          span,
          async () => 1,
          (data) => {
            span.end();
            return data + 1;
          },
        ),
        2,
      );

      const other = Laminar.startSpan({ name: "other" });
      assert.strictEqual(
        await traceCall(
          other,
          async () => "data",
          () => {
            throw new Error("attribute bug");
          },
        ),
        "data",
      );
      assert.strictEqual(exporter.getFinishedSpans().length, 2);
    });
  });

  void describe("settle", () => {
    void it("keeps an APIPromise-like result one", async () => {
      const unwrapped: any[] = [];
      const apiPromise = {
        responsePromise: Promise.resolve(),
        _thenUnwrap(fn: (data: any) => any) {
          unwrapped.push(fn({ body: 1 }));
          return this;
        },
      };
      const result = settle(
        apiPromise,
        (data) => ({ ...data, seen: true }),
        () => assert.fail("fail must not run"),
      );
      assert.strictEqual(result, apiPromise);
      assert.deepStrictEqual(unwrapped, [{ body: 1, seen: true }]);
    });

    void it("rebuilds an HttpResponsePromise-like result through fromPromise", async () => {
      class HttpResponsePromise extends Promise<any> {
        static fromPromise(promise: Promise<any>) {
          return new HttpResponsePromise((resolve, reject) =>
            promise.then(resolve, reject),
          );
        }
        withRawResponse() {
          return Promise.resolve({ data: "body", rawResponse: { ok: true } });
        }
      }
      const original = new HttpResponsePromise((resolve) => resolve("body"));
      const result = settle(
        original,
        (data) => `${data}!`,
        () => assert.fail("fail must not run"),
      );
      assert.ok(result instanceof HttpResponsePromise);
      assert.deepStrictEqual(await result.withRawResponse(), {
        data: "body",
        rawResponse: { ok: true },
      });
      assert.deepStrictEqual(await result, {
        data: "body!",
        rawResponse: { ok: true },
      });
    });
  });

  void describe("instrumentStream", () => {
    const run = async (
      stream: any,
      consume: (stream: any) => Promise<void>,
    ): Promise<{ events: number[]; done: unknown[] }> => {
      const events: number[] = [];
      const done: unknown[] = [];
      instrumentStream<number>(stream, {
        onEvent: (event) => events.push(event),
        onDone: (error) => done.push(error),
      });
      await consume(stream);
      return { events, done };
    };

    void it("reports every event and finishes once on completion", async () => {
      const stream = { [Symbol.asyncIterator]: () => numbers(3) };
      const { events, done } = await run(stream, async (s) => {
        for await (const _ of s);
      });
      assert.deepStrictEqual(events, [0, 1, 2]);
      assert.deepStrictEqual(done, [undefined]);
    });

    void it("finishes once when the caller breaks early", async () => {
      const stream = { [Symbol.asyncIterator]: () => numbers(5) };
      const { events, done } = await run(stream, async (s) => {
        for await (const n of s) if (n === 1) break;
      });
      assert.deepStrictEqual(events, [0, 1]);
      assert.deepStrictEqual(done, [undefined]);
    });

    void it("finishes once with the error when iteration fails", async () => {
      const stream = { [Symbol.asyncIterator]: () => numbers(5, 2) };
      const { done } = await run(stream, async (s) => {
        await assert.rejects(async () => {
          for await (const _ of s);
        }, /stream broke/);
      });
      assert.strictEqual(done.length, 1);
      assert.match((done[0] as Error).message, /stream broke/);
    });

    void it("wraps the iterator field of openai / anthropic streams", async () => {
      const stream: any = {
        iterator: () => numbers(2),
        [Symbol.asyncIterator]() {
          return this.iterator();
        },
      };
      const { events } = await run(stream, async (s) => {
        for await (const _ of s);
      });
      assert.deepStrictEqual(events, [0, 1]);
    });

    void it("never throws a hook error into the caller", async () => {
      const stream = { [Symbol.asyncIterator]: () => numbers(2) };
      instrumentStream(stream, {
        onEvent: () => {
          throw new Error("event bug");
        },
        onDone: () => {
          throw new Error("done bug");
        },
      });
      const seen: number[] = [];
      for await (const n of stream) seen.push(n);
      assert.deepStrictEqual(seen, [0, 1]);
    });
  });

  void it("traceAsyncIterable reports items pulled with next()", async () => {
    const events: number[] = [];
    let finished = 0;
    const generator = traceAsyncIterable(numbers(3), {
      onEvent: (event) => events.push(event),
      onDone: () => finished++,
    });
    await generator.next();
    await generator.next();
    await generator.return(undefined);
    assert.deepStrictEqual(events, [0, 1]);
    assert.strictEqual(finished, 1);
  });
});
