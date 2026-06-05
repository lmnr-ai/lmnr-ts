import { describe, expect, it } from 'vitest';

import { normalizeTraceId, NOTE_METADATA_KEY, readNoteFromMetadata } from './trace-note';

describe('normalizeTraceId', () => {
  it('passes a dashed UUID through', () => {
    expect(normalizeTraceId('01234567-89ab-cdef-0123-456789abcdef'))
      .toBe('01234567-89ab-cdef-0123-456789abcdef');
  });

  it('lowercases an uppercase UUID', () => {
    expect(normalizeTraceId('01234567-89AB-CDEF-0123-456789ABCDEF'))
      .toBe('01234567-89ab-cdef-0123-456789abcdef');
  });

  it('converts a 32-char OTel hex id to UUID form', () => {
    expect(normalizeTraceId('0123456789abcdef0123456789abcdef'))
      .toBe('01234567-89ab-cdef-0123-456789abcdef');
  });

  it('strips a 0x prefix before converting', () => {
    expect(normalizeTraceId('0x0123456789abcdef0123456789abcdef'))
      .toBe('01234567-89ab-cdef-0123-456789abcdef');
  });

  it('throws on anything else', () => {
    expect(() => normalizeTraceId('not-a-trace-id')).toThrow(/Invalid trace id/);
    expect(() => normalizeTraceId('0123')).toThrow(/Invalid trace id/);
    expect(() => normalizeTraceId('')).toThrow(/Invalid trace id/);
  });
});

describe('readNoteFromMetadata', () => {
  it('reads the note from a JSON-string metadata column', () => {
    const metadata = JSON.stringify({ [NOTE_METADATA_KEY]: 'hello', other: 'x' });
    expect(readNoteFromMetadata(metadata)).toBe('hello');
  });

  it('reads the note from an already-parsed object', () => {
    expect(readNoteFromMetadata({ [NOTE_METADATA_KEY]: 'hello' })).toBe('hello');
  });

  it('returns empty string when the key is absent', () => {
    expect(readNoteFromMetadata(JSON.stringify({ other: 'x' }))).toBe('');
  });

  it('returns empty string for empty / null / malformed metadata', () => {
    expect(readNoteFromMetadata('')).toBe('');
    expect(readNoteFromMetadata(null)).toBe('');
    expect(readNoteFromMetadata(undefined)).toBe('');
    expect(readNoteFromMetadata('{not json')).toBe('');
    expect(readNoteFromMetadata(42)).toBe('');
  });

  it('returns empty string when the note value is not a string', () => {
    expect(readNoteFromMetadata(JSON.stringify({ [NOTE_METADATA_KEY]: 7 }))).toBe('');
  });
});
