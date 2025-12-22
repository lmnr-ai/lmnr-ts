import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import { context, trace } from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";

import { Laminar, observeDecorator } from "../src";
import { _resetConfiguration, initializeTracing } from "../src/opentelemetry-lib/configuration";

void describe("observeDecorator", () => {
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

  void it("throws error when applied to a property", () => {
    assert.throws(() => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      class TestClass {
        // @ts-expect-error - Testing runtime error for invalid decorator usage
        @observeDecorator({ name: "testProperty" })
        public testProperty: string = "test value";
      }
    }, {
      name: "Error",
      message: "observeDecorator can only be applied to methods. Applied to: testProperty",
    });
  });

  void it("decorates async methods with basic configuration", async () => {
    class TestService {
      @observeDecorator({ name: "asyncMethod", spanType: "LLM" })
      public async asyncMethod(input: number): Promise<number> {
        await new Promise(resolve => setTimeout(resolve, 10));
        return input * 2;
      }
    }

    const service = new TestService();
    const result = await service.asyncMethod(5);

    assert.strictEqual(result, 10);

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].name, "asyncMethod");
    assert.strictEqual(spans[0].attributes["lmnr.span.type"], "LLM");
    assert.strictEqual(spans[0].attributes["lmnr.span.input"], JSON.stringify([5]));
    assert.strictEqual(spans[0].attributes["lmnr.span.output"], JSON.stringify(10));
  });

  void it("uses method name as default span name", async () => {
    class TestService {
      @observeDecorator({})
      public async methodWithoutName(): Promise<string> {
        return Promise.resolve("result");
      }
    }

    const service = new TestService();
    const result = await service.methodWithoutName();

    assert.strictEqual(result, "result");

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].name, "methodWithoutName");
  });

  void it("sets metadata, tags, and session info", async () => {
    class TestService {
      @observeDecorator({
        name: "metadataMethod",
        metadata: { version: "1.0", model: "gpt-4" },
        tags: ["test", "metadata"],
        sessionId: "test-session-123",
        userId: "user-456",
      })
      public async metadataMethod(): Promise<string> {
        return Promise.resolve("metadata test");
      }
    }

    const service = new TestService();
    const result = await service.metadataMethod();

    assert.strictEqual(result, "metadata test");

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    const attrs = spans[0].attributes;
    assert.strictEqual(attrs["lmnr.association.properties.metadata.version"], "1.0");
    assert.strictEqual(attrs["lmnr.association.properties.metadata.model"], "gpt-4");
    assert.deepStrictEqual(attrs["lmnr.association.properties.tags"], ["test", "metadata"]);
    assert.strictEqual(attrs["lmnr.association.properties.session_id"], "test-session-123");
    assert.strictEqual(attrs["lmnr.association.properties.user_id"], "user-456");
  });

  void it("supports dynamic configuration function", async () => {
    class TestService {
      @observeDecorator((_thisArg, operation, ...values) => ({
        name: `math_${operation as string}`,
        spanType: "TOOL" as const,
        metadata: {
          operation: operation as string,
          valueCount: (values as number[]).length,
        },
        tags: ["math", operation as string],
      }))
      public async performMath(operation: string, ...values: number[]): Promise<number> {
        return Promise.resolve(operation === "sum"
          ? values.reduce((a, b) => a + b, 0)
          : values.reduce((a, b) => a * b, 1));
      }
    }

    const service = new TestService();
    const result = await service.performMath("sum", 1, 2, 3);

    assert.strictEqual(result, 6);

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].name, "math_sum");
    const attrs = spans[0].attributes;
    assert.strictEqual(attrs["lmnr.association.properties.metadata.operation"], "sum");
    assert.strictEqual(attrs["lmnr.association.properties.metadata.valueCount"], 3);
    assert.deepStrictEqual(attrs["lmnr.association.properties.tags"], ["math", "sum"]);
  });

  void it("handles exceptions in decorated methods", async () => {
    class TestService {
      @observeDecorator({ name: "errorMethod" })
      public errorMethod(): never {
        throw new Error("Test error");
      }
    }

    const service = new TestService();

    await assert.rejects(
      () => service.errorMethod(),
      (error: Error) => {
        assert.strictEqual(error.message, "Test error");
        return true;
      },
    );

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].name, "errorMethod");
    assert.strictEqual(spans[0].events.length, 1);
    assert.strictEqual(spans[0].events[0].name, "exception");
  });

  void it("ignores input and output when configured", async () => {
    class TestService {
      @observeDecorator({
        name: "ignoreMethod",
        ignoreInput: true,
        ignoreOutput: true,
      })
      public async ignoreMethod(): Promise<string> {
        return Promise.resolve("sensitive result");
      }
    }

    const service = new TestService();
    const result = await service.ignoreMethod();

    assert.strictEqual(result, "sensitive result");

    const spans = exporter.getFinishedSpans();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].attributes["lmnr.span.input"], undefined);
    assert.strictEqual(spans[0].attributes["lmnr.span.output"], undefined);
  });
});
