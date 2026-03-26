import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { outputJson, outputJsonError } from './output';

describe('outputJson', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes stringified object to stdout', () => {
    const data = { name: 'test', count: 42 };
    outputJson(data);
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(data));
  });

  it('writes stringified array to stdout', () => {
    const data = [{ id: '1' }, { id: '2' }];
    outputJson(data);
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(data));
  });

  it('writes null', () => {
    outputJson(null);
    expect(logSpy).toHaveBeenCalledWith('null');
  });

  it('writes string value', () => {
    outputJson('hello');
    expect(logSpy).toHaveBeenCalledWith('"hello"');
  });

  it('output is valid parseable JSON', () => {
    const data = { nested: { array: [1, 2, 3] } };
    outputJson(data);
    const output = logSpy.mock.calls[0][0] as string;
    expect((): unknown => JSON.parse(output)).not.toThrow();
    expect(JSON.parse(output)).toEqual(data);
  });
});

describe('outputJsonError', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?) => {
      throw new Error(`process.exit(${code})`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes error message from Error instance and exits with code 1', () => {
    expect(() => outputJsonError(new Error('something failed'))).toThrow('process.exit(1)');
    const output = logSpy.mock.calls[0][0] as string;
    expect(JSON.parse(output)).toEqual({ error: 'something failed' });
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('writes string error and exits with code 1', () => {
    expect(() => outputJsonError('bad request')).toThrow('process.exit(1)');
    const output = logSpy.mock.calls[0][0] as string;
    expect(JSON.parse(output)).toEqual({ error: 'bad request' });
  });

  it('uses custom exit code', () => {
    expect(() => outputJsonError('conflict', 5)).toThrow('process.exit(5)');
    expect(exitSpy).toHaveBeenCalledWith(5);
  });

  it('output is valid parseable JSON', () => {
    expect(() => outputJsonError(new Error('test'))).toThrow();
    const output = logSpy.mock.calls[0][0] as string;
    expect((): unknown => JSON.parse(output)).not.toThrow();
  });
});
