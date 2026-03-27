import { describe, expect, it } from 'vitest';

import {
  extractMetadataFromStdout,
  METADATA_PROTOCOL_PREFIX,
} from './metadata';

describe('extractMetadataFromStdout', () => {
  describe('Basic functionality', () => {
    it('parses simple JSON with protocol prefix', () => {

      const stdout = `${METADATA_PROTOCOL_PREFIX} {"name": "test_func", "params": []}`;
      const result = extractMetadataFromStdout(stdout);

      expect(result.name).toBe('test_func');
      expect(result.params).toEqual([]);
    });

    it('parses JSON with protocol prefix on a new line', () => {
      // eslint-disable-next-line @stylistic/max-len
      const stdout = `${METADATA_PROTOCOL_PREFIX}\n{"name": "my_function", "params": ["arg1", "arg2"]}`;
      const result = extractMetadataFromStdout(stdout);

      expect(result.name).toBe('my_function');
      expect(result.params).toEqual(['arg1', 'arg2']);
    });

    it('handles whitespace after protocol prefix', () => {

      const stdout = `${METADATA_PROTOCOL_PREFIX}   {"name": "func", "params": []}`;
      const result = extractMetadataFromStdout(stdout);

      expect(result.name).toBe('func');
    });

    it('handles no whitespace after protocol prefix', () => {

      const stdout = `${METADATA_PROTOCOL_PREFIX}{"name": "func", "params": []}`;
      const result = extractMetadataFromStdout(stdout);

      expect(result.name).toBe('func');
    });
  });

  describe('Multiple protocol prefixes', () => {
    it('returns the last valid JSON when multiple prefixes exist', () => {
      const stdout = `${METADATA_PROTOCOL_PREFIX} {"name": "first", "params": []}
${METADATA_PROTOCOL_PREFIX} {"name": "second", "params": []}
${METADATA_PROTOCOL_PREFIX} {"name": "last", "params": []}`;

      const result = extractMetadataFromStdout(stdout);
      expect(result.name).toBe('last');
    });

    it('skips invalid JSON and returns the last valid one', () => {
      const stdout = `${METADATA_PROTOCOL_PREFIX} {"name": "valid", "params": []}
${METADATA_PROTOCOL_PREFIX} invalid json here
${METADATA_PROTOCOL_PREFIX} {"name": "last_valid", "params": [1, 2, 3]}`;

      const result = extractMetadataFromStdout(stdout);
      expect(result.name).toBe('last_valid');
      expect(result.params).toEqual([1, 2, 3]);
    });
  });

  describe('Protocol prefix in JSON payload (the bug we fixed)', () => {
    it('handles protocol prefix in function name', () => {
      // eslint-disable-next-line @stylistic/max-len
      const stdout = `${METADATA_PROTOCOL_PREFIX} {"name": "test_LMNR_METADATA:_func", "params": []}`;
      const result = extractMetadataFromStdout(stdout);

      expect(result.name).toBe('test_LMNR_METADATA:_func');
      expect(result.params).toEqual([]);
    });

    it('handles protocol prefix in string values', () => {
      // eslint-disable-next-line @stylistic/max-len
      const stdout = `${METADATA_PROTOCOL_PREFIX} {"name": "func", "description": "Uses LMNR_METADATA: prefix", "params": []}`;
      const result = extractMetadataFromStdout(stdout);

      expect(result.name).toBe('func');
      expect(result.description).toBe('Uses LMNR_METADATA: prefix');
    });

    it('handles multiple protocol strings in JSON values', () => {
      // eslint-disable-next-line @stylistic/max-len
      const stdout = `${METADATA_PROTOCOL_PREFIX} {"name": "LMNR_METADATA:test", "note": "LMNR_METADATA: appears here", "params": ["LMNR_METADATA:"]}`;
      const result = extractMetadataFromStdout(stdout);

      expect(result.name).toBe('LMNR_METADATA:test');
      expect(result.note).toBe('LMNR_METADATA: appears here');
      expect(result.params).toEqual(['LMNR_METADATA:']);
    });

    it('handles escaped characters in strings containing protocol prefix', () => {
      // eslint-disable-next-line @stylistic/max-len
      const stdout = `${METADATA_PROTOCOL_PREFIX} {"name": "func", "path": "/path/to/LMNR_METADATA:\\\\file.py", "params": []}`;
      const result = extractMetadataFromStdout(stdout);

      expect(result.name).toBe('func');
      expect(result.path).toBe('/path/to/LMNR_METADATA:\\file.py');
    });
  });

  describe('Log output before metadata', () => {
    it('parses JSON when preceded by log lines', () => {
      const stdout = `INFO: Starting discovery
DEBUG: Processing file
${METADATA_PROTOCOL_PREFIX} {"name": "my_func", "params": []}`;

      const result = extractMetadataFromStdout(stdout);
      expect(result.name).toBe('my_func');
    });

    it('handles log line without trailing newline before metadata', () => {
      const stdout = `INFO: Starting discoveryLMNR_METADATA: {"name": "my_func", "params": []}`;
      const result = extractMetadataFromStdout(stdout);

      expect(result.name).toBe('my_func');
    });

    it('handles multiple log lines and finds metadata', () => {
      const stdout = `2024-01-22 10:00:00 - INFO - Loading module
2024-01-22 10:00:01 - DEBUG - Scanning functions
2024-01-22 10:00:02 - INFO - Found function
${METADATA_PROTOCOL_PREFIX} {"name": "discovered_func", "params": ["x", "y", "z"]}
2024-01-22 10:00:03 - INFO - Done`;

      const result = extractMetadataFromStdout(stdout);
      expect(result.name).toBe('discovered_func');
      expect(result.params).toEqual(['x', 'y', 'z']);
    });
  });

  describe('Complex JSON structures', () => {
    it('parses nested objects', () => {
      // eslint-disable-next-line @stylistic/max-len
      const stdout = `${METADATA_PROTOCOL_PREFIX} {"name": "func", "params": [{"name": "arg1", "type": "str"}], "metadata": {"version": 1}}`;
      const result = extractMetadataFromStdout(stdout);

      expect(result.name).toBe('func');
      expect(result.params[0].name).toBe('arg1');
      expect(result.metadata.version).toBe(1);
    });

    it('parses nested arrays', () => {
      // eslint-disable-next-line @stylistic/max-len
      const stdout = `${METADATA_PROTOCOL_PREFIX} {"name": "func", "params": [["a", "b"], ["c", "d"]]}`;
      const result = extractMetadataFromStdout(stdout);

      expect(result.params).toEqual([['a', 'b'], ['c', 'd']]);
    });

    it('handles JSON with special characters in strings', () => {
      // eslint-disable-next-line @stylistic/max-len
      const stdout = `${METADATA_PROTOCOL_PREFIX} {"name": "func", "description": "Test with \\"quotes\\" and \\n newlines", "params": []}`;
      const result = extractMetadataFromStdout(stdout);

      expect(result.name).toBe('func');
      expect(result.description).toBe('Test with "quotes" and \n newlines');
    });

    it('parses JSON with Unicode characters', () => {

      const stdout = `${METADATA_PROTOCOL_PREFIX} {"name": "测试函数", "params": ["日本語", "한글"]}`;
      const result = extractMetadataFromStdout(stdout);

      expect(result.name).toBe('测试函数');
      expect(result.params).toEqual(['日本語', '한글']);
    });
  });

  describe('Multi-line JSON', () => {
    it('parses multi-line formatted JSON', () => {
      const stdout = `${METADATA_PROTOCOL_PREFIX} {
  "name": "multi_line_func",
  "params": [
    "param1",
    "param2"
  ]
}`;

      const result = extractMetadataFromStdout(stdout);
      expect(result.name).toBe('multi_line_func');
      expect(result.params).toEqual(['param1', 'param2']);
    });

    it('parses multi-line JSON with nested objects', () => {
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
      expect(result.name).toBe('complex_func');
      expect(result.params[0].name).toBe('arg1');
      expect(result.returns.type).toBe('object');
    });
  });

  describe('JSON followed by additional text', () => {
    it('parses JSON when followed by log output', () => {
      const stdout = `${METADATA_PROTOCOL_PREFIX} {"name": "func", "params": []}
INFO: Completed discovery`;

      const result = extractMetadataFromStdout(stdout);
      expect(result.name).toBe('func');
    });

    it('parses JSON when followed by more text on same line', () => {

      const stdout = `${METADATA_PROTOCOL_PREFIX} {"name": "func", "params": []} extra text here`;
      const result = extractMetadataFromStdout(stdout);

      expect(result.name).toBe('func');
    });
  });

  describe('Backward compatibility', () => {
    it('parses plain JSON without protocol prefix', () => {
      const stdout = '{"name": "legacy_func", "params": []}';
      const result = extractMetadataFromStdout(stdout);

      expect(result.name).toBe('legacy_func');
      expect(result.params).toEqual([]);
    });

    it('parses plain JSON with whitespace', () => {
      const stdout = '  \n{"name": "func", "params": []}  \n';
      const result = extractMetadataFromStdout(stdout);

      expect(result.name).toBe('func');
    });

    it('falls back to plain JSON when protocol prefix not found', () => {
      const stdout = `Some log output
{"name": "fallback_func", "params": ["a", "b"]}`;

      // This should fail the protocol search and try to parse as plain JSON
      // which will fail because of the log output
      expect(
        (): unknown => extractMetadataFromStdout(stdout),
      ).toThrow(/No metadata found in output/);
    });
  });

  describe('Error handling', () => {
    it('throws error when no metadata found', () => {
      const stdout = 'Just some log output without any metadata';

      expect(
        (): unknown => extractMetadataFromStdout(stdout),
      ).toThrow(/No metadata found in output/);
    });

    it('throws error when protocol prefix exists but no valid JSON', () => {
      const stdout = `${METADATA_PROTOCOL_PREFIX} this is not valid json`;

      expect(
        (): unknown => extractMetadataFromStdout(stdout),
      ).toThrow(/No valid metadata JSON found in output/);
    });

    it('throws error for empty string', () => {
      expect(
        (): unknown => extractMetadataFromStdout(''),
      ).toThrow(/No metadata found in output/);
    });

    it('throws error for protocol prefix with incomplete JSON', () => {
      const stdout = `${METADATA_PROTOCOL_PREFIX} {"name": "func", "params":`;

      expect(
        (): unknown => extractMetadataFromStdout(stdout),
      ).toThrow(/No valid metadata JSON found in output/);
    });
  });

  describe('Edge cases', () => {
    it('handles JSON with empty strings', () => {
      const stdout = `${METADATA_PROTOCOL_PREFIX} {"name": "", "params": [""]}`;
      const result = extractMetadataFromStdout(stdout);

      expect(result.name).toBe('');
      expect(result.params).toEqual(['']);
    });

    it('handles JSON with null values', () => {
      // eslint-disable-next-line @stylistic/max-len
      const stdout = `${METADATA_PROTOCOL_PREFIX} {"name": "func", "description": null, "params": []}`;
      const result = extractMetadataFromStdout(stdout);

      expect(result.name).toBe('func');
      expect(result.description).toBe(null);
    });

    it('handles JSON with boolean values', () => {
      // eslint-disable-next-line @stylistic/max-len
      const stdout = `${METADATA_PROTOCOL_PREFIX} {"name": "func", "async": true, "deprecated": false, "params": []}`;
      const result = extractMetadataFromStdout(stdout);

      expect(result.async).toBe(true);
      expect(result.deprecated).toBe(false);
    });

    it('handles JSON with numeric values', () => {
      // eslint-disable-next-line @stylistic/max-len
      const stdout = `${METADATA_PROTOCOL_PREFIX} {"name": "func", "version": 1.5, "priority": 42, "params": []}`;
      const result = extractMetadataFromStdout(stdout);

      expect(result.version).toBe(1.5);
      expect(result.priority).toBe(42);
    });

    it('handles JSON array at root level', () => {

      const stdout = `${METADATA_PROTOCOL_PREFIX} [{"name": "func1"}, {"name": "func2"}]`;
      const result = extractMetadataFromStdout(stdout);

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(2);
      expect(result[0].name).toBe('func1');
      expect(result[1].name).toBe('func2');
    });

    it('handles deeply nested JSON', () => {

      const stdout = `${METADATA_PROTOCOL_PREFIX} {"a": {"b": {"c": {"d": {"e": "deep"}}}}}`;
      const result = extractMetadataFromStdout(stdout);

      expect(result.a.b.c.d.e).toBe('deep');
    });

    it('handles JSON with escaped backslashes', () => {
      // eslint-disable-next-line @stylistic/max-len
      const stdout = `${METADATA_PROTOCOL_PREFIX} {"name": "func", "path": "C:\\\\Users\\\\test", "params": []}`;
      const result = extractMetadataFromStdout(stdout);

      expect(result.path).toBe('C:\\Users\\test');
    });

    it('handles protocol prefix at the very end of a log line', () => {
      const stdout = `Processing complete.LMNR_METADATA: {"name": "func", "params": []}`;
      const result = extractMetadataFromStdout(stdout);

      expect(result.name).toBe('func');
    });

    it('handles multiple occurrences in a complex log stream', () => {
      /* eslint-disable @stylistic/max-len */
      const stdout = `[2024-01-22 10:00:00] INFO: Starting
[2024-01-22 10:00:01] DEBUG: Reading LMNR_METADATA: configuration file
[2024-01-22 10:00:02] INFO: Discovery started
${METADATA_PROTOCOL_PREFIX} {"name": "function_with_LMNR_METADATA:_in_name", "params": ["LMNR_METADATA:", "test"]}
[2024-01-22 10:00:03] INFO: Done`;
      /* eslint-enable @stylistic/max-len */


      const result = extractMetadataFromStdout(stdout);
      expect(result.name).toBe('function_with_LMNR_METADATA:_in_name');
      expect(result.params).toEqual(['LMNR_METADATA:', 'test']);
    });
  });
});
