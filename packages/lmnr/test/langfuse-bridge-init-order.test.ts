/**
 * `Laminar.initialize({ bridges: ["langfuse"] })` before `@langfuse/tracing`
 * has run: the bridge creates Langfuse's global slot itself and Langfuse
 * adopts it. Its own file, so no `@langfuse/*` module is loaded before the
 * bridge installs.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";

import { Laminar, LaminarSpanProcessor } from "../src/index";

const LANGFUSE_GLOBAL_SYMBOL = Symbol.for("langfuse");

void describe("Langfuse bridge before @langfuse/tracing loads", () => {
  after(async () => {
    if (Laminar.initialized()) await Laminar.shutdown();
  });

  void it("creates Langfuse's slot, which Langfuse then uses", async () => {
    assert.strictEqual((globalThis as any)[LANGFUSE_GLOBAL_SYMBOL], undefined);
    const laminarExporter = new InMemorySpanExporter();
    Laminar.initialize({
      projectApiKey: "test",
      spanProcessor: new LaminarSpanProcessor({
        exporter: laminarExporter,
        disableBatch: true,
      }),
      bridges: ["langfuse"],
    });
    assert.ok((globalThis as any)[LANGFUSE_GLOBAL_SYMBOL]);

    const { setLangfuseTracerProvider, startActiveObservation } = await import(
      "@langfuse/tracing"
    );
    const langfuseExporter = new InMemorySpanExporter();
    setLangfuseTracerProvider(
      new TracerProvider({
        spanProcessors: [
          new SimpleSpanProcessor({ exporter: langfuseExporter }),
        ],
      }) as any,
    );
    await startActiveObservation("lf-root", async () => undefined);
    await Laminar.flush();

    const [exported] = langfuseExporter.getFinishedSpans();
    assert.strictEqual(exported?.name, "lf-root");
    assert.strictEqual(exported.attributes["lmnr.span.bridge.name"], undefined);
    const mirrored = laminarExporter
      .getFinishedSpans()
      .find((s) => s.name === "lf-root");
    assert.ok(mirrored, "lf-root did not reach Laminar");
    assert.strictEqual(
      mirrored.attributes["lmnr.span.bridge.name"],
      "langfuse",
    );
  });
});
