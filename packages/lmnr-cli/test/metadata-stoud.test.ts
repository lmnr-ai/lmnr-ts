import * as assert from 'node:assert';
import { describe, it } from 'node:test';

import { extractMetadataFromStdout, METADATA_PROTOCOL_PREFIX } from '../src/commands/dev.js';

void describe('extractMetadataFromStdout', () => {
  void describe('Basic functionality', () => {
    void it('parses simple JSON with protocol prefix', () => {

      const stdout = `${METADATA_PROTOCOL_PREFIX} {"name": "test_func", "params": []}`;
      const result = extractMetadataFromStdout(stdout);

      assert.strictEqual(result.name, 'test_func');
      assert.deepStrictEqual(result.params, []);
    });

    void it('parses JSON with protocol prefix on a new line', () => {
      // eslint-disable-next-line @stylistic/max-len
      const stdout = `${METADATA_PROTOCOL_PREFIX}\n{"name": "my_function", "params": ["arg1", "arg2"]}`;
      const result = extractMetadataFromStdout(stdout);

      assert.strictEqual(result.name, 'my_function');
      assert.deepStrictEqual(result.params, ['arg1', 'arg2']);
    });

    void it('handles whitespace after protocol prefix', () => {

      const stdout = `${METADATA_PROTOCOL_PREFIX}   {"name": "func", "params": []}`;
      const result = extractMetadataFromStdout(stdout);

      assert.strictEqual(result.name, 'func');
    });

    void it('handles no whitespace after protocol prefix', () => {

      const stdout = `${METADATA_PROTOCOL_PREFIX}{"name": "func", "params": []}`;
      const result = extractMetadataFromStdout(stdout);

      assert.strictEqual(result.name, 'func');
    });
  });

  void describe('Multiple protocol prefixes', () => {
    void it('returns the last valid JSON when multiple prefixes exist', () => {
      const stdout = `${METADATA_PROTOCOL_PREFIX} {"name": "first", "params": []}
${METADATA_PROTOCOL_PREFIX} {"name": "second", "params": []}
${METADATA_PROTOCOL_PREFIX} {"name": "last", "params": []}`;

      const result = extractMetadataFromStdout(stdout);
      assert.strictEqual(result.name, 'last');
    });

    void it('skips invalid JSON and returns the last valid one', () => {
      const stdout = `${METADATA_PROTOCOL_PREFIX} {"name": "valid", "params": []}
${METADATA_PROTOCOL_PREFIX} invalid json here
${METADATA_PROTOCOL_PREFIX} {"name": "last_valid", "params": [1, 2, 3]}`;

      const result = extractMetadataFromStdout(stdout);
      assert.strictEqual(result.name, 'last_valid');
      assert.deepStrictEqual(result.params, [1, 2, 3]);
    });
  });

  void describe('Protocol prefix in JSON payload (the bug we fixed)', () => {
    void it('handles protocol prefix in function name', () => {
      // eslint-disable-next-line @stylistic/max-len
      const stdout = `${METADATA_PROTOCOL_PREFIX} {"name": "test_LMNR_METADATA:_func", "params": []}`;
      const result = extractMetadataFromStdout(stdout);

      assert.strictEqual(result.name, 'test_LMNR_METADATA:_func');
      assert.deepStrictEqual(result.params, []);
    });

    void it('handles protocol prefix in string values', () => {
      // eslint-disable-next-line @stylistic/max-len
      const stdout = `${METADATA_PROTOCOL_PREFIX} {"name": "func", "description": "Uses LMNR_METADATA: prefix", "params": []}`;
      const result = extractMetadataFromStdout(stdout);

      assert.strictEqual(result.name, 'func');
      assert.strictEqual(result.description, 'Uses LMNR_METADATA: prefix');
    });

    void it('handles multiple protocol strings in JSON values', () => {
      // eslint-disable-next-line @stylistic/max-len
      const stdout = `${METADATA_PROTOCOL_PREFIX} {"name": "LMNR_METADATA:test", "note": "LMNR_METADATA: appears here", "params": ["LMNR_METADATA:"]}`;
      const result = extractMetadataFromStdout(stdout);

      assert.strictEqual(result.name, 'LMNR_METADATA:test');
      assert.strictEqual(result.note, 'LMNR_METADATA: appears here');
      assert.deepStrictEqual(result.params, ['LMNR_METADATA:']);
    });

    void it('handles escaped characters in strings containing protocol prefix', () => {
      // eslint-disable-next-line @stylistic/max-len
      const stdout = `${METADATA_PROTOCOL_PREFIX} {"name": "func", "path": "/path/to/LMNR_METADATA:\\\\file.py", "params": []}`;
      const result = extractMetadataFromStdout(stdout);

      assert.strictEqual(result.name, 'func');
      assert.strictEqual(result.path, '/path/to/LMNR_METADATA:\\file.py');
    });
  });

  void describe('Log output before metadata', () => {
    void it('parses JSON when preceded by log lines', () => {
      const stdout = `INFO: Starting discovery
DEBUG: Processing file
${METADATA_PROTOCOL_PREFIX} {"name": "my_func", "params": []}`;

      const result = extractMetadataFromStdout(stdout);
      assert.strictEqual(result.name, 'my_func');
    });

    void it('handles log line without trailing newline before metadata', () => {
      const stdout = `INFO: Starting discoveryLMNR_METADATA: {"name": "my_func", "params": []}`;
      const result = extractMetadataFromStdout(stdout);

      assert.strictEqual(result.name, 'my_func');
    });

    void it('handles multiple log lines and finds metadata', () => {
      const stdout = `2024-01-22 10:00:00 - INFO - Loading module
2024-01-22 10:00:01 - DEBUG - Scanning functions
2024-01-22 10:00:02 - INFO - Found function
${METADATA_PROTOCOL_PREFIX} {"name": "discovered_func", "params": ["x", "y", "z"]}
2024-01-22 10:00:03 - INFO - Done`;

      const result = extractMetadataFromStdout(stdout);
      assert.strictEqual(result.name, 'discovered_func');
      assert.deepStrictEqual(result.params, ['x', 'y', 'z']);
    });
  });

  void describe('Complex JSON structures', () => {
    void it('parses nested objects', () => {
      // eslint-disable-next-line @stylistic/max-len
      const stdout = `${METADATA_PROTOCOL_PREFIX} {"name": "func", "params": [{"name": "arg1", "type": "str"}], "metadata": {"version": 1}}`;
      const result = extractMetadataFromStdout(stdout);

      assert.strictEqual(result.name, 'func');
      assert.strictEqual(result.params[0].name, 'arg1');
      assert.strictEqual(result.metadata.version, 1);
    });

    void it('parses nested arrays', () => {
      // eslint-disable-next-line @stylistic/max-len
      const stdout = `${METADATA_PROTOCOL_PREFIX} {"name": "func", "params": [["a", "b"], ["c", "d"]]}`;
      const result = extractMetadataFromStdout(stdout);

      assert.deepStrictEqual(result.params, [['a', 'b'], ['c', 'd']]);
    });

    void it('handles JSON with special characters in strings', () => {
      // eslint-disable-next-line @stylistic/max-len
      const stdout = `${METADATA_PROTOCOL_PREFIX} {"name": "func", "description": "Test with \\"quotes\\" and \\n newlines", "params": []}`;
      const result = extractMetadataFromStdout(stdout);

      assert.strictEqual(result.name, 'func');
      assert.strictEqual(result.description, 'Test with "quotes" and \n newlines');
    });

    void it('parses JSON with Unicode characters', () => {

      const stdout = `${METADATA_PROTOCOL_PREFIX} {"name": "测试函数", "params": ["日本語", "한글"]}`;
      const result = extractMetadataFromStdout(stdout);

      assert.strictEqual(result.name, '测试函数');
      assert.deepStrictEqual(result.params, ['日本語', '한글']);
    });
  });

  void describe('Multi-line JSON', () => {
    void it('parses multi-line formatted JSON', () => {
      const stdout = `${METADATA_PROTOCOL_PREFIX} {
  "name": "multi_line_func",
  "params": [
    "param1",
    "param2"
  ]
}`;

      const result = extractMetadataFromStdout(stdout);
      assert.strictEqual(result.name, 'multi_line_func');
      assert.deepStrictEqual(result.params, ['param1', 'param2']);
    });

    void it('parses multi-line JSON with nested objects', () => {
      const stdout = `${METADATA_PROTOCOL_PREFIX} {
  "name": "complex_func",
  "params": [
    {
      "name": "arg1",
      "type": "string",
      "required": true
    }
  ],
  "returns": {
    "type": "object"
  }
}`;

      const result = extractMetadataFromStdout(stdout);
      assert.strictEqual(result.name, 'complex_func');
      assert.strictEqual(result.params[0].name, 'arg1');
      assert.strictEqual(result.returns.type, 'object');
    });
  });

  void describe('JSON followed by additional text', () => {
    void it('parses JSON when followed by log output', () => {
      const stdout = `${METADATA_PROTOCOL_PREFIX} {"name": "func", "params": []}
INFO: Completed discovery`;

      const result = extractMetadataFromStdout(stdout);
      assert.strictEqual(result.name, 'func');
    });

    void it('parses JSON when followed by more text on same line', () => {

      const stdout = `${METADATA_PROTOCOL_PREFIX} {"name": "func", "params": []} extra text here`;
      const result = extractMetadataFromStdout(stdout);

      assert.strictEqual(result.name, 'func');
    });
  });

  void describe('Backward compatibility', () => {
    void it('parses plain JSON without protocol prefix', () => {
      const stdout = '{"name": "legacy_func", "params": []}';
      const result = extractMetadataFromStdout(stdout);

      assert.strictEqual(result.name, 'legacy_func');
      assert.deepStrictEqual(result.params, []);
    });

    void it('parses plain JSON with whitespace', () => {
      const stdout = '  \n{"name": "func", "params": []}  \n';
      const result = extractMetadataFromStdout(stdout);

      assert.strictEqual(result.name, 'func');
    });

    void it('falls back to plain JSON when protocol prefix not found', () => {
      const stdout = `Some log output
{"name": "fallback_func", "params": ["a", "b"]}`;

      // This should fail the protocol search and try to parse as plain JSON
      // which will fail because of the log output
      assert.throws(
        () => extractMetadataFromStdout(stdout),
        /No metadata found in output/,
      );
    });
  });

  void describe('Error handling', () => {
    void it('throws error when no metadata found', () => {
      const stdout = 'Just some log output without any metadata';

      assert.throws(
        () => extractMetadataFromStdout(stdout),
        /No metadata found in output/,
      );
    });

    void it('throws error when protocol prefix exists but no valid JSON', () => {
      const stdout = `${METADATA_PROTOCOL_PREFIX} this is not valid json`;

      assert.throws(
        () => extractMetadataFromStdout(stdout),
        /No valid metadata JSON found in output/,
      );
    });

    void it('throws error for empty string', () => {
      assert.throws(
        () => extractMetadataFromStdout(''),
        /No metadata found in output/,
      );
    });

    void it('throws error for protocol prefix with incomplete JSON', () => {
      const stdout = `${METADATA_PROTOCOL_PREFIX} {"name": "func", "params":`;

      assert.throws(
        () => extractMetadataFromStdout(stdout),
        /No valid metadata JSON found in output/,
      );
    });
  });

  void describe('Edge cases', () => {
    void it('handles JSON with empty strings', () => {
      const stdout = `${METADATA_PROTOCOL_PREFIX} {"name": "", "params": [""]}`;
      const result = extractMetadataFromStdout(stdout);

      assert.strictEqual(result.name, '');
      assert.deepStrictEqual(result.params, ['']);
    });

    void it('handles JSON with null values', () => {
      // eslint-disable-next-line @stylistic/max-len
      const stdout = `${METADATA_PROTOCOL_PREFIX} {"name": "func", "description": null, "params": []}`;
      const result = extractMetadataFromStdout(stdout);

      assert.strictEqual(result.name, 'func');
      assert.strictEqual(result.description, null);
    });

    void it('handles JSON with boolean values', () => {
      // eslint-disable-next-line @stylistic/max-len
      const stdout = `${METADATA_PROTOCOL_PREFIX} {"name": "func", "async": true, "deprecated": false, "params": []}`;
      const result = extractMetadataFromStdout(stdout);

      assert.strictEqual(result.async, true);
      assert.strictEqual(result.deprecated, false);
    });

    void it('handles JSON with numeric values', () => {
      // eslint-disable-next-line @stylistic/max-len
      const stdout = `${METADATA_PROTOCOL_PREFIX} {"name": "func", "version": 1.5, "priority": 42, "params": []}`;
      const result = extractMetadataFromStdout(stdout);

      assert.strictEqual(result.version, 1.5);
      assert.strictEqual(result.priority, 42);
    });

    void it('handles JSON array at root level', () => {

      const stdout = `${METADATA_PROTOCOL_PREFIX} [{"name": "func1"}, {"name": "func2"}]`;
      const result = extractMetadataFromStdout(stdout);

      assert.strictEqual(Array.isArray(result), true);
      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].name, 'func1');
      assert.strictEqual(result[1].name, 'func2');
    });

    void it('handles deeply nested JSON', () => {

      const stdout = `${METADATA_PROTOCOL_PREFIX} {"a": {"b": {"c": {"d": {"e": "deep"}}}}}`;
      const result = extractMetadataFromStdout(stdout);

      assert.strictEqual(result.a.b.c.d.e, 'deep');
    });

    void it('handles JSON with escaped backslashes', () => {
      // eslint-disable-next-line @stylistic/max-len
      const stdout = `${METADATA_PROTOCOL_PREFIX} {"name": "func", "path": "C:\\\\Users\\\\test", "params": []}`;
      const result = extractMetadataFromStdout(stdout);

      assert.strictEqual(result.path, 'C:\\Users\\test');
    });

    void it('handles protocol prefix at the very end of a log line', () => {
      const stdout = `Processing complete.LMNR_METADATA: {"name": "func", "params": []}`;
      const result = extractMetadataFromStdout(stdout);

      assert.strictEqual(result.name, 'func');
    });

    void it('handles multiple occurrences in a complex log stream', () => {
      /* eslint-disable @stylistic/max-len */
      const stdout = `[2024-01-22 10:00:00] INFO: Starting
[2024-01-22 10:00:01] DEBUG: Reading LMNR_METADATA: configuration file
[2024-01-22 10:00:02] INFO: Discovery started
${METADATA_PROTOCOL_PREFIX} {"name": "function_with_LMNR_METADATA:_in_name", "params": ["LMNR_METADATA:", "test"]}
[2024-01-22 10:00:03] INFO: Done`;
      /* eslint-enable @stylistic/max-len */


      const result = extractMetadataFromStdout(stdout);
      assert.strictEqual(result.name, 'function_with_LMNR_METADATA:_in_name');
      assert.deepStrictEqual(result.params, ['LMNR_METADATA:', 'test']);
    });
  });
});
