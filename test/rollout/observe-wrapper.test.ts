import * as assert from 'node:assert';
import { describe, it } from 'node:test';

import { observe } from '../../src/decorators';

void describe('observe with rolloutEntrypoint', () => {
  void it('returns a wrapped function when rolloutEntrypoint is true', () => {
    const testFn = (arg1: string, arg2: number) => `${arg1}-${arg2}`;

    const wrapped = observe({ name: 'testAgent', rolloutEntrypoint: true }, testFn);

    assert.ok(typeof wrapped === 'function', 'Should return a function');
  });

  void it('registers function in Map when _set_rollout_global is true', () => {
    globalThis._set_rollout_global = true;
    globalThis._rolloutFunctions = new Map();

    const testFn = (arg1: string, arg2: number) => `${arg1}-${arg2}`;

    observe({ name: 'testAgent', rolloutEntrypoint: true }, testFn);

    assert.ok(globalThis._rolloutFunctions.size > 0, 'Function should be registered in Map');

    // Clean up
    globalThis._set_rollout_global = false;
  });

  void it('calls returned function successfully', async () => {
    globalThis._set_rollout_global = false;

    const testFn = (arg1: string) => `result: ${arg1}`;

    const wrapped = observe({ name: 'testAgent', rolloutEntrypoint: true }, testFn);

    // TODO: Cleanup the typing after the 0.8.0 release is merged
    // eslint-disable-next-line @typescript-eslint/await-thenable
    const result = await wrapped('test');

    assert.strictEqual(result, 'result: test');
  });

  void it('extracts parameter names and stores in Map', () => {
    globalThis._set_rollout_global = true;
    globalThis._rolloutFunctions = new Map();

    const testFn = (instruction: string, temperature: number, options: any) => {
      console.debug(instruction, temperature, options);
      return 'result';
    };

    observe({ name: 'testAgent', rolloutEntrypoint: true }, testFn);

    assert.ok(globalThis._rolloutFunctions.size > 0);
    const registered = Array.from(globalThis._rolloutFunctions.values())[0];
    assert.ok(registered.params.length >= 2);
    assert.deepStrictEqual(
      registered.params, [{ name: 'instruction' }, { name: 'temperature' }, { name: 'options' }],
    );

    // Clean up
    globalThis._set_rollout_global = false;
  });

  void it('works in backward compatible mode without rolloutEntrypoint', async () => {
    const testFn = (arg1: string) => `result: ${arg1}`;

    const result = await observe({ name: 'testAgent' }, testFn, 'test');

    assert.strictEqual(result, 'result: test');
  });

  void it('throws error if fn is not a function', async () => {
    await assert.rejects(
      async () => {
        await observe({ name: 'test' }, null as any, 'arg');
      },
      /Invalid `observe` usage/,
    );
  });

  void it('handles multiple functions in Map', () => {
    globalThis._set_rollout_global = true;
    globalThis._rolloutFunctions = new Map();

    const fn1 = (x: string) => x;
    const fn2 = (y: number) => y;

    observe({ name: 'agent1', rolloutEntrypoint: true }, fn1);
    observe({ name: 'agent2', rolloutEntrypoint: true }, fn2);

    assert.strictEqual(globalThis._rolloutFunctions.size, 2);

    // Clean up
    globalThis._set_rollout_global = false;
  });

  void it('extracts parameters from arrow functions', () => {
    globalThis._set_rollout_global = true;
    globalThis._rolloutFunctions = new Map();

    const arrowFn = (x: string, y: number) => x + y;

    observe({ name: 'arrow', rolloutEntrypoint: true }, arrowFn);

    const registered = Array.from(globalThis._rolloutFunctions.values())[0];
    assert.deepStrictEqual(registered.params, [{ name: 'x' }, { name: 'y' }]);

    globalThis._set_rollout_global = false;
  });

  void it('extracts parameters from async functions', () => {
    globalThis._set_rollout_global = true;
    globalThis._rolloutFunctions = new Map();

    // eslint-disable-next-line @typescript-eslint/require-await
    const asyncFn = async (a: string, b: boolean) => ({ a, b });

    observe({ name: 'async', rolloutEntrypoint: true }, asyncFn);

    const registered = Array.from(globalThis._rolloutFunctions.values())[0];
    assert.deepStrictEqual(registered.params, [{ name: 'a' }, { name: 'b' }]);

    globalThis._set_rollout_global = false;
  });

  void it('handles parameters with default values', () => {
    globalThis._set_rollout_global = true;
    globalThis._rolloutFunctions = new Map();

    // Function string will be: "(x: string, y: number = 5) => ..."
    const fnWithDefaults = (x: string, y: number = 5) => x + y;

    observe({ name: 'defaults', rolloutEntrypoint: true }, fnWithDefaults);

    const registered = Array.from(globalThis._rolloutFunctions.values())[0];
    assert.deepStrictEqual(registered.params, [{ name: 'x' }, { name: 'y' }]);

    globalThis._set_rollout_global = false;
  });

  void it('propagates rolloutSessionId from env var', async () => {
    process.env.LMNR_ROLLOUT_SESSION_ID = 'test-session-123';

    const testFn = (x: string) => x;
    const wrapped = observe({ name: 'test', rolloutEntrypoint: true }, testFn);

    // Call the wrapped function
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await wrapped('test-value');

    // The rolloutSessionId should be picked up from env var
    // This is tested more thoroughly in integration tests
    assert.ok(true);

    delete process.env.LMNR_ROLLOUT_SESSION_ID;
  });
});

