import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";

import { Laminar } from "../src/index";

void describe("initialize", () => {
  const originalEnv = process.env;
  void beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.LMNR_PROJECT_API_KEY;
    delete process.env.LMNR_BASE_URL;
    delete process.env.OTEL_ENDPOINT;
    delete process.env.OTEL_HEADERS;
    delete process.env.OTEL_PROTOCOL;
    delete process.env.OTEL_EXPORTER;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS;
  });
  void afterEach(async () => {
    process.env = originalEnv;
    await Laminar.shutdown();
  });

  void it("initializes", () => {
    Laminar.initialize({
      projectApiKey: "test",
    });

    assert.strictEqual(Laminar.initialized(), true);
  });

  void it("throws an error if projectApiKey is not provided", () => {
    assert.throws(() => Laminar.initialize({}), Error);
  });
});
