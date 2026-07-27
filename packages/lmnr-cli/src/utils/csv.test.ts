import { describe, expect, it } from 'vitest';

import { toCsv } from './csv';

describe('toCsv', () => {
  it('emits a header row then one line per record', () => {
    const csv = toCsv(['id', 'name'], [
      { id: '1', name: 'alice' },
      { id: '2', name: 'bob' },
    ]);
    expect(csv).toBe('id,name\n1,alice\n2,bob');
  });

  it('returns just the header when there are no rows', () => {
    expect(toCsv(['id', 'name'], [])).toBe('id,name');
  });

  it('fills missing keys with empty fields, honoring column order', () => {
    const csv = toCsv(['id', 'name', 'extra'], [{ id: '1', name: 'alice' }]);
    expect(csv).toBe('id,name,extra\n1,alice,');
  });

  it('stringifies numbers and booleans without quoting', () => {
    const csv = toCsv(['n', 'b'], [{ n: 42, b: true }]);
    expect(csv).toBe('n,b\n42,true');
  });

  it('renders null and undefined as empty fields', () => {
    const csv = toCsv(['a', 'b'], [{ a: null, b: undefined }]);
    expect(csv).toBe('a,b\n,');
  });

  it('quotes and escapes commas, quotes, LF and CR', () => {
    expect(toCsv(['v'], [{ v: 'a,b' }])).toBe('v\n"a,b"');
    expect(toCsv(['v'], [{ v: 'a"b' }])).toBe('v\n"a""b"');
    expect(toCsv(['v'], [{ v: 'a\nb' }])).toBe('v\n"a\nb"');
    expect(toCsv(['v'], [{ v: 'a\rb' }])).toBe('v\n"a\rb"');
  });

  it('serializes object cells as a single JSON string cell', () => {
    const csv = toCsv(['j'], [{ j: { a: 1, b: [2, 3] } }]);
    expect(csv).toBe('j\n"{""a"":1,""b"":[2,3]}"');
  });
});
