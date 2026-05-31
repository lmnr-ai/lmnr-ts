import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

<<<<<<< HEAD
import {
  detectSpine,
  hasOverlap,
  resolveCacheUntilSpanId,
  SpanRecord,
} from '../../src/debug/spine';
=======
import { detectSpine, hasOverlap, SpanRecord } from '../../src/debug/spine';
>>>>>>> d989320 (LAM-1672: rework debugger into in-process debug/replay (SDK))

const dataDir = join(__dirname, '..', 'data', 'debug');

interface SpineCase {
  name: string;
  spans: {
    span_path: string;
    span_type: string;
    start_time: number;
    end_time: number;
  }[];
  expect: { spine_path: string | null; spine_starts: number[] };
}

interface OverlapCase {
  name: string;
  spine_calls: { start_time: number; end_time: number }[];
  n: number;
  expect: boolean;
}

const spineVectors: SpineCase[] = JSON.parse(
  readFileSync(join(dataDir, 'spine_vectors.json'), 'utf-8'),
).cases;

const overlapVectors: OverlapCase[] = JSON.parse(
  readFileSync(join(dataDir, 'overlap_vectors.json'), 'utf-8'),
).cases;

void describe('detectSpine (spine vector parity)', () => {
  for (const testCase of spineVectors) {
    void it(testCase.name, () => {
      const spans: SpanRecord[] = testCase.spans.map((s) => ({
        spanPath: s.span_path,
        spanType: s.span_type,
        startTime: s.start_time,
        endTime: s.end_time,
<<<<<<< HEAD
        spanId: "",
=======
>>>>>>> d989320 (LAM-1672: rework debugger into in-process debug/replay (SDK))
      }));

      const result = detectSpine(spans);
      assert.strictEqual(result.spinePath, testCase.expect.spine_path);
      assert.deepStrictEqual(
        result.spineCalls.map((c) => c.startTime),
        testCase.expect.spine_starts,
      );
    });
  }
});

void describe('hasOverlap (overlap vector parity)', () => {
  for (const testCase of overlapVectors) {
    void it(testCase.name, () => {
      const calls: SpanRecord[] = testCase.spine_calls.map((c) => ({
        spanPath: 'loop.llm',
        spanType: 'LLM',
        startTime: c.start_time,
        endTime: c.end_time,
<<<<<<< HEAD
        spanId: '',
=======
>>>>>>> d989320 (LAM-1672: rework debugger into in-process debug/replay (SDK))
      }));
      assert.strictEqual(hasOverlap(calls, testCase.n), testCase.expect);
    });
  }
});
<<<<<<< HEAD

const spineWithIds = (...spanIds: string[]): SpanRecord[] =>
  spanIds.map((spanId, i) => ({
    spanPath: 'loop.llm',
    spanType: 'LLM',
    startTime: i,
    endTime: i + 0.5,
    spanId,
  }));

const FULL_UUID = '00000000-0000-0000-0123-456789abcdef';

void describe('resolveCacheUntilSpanId', () => {
  // Full UUID, last two groups, raw 16-hex, short hex suffix — all forms the
  // user might copy for the same span id resolve to the same call.
  for (const needle of [
    '00000000000000000123456789abcdef',
    '0123456789abcdef',
    'abcdef',
  ]) {
    void it(`matches form ${needle}`, () => {
      const spine = spineWithIds('11111111-1111-1111-1111-111111111111', FULL_UUID);
      // The target is the 2nd call, so the resolved count is 2 (inclusive).
      assert.strictEqual(resolveCacheUntilSpanId(spine, needle), 2);
    });
  }

  void it('returns the first occurrence count', () => {
    const spine = spineWithIds(FULL_UUID, '22222222-2222-2222-2222-222222222222');
    assert.strictEqual(resolveCacheUntilSpanId(spine, '456789abcdef'), 1);
  });

  void it('returns null when not found', () => {
    const spine = spineWithIds('11111111-1111-1111-1111-111111111111');
    assert.strictEqual(resolveCacheUntilSpanId(spine, 'deadbeef'), null);
  });

  void it('returns null on an empty spine', () => {
    assert.strictEqual(resolveCacheUntilSpanId([], 'abcdef'), null);
  });
});
=======
>>>>>>> d989320 (LAM-1672: rework debugger into in-process debug/replay (SDK))
