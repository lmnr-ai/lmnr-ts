import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import { extractRolloutFunctions } from '../../src/cli/worker/ts-parser';

void describe('Multiple Destructured Parameters', () => {
  void it('assigns unique names to multiple destructured parameters', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rollout-test-'));
    const testFile = path.join(tempDir, 'test.ts');

    // Create a test file with multiple destructured parameters
    const content = `
      import { observe } from '@lmnr-ai/lmnr';

      export const multiDestructured = observe(
        { name: 'multiDestructured', rolloutEntrypoint: true },
        async ({ a, b }: { a: string; b: number }, { c, d }: { c: boolean; d: string }) => {
          return { a, b, c, d };
        }
      );
    `;

    fs.writeFileSync(testFile, content);

    try {
      const functions = extractRolloutFunctions(testFile);
      assert.strictEqual(functions.size, 1);

      const func = functions.get('multiDestructured');
      assert.ok(func, 'Function should be found');
      assert.strictEqual(func.params.length, 2, 'Should have 2 parameters');

      // First destructured param
      const param1 = func.params[0];
      assert.strictEqual(param1.name, '_destructured0', 'First param should be _destructured0');
      assert.ok(param1.nested, 'First param should have nested properties');
      assert.strictEqual(param1.nested.length, 2);
      assert.ok(param1.nested.find(p => p.name === 'a'));
      assert.ok(param1.nested.find(p => p.name === 'b'));

      // Second destructured param
      const param2 = func.params[1];
      assert.strictEqual(param2.name, '_destructured1', 'Second param should be _destructured1');
      assert.ok(param2.nested, 'Second param should have nested properties');
      assert.strictEqual(param2.nested.length, 2);
      assert.ok(param2.nested.find(p => p.name === 'c'));
      assert.ok(param2.nested.find(p => p.name === 'd'));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  void it('uses simple name for single destructured parameter', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rollout-test-'));
    const testFile = path.join(tempDir, 'test.ts');

    // Create a test file with single destructured parameter
    const content = `
      import { observe } from '@lmnr-ai/lmnr';

      export const singleDestructured = observe(
        { name: 'singleDestructured', rolloutEntrypoint: true },
        async ({ a, b }: { a: string; b: number }) => {
          return { a, b };
        }
      );
    `;

    fs.writeFileSync(testFile, content);

    try {
      const functions = extractRolloutFunctions(testFile);
      assert.strictEqual(functions.size, 1);

      const func = functions.get('singleDestructured');
      assert.ok(func, 'Function should be found');
      assert.strictEqual(func.params.length, 1, 'Should have 1 parameter');

      const param = func.params[0];
      assert.strictEqual(param.name, '_destructured', 'Should use simple _destructured name');
      assert.ok(param.nested, 'Should have nested properties');
      assert.strictEqual(param.nested.length, 2);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  void it('avoids name collisions with actual parameter names', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rollout-test-'));
    const testFile = path.join(tempDir, 'test.ts');

    // Create a test file with a parameter named _destructured
    const content = `
      import { observe } from '@lmnr-ai/lmnr';

      export const avoidCollision = observe(
        { name: 'avoidCollision', rolloutEntrypoint: true },
        async (_destructured: string, { a, b }: { a: string; b: number }) => {
          return { _destructured, a, b };
        }
      );
    `;

    fs.writeFileSync(testFile, content);

    try {
      const functions = extractRolloutFunctions(testFile);
      assert.strictEqual(functions.size, 1);

      const func = functions.get('avoidCollision');
      assert.ok(func, 'Function should be found');
      assert.strictEqual(func.params.length, 2, 'Should have 2 parameters');

      // First param is a regular param named _destructured
      const param1 = func.params[0];
      assert.strictEqual(param1.name, '_destructured');
      assert.ok(!param1.nested, 'First param should not have nested properties');

      // Second param should avoid collision and use _destructured0
      const param2 = func.params[1];
      assert.strictEqual(
        param2.name,
        '_destructured0',
        'Should use _destructured0 to avoid collision',
      );
      assert.ok(param2.nested, 'Should have nested properties');
      assert.strictEqual(param2.nested.length, 2);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  void it('handles mixed destructured and regular parameters', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rollout-test-'));
    const testFile = path.join(tempDir, 'test.ts');

    const content = `
      import { observe } from '@lmnr-ai/lmnr';

      export const mixedParams = observe(
        { name: 'mixedParams', rolloutEntrypoint: true },
        async (
          x: string,
          { a, b }: { a: string; b: number },
          y: number,
          { c, d }: { c: boolean; d: string }
        ) => {
          return { x, a, b, y, c, d };
        }
      );
    `;

    fs.writeFileSync(testFile, content);

    try {
      const functions = extractRolloutFunctions(testFile);
      assert.strictEqual(functions.size, 1);

      const func = functions.get('mixedParams');
      assert.ok(func, 'Function should be found');
      assert.strictEqual(func.params.length, 4, 'Should have 4 parameters');

      // Regular param
      assert.strictEqual(func.params[0].name, 'x');
      assert.ok(!func.params[0].nested);

      // First destructured
      assert.strictEqual(func.params[1].name, '_destructured0');
      assert.ok(func.params[1].nested);
      assert.strictEqual(func.params[1].nested.length, 2);

      // Regular param
      assert.strictEqual(func.params[2].name, 'y');
      assert.ok(!func.params[2].nested);

      // Second destructured
      assert.strictEqual(func.params[3].name, '_destructured1');
      assert.ok(func.params[3].nested);
      assert.strictEqual(func.params[3].nested.length, 2);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  void it('handles more than 2 destructured parameters', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rollout-test-'));
    const testFile = path.join(tempDir, 'test.ts');

    const content = `
      import { observe } from '@lmnr-ai/lmnr';

      export const threeDestructured = observe(
        { name: 'threeDestructured', rolloutEntrypoint: true },
        async (
          { a, b }: { a: string; b: number },
          { c, d }: { c: boolean; d: string },
          { e, f }: { e: number[]; f: Record<string, any> }
        ) => {
          return { a, b, c, d, e, f };
        }
      );
    `;

    fs.writeFileSync(testFile, content);

    try {
      const functions = extractRolloutFunctions(testFile);
      assert.strictEqual(functions.size, 1);

      const func = functions.get('threeDestructured');
      assert.ok(func, 'Function should be found');
      assert.strictEqual(func.params.length, 3, 'Should have 3 parameters');

      // All three should be destructured with indexed names
      assert.strictEqual(func.params[0].name, '_destructured0');
      assert.ok(func.params[0].nested);
      assert.strictEqual(func.params[0].nested.length, 2);
      assert.ok(func.params[0].nested.find(p => p.name === 'a'));
      assert.ok(func.params[0].nested.find(p => p.name === 'b'));

      assert.strictEqual(func.params[1].name, '_destructured1');
      assert.ok(func.params[1].nested);
      assert.strictEqual(func.params[1].nested.length, 2);
      assert.ok(func.params[1].nested.find(p => p.name === 'c'));
      assert.ok(func.params[1].nested.find(p => p.name === 'd'));

      assert.strictEqual(func.params[2].name, '_destructured2');
      assert.ok(func.params[2].nested);
      assert.strictEqual(func.params[2].nested.length, 2);
      assert.ok(func.params[2].nested.find(p => p.name === 'e'));
      assert.ok(func.params[2].nested.find(p => p.name === 'f'));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  void it('handles deeply nested destructured parameters', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rollout-test-'));
    const testFile = path.join(tempDir, 'test.ts');

    const content = `
      import { observe } from '@lmnr-ai/lmnr';

      export const deeplyNested = observe(
        { name: 'deeplyNested', rolloutEntrypoint: true },
        async ({
          user,
          settings,
          metadata
        }: {
          user: {
            id: string;
            name: string;
            profile: {
              age: number;
              location: string;
            };
          };
          settings: {
            theme: string;
            notifications: boolean;
          };
          metadata: Record<string, any>;
        }) => {
          return { user, settings, metadata };
        }
      );
    `;

    fs.writeFileSync(testFile, content);

    try {
      const functions = extractRolloutFunctions(testFile);
      assert.strictEqual(functions.size, 1);

      const func = functions.get('deeplyNested');
      assert.ok(func, 'Function should be found');
      assert.strictEqual(func.params.length, 1, 'Should have 1 parameter');

      const param = func.params[0];
      assert.strictEqual(param.name, '_destructured');
      assert.ok(param.nested, 'Should have nested properties');
      assert.strictEqual(param.nested.length, 3);

      // Check top-level nested properties
      const userProp = param.nested.find(p => p.name === 'user');
      const settingsProp = param.nested.find(p => p.name === 'settings');
      const metadataProp = param.nested.find(p => p.name === 'metadata');

      assert.ok(userProp, 'Should have user property');
      assert.ok(settingsProp, 'Should have settings property');
      assert.ok(metadataProp, 'Should have metadata property');

      // Check that nested objects have their own nested structure
      assert.ok(userProp.nested, 'user should have nested properties');
      assert.strictEqual(userProp.nested.length, 3);
      assert.ok(userProp.nested.find(p => p.name === 'id'));
      assert.ok(userProp.nested.find(p => p.name === 'name'));

      const profileProp = userProp.nested.find(p => p.name === 'profile');
      assert.ok(profileProp, 'Should have profile property');
      assert.ok(profileProp.nested, 'profile should have nested properties');
      assert.strictEqual(profileProp.nested.length, 2);
      assert.ok(profileProp.nested.find(p => p.name === 'age'));
      assert.ok(profileProp.nested.find(p => p.name === 'location'));

      assert.ok(settingsProp.nested, 'settings should have nested properties');
      assert.strictEqual(settingsProp.nested.length, 2);
      assert.ok(settingsProp.nested.find(p => p.name === 'theme'));
      assert.ok(settingsProp.nested.find(p => p.name === 'notifications'));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  void it('handles multiple destructured params with nested objects', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rollout-test-'));
    const testFile = path.join(tempDir, 'test.ts');

    const content = `
      import { observe } from '@lmnr-ai/lmnr';

      export const multiWithNested = observe(
        { name: 'multiWithNested', rolloutEntrypoint: true },
        async (
          {
            request,
            auth
          }: {
            request: {
              method: string;
              headers: Record<string, string>;
            };
            auth: {
              token: string;
              userId: string;
            };
          },
          {
            options,
            config
          }: {
            options: {
              timeout: number;
              retries: number;
            };
            config: {
              debug: boolean;
              verbose: boolean;
            };
          }
        ) => {
          return { request, auth, options, config };
        }
      );
    `;

    fs.writeFileSync(testFile, content);

    try {
      const functions = extractRolloutFunctions(testFile);
      assert.strictEqual(functions.size, 1);

      const func = functions.get('multiWithNested');
      assert.ok(func, 'Function should be found');
      assert.strictEqual(func.params.length, 2, 'Should have 2 parameters');

      // First destructured param
      const param1 = func.params[0];
      assert.strictEqual(param1.name, '_destructured0');
      assert.ok(param1.nested);
      assert.strictEqual(param1.nested.length, 2);

      const requestProp = param1.nested.find(p => p.name === 'request');
      const authProp = param1.nested.find(p => p.name === 'auth');
      assert.ok(requestProp);
      assert.ok(authProp);

      // Check nested properties of first param
      assert.ok(requestProp.nested);
      assert.strictEqual(requestProp.nested.length, 2);
      assert.ok(requestProp.nested.find(p => p.name === 'method'));
      assert.ok(requestProp.nested.find(p => p.name === 'headers'));

      assert.ok(authProp.nested);
      assert.strictEqual(authProp.nested.length, 2);
      assert.ok(authProp.nested.find(p => p.name === 'token'));
      assert.ok(authProp.nested.find(p => p.name === 'userId'));

      // Second destructured param
      const param2 = func.params[1];
      assert.strictEqual(param2.name, '_destructured1');
      assert.ok(param2.nested);
      assert.strictEqual(param2.nested.length, 2);

      const optionsProp = param2.nested.find(p => p.name === 'options');
      const configProp = param2.nested.find(p => p.name === 'config');
      assert.ok(optionsProp);
      assert.ok(configProp);

      // Check nested properties of second param
      assert.ok(optionsProp.nested);
      assert.strictEqual(optionsProp.nested.length, 2);
      assert.ok(optionsProp.nested.find(p => p.name === 'timeout'));
      assert.ok(optionsProp.nested.find(p => p.name === 'retries'));

      assert.ok(configProp.nested);
      assert.strictEqual(configProp.nested.length, 2);
      assert.ok(configProp.nested.find(p => p.name === 'debug'));
      assert.ok(configProp.nested.find(p => p.name === 'verbose'));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  void it('handles destructured params with optional nested properties', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rollout-test-'));
    const testFile = path.join(tempDir, 'test.ts');

    const content = `
      import { observe } from '@lmnr-ai/lmnr';

      export const optionalNested = observe(
        { name: 'optionalNested', rolloutEntrypoint: true },
        async (
          {
            required,
            optional
          }: {
            required: {
              id: string;
              name: string;
            };
            optional?: {
              tags?: string[];
              metadata?: Record<string, any>;
            };
          }
        ) => {
          return { required, optional };
        }
      );
    `;

    fs.writeFileSync(testFile, content);

    try {
      const functions = extractRolloutFunctions(testFile);
      assert.strictEqual(functions.size, 1);

      const func = functions.get('optionalNested');
      assert.ok(func, 'Function should be found');
      assert.strictEqual(func.params.length, 1, 'Should have 1 parameter');

      const param = func.params[0];
      assert.strictEqual(param.name, '_destructured');
      assert.ok(param.nested);
      assert.strictEqual(param.nested.length, 2);

      const requiredProp = param.nested.find(p => p.name === 'required');
      const optionalProp = param.nested.find(p => p.name === 'optional');

      assert.ok(requiredProp);
      assert.ok(optionalProp);

      // Required property should be required
      assert.strictEqual(requiredProp.required, true);
      assert.ok(requiredProp.nested);

      // Optional property should not be required
      assert.strictEqual(optionalProp.required, false);
      assert.ok(optionalProp.nested);

      // Check nested optional properties
      const tagsProp = optionalProp.nested.find(p => p.name === 'tags');
      const metadataProp = optionalProp.nested.find(p => p.name === 'metadata');

      assert.ok(tagsProp);
      assert.ok(metadataProp);
      assert.strictEqual(tagsProp.required, false);
      assert.strictEqual(metadataProp.required, false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
