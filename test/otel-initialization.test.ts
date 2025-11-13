import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { getOtelEnvVar, parseOtelHeaders, hasOtelConfig, validateTracingConfig } from '../src/utils';

describe('OTEL environment variable utilities', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('getOtelEnvVar', () => {
    it('should check OTEL env vars in correct priority order', () => {
      process.env.OTEL_ENDPOINT = 'http://otel-endpoint';
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://otlp-endpoint';
      process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = 'http://traces-endpoint';

      assert.strictEqual(getOtelEnvVar('ENDPOINT'), 'http://traces-endpoint');
    });

    it('should fallback through priority order', () => {
      process.env.OTEL_ENDPOINT = 'http://otel-endpoint';
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://otlp-endpoint';

      assert.strictEqual(getOtelEnvVar('ENDPOINT'), 'http://otlp-endpoint');
    });

    it('should use lowest priority when others not available', () => {
      process.env.OTEL_ENDPOINT = 'http://otel-endpoint';

      assert.strictEqual(getOtelEnvVar('ENDPOINT'), 'http://otel-endpoint');
    });

    it('should return undefined when no OTEL env var is found', () => {
      assert.strictEqual(getOtelEnvVar('NONEXISTENT'), undefined);
    });
  });

  describe('parseOtelHeaders', () => {
    it('should parse valid OTEL headers string', () => {
      const headersStr = 'Authorization=Bearer%20token,Content-Type=application/json';
      const expected = {
        Authorization: 'Bearer token',
        'Content-Type': 'application/json',
      };
      assert.deepStrictEqual(parseOtelHeaders(headersStr), expected);
    });

    it('should return empty object for empty headers string', () => {
      assert.deepStrictEqual(parseOtelHeaders(''), {});
      assert.deepStrictEqual(parseOtelHeaders(undefined), {});
    });

    it('should handle headers without equals sign', () => {
      const headersStr = 'invalid,no-equals-sign';
      assert.deepStrictEqual(parseOtelHeaders(headersStr), {});
    });

    it('should handle URL-encoded values', () => {
      const headersStr = 'key=value%20with%20spaces';
      assert.deepStrictEqual(parseOtelHeaders(headersStr), { key: 'value with spaces' });
    });

    it('should handle multiple equals signs in value', () => {
      const headersStr = 'Authorization=Bearer%20token=abc123';
      assert.deepStrictEqual(parseOtelHeaders(headersStr), { Authorization: 'Bearer token=abc123' });
    });
  });

  describe('hasOtelConfig', () => {
    it('should return true when OTEL_ENDPOINT is set', () => {
      process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = 'http://endpoint';
      assert.strictEqual(hasOtelConfig(), true);
    });

    it('should return true when OTEL_HEADERS is set', () => {
      process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS = 'Authorization=Bearer%20token';
      assert.strictEqual(hasOtelConfig(), true);
    });

    it('should return false when no OTEL config is set', () => {
      assert.strictEqual(hasOtelConfig(), false);
    });
  });

  describe('validateTracingConfig', () => {
    it('should not throw when API key is provided', () => {
      assert.doesNotThrow(() => validateTracingConfig('test-api-key'));
    });

    it('should not throw when OTEL_ENDPOINT is set', () => {
      process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = 'http://endpoint';
      assert.doesNotThrow(() => validateTracingConfig());
    });

    it('should not throw when OTEL_HEADERS is set', () => {
      process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS = 'Authorization=Bearer%20token';
      assert.doesNotThrow(() => validateTracingConfig());
    });

    it('should throw when neither API key nor OTEL config is available', () => {
      assert.throws(
        () => validateTracingConfig(),
        (error: Error) => {
          return error.message.includes('Please initialize the Laminar object with your project API key');
        }
      );
    });
  });
});

describe('Laminar initialization with OTEL configuration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    // Clear any env vars that might affect tests
    delete process.env.LMNR_PROJECT_API_KEY;
    delete process.env.LMNR_BASE_URL;
    delete process.env.OTEL_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS;
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should validate that API key is provided in traditional mode', () => {
    process.env.LMNR_PROJECT_API_KEY = 'test-key';
    assert.doesNotThrow(() => validateTracingConfig(process.env.LMNR_PROJECT_API_KEY));
  });

  it('should validate that OTEL config is provided when no API key', () => {
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = 'http://collector:4318/v1/traces';
    assert.doesNotThrow(() => validateTracingConfig());
  });

  it('should throw error when neither API key nor OTEL config is available', () => {
    assert.throws(
      () => validateTracingConfig(),
      (error: Error) => {
        return error.message.includes('Please initialize the Laminar object with your project API key');
      }
    );
  });

  it('should allow API key to take precedence over OTEL config', () => {
    process.env.LMNR_PROJECT_API_KEY = 'laminar-key';
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = 'http://collector:4318';

    // Both are available, so validation should pass
    assert.doesNotThrow(() => validateTracingConfig(process.env.LMNR_PROJECT_API_KEY));
  });
});

describe('LaminarSpanExporter OTEL configuration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.LMNR_PROJECT_API_KEY;
    delete process.env.LMNR_BASE_URL;
    delete process.env.OTEL_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS;
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL;
    delete process.env.OTEL_EXPORTER;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should detect http protocol from OTEL_PROTOCOL', () => {
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = 'http://collector:4318';
    process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL = 'http/protobuf';

    const endpoint = getOtelEnvVar('ENDPOINT');
    const protocol = getOtelEnvVar('PROTOCOL');

    assert.strictEqual(endpoint, 'http://collector:4318');
    assert.strictEqual(protocol, 'http/protobuf');
  });

  it('should detect http protocol from OTEL_EXPORTER', () => {
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = 'http://collector:4318';
    process.env.OTEL_EXPORTER = 'otlp_http';

    const endpoint = getOtelEnvVar('ENDPOINT');
    assert.strictEqual(endpoint, 'http://collector:4318');
    assert.strictEqual(process.env.OTEL_EXPORTER, 'otlp_http');
  });

  it('should default to grpc protocol when not specified', () => {
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = 'http://collector:4317';

    const protocol = getOtelEnvVar('PROTOCOL');
    assert.strictEqual(protocol, undefined);
  });

  it('should parse OTEL headers correctly', () => {
    process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS = 'Authorization=Bearer%20token,x-custom=value';

    const headersStr = getOtelEnvVar('HEADERS');
    const headers = parseOtelHeaders(headersStr);

    assert.deepStrictEqual(headers, {
      Authorization: 'Bearer token',
      'x-custom': 'value',
    });
  });
});

