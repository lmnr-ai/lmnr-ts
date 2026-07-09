import * as assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { canonicalJson, debugInputHash } from "../../src/debug/hash";
import {
  verbatimPromptMessages,
  verbatimPromptString,
} from "../../src/opentelemetry-lib/instrumentation/aisdk/v7-integration/utils";

interface HashCase {
  name: string;
  input: unknown[];
  expected_hash: string;
}

const vectors: HashCase[] = JSON.parse(
  readFileSync(
    join(__dirname, "..", "data", "debug", "input_hash_cases.json"),
    "utf-8",
  ),
).cases;

void describe("debug input hash (parity vectors)", () => {
  for (const testCase of vectors) {
    void it(testCase.name, () => {
      // Locked digest: byte-identical to the Rust app-server over the same
      // input (the fixture mirrors app-server/test/data/debug/
      // input_hash_vectors.json). A regression in canonicalization or
      // system-stripping breaks this.
      assert.strictEqual(
        debugInputHash(testCase.input),
        testCase.expected_hash,
      );
      // A hex blake3 digest is exactly 64 lowercase hex chars.
      assert.match(debugInputHash(testCase.input), /^[0-9a-f]{64}$/);
    });
  }
});

void describe("canonicalJson", () => {
  void it("sorts object keys lexicographically (recursive)", () => {
    assert.strictEqual(
      canonicalJson({ b: 1, a: { d: 2, c: 3 } }),
      '{"a":{"c":3,"d":2},"b":1}',
    );
  });

  void it("preserves array order", () => {
    assert.strictEqual(canonicalJson([3, 1, 2]), "[3,1,2]");
  });

  void it("drops undefined object values (serde skips None)", () => {
    assert.strictEqual(canonicalJson({ a: 1, b: undefined }), '{"a":1}');
  });

  void it("serializes null", () => {
    assert.strictEqual(canonicalJson(null), "null");
    assert.strictEqual(canonicalJson({ a: null }), '{"a":null}');
  });

  void it("emits no whitespace between separators", () => {
    const out = canonicalJson({ role: "user", content: "hi" });
    assert.ok(!out.includes(", ") && !out.includes(": "));
  });
});

void describe("debugInputHash system stripping", () => {
  void it("strips a non-empty leading system message", () => {
    const withSystem = [
      { role: "system", content: "be terse" },
      { role: "user", content: "hi" },
    ];
    const withoutSystem = [{ role: "user", content: "hi" }];
    assert.strictEqual(
      debugInputHash(withSystem),
      debugInputHash(withoutSystem),
    );
  });

  void it("strips an empty system message too (all-by-role semantics)", () => {
    // The coding agent may add/remove/edit its own system prompt(s) between
    // iterations — those edits must not change the cache key, so EVERY
    // role=="system" message is stripped regardless of content.
    const emptySystem = [
      { role: "system", content: "" },
      { role: "user", content: "hi" },
    ];
    const userOnly = [{ role: "user", content: "hi" }];
    assert.strictEqual(debugInputHash(emptySystem), debugInputHash(userOnly));
  });

  void it("strips repeated and trailing system messages", () => {
    const messy = [
      { role: "system", content: "first" },
      { role: "user", content: "hi" },
      { role: "system", content: [{ type: "text", text: "second" }] },
    ];
    const userOnly = [{ role: "user", content: "hi" }];
    assert.strictEqual(debugInputHash(messy), debugInputHash(userOnly));
  });

  void it("is insensitive to message-object key order", () => {
    const a = [{ role: "user", content: "x" }];
    const b = [{ content: "x", role: "user" }];
    assert.strictEqual(debugInputHash(a), debugInputHash(b));
  });
});

void describe("verbatimPromptMessages", () => {
  void it("passes the LanguageModel-level prompt through unchanged", () => {
    const prompt = [
      { role: "system", content: "be terse" },
      {
        role: "user",
        content: [
          { type: "text", text: "hello", providerOptions: { openai: {} } },
        ],
      },
    ];
    assert.deepStrictEqual(verbatimPromptMessages(prompt), prompt);
  });

  void it("base64-encodes Uint8Array file data (the only transformation)", () => {
    const prompt = [
      {
        role: "user",
        content: [
          {
            type: "file",
            mediaType: "image/png",
            data: new Uint8Array([1, 2, 3]),
          },
        ],
      },
    ];
    const messages = verbatimPromptMessages(prompt) as any[];
    assert.strictEqual(
      messages[0].content[0].data,
      Buffer.from([1, 2, 3]).toString("base64"),
    );
  });

  void it("returns null when the prompt cannot be stringified", () => {
    // A circular content object makes stringifyPromptForTelemetry's
    // JSON.stringify throw. The caller must see null (run live, no latch)
    // rather than a hash over a default payload that would force a spurious
    // MISS.
    const circular: Record<string, unknown> = { type: "text", text: "hi" };
    circular.self = circular;
    const prompt = [{ role: "user", content: [circular] }];
    assert.strictEqual(verbatimPromptMessages(prompt), null);
    assert.strictEqual(verbatimPromptString(prompt), null);
  });
});

void describe("record-time vs replay-time hash equality", () => {
  void it("recorded gen_ai.input.messages bytes hash equals replay-entry prompt hash", () => {
    // End-to-end pin: the v7 integration records
    // `gen_ai.input.messages = verbatimPromptString(promptMessages)` and the
    // replay wrapper computes
    // `debugInputHash(verbatimPromptMessages(options.prompt))`. Both flow
    // through the same serializer, so the hashes must be identical — this is
    // what keys the server-side debugger cache consistently across record and
    // replay.
    const prompt = [
      { role: "system", content: "You are a helpful assistant." },
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this image?" },
          {
            type: "file",
            mediaType: "image/png",
            data: new Uint8Array([137, 80, 78, 71]),
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "Let me look.",
            providerOptions: { anthropic: { signature: "sig" } },
          },
          {
            type: "tool-call",
            toolCallId: "call_1",
            toolName: "describe_image",
            input: { detail: "high" },
          },
        ],
      },
    ];

    // Record time: the attribute the SDK stamps on the LLM span.
    const recordedAttribute = verbatimPromptString(prompt);
    assert.ok(recordedAttribute !== null);
    const recordTimeHash = debugInputHash(
      JSON.parse(recordedAttribute) as unknown[],
    );

    // Replay time: the wrapper hashes the same prompt at doGenerate entry.
    const replayMessages = verbatimPromptMessages(prompt);
    assert.ok(replayMessages !== null);
    const replayTimeHash = debugInputHash(replayMessages);

    assert.strictEqual(recordTimeHash, replayTimeHash);
    assert.match(recordTimeHash, /^[0-9a-f]{64}$/);
  });
});
