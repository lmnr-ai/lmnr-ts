import * as assert from "node:assert";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

import { CachedSpan } from "@lmnr-ai/types";

import { DebugConfig } from "../../src/debug/config";
import {
  awaitCacheReady,
  DebugRuntime,
  getRuntime,
  initDebugRuntime,
  resetDebugRuntime,
} from "../../src/debug/index";
import { ReplayCache } from "../../src/debug/replay-cache";
import { SqlQuery } from "../../src/debug/source-trace";

class FakeSql implements SqlQuery {
  private metadataRows: Record<string, any>[];
  private payloadRows: Record<string, any>[];

  constructor(
    metadataRows: Record<string, any>[],
    payloadRows: Record<string, any>[],
  ) {
    this.metadataRows = metadataRows;
    this.payloadRows = payloadRows;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async query(sql: string): Promise<Array<Record<string, any>>> {
    if (sql.includes("span_type, start_time")) {
      const rows = this.metadataRows;
      this.metadataRows = [];
      return rows;
    }
    const rows = this.payloadRows;
    this.payloadRows = [];
    return rows;
  }
}

class BoomSql implements SqlQuery {
  // eslint-disable-next-line @typescript-eslint/require-await
  async query(): Promise<Array<Record<string, any>>> {
    throw new Error("network down");
  }
}

const config = (overrides: Partial<DebugConfig> = {}): DebugConfig => ({
  sessionId: "s",
  replayTraceId: "r",
  cacheUntil: 2,
  ...overrides,
});

const DEBUG_ENV_KEYS = [
  "LMNR_DEBUG",
  "LMNR_DEBUG_SESSION_ID",
  "LMNR_DEBUG_REPLAY_TRACE_ID",
  "LMNR_DEBUG_CACHE_UNTIL",
];

const clearDebugEnv = () => {
  for (const key of DEBUG_ENV_KEYS) {
    delete process.env[key];
  }
};

const originalLog = console.log.bind(console);
const originalCwd = process.cwd.bind(process);

const withCapturedConsole = (fn: () => void): string[] => {
  const lines: string[] = [];

  console.log = (...args: unknown[]) => {
    lines.push(args.join(" "));
  };
  try {
    fn();
  } finally {
    console.log = originalLog;
  }
  return lines;
};

void describe("DebugRuntime", () => {
  // Some emitPointer tests don't override process.cwd, so they best-effort write
  // `.lmnr/last-run.json` into the real cwd. Only remove the dir afterwards if
  // this run is what created it — never clobber a pre-existing one.
  const pointerDir = join(originalCwd(), ".lmnr");
  let pointerDirPreexisted = false;
  before(() => {
    pointerDirPreexisted = existsSync(pointerDir);
  });
  after(() => {
    if (!pointerDirPreexisted && existsSync(pointerDir)) {
      rmSync(pointerDir, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    resetDebugRuntime();
    clearDebugEnv();
  });
  afterEach(() => {
    resetDebugRuntime();
    clearDebugEnv();
    process.cwd = originalCwd;
  });

  void it("getCached advances the occurrence counter", () => {
    const cache = new ReplayCache("loop.llm", 2, [
      { output: "0" } as unknown as CachedSpan,
      { output: "1" } as unknown as CachedSpan,
    ]);
    const runtime = new DebugRuntime(config(), cache, null);

    assert.deepStrictEqual(runtime.getCached("loop.llm"), { output: "0" });
    assert.deepStrictEqual(runtime.getCached("loop.llm"), { output: "1" });
    // Past the window -> live.
    assert.strictEqual(runtime.getCached("loop.llm"), undefined);
    // Non-spine path -> live, even on the first occurrence.
    assert.strictEqual(runtime.getCached("other"), undefined);
  });

  void it("getCached returns undefined with no cache", () => {
    const runtime = new DebugRuntime(config(), null, null);
    assert.strictEqual(runtime.getCached("loop.llm"), undefined);
  });

  void it("getCached advances the counter while the cache is loading", () => {
    // Simulates the async-fill window: calls happen before setCache. The
    // counter must advance so post-setCache calls resume at the right slot.
    const runtime = new DebugRuntime(config(), null, null);
    assert.strictEqual(runtime.getCached("loop.llm"), undefined);

    runtime.setCache(
      new ReplayCache("loop.llm", 2, [
        { output: "0" } as unknown as CachedSpan,
        { output: "1" } as unknown as CachedSpan,
      ]),
    );

    // First live call consumed occurrence 0; the cache resumes at 1.
    assert.deepStrictEqual(runtime.getCached("loop.llm"), { output: "1" });
    assert.strictEqual(runtime.getCached("loop.llm"), undefined);
  });

  void it("recordTraceId keeps the first trace id", () => {
    const runtime = new DebugRuntime(config(), null, null);
    runtime.recordTraceId("trace-a");
    runtime.recordTraceId("trace-b");
    const lines = withCapturedConsole(() => runtime.emitPointer());
    const payload = lines[0].slice("LMNR_DEBUG_RUN ".length);
    assert.strictEqual(JSON.parse(payload).trace_id, "trace-a");
  });

  void it("recordProjectId keeps the first project id", () => {
    const runtime = new DebugRuntime(config(), null, "https://x");
    runtime.recordProjectId("proj-a");
    runtime.recordProjectId("proj-b");
    assert.strictEqual(
      runtime.debuggerSessionUrl(),
      "https://x/project/proj-a/debugger-sessions/s",
    );
  });

  void it("debuggerSessionUrl falls back to the base before a project id", () => {
    const runtime = new DebugRuntime(config(), null, "https://app.x");
    assert.strictEqual(runtime.debuggerSessionUrl(), "https://app.x");
  });

  void it("debuggerSessionUrl is null without a base url", () => {
    const runtime = new DebugRuntime(config(), null, null);
    assert.strictEqual(runtime.debuggerSessionUrl(), null);
  });

  void it("debuggerSessionUrl is the full per-session url once known", () => {
    const runtime = new DebugRuntime(
      config({ sessionId: "sess-1" }),
      null,
      "https://app.x",
    );
    runtime.recordProjectId("proj-1");
    assert.strictEqual(
      runtime.debuggerSessionUrl(),
      "https://app.x/project/proj-1/debugger-sessions/sess-1",
    );
  });

  void it("emitPointer carries the full debugger url", () => {
    // The pointer's debugger_url must carry the SAME full per-session URL the
    // console prints, built via the shared debuggerSessionUrl code path.
    const dir = mkdtempSync(join(tmpdir(), "lmnr-runtime-"));
    process.cwd = () => dir;
    const runtime = new DebugRuntime(
      config({ sessionId: "sess-1" }),
      null,
      "https://app.x",
    );
    runtime.recordProjectId("proj-1");
    runtime.recordTraceId("trace-a");
    const lines = withCapturedConsole(() => runtime.emitPointer());
    const payload = JSON.parse(lines[0].slice("LMNR_DEBUG_RUN ".length));
    assert.strictEqual(
      payload.debugger_url,
      "https://app.x/project/proj-1/debugger-sessions/sess-1",
    );
  });

  void it("emitPointer uses the construction-time started_at", async () => {
    // started_at must reflect when the run began (runtime construction at SDK
    // init), not when the pointer is emitted (shutdown). Wait between the two so
    // an emit-time timestamp would land strictly after the construction window.
    const dir = mkdtempSync(join(tmpdir(), "lmnr-runtime-"));
    process.cwd = () => dir;
    const runtime = new DebugRuntime(config(), null, null);
    const afterConstruct = new Date().toISOString();
    await new Promise((resolve) => setTimeout(resolve, 10));
    runtime.recordTraceId("trace-a");
    const lines = withCapturedConsole(() => runtime.emitPointer());
    const payload = JSON.parse(lines[0].slice("LMNR_DEBUG_RUN ".length));
    // Captured at/before construction, so it cannot be later than the timestamp
    // taken right after the constructor — an emit-time value would exceed it.
    assert.ok(payload.started_at <= afterConstruct);
  });

  void it("emitPointer only emits once", () => {
    const dir = mkdtempSync(join(tmpdir(), "lmnr-runtime-"));
    process.cwd = () => dir;
    const runtime = new DebugRuntime(config(), null, null);
    runtime.recordTraceId("trace-a");
    const lines = withCapturedConsole(() => {
      runtime.emitPointer();
      runtime.emitPointer();
    });
    const pointerLines = lines.filter((l) => l.startsWith("LMNR_DEBUG_RUN "));
    assert.strictEqual(pointerLines.length, 1);
  });

  void it("init returns null when disabled", () => {
    const { runtime } = initDebugRuntime({} as SqlQuery);
    assert.strictEqual(runtime, null);
    assert.strictEqual(getRuntime(), null);
  });

  void it("init off does not latch the one-shot flag", () => {
    // When debug is off, init must NOT spend the one-shot flag: a later init
    // after the env flips LMNR_DEBUG on must still build a runtime without an
    // intervening resetDebugRuntime().
    const off = initDebugRuntime({} as SqlQuery);
    assert.strictEqual(off.runtime, null);

    process.env.LMNR_DEBUG = "true";
    const on = initDebugRuntime({} as SqlQuery);
    assert.ok(on.runtime !== null);
    assert.strictEqual(getRuntime(), on.runtime);
  });

  void it("init is idempotent", () => {
    process.env.LMNR_DEBUG = "true";
    const first = initDebugRuntime({} as SqlQuery);
    const second = initDebugRuntime({} as SqlQuery);
    assert.strictEqual(first.runtime, second.runtime);
    assert.strictEqual(first.runtime, getRuntime());
  });

  void it("idempotent init returns the in-flight ready promise", async () => {
    // A second init while the first call's cache is still loading must return
    // the same in-flight build promise, not an already-settled Promise.resolve()
    // — otherwise a caller awaiting the second `ready` runs before setCache.
    process.env.LMNR_DEBUG = "true";
    process.env.LMNR_DEBUG_REPLAY_TRACE_ID = "trace-1";
    process.env.LMNR_DEBUG_CACHE_UNTIL = "2";

    const metadata = [
      {
        path: "agent.loop.llm",
        span_type: "LLM",
        start_time: 1.0,
        end_time: 1.5,
      },
      {
        path: "agent.loop.llm",
        span_type: "LLM",
        start_time: 2.0,
        end_time: 2.5,
      },
    ];
    const payloads = [
      { name: "chat", input: "a", output: "0", attributes: {} },
      { name: "chat", input: "b", output: "1", attributes: {} },
    ];

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    class DeferredSql implements SqlQuery {
      private metadataRows = metadata;
      private payloadRows = payloads;
      async query(sql: string): Promise<Array<Record<string, any>>> {
        await gate;
        if (sql.includes("span_type, start_time")) {
          const rows = this.metadataRows;
          this.metadataRows = [];
          return rows;
        }
        const rows = this.payloadRows;
        this.payloadRows = [];
        return rows;
      }
    }

    const first = initDebugRuntime(new DeferredSql(), "https://www.lmnr.ai");
    // Second init happens while the first build is still gated (not settled).
    const second = initDebugRuntime({} as SqlQuery);
    assert.strictEqual(first.runtime, second.runtime);
    assert.notStrictEqual(second.ready, Promise.resolve());

    release();
    await second.ready;
    // The cache landed by the time the second `ready` resolved.
    assert.deepStrictEqual(second.runtime!.getCached("agent.loop.llm"), {
      name: "chat",
      input: "a",
      output: "0",
      attributes: {},
    });
  });

<<<<<<< HEAD
  void it("awaitCacheReady waits for the in-flight build then serves slot 0", async () => {
    // The replay consumer awaits this before the cache lookup. A call that
    // arrives during the async-fill window must wait for setCache so it serves
    // occurrence 0 instead of running live and skipping the first cached span.
    process.env.LMNR_DEBUG = "true";
    process.env.LMNR_DEBUG_REPLAY_TRACE_ID = "trace-1";
    process.env.LMNR_DEBUG_CACHE_UNTIL = "2";

    const metadata = [
      {
        path: "agent.loop.llm",
        span_type: "LLM",
        start_time: 1.0,
        end_time: 1.5,
      },
      {
        path: "agent.loop.llm",
        span_type: "LLM",
        start_time: 2.0,
        end_time: 2.5,
      },
    ];
    const payloads = [
      { name: "chat", input: "a", output: "0", attributes: {} },
      { name: "chat", input: "b", output: "1", attributes: {} },
=======
  void it('awaitCacheReady waits for the in-flight build then serves slot 0', async () => {
    // The replay consumer awaits this before the cache lookup. A call that
    // arrives during the async-fill window must wait for setCache so it serves
    // occurrence 0 instead of running live and skipping the first cached span.
    process.env.LMNR_DEBUG = 'true';
    process.env.LMNR_DEBUG_REPLAY_TRACE_ID = 'trace-1';
    process.env.LMNR_DEBUG_CACHE_UNTIL = '2';

    const metadata = [
      { path: 'agent.loop.llm', span_type: 'LLM', start_time: 1.0, end_time: 1.5 },
      { path: 'agent.loop.llm', span_type: 'LLM', start_time: 2.0, end_time: 2.5 },
    ];
    const payloads = [
      { name: 'chat', input: 'a', output: '0', attributes: {} },
      { name: 'chat', input: 'b', output: '1', attributes: {} },
>>>>>>> bfccfa7 (fix(debug): wait for replay cache load before serving so first spine calls aren't skipped)
    ];

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    class DeferredSql implements SqlQuery {
      private metadataRows = metadata;
      private payloadRows = payloads;
      async query(sql: string): Promise<Array<Record<string, any>>> {
        await gate;
<<<<<<< HEAD
        if (sql.includes("span_type, start_time")) {
=======
        if (sql.includes('span_type, start_time')) {
>>>>>>> bfccfa7 (fix(debug): wait for replay cache load before serving so first spine calls aren't skipped)
          const rows = this.metadataRows;
          this.metadataRows = [];
          return rows;
        }
        const rows = this.payloadRows;
        this.payloadRows = [];
        return rows;
      }
    }

    const { runtime } = initDebugRuntime(new DeferredSql());
    assert.ok(runtime !== null);
    // Cache is still loading: a lookup right now would miss and burn slot 0.
<<<<<<< HEAD
    assert.strictEqual(getRuntime()!.getCached("peek") !== undefined, false);

    const waited = awaitCacheReady(1_000).then(() =>
      runtime.getCached("agent.loop.llm"),
=======
    assert.strictEqual(getRuntime()!.getCached('peek') !== undefined, false);

    const waited = awaitCacheReady(1_000).then(() =>
      runtime.getCached('agent.loop.llm'),
>>>>>>> bfccfa7 (fix(debug): wait for replay cache load before serving so first spine calls aren't skipped)
    );
    // Let the build settle while the wait is in flight.
    release();
    const served = await waited;
    assert.deepStrictEqual(served, {
<<<<<<< HEAD
      name: "chat",
      input: "a",
      output: "0",
=======
      name: 'chat',
      input: 'a',
      output: '0',
>>>>>>> bfccfa7 (fix(debug): wait for replay cache load before serving so first spine calls aren't skipped)
      attributes: {},
    });
  });

<<<<<<< HEAD
  void it("awaitCacheReady is capped by the timeout on a hung build", async () => {
    // A source-trace fetch that never resolves must not block the user's
    // program: the wait is bounded and returns even though the cache never lands.
    process.env.LMNR_DEBUG = "true";
    process.env.LMNR_DEBUG_REPLAY_TRACE_ID = "trace-1";
    process.env.LMNR_DEBUG_CACHE_UNTIL = "2";
=======
  void it('awaitCacheReady is capped by the timeout on a hung build', async () => {
    // A source-trace fetch that never resolves must not block the user's
    // program: the wait is bounded and returns even though the cache never lands.
    process.env.LMNR_DEBUG = 'true';
    process.env.LMNR_DEBUG_REPLAY_TRACE_ID = 'trace-1';
    process.env.LMNR_DEBUG_CACHE_UNTIL = '2';
>>>>>>> bfccfa7 (fix(debug): wait for replay cache load before serving so first spine calls aren't skipped)

    class HangingSql implements SqlQuery {
      // Never resolves -> the cache build hangs forever.
      query(): Promise<Array<Record<string, any>>> {
        return new Promise(() => {});
      }
    }

    initDebugRuntime(new HangingSql());
    const start = Date.now();
    await awaitCacheReady(30);
    // Returned via the timeout branch, not the (never-settling) build promise.
    assert.ok(Date.now() - start < 1_000);
  });

<<<<<<< HEAD
  void it("reset allows reinit to re-read env", () => {
=======
  void it('reset allows reinit to re-read env', () => {
>>>>>>> bfccfa7 (fix(debug): wait for replay cache load before serving so first spine calls aren't skipped)
    // A shutdown/initialize cycle must re-read LMNR_DEBUG*: reset clears the
    // one-shot flag so a previously-off run can turn debug on (and vice versa).
    const off = initDebugRuntime({} as SqlQuery);
    assert.strictEqual(off.runtime, null);

    resetDebugRuntime();
    process.env.LMNR_DEBUG = "true";
    const on = initDebugRuntime({} as SqlQuery);
    assert.ok(on.runtime !== null);
    assert.strictEqual(getRuntime(), on.runtime);
  });

  void it("init builds the cache for a looping spine", async () => {
    process.env.LMNR_DEBUG = "true";
    process.env.LMNR_DEBUG_REPLAY_TRACE_ID = "trace-1";
    process.env.LMNR_DEBUG_CACHE_UNTIL = "2";

    const metadata = [
      {
        path: "agent.loop.llm",
        span_type: "LLM",
        start_time: 1.0,
        end_time: 1.5,
      },
      {
        path: "agent.loop.llm",
        span_type: "LLM",
        start_time: 2.0,
        end_time: 2.5,
      },
    ];
    const payloads = [
      { name: "chat", input: "a", output: "0", attributes: {} },
      { name: "chat", input: "b", output: "1", attributes: {} },
    ];
    const sql = new FakeSql(metadata, payloads);

    const { runtime, ready } = initDebugRuntime(sql, "https://www.lmnr.ai");
    await ready;
    assert.ok(runtime !== null);
    assert.deepStrictEqual(runtime.getCached("agent.loop.llm"), {
      name: "chat",
      input: "a",
      output: "0",
      attributes: {},
    });
  });

  void it("init resolves a span-id cache_until to an occurrence count", async () => {
    // A span-id LMNR_DEBUG_CACHE_UNTIL resolves to the matched call's 1-based
    // occurrence on the spine: matching the 2nd of 3 calls caches occurrences 0-1.
    process.env.LMNR_DEBUG = "true";
    process.env.LMNR_DEBUG_REPLAY_TRACE_ID = "trace-1";
    process.env.LMNR_DEBUG_CACHE_UNTIL = "0123-456789abcdef";

    const metadata = [
      {
        path: "agent.loop.llm",
        span_type: "LLM",
        start_time: 1.0,
        end_time: 1.5,
        span_id: "11111111-1111-1111-1111-111111111111",
      },
      {
        path: "agent.loop.llm",
        span_type: "LLM",
        start_time: 2.0,
        end_time: 2.5,
        span_id: "00000000-0000-0000-0123-456789abcdef",
      },
      {
        path: "agent.loop.llm",
        span_type: "LLM",
        start_time: 3.0,
        end_time: 3.5,
        span_id: "22222222-2222-2222-2222-222222222222",
      },
    ];
    const payloads = [
      { name: "chat", input: "a", output: "0", attributes: {} },
      { name: "chat", input: "b", output: "1", attributes: {} },
      { name: "chat", input: "c", output: "2", attributes: {} },
    ];
    const sql = new FakeSql(metadata, payloads);

    const { runtime, ready } = initDebugRuntime(sql);
    await ready;
    assert.ok(runtime !== null);
    assert.strictEqual(runtime.replayConfigured, true);
    // Occurrences 0 and 1 are cached (up to and including the matched span).
    assert.strictEqual(runtime.getCached("agent.loop.llm")?.output, "0");
    assert.strictEqual(runtime.getCached("agent.loop.llm")?.output, "1");
    // The 3rd call is past the resolved window -> live.
    assert.strictEqual(runtime.getCached("agent.loop.llm"), undefined);
  });

  void it("init degrades to live on an unmatched span-id cache_until", async () => {
    process.env.LMNR_DEBUG = "true";
    process.env.LMNR_DEBUG_REPLAY_TRACE_ID = "trace-1";
    process.env.LMNR_DEBUG_CACHE_UNTIL = "deadbeef";

    const metadata = [
      {
        path: "agent.loop.llm",
        span_type: "LLM",
        start_time: 1.0,
        end_time: 1.5,
        span_id: "11111111-1111-1111-1111-111111111111",
      },
    ];
    const sql = new FakeSql(metadata, []);

    const { runtime, ready } = initDebugRuntime(sql);
    await ready;
    assert.ok(runtime !== null);
    // Unmatched span id -> no cache -> every call runs live.
    assert.strictEqual(runtime.getCached("agent.loop.llm"), undefined);
  });

  void it("init degrades to live on overlap", async () => {
    process.env.LMNR_DEBUG = "true";
    process.env.LMNR_DEBUG_REPLAY_TRACE_ID = "trace-1";
    process.env.LMNR_DEBUG_CACHE_UNTIL = "2";

    const metadata = [
      { path: "loop.llm", span_type: "LLM", start_time: 0.0, end_time: 1.5 },
      { path: "loop.llm", span_type: "LLM", start_time: 1.0, end_time: 2.0 },
    ];
    const sql = new FakeSql(metadata, []);

    const { runtime, ready } = initDebugRuntime(sql);
    await ready;
    assert.ok(runtime !== null);
    // Overlap guard -> no cache -> every call runs live.
    assert.strictEqual(runtime.getCached("loop.llm"), undefined);
  });

  void it("init degrades to live on fetch failure", async () => {
    process.env.LMNR_DEBUG = "true";
    process.env.LMNR_DEBUG_REPLAY_TRACE_ID = "trace-1";
    process.env.LMNR_DEBUG_CACHE_UNTIL = "2";

    const { runtime, ready } = initDebugRuntime(new BoomSql());
    await ready;
    assert.ok(runtime !== null); // never crashes
    assert.strictEqual(runtime.getCached("loop.llm"), undefined);
  });
});
