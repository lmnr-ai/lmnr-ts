import * as assert from 'node:assert';
import { describe, it } from 'node:test';

import { fetchSpineMetadata, SqlQuery, toEpoch } from '../../src/debug/source-trace';
import { hasOverlap } from '../../src/debug/spine';

class FakeSql implements SqlQuery {
  private rows: Record<string, any>[];

  constructor(rows: Record<string, any>[]) {
    this.rows = rows;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async query(): Promise<Array<Record<string, any>>> {
    const rows = this.rows;
    this.rows = [];
    return rows;
  }
}

void describe('source-trace toEpoch', () => {
  void it('returns the missing default for null / undefined', () => {
    assert.strictEqual(toEpoch(null), 0);
    assert.strictEqual(toEpoch(undefined), 0);
    assert.strictEqual(toEpoch(null, Infinity), Infinity);
  });

  void it('parses ISO-8601 nanosecond timestamps to a ms epoch', () => {
    // ClickHouse returns DateTime64(9) (nanosecond) strings; they must parse to
    // a real epoch, not fall through to the lexical fallback.
    assert.strictEqual(
      toEpoch('2024-01-15T10:30:45.123456789Z'),
      Date.parse('2024-01-15T10:30:45.123Z'),
    );
  });

  void it('lexical fallback preserves chronological order', () => {
    // Unparseable-but-ISO-ordered strings must map monotonically: a later
    // timestamp can never score lower (a flat ordinal sum reversed them).
    // Force the fallback by appending a non-numeric tail so Date.parse fails;
    // the strings differ in the resolvable leading chars (year/month).
    const a = '2024-01-15T10:30:45!';
    const b = '2024-02-15T10:30:45!';
    assert.ok(Number.isNaN(Date.parse(a)) && Number.isNaN(Date.parse(b)));
    assert.ok(a < b);
    assert.ok(toEpoch(a) < toEpoch(b));
  });
});

void describe('fetchSpineMetadata end_time handling', () => {
  void it('treats a missing end_time as unbounded so overlap fires', async () => {
    // A null end_time must not collapse to 0 — otherwise the overlap guard
    // (start < prev.end) never fires and replay proceeds when it should not.
    const sql = new FakeSql([
      { path: 'loop.llm', span_type: 'LLM', start_time: 0.0, end_time: null },
      { path: 'loop.llm', span_type: 'LLM', start_time: 1.0, end_time: 2.0 },
    ]);
    const records = await fetchSpineMetadata(sql, 'trace-1');

    assert.strictEqual(records[0].endTime, Infinity);
    // The unbounded first call overlaps the second -> guard fires -> run live.
    assert.strictEqual(hasOverlap(records, 2), true);
  });

  void it('leaves a present end_time untouched', async () => {
    const sql = new FakeSql([
      { path: 'loop.llm', span_type: 'LLM', start_time: 0.0, end_time: 1.0 },
      { path: 'loop.llm', span_type: 'LLM', start_time: 1.0, end_time: 2.0 },
    ]);
    const records = await fetchSpineMetadata(sql, 'trace-1');

    assert.strictEqual(records[0].endTime, 1.0);
    assert.strictEqual(hasOverlap(records, 2), false);
  });
});
