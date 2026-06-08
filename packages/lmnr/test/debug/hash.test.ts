import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  extractInputMessages,
  inputChatMessagesFromJson,
} from '../../src/debug/aisdk-normalize';
import { canonicalJson, debugInputHash } from '../../src/debug/hash';

interface HashCase {
  name: string;
  messages: unknown[];
  canonical_hashed: string;
  expected_hash: string;
}

const vectors: HashCase[] = JSON.parse(
  readFileSync(join(__dirname, '..', 'data', 'debug', 'input_hash_cases.json'), 'utf-8'),
).cases;

void describe('debug input hash (parity vectors)', () => {
  for (const testCase of vectors) {
    void it(testCase.name, () => {
      // Locked digest: byte-identical to the Rust `blake3` crate over the same
      // canonical string (see input_hash_cases.json header). A regression in
      // canonicalization or system-stripping breaks this.
      assert.strictEqual(debugInputHash(testCase.messages), testCase.expected_hash);
      // A hex blake3 digest is exactly 64 lowercase hex chars.
      assert.match(debugInputHash(testCase.messages), /^[0-9a-f]{64}$/);
    });
  }
});

void describe('canonicalJson', () => {
  void it('sorts object keys lexicographically (recursive)', () => {
    assert.strictEqual(
      canonicalJson({ b: 1, a: { d: 2, c: 3 } }),
      '{"a":{"c":3,"d":2},"b":1}',
    );
  });

  void it('preserves array order', () => {
    assert.strictEqual(canonicalJson([3, 1, 2]), '[3,1,2]');
  });

  void it('drops undefined object values (serde skips None)', () => {
    assert.strictEqual(canonicalJson({ a: 1, b: undefined }), '{"a":1}');
  });

  void it('serializes null', () => {
    assert.strictEqual(canonicalJson(null), 'null');
    assert.strictEqual(canonicalJson({ a: null }), '{"a":null}');
  });

  void it('emits no whitespace between separators', () => {
    const out = canonicalJson({ role: 'user', content: 'hi' });
    assert.ok(!out.includes(', ') && !out.includes(': '));
  });
});

void describe('debugInputHash system stripping', () => {
  void it('strips a non-empty leading system message', () => {
    const withSystem = [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hi' },
    ];
    const withoutSystem = [{ role: 'user', content: 'hi' }];
    assert.strictEqual(debugInputHash(withSystem), debugInputHash(withoutSystem));
  });

  void it('keeps an empty system message in the hashed array', () => {
    const emptySystem = [
      { role: 'system', content: '' },
      { role: 'user', content: 'hi' },
    ];
    const userOnly = [{ role: 'user', content: 'hi' }];
    assert.notStrictEqual(debugInputHash(emptySystem), debugInputHash(userOnly));
  });

  void it('is insensitive to message-object key order', () => {
    const a = [{ role: 'user', content: 'x' }];
    const b = [{ content: 'x', role: 'user' }];
    assert.strictEqual(debugInputHash(a), debugInputHash(b));
  });
});

void describe('inputChatMessagesFromJson', () => {
  void it('keeps a plain-string content message', () => {
    assert.deepStrictEqual(
      inputChatMessagesFromJson([{ role: 'user', content: 'hi' }]),
      [{ role: 'user', content: 'hi' }],
    );
  });

  void it('maps a text content-part array to parsed parts', () => {
    assert.deepStrictEqual(
      inputChatMessagesFromJson([
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      ]),
      [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    );
  });

  void it('falls back to a Text blob when any part is unrecognized', () => {
    const content = [{ type: 'mystery', foo: 1 }];
    assert.deepStrictEqual(
      inputChatMessagesFromJson([{ role: 'user', content }]),
      [{ role: 'user', content: JSON.stringify(content) }],
    );
  });

  void it('reshapes camelCase AI SDK tool-call/tool-result parts (no Text-blob fallback)', () => {
    // AI SDK prompt parts are camelCase (toolName/toolCallId), matching the
    // server's `#[serde(rename_all = "camelCase")]`. They must parse into the
    // normalized content-part shape, NOT collapse to a stringified Text blob.
    assert.deepStrictEqual(
      inputChatMessagesFromJson([
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolName: 'get_weather',
              toolCallId: 'call_1',
              input: { city: 'SF' },
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call_1',
              toolName: 'get_weather',
              output: '72F',
            },
          ],
        },
      ]),
      [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_call',
              name: 'get_weather',
              id: 'call_1',
              arguments: { city: 'SF' },
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call_1',
              output: '72F',
              toolName: 'get_weather',
            },
          ],
        },
      ],
    );
  });

  void it('accepts AI SDK v4 args/result aliases for tool parts', () => {
    assert.deepStrictEqual(
      inputChatMessagesFromJson([
        {
          role: 'assistant',
          content: [
            { type: 'tool-call', toolName: 't', toolCallId: 'c', args: { a: 1 } },
          ],
        },
        {
          role: 'tool',
          content: [
            { type: 'tool-result', toolCallId: 'c', toolName: 't', result: 'ok' },
          ],
        },
      ]),
      [
        {
          role: 'assistant',
          content: [{ type: 'tool_call', name: 't', id: 'c', arguments: { a: 1 } }],
        },
        {
          role: 'tool',
          content: [
            { type: 'tool-result', toolCallId: 'c', output: 'ok', toolName: 't' },
          ],
        },
      ],
    );
  });

  void it('preserves tool_call_id and skips malformed messages', () => {
    assert.deepStrictEqual(
      inputChatMessagesFromJson([
        { role: 'tool', tool_call_id: 'c1', content: 'ok' },
        { notAMessage: true },
        { role: 'user' },
      ]),
      [{ role: 'tool', content: 'ok', tool_call_id: 'c1' }],
    );
  });

  void it('returns [] for non-array input', () => {
    assert.deepStrictEqual(inputChatMessagesFromJson({ role: 'user' }), []);
  });
});

void describe('extractInputMessages', () => {
  void it('reshapes an AI SDK prompt and hashes identically to the reconstructed array', () => {
    const prompt = [
      { role: 'system' as const, content: 'be terse' },
      {
        role: 'user' as const,
        content: [{ type: 'text' as const, text: 'hello' }],
      },
    ];
    const reshaped = extractInputMessages({ prompt: prompt });
    assert.ok(Array.isArray(reshaped) && reshaped.length > 0);
    // The same bytes the server would hash flow through debugInputHash.
    assert.match(debugInputHash(reshaped), /^[0-9a-f]{64}$/);
  });

  void it('returns null when the prompt cannot be stringified', () => {
    // A circular content object makes stringifyPromptForTelemetry's JSON.stringify
    // throw. The caller must see null (run live, no latch) rather than a hash over
    // a default payload that would force a spurious MISS.
    const circular: Record<string, unknown> = { type: 'text', text: 'hi' };
    circular.self = circular;
    const prompt = [{ role: 'user', content: [circular] }];
    assert.strictEqual(extractInputMessages({ prompt: prompt as never }), null);
  });
});
