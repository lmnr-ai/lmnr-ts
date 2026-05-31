import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { detectSpine, hasOverlap, SpanRecord } from '../../src/debug/spine';

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
      }));
      assert.strictEqual(hasOverlap(calls, testCase.n), testCase.expect);
    });
  }
});
