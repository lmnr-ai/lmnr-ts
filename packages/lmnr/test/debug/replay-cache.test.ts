import * as assert from "node:assert";
import { describe, it } from "node:test";

import { CachedSpan } from "@lmnr-ai/types";

import { ReplayCache } from "../../src/debug/replay-cache";

const payloads = (n: number): CachedSpan[] =>
  Array.from(
    { length: n },
    (_, i) => ({ output: `resp-${i}` }) as unknown as CachedSpan,
  );

void describe("ReplayCache", () => {
  void it("replays first N occurrences in order", () => {
    const cache = new ReplayCache("loop.llm", 3, payloads(5));

    const seen: (CachedSpan | undefined)[] = [];
    for (let i = 0; i < 3; i++) {
      seen.push(cache.getCached("loop.llm", i));
    }

    assert.deepStrictEqual(seen, [
      { output: "resp-0" },
      { output: "resp-1" },
      { output: "resp-2" },
    ]);
  });

  void it("returns undefined for non-spine path", () => {
    const cache = new ReplayCache("loop.llm", 3, payloads(3));
    assert.strictEqual(cache.getCached("other.path", 0), undefined);
  });

  void it("returns undefined past cache_until", () => {
    const cache = new ReplayCache("loop.llm", 2, payloads(5));
    assert.deepStrictEqual(cache.getCached("loop.llm", 1), {
      output: "resp-1",
    });
    assert.strictEqual(cache.getCached("loop.llm", 2), undefined);
  });

  void it("returns undefined when fewer payloads than cache_until", () => {
    const cache = new ReplayCache("loop.llm", 5, payloads(2));
    assert.deepStrictEqual(cache.getCached("loop.llm", 0), {
      output: "resp-0",
    });
    assert.deepStrictEqual(cache.getCached("loop.llm", 1), {
      output: "resp-1",
    });
    assert.strictEqual(cache.getCached("loop.llm", 2), undefined);
  });

  void it("truncates payloads to cache_until", () => {
    const cache = new ReplayCache("loop.llm", 2, payloads(5));
    assert.deepStrictEqual(cache.getCached("loop.llm", 0), {
      output: "resp-0",
    });
    assert.deepStrictEqual(cache.getCached("loop.llm", 1), {
      output: "resp-1",
    });
    assert.strictEqual(cache.getCached("loop.llm", 2), undefined);
  });
});
