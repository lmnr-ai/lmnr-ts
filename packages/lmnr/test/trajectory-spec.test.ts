/**
 * The lmnr-atif spec artifacts and reader (`src/trajectory/`). Port of the
 * Python SDK's `tests/test_lmnr_atif.py`.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import Ajv2020 from "ajv/dist/2020";

import { canonicalJson } from "../src/trajectory/py";
import * as reader from "../src/trajectory/reader";
import { TrajectoryExtension } from "../src/trajectory/reader";
import { SPEC_VERSION } from "../src/trajectory/spec";
import {
  FIXTURES,
  loadFixture,
  loadSchema,
  SPEC_DIR,
  schemaErrors,
} from "./trajectory-helpers";

const clone = <T>(value: T): T => structuredClone(value);
const doc = () => readFileSync(path.join(SPEC_DIR, "lmnr-atif.md"), "utf8");

void describe("lmnr-atif spec artifacts", () => {
  void it("has fixtures", () => {
    assert.ok(FIXTURES.length >= 4);
  });

  void it("spec version matches every artifact", () => {
    assert.equal(loadSchema().$id, `urn:lmnr-atif:${SPEC_VERSION}`);
    assert.ok(doc().includes(`- **Spec version:** ${SPEC_VERSION}\n`));
    assert.ok(doc().includes(`### ${SPEC_VERSION}\n`));
    for (const name of FIXTURES) {
      const trajectory = loadFixture(name);
      assert.equal(trajectory.extra.lmnr.spec_version, SPEC_VERSION, name);
      for (const sub of trajectory.subagent_trajectories ?? []) {
        assert.equal(sub.extra.lmnr.spec_version, SPEC_VERSION, name);
      }
    }
  });

  void it("schema is a valid draft 2020-12 JSON schema", () => {
    const ajv = new Ajv2020({ strict: false });
    assert.equal(ajv.validateSchema(loadSchema()), true, ajv.errorsText());
  });

  for (const name of FIXTURES) {
    void it(`fixture ${name} matches the schema`, () => {
      assert.deepEqual(schemaErrors(loadFixture(name)), []);
    });
  }

  void it("schema rejects unknown keys and other versions", () => {
    const base = loadFixture("basic-agent-loop.json");

    const typo = clone(base);
    const lmnr = typo.steps[2].extra.lmnr;
    lmnr.start = lmnr.start_time;
    delete lmnr.start_time;
    assert.notDeepEqual(schemaErrors(typo), []);

    const newer = clone(base);
    newer.extra.lmnr.spec_version = "0.2.0";
    assert.notDeepEqual(schemaErrors(newer), []);

    const noProducer = clone(base);
    delete noProducer.extra.lmnr.producer;
    assert.notDeepEqual(schemaErrors(noProducer), []);

    const badTime = clone(base);
    badTime.steps[2].extra.lmnr.end_time = "2026-10-28T12:00:01Z";
    assert.notDeepEqual(schemaErrors(badTime), []);
  });

  void it("schema checks step fields by step kind", () => {
    const base = loadFixture("errors-and-dispatch.json");
    // `synthetic` belongs to `llm_call_count: 0` steps only.
    const llmStep = clone(base);
    llmStep.steps[1].extra.lmnr.synthetic = true;
    assert.notDeepEqual(schemaErrors(llmStep), []);
    // A message step can't carry LLM-call fields.
    const userStep = clone(base);
    userStep.steps[0].extra.lmnr.provider = "openai";
    assert.notDeepEqual(schemaErrors(userStep), []);
  });

  void it("fixture def keys are sha256 of canonical JSON", () => {
    // Keys are opaque to readers, but our fixtures follow the SHOULD in §6.6.
    for (const name of FIXTURES) {
      const defs = loadFixture(name).extra.lmnr.defs ?? {};
      for (const table of Object.values<Record<string, unknown>>(defs)) {
        for (const [key, value] of Object.entries(table)) {
          const hash = bytesToHex(sha256(utf8ToBytes(canonicalJson(value))));
          assert.equal(key, `sha256:${hash}`);
        }
      }
    }
  });

  void it("doc field tables match the schema", () => {
    // Every key in the doc's field tables is in the schema, and vice versa.
    const defs = loadSchema().$defs;
    const sections: Record<string, string> = {
      "### 4.1": "trajectoryLmnr",
      "### 4.2": "llmStepLmnr",
      "### 4.3": "syntheticStepLmnr",
      "### 4.4": "messageStepLmnr",
      "### 4.5": "toolCallLmnr",
      "### 4.6": "observationResultLmnr",
      "### 4.7": "metricsLmnr",
      "### 4.8": "finalMetricsLmnr",
      "### 4.9": "subagentRefLmnr",
    };
    for (const [heading, name] of Object.entries(sections)) {
      const section = doc()
        .split(heading)[1]
        .split("\n### ")[0]
        .split("\n## ")[0];
      const documented = new Set<string>();
      for (const [, cell] of section.matchAll(/^\| ([^|]+) \|/gm)) {
        for (const [, key] of cell.matchAll(/`([a-z_]+)`/g)) {
          documented.add(key);
        }
      }
      assert.deepEqual(
        [...documented].sort(),
        Object.keys(defs[name].properties).sort(),
        heading,
      );
    }
  });
});

void describe("lmnr-atif versioning", () => {
  const cases: [unknown, string, boolean][] = [
    ["0.1.0", "0.1.0", true],
    ["0.1.7", "0.1.0", true],
    ["0.1.0", "0.1.3", true],
    ["0.2.0", "0.1.0", false],
    ["0.0.9", "0.1.0", false],
    ["1.0.0", "0.1.0", false],
    ["1.4.2", "1.0.0", true],
    ["2.0.0", "1.9.0", false],
    ["0.1.0-rc.1", "0.1.0", true],
    ["0.1", "0.1.0", false],
    ["lmnr-atif/1", "0.1.0", false],
    [null, "0.1.0", false],
    [1, "0.1.0", false],
  ];
  for (const [version, reference, expected] of cases) {
    void it(`isCompatible(${JSON.stringify(version)}, ${reference})`, () => {
      assert.equal(reader.isCompatible(version, reference), expected);
    });
  }

  void it("read returns null for plain or unreadable ATIF", () => {
    const base = loadFixture("basic-agent-loop.json");
    assert.notEqual(TrajectoryExtension.read(base), null);

    const plain = clone(base);
    delete plain.extra;
    assert.equal(TrajectoryExtension.read(plain), null);

    const newer = clone(base);
    newer.extra.lmnr.spec_version = "0.2.0";
    assert.equal(TrajectoryExtension.read(newer), null);

    const missing = clone(base);
    delete missing.extra.lmnr.spec_version;
    assert.equal(TrajectoryExtension.read(missing), null);

    const oldAtif = clone(base);
    oldAtif.schema_version = "ATIF-v1.6";
    assert.equal(TrajectoryExtension.read(oldAtif), null);

    assert.equal(TrajectoryExtension.read("not a trajectory"), null);
  });

  void it("subagent inherits the parent's version and defs", () => {
    const base = loadFixture("subagents.json");
    const root = TrajectoryExtension.read(base);
    assert.notEqual(root, null);

    const researcher = clone(base.subagent_trajectories[0]);
    delete researcher.extra.lmnr.spec_version;
    const sub = TrajectoryExtension.read(researcher, root);
    assert.notEqual(sub, null);
    assert.equal(sub!.specVersion, SPEC_VERSION);
    assert.equal(TrajectoryExtension.read(researcher), null);

    // The researcher's `$ref` lives in the root's defs (§6.6 ancestor lookup).
    const tools = reader.toolDefinitions(researcher, researcher.steps[2], sub);
    assert.notEqual(tools, null);
    assert.deepEqual(
      tools!.map((t) => t.function.name),
      ["web_search"],
    );

    const bare = { steps: [{ step_id: 1, source: "user", message: "hi" }] };
    assert.notEqual(TrajectoryExtension.read(bare, root), null);
  });

  void it("an unresolved ref is absent", () => {
    const ext = TrajectoryExtension.read(loadFixture("overrides.json"))!;
    assert.equal(
      ext.resolve({ $ref: "sha256:missing" }, "system_prompts"),
      undefined,
    );
    assert.equal(ext.resolve("inline", "system_prompts"), "inline");
    assert.equal(ext.resolve(null, "system_prompts"), null);
  });
});

void describe("lmnr-atif resolution", () => {
  void it("resolves the system prompt", () => {
    const base = loadFixture("overrides.json");
    const ext = TrajectoryExtension.read(base);
    const steps = reader.stepsOf(base);
    assert.equal(reader.leadingSystemCount(steps), 2);

    // Default: the leading system steps, one message each, roles preserved.
    assert.deepEqual(reader.systemPrompt(steps, 3, ext), [
      { role: "system", content: "You are a travel agent." },
      { role: "developer", content: "Always quote prices in EUR." },
    ]);
    // Override through a $ref; not sticky.
    assert.deepEqual(reader.systemPrompt(steps, 4, ext), [
      {
        role: "system",
        content:
          base.extra.lmnr.defs.system_prompts[
            base.steps[4].extra.lmnr.system_prompt.$ref
          ],
      },
    ]);
    assert.equal(reader.systemPrompt(steps, 6, ext).length, 2);
    // A mid-history system step (step 8) never changes the system prompt.
    assert.equal(reader.systemPrompt(steps, 9, ext).length, 2);

    // Plain ATIF ignores overrides and keeps roles as `system`.
    assert.deepEqual(reader.systemPrompt(steps, 4, null), [
      { role: "system", content: "You are a travel agent." },
      { role: "system", content: "Always quote prices in EUR." },
    ]);
  });

  void it("an explicit empty system prompt and tool set", () => {
    const base = loadFixture("overrides.json");
    base.steps[4].extra.lmnr.system_prompt = "";
    const ext = TrajectoryExtension.read(base);
    const steps = reader.stepsOf(base);
    assert.deepEqual(reader.systemPrompt(steps, 4, ext), []);
    // Step 5 offers no tools (`[]`), unlike the agent default.
    assert.deepEqual(reader.toolDefinitions(base, steps[4], ext), []);
    assert.deepEqual(
      reader.toolDefinitions(base, steps[4], null),
      base.agent.tool_definitions,
    );
  });

  void it("resolves tool definitions", () => {
    const base = loadFixture("overrides.json");
    const ext = TrajectoryExtension.read(base);
    const steps = reader.stepsOf(base);
    const names = (tools: any[] | null) => tools!.map((t) => t.function.name);
    assert.deepEqual(names(reader.toolDefinitions(base, steps[3], ext)), [
      "search_flights",
      "search_hotels",
    ]);
    assert.deepEqual(names(reader.toolDefinitions(base, steps[6], ext)), [
      "search_hotels",
    ]);

    const noTools = { agent: { name: "a", version: "1" }, steps: [] };
    assert.equal(
      reader.toolDefinitions(noTools, { source: "agent" }, null),
      null,
    );
  });

  void it("input messages from history", () => {
    const base = loadFixture("basic-agent-loop.json");
    const ext = TrajectoryExtension.read(base);
    const steps = reader.stepsOf(base);
    const messages = reader.inputMessages(steps, 3, ext);
    assert.deepEqual(
      messages.map((m) => m.role),
      ["system", "user", "assistant", "tool"],
    );
    const assistant = messages[2];
    assert.equal(assistant.content, "");
    assert.ok(
      assistant.reasoning_content.startsWith("The user wants a refund"),
    );
    assert.equal(assistant.tool_calls[0].function_name, "get_order");
    assert.deepEqual(messages[3], {
      role: "tool",
      tool_call_id: "toolu_01",
      content: '{"order_id": "A-1042", "status": "shipped"}',
    });
    assert.deepEqual(
      reader.inputMessages(steps, 2, ext).map((m) => m.role),
      ["system", "user"],
    );
  });

  void it("an input_messages override replaces the history", () => {
    const base = loadFixture("overrides.json");
    const ext = TrajectoryExtension.read(base);
    const steps = reader.stepsOf(base);
    const messages = reader.inputMessages(steps, 9, ext);
    assert.deepEqual(messages, [
      { role: "system", content: "You are a travel agent." },
      { role: "developer", content: "Always quote prices in EUR." },
      {
        role: "system",
        content: "Earlier turns were compacted into a summary.",
      },
      { role: "user", content: base.steps[8].message },
    ]);
    // A plain-ATIF reader gets the whole linear history instead.
    const plain = reader.inputMessages(steps, 9, null);
    assert.ok(plain.length > messages.length);
    assert.deepEqual(plain.slice(-2), [
      {
        role: "system",
        content: "Earlier turns were compacted into a summary.",
      },
      { role: "user", content: base.steps[8].message },
    ]);
  });

  void it("an input_messages override is the base for later steps", () => {
    // A step after an override extends it, not the whole history (§6.4).
    const base = loadFixture("overrides.json");
    const ext = TrajectoryExtension.read(base);
    const steps = reader.stepsOf(base);
    assert.equal("input_messages" in steps[11].extra.lmnr, false);
    assert.deepEqual(reader.inputMessages(steps, 11, ext), [
      { role: "system", content: "You are a travel agent." },
      { role: "developer", content: "Always quote prices in EUR." },
      {
        role: "system",
        content: "Earlier turns were compacted into a summary.",
      },
      { role: "user", content: base.steps[8].message },
      { role: "assistant", content: base.steps[9].message },
      { role: "user", content: "Any cheaper one?" },
    ]);
    // Steps before the override still see the whole history.
    assert.equal(reader.inputMessages(steps, 6, ext).length, 7);
  });

  void it("synthetic steps add no messages", () => {
    const base = loadFixture("errors-and-dispatch.json");
    const ext = TrajectoryExtension.read(base);
    const steps = reader.stepsOf(base);
    assert.ok(reader.isSynthetic(steps[2], ext));
    assert.deepEqual(reader.stepMessages(steps[2], ext), []);
    assert.deepEqual(
      reader.inputMessages(steps, 3, ext).map((m) => m.role),
      ["user", "assistant", "tool", "tool"],
    );
    // Without the extension, the dispatch step looks like any agent step.
    assert.equal(reader.inputMessages(steps, 3, null).length, 6);
  });

  void it("an observation without a call id is a user message", () => {
    const step = {
      step_id: 1,
      source: "agent",
      message: "ls",
      observation: { results: [{ content: "file.txt" }] },
    };
    assert.deepEqual(reader.stepMessages(step, null), [
      { role: "assistant", content: "ls" },
      { role: "user", content: "file.txt" },
    ]);
  });
});

void describe("lmnr-atif errors and usage", () => {
  void it("reads step and tool errors", () => {
    const base = loadFixture("errors-and-dispatch.json");
    const ext = TrajectoryExtension.read(base);
    const steps = reader.stepsOf(base);
    assert.equal(reader.stepError(steps[1], ext), null);
    assert.deepEqual(reader.stepError(steps[3], ext), {
      type: "RateLimitError",
      message: "Error code: 429 - rate_limit_error",
    });
    assert.equal(reader.stepError(steps[3], null), null);

    const results = reader.observationResults(steps[1]);
    assert.deepEqual(reader.resultError(results[0], ext), {
      type: "TimeoutError",
      message: "tests did not finish in 60s",
    });
    assert.equal(
      reader.resultError(reader.observationResults(steps[2])[0], ext),
      null,
    );
  });

  for (const flag of ["tool_result_is_error", "is_error"]) {
    void it(`reads tool errors from Harbor's ${flag}`, () => {
      const result = {
        source_call_id: "c1",
        content: "boom",
        extra: { [flag]: true },
      };
      assert.deepEqual(reader.resultError(result, null), {
        type: "ToolError",
        message: "",
      });
      assert.equal(
        reader.resultError({ ...result, extra: { [flag]: false } }, null),
        null,
      );
    });
  }

  void it("reads usage with fallbacks", () => {
    const base = loadFixture("basic-agent-loop.json");
    const ext = TrajectoryExtension.read(base);
    const metrics = base.steps[2].metrics;
    assert.deepEqual(reader.usageExtension(metrics, ext), {
      cache_creation_tokens: 300,
      input_cost_usd: 0.00132,
      output_cost_usd: 0.00096,
    });
    assert.deepEqual(reader.usageExtension(metrics, null), {});

    const harborMetrics = {
      prompt_tokens: 10,
      extra: { reasoning_tokens: 7, cache_creation_input_tokens: 3 },
    };
    assert.deepEqual(reader.usageExtension(harborMetrics, null), {
      reasoning_tokens: 7,
      cache_creation_tokens: 3,
    });
    assert.deepEqual(reader.usageExtension(null, ext), {});
  });
});
