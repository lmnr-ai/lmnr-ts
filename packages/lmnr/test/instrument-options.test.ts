import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  getExplicitInstrumentOption,
  getInstrumentOption,
  type InstrumentOptions,
  instrumentOptionEnvVar,
  resetInstrumentOptions,
  resolveInstrumentOptions,
  setInstrumentOptions,
} from "../src/opentelemetry-lib/tracing/instrument-options";

const resolve = (
  options?: InstrumentOptions,
  env: Record<string, string | undefined> = {},
) => {
  const warnings: string[] = [];
  const resolved = resolveInstrumentOptions(options, env, (message) =>
    warnings.push(message),
  );
  return { resolved, warnings };
};

void describe("instrumentOptions", () => {
  void afterEach(() => {
    delete process.env.LMNR_LANGGRAPH_RECORD_GRAPH;
    resetInstrumentOptions();
  });

  void it("derives env var names from instrument and option", () => {
    assert.equal(
      instrumentOptionEnvVar("langchain", "recordMetadata"),
      "LMNR_LANGCHAIN_RECORD_METADATA",
    );
    assert.equal(
      instrumentOptionEnvVar("temporal", "createActivitySpan"),
      "LMNR_TEMPORAL_CREATE_ACTIVITY_SPAN",
    );
  });

  void it("keeps only explicitly set values", () => {
    const { resolved, warnings } = resolve();
    assert.deepEqual(resolved, {});
    assert.deepEqual(warnings, []);
  });

  void it("parses boolean env values", () => {
    const { resolved, warnings } = resolve(undefined, {
      LMNR_LANGCHAIN_RECORD_METADATA: " Yes ",
      LMNR_LANGGRAPH_RECORD_GRAPH: "0",
      LMNR_TEMPORAL_CREATE_ACTIVITY_SPAN: "OFF",
      LMNR_TEMPORAL_RECORD_ACTIVITY_ARGS: "1",
      LMNR_TEMPORAL_RECORD_ACTIVITY_OUTPUT: "",
    });
    assert.deepEqual(resolved, {
      langchain: { recordMetadata: true },
      langgraph: { recordGraph: false },
      temporal: { createActivitySpan: false, recordActivityArgs: true },
    });
    assert.deepEqual(warnings, []);
  });

  void it("warns on and ignores a non-boolean env value", () => {
    const { resolved, warnings } = resolve(undefined, {
      LMNR_LANGGRAPH_RECORD_GRAPH: "maybe",
    });
    assert.deepEqual(resolved, {});
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /LMNR_LANGGRAPH_RECORD_GRAPH=maybe/);
  });

  void it("prefers initialize options over env", () => {
    const { resolved } = resolve(
      { langgraph: { recordGraph: true } },
      {
        LMNR_LANGGRAPH_RECORD_GRAPH: "false",
        LMNR_LANGCHAIN_RECORD_METADATA: "true",
      },
    );
    assert.deepEqual(resolved, {
      langchain: { recordMetadata: true },
      langgraph: { recordGraph: true },
    });
  });

  void it("warns on and ignores unknown or invalid options", () => {
    const { resolved, warnings } = resolve({
      langchain: { recordMetadata: "yes", recordEverything: true },
      openai: { recordStuff: true },
      langgraph: true,
      temporal: { recordActivityArgs: undefined },
    } as any);
    assert.deepEqual(resolved, {});
    assert.equal(warnings.length, 4);
    assert.ok(warnings.some((w) => w.includes("langchain.recordMetadata")));
    assert.ok(warnings.some((w) => w.includes("langchain.recordEverything")));
    assert.ok(warnings.some((w) => w.includes("instrumentOptions.openai")));
    assert.ok(warnings.some((w) => w.includes("instrumentOptions.langgraph")));
  });

  void it("applies defaults to unset options", () => {
    setInstrumentOptions({ temporal: { recordActivityArgs: false } });
    assert.equal(getInstrumentOption("langchain", "recordMetadata"), false);
    assert.equal(getInstrumentOption("langgraph", "recordGraph"), true);
    assert.equal(getInstrumentOption("temporal", "recordActivityArgs"), false);
    assert.equal(getInstrumentOption("temporal", "createActivitySpan"), true);
    assert.equal(
      getExplicitInstrumentOption("temporal", "createActivitySpan"),
      undefined,
    );
  });

  void it("reads the env lazily when initialize never ran, and again after a reset", () => {
    process.env.LMNR_LANGGRAPH_RECORD_GRAPH = "false";
    assert.equal(getInstrumentOption("langgraph", "recordGraph"), false);

    setInstrumentOptions({ langgraph: { recordGraph: true } });
    assert.equal(getInstrumentOption("langgraph", "recordGraph"), true);

    resetInstrumentOptions();
    delete process.env.LMNR_LANGGRAPH_RECORD_GRAPH;
    assert.equal(getInstrumentOption("langgraph", "recordGraph"), true);
  });
});
