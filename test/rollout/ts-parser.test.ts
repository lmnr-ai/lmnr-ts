import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { extractRolloutFunctions } from '../../src/cli/rollout/ts-parser';

/**
 * Helper to create a temporary TypeScript file for testing
 */
function createTempFile(content: string): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lmnr-test-'));
  const filePath = path.join(tempDir, 'test.ts');
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

/**
 * Helper to clean up temporary file
 */
function cleanupTempFile(filePath: string): void {
  const dir = path.dirname(filePath);
  fs.rmSync(dir, { recursive: true, force: true });
}

void describe('extractRolloutFunctions', () => {
  void it('extracts simple parameters', () => {
    const content = `
import { observe } from '@lmnr-ai/lmnr';

export const simpleAgent = observe({ rolloutEntrypoint: true }, (
  async (input: string, count: number) => {
    return { result: input };
  }
));
`;
    const filePath = createTempFile(content);

    try {
      const functions = extractRolloutFunctions(filePath);

      assert.equal(functions.size, 1);
      assert.ok(functions.has('simpleAgent'));

      const metadata = functions.get('simpleAgent')!;
      assert.equal(metadata.name, 'simpleAgent');
      assert.equal(metadata.params.length, 2);

      assert.equal(metadata.params[0].name, 'input');
      assert.equal(metadata.params[0].type, 'string');
      assert.equal(metadata.params[0].required, true);

      assert.equal(metadata.params[1].name, 'count');
      assert.equal(metadata.params[1].type, 'number');
      assert.equal(metadata.params[1].required, true);
    } finally {
      cleanupTempFile(filePath);
    }
  });

  void it('extracts optional parameters with question mark', () => {
    const content = `
import { observe } from '@lmnr-ai/lmnr';

export const optionalAgent = observe({ rolloutEntrypoint: true }, (
  async (input: string, count?: number, options?: { verbose: boolean }) => {
    return { result: input };
  }
));
`;
    const filePath = createTempFile(content);

    try {
      const functions = extractRolloutFunctions(filePath);
      const metadata = functions.get('optionalAgent')!;

      assert.equal(metadata.params.length, 3);
      assert.equal(metadata.params[0].required, true);
      assert.equal(metadata.params[1].required, false);
      assert.equal(metadata.params[2].required, false);
      assert.equal(metadata.params[2].type, '{ verbose: boolean }');
    } finally {
      cleanupTempFile(filePath);
    }
  });

  void it('extracts parameters with default values', () => {
    const content = `
import { observe } from '@lmnr-ai/lmnr';

export const defaultAgent = observe({ rolloutEntrypoint: true }, (
  async (input: string, count = 10, options = { verbose: true }) => {
    return { result: input };
  }
));
`;
    const filePath = createTempFile(content);

    try {
      const functions = extractRolloutFunctions(filePath);
      const metadata = functions.get('defaultAgent')!;

      assert.equal(metadata.params.length, 3);
      assert.equal(metadata.params[0].required, true);
      assert.equal(metadata.params[0].default, undefined);

      assert.equal(metadata.params[1].required, false);
      assert.equal(metadata.params[1].default, '10');

      assert.equal(metadata.params[2].required, false);
      assert.equal(metadata.params[2].default, '{ verbose: true }');
    } finally {
      cleanupTempFile(filePath);
    }
  });

  void it('extracts object destructuring parameters', () => {
    const content = `
import { observe } from '@lmnr-ai/lmnr';

export const destructuredAgent = observe({ rolloutEntrypoint: true }, (
  async ({
    query,
    options = { verbose: true },
    limit = 10,
    metadata,
  }: {
    query: string;
    options?: { verbose: boolean; timeout?: number };
    limit?: number;
    metadata: Record<string, any>;
  }) => {
    return { result: query };
  }
));
`;
    const filePath = createTempFile(content);

    try {
      const functions = extractRolloutFunctions(filePath);
      const metadata = functions.get('destructuredAgent')!;

      assert.equal(metadata.params.length, 1);
      assert.equal(metadata.params[0].name, '_destructured');
      assert.ok(metadata.params[0].type?.includes('query: string'));
      assert.equal(metadata.params[0].required, true);

      // Check nested parameters
      const nested = metadata.params[0].nested!;
      assert.equal(nested.length, 4);

      // query - required
      assert.equal(nested[0].name, 'query');
      assert.equal(nested[0].type, 'string');
      assert.equal(nested[0].required, true);

      // options - optional with default
      assert.equal(nested[1].name, 'options');
      assert.equal(nested[1].type, '{ verbose: boolean; timeout?: number }');
      assert.equal(nested[1].required, false);
      assert.equal(nested[1].default, '{ verbose: true }');

      // limit - optional with default
      assert.equal(nested[2].name, 'limit');
      assert.equal(nested[2].type, 'number');
      assert.equal(nested[2].required, false);
      assert.equal(nested[2].default, '10');

      // metadata - required
      assert.equal(nested[3].name, 'metadata');
      assert.equal(nested[3].type, 'Record<string, any>');
      assert.equal(nested[3].required, true);
    } finally {
      cleanupTempFile(filePath);
    }
  });

  void it('handles complex nested types', () => {
    const content = `
import { observe } from '@lmnr-ai/lmnr';

export const complexAgent = observe({ rolloutEntrypoint: true }, (
  async (config: {
    api: { url: string; timeout: number };
    retries: number[];
    handlers: Map<string, (data: any) => Promise<void>>;
  }) => {
    return { result: 'ok' };
  }
));
`;
    const filePath = createTempFile(content);

    try {
      const functions = extractRolloutFunctions(filePath);
      const metadata = functions.get('complexAgent')!;

      assert.equal(metadata.params.length, 1);
      assert.equal(metadata.params[0].name, 'config');
      assert.ok(metadata.params[0].type?.includes('api:'));
      assert.ok(metadata.params[0].type?.includes('retries:'));
      assert.ok(metadata.params[0].type?.includes('handlers:'));
      assert.ok(metadata.params[0].type?.includes('Map<'));
    } finally {
      cleanupTempFile(filePath);
    }
  });

  void it('extracts multiple rollout functions from same file', () => {
    const content = `
import { observe } from '@lmnr-ai/lmnr';

export const agent1 = observe({ rolloutEntrypoint: true }, (
  async (input: string) => {
    return { result: input };
  }
));

export const agent2 = observe({ rolloutEntrypoint: true }, (
  async (query: string, limit: number) => {
    return { result: query };
  }
));
`;
    const filePath = createTempFile(content);

    try {
      const functions = extractRolloutFunctions(filePath);

      assert.equal(functions.size, 2);
      assert.ok(functions.has('agent1'));
      assert.ok(functions.has('agent2'));

      const agent1 = functions.get('agent1')!;
      assert.equal(agent1.params.length, 1);
      assert.equal(agent1.params[0].name, 'input');

      const agent2 = functions.get('agent2')!;
      assert.equal(agent2.params.length, 2);
      assert.equal(agent2.params[0].name, 'query');
      assert.equal(agent2.params[1].name, 'limit');
    } finally {
      cleanupTempFile(filePath);
    }
  });

  void it('ignores functions without rolloutEntrypoint', () => {
    const content = `
import { observe } from '@lmnr-ai/lmnr';

export const regularFunction = observe({ name: 'test' }, (
  async (input: string) => {
    return { result: input };
  }
), 'hello');

export const rolloutFunction = observe({ rolloutEntrypoint: true }, (
  async (query: string) => {
    return { result: query };
  }
));
`;
    const filePath = createTempFile(content);

    try {
      const functions = extractRolloutFunctions(filePath);

      assert.equal(functions.size, 1);
      assert.ok(!functions.has('regularFunction'));
      assert.ok(functions.has('rolloutFunction'));
    } finally {
      cleanupTempFile(filePath);
    }
  });

  void it('handles union types', () => {
    const content = `
import { observe } from '@lmnr-ai/lmnr';

export const unionAgent = observe({ rolloutEntrypoint: true }, (
  async (input: string | number, status: 'active' | 'inactive') => {
    return { result: input };
  }
));
`;
    const filePath = createTempFile(content);

    try {
      const functions = extractRolloutFunctions(filePath);
      const metadata = functions.get('unionAgent')!;

      assert.equal(metadata.params.length, 2);
      assert.equal(metadata.params[0].type, 'string | number');
      assert.equal(metadata.params[1].type, "'active' | 'inactive'");
    } finally {
      cleanupTempFile(filePath);
    }
  });

  void it('handles array types', () => {
    const content = `
import { observe } from '@lmnr-ai/lmnr';

export const arrayAgent = observe({ rolloutEntrypoint: true }, (
  async (items: string[], matrix: number[][], configs: Array<{ id: string }>) => {
    return { result: items };
  }
));
`;
    const filePath = createTempFile(content);

    try {
      const functions = extractRolloutFunctions(filePath);
      const metadata = functions.get('arrayAgent')!;

      assert.equal(metadata.params.length, 3);
      assert.equal(metadata.params[0].type, 'string[]');
      assert.equal(metadata.params[1].type, 'number[][]');
      assert.ok(metadata.params[2].type?.includes('Array<'));
    } finally {
      cleanupTempFile(filePath);
    }
  });

  void it('handles generic types', () => {
    const content = `
import { observe } from '@lmnr-ai/lmnr';

export const genericAgent = observe({ rolloutEntrypoint: true }, (
  async (data: Promise<string>, map: Map<string, number>, set: Set<string>) => {
    return { result: await data };
  }
));
`;
    const filePath = createTempFile(content);

    try {
      const functions = extractRolloutFunctions(filePath);
      const metadata = functions.get('genericAgent')!;

      assert.equal(metadata.params.length, 3);
      assert.equal(metadata.params[0].type, 'Promise<string>');
      assert.equal(metadata.params[1].type, 'Map<string, number>');
      assert.equal(metadata.params[2].type, 'Set<string>');
    } finally {
      cleanupTempFile(filePath);
    }
  });

  void it('handles tuple types', () => {
    const content = `
import { observe } from '@lmnr-ai/lmnr';

export const tupleAgent = observe({ rolloutEntrypoint: true }, (
  async (point: [number, number], record: [string, boolean, number?]) => {
    return { result: point };
  }
));
`;
    const filePath = createTempFile(content);

    try {
      const functions = extractRolloutFunctions(filePath);
      const metadata = functions.get('tupleAgent')!;

      assert.equal(metadata.params.length, 2);
      assert.equal(metadata.params[0].type, '[number, number]');
      assert.equal(metadata.params[1].type, '[string, boolean, number?]');
    } finally {
      cleanupTempFile(filePath);
    }
  });

  void it('handles function types', () => {
    const content = `
import { observe } from '@lmnr-ai/lmnr';

export const callbackAgent = observe({ rolloutEntrypoint: true }, (
  async (
    callback: (data: string) => void,
    asyncCallback: (data: string) => Promise<number>
  ) => {
    return { result: 'ok' };
  }
));
`;
    const filePath = createTempFile(content);

    try {
      const functions = extractRolloutFunctions(filePath);
      const metadata = functions.get('callbackAgent')!;

      assert.equal(metadata.params.length, 2);
      assert.ok(metadata.params[0].type?.includes('=>'));
      assert.ok(metadata.params[1].type?.includes('Promise'));
    } finally {
      cleanupTempFile(filePath);
    }
  });

  void it('handles no parameters', () => {
    const content = `
import { observe } from '@lmnr-ai/lmnr';

export const noParamsAgent = observe({ rolloutEntrypoint: true }, (
  async () => {
    return { result: 'ok' };
  }
));
`;
    const filePath = createTempFile(content);

    try {
      const functions = extractRolloutFunctions(filePath);
      const metadata = functions.get('noParamsAgent')!;

      assert.equal(metadata.params.length, 0);
    } finally {
      cleanupTempFile(filePath);
    }
  });

  void it('handles mixed destructuring and regular parameters', () => {
    const content = `
import { observe } from '@lmnr-ai/lmnr';

export const mixedAgent = observe({ rolloutEntrypoint: true }, (
  async (
    id: string,
    { query, limit = 10 }: { query: string; limit?: number },
    callback: (result: any) => void
  ) => {
    return { result: query };
  }
));
`;
    const filePath = createTempFile(content);

    try {
      const functions = extractRolloutFunctions(filePath);
      const metadata = functions.get('mixedAgent')!;

      assert.equal(metadata.params.length, 3);

      // First param - regular
      assert.equal(metadata.params[0].name, 'id');
      assert.equal(metadata.params[0].type, 'string');

      // Second param - destructured
      assert.equal(metadata.params[1].name, '_destructured');
      assert.ok(metadata.params[1].nested);
      assert.equal(metadata.params[1].nested.length, 2);
      assert.equal(metadata.params[1].nested[0].name, 'query');
      assert.equal(metadata.params[1].nested[1].name, 'limit');
      assert.equal(metadata.params[1].nested[1].default, '10');

      // Third param - regular function type
      assert.equal(metadata.params[2].name, 'callback');
      assert.ok(metadata.params[2].type?.includes('=>'));
    } finally {
      cleanupTempFile(filePath);
    }
  });

  void it('returns empty map for file with no rollout functions', () => {
    const content = `
import { observe } from '@lmnr-ai/lmnr';

export const regularFunction = async (input: string) => {
  return { result: input };
};
`;
    const filePath = createTempFile(content);

    try {
      const functions = extractRolloutFunctions(filePath);
      assert.equal(functions.size, 0);
    } finally {
      cleanupTempFile(filePath);
    }
  });

  void it('handles deeply nested object types in destructuring', () => {
    const content = `
import { observe } from '@lmnr-ai/lmnr';

export const deepAgent = observe({ rolloutEntrypoint: true }, (
  async ({
    config,
    options,
  }: {
    config: {
      api: {
        baseUrl: string;
        timeout?: number;
      };
      retry: boolean;
    };
    options?: {
      cache?: {
        enabled: boolean;
        ttl: number;
      };
    };
  }) => {
    return { result: 'ok' };
  }
));
`;
    const filePath = createTempFile(content);

    try {
      const functions = extractRolloutFunctions(filePath);
      const metadata = functions.get('deepAgent')!;

      assert.equal(metadata.params.length, 1);
      assert.equal(metadata.params[0].name, '_destructured');
      assert.equal(metadata.params[0].nested!.length, 2);

      // Check that complex nested types are preserved
      assert.ok(metadata.params[0].nested![0].type?.includes('baseUrl'));
      assert.ok(metadata.params[0].nested![0].type?.includes('timeout'));
      assert.ok(metadata.params[0].nested![1].type?.includes('cache'));
    } finally {
      cleanupTempFile(filePath);
    }
  });

  void it('handles type literals and intersection types', () => {
    const content = `
import { observe } from '@lmnr-ai/lmnr';

export const intersectionAgent = observe({ rolloutEntrypoint: true }, (
  async (config: { id: string } & { name: string }, count: number) => {
    return { result: config.id };
  }
));
`;
    const filePath = createTempFile(content);

    try {
      const functions = extractRolloutFunctions(filePath);
      const metadata = functions.get('intersectionAgent')!;

      assert.equal(metadata.params.length, 2);
      // Intersection types are preserved
      assert.ok(metadata.params[0].type?.includes('&'));
    } finally {
      cleanupTempFile(filePath);
    }
  });

  void it('handles rest parameters', () => {
    const content = `
import { observe } from '@lmnr-ai/lmnr';

export const restAgent = observe({ rolloutEntrypoint: true }, (
  async (first: string, ...rest: number[]) => {
    return { result: first };
  }
));
`;
    const filePath = createTempFile(content);

    try {
      const functions = extractRolloutFunctions(filePath);
      const metadata = functions.get('restAgent')!;

      // Rest parameters are still captured
      assert.equal(metadata.params.length, 2);
      assert.equal(metadata.params[0].name, 'first');
    } finally {
      cleanupTempFile(filePath);
    }
  });

  void it('handles named exports (export { ... } syntax)', () => {
    const content = `
import { observe } from '@lmnr-ai/lmnr';

const agent1 = observe({ rolloutEntrypoint: true }, (
  async (input: string) => {
    return { result: input };
  }
));

const agent2 = observe({ rolloutEntrypoint: true }, (
  async (query: string, limit: number) => {
    return { result: query };
  }
));

const notExported = observe({ rolloutEntrypoint: true }, (
  async (x: string) => {
    return { result: x };
  }
));

export { agent1, agent2 };
`;
    const filePath = createTempFile(content);

    try {
      const functions = extractRolloutFunctions(filePath);

      // Should find the two exported functions
      assert.equal(functions.size, 2);
      assert.ok(functions.has('agent1'));
      assert.ok(functions.has('agent2'));
      assert.ok(!functions.has('notExported'));

      const agent1 = functions.get('agent1')!;
      assert.equal(agent1.params.length, 1);
      assert.equal(agent1.params[0].name, 'input');

      const agent2 = functions.get('agent2')!;
      assert.equal(agent2.params.length, 2);
      assert.equal(agent2.params[0].name, 'query');
      assert.equal(agent2.params[1].name, 'limit');
    } finally {
      cleanupTempFile(filePath);
    }
  });

  void it('extracts nested properties from non-destructured object parameters', () => {
    const content = `
import { observe } from '@lmnr-ai/lmnr';

export const objectParamAgent = observe({ rolloutEntrypoint: true }, (
  async (
    userMessage: string,
    model: {
      provider: string;
      name: string;
    }
  ) => {
    return { result: userMessage };
  }
));
`;
    const filePath = createTempFile(content);

    try {
      const functions = extractRolloutFunctions(filePath);
      const metadata = functions.get('objectParamAgent')!;

      assert.equal(metadata.params.length, 2);

      // First param - simple string
      assert.equal(metadata.params[0].name, 'userMessage');
      assert.equal(metadata.params[0].type, 'string');
      assert.equal(metadata.params[0].required, true);
      assert.equal(metadata.params[0].nested, undefined);

      // Second param - object with nested properties
      assert.equal(metadata.params[1].name, 'model');
      assert.ok(metadata.params[1].type?.includes('provider'));
      assert.equal(metadata.params[1].required, true);
      assert.ok(metadata.params[1].nested);
      assert.equal(metadata.params[1].nested.length, 2);

      // Check nested properties
      assert.equal(metadata.params[1].nested[0].name, 'provider');
      assert.equal(metadata.params[1].nested[0].type, 'string');
      assert.equal(metadata.params[1].nested[0].required, true);

      assert.equal(metadata.params[1].nested[1].name, 'name');
      assert.equal(metadata.params[1].nested[1].type, 'string');
      assert.equal(metadata.params[1].nested[1].required, true);
    } finally {
      cleanupTempFile(filePath);
    }
  });

  void it('extracts nested properties from object parameters with optional fields', () => {
    const content = `
import { observe } from '@lmnr-ai/lmnr';

export const optionalNestedAgent = observe({ rolloutEntrypoint: true }, (
  async (
    config: {
      required: string;
      optional?: number;
      withDefault?: boolean;
    }
  ) => {
    return { result: 'ok' };
  }
));
`;
    const filePath = createTempFile(content);

    try {
      const functions = extractRolloutFunctions(filePath);
      const metadata = functions.get('optionalNestedAgent')!;

      assert.equal(metadata.params.length, 1);
      assert.equal(metadata.params[0].name, 'config');
      assert.ok(metadata.params[0].nested);
      assert.equal(metadata.params[0].nested.length, 3);

      // Check required field
      assert.equal(metadata.params[0].nested[0].name, 'required');
      assert.equal(metadata.params[0].nested[0].required, true);

      // Check optional fields
      assert.equal(metadata.params[0].nested[1].name, 'optional');
      assert.equal(metadata.params[0].nested[1].required, false);

      assert.equal(metadata.params[0].nested[2].name, 'withDefault');
      assert.equal(metadata.params[0].nested[2].required, false);
    } finally {
      cleanupTempFile(filePath);
    }
  });

  void it('extracts nested properties from complex nested objects', () => {
    const content = `
import { observe } from '@lmnr-ai/lmnr';

export const complexNestedAgent = observe({ rolloutEntrypoint: true }, (
  async (
    config: {
      api: {
        url: string;
        timeout?: number;
      };
      retry: boolean;
    }
  ) => {
    return { result: 'ok' };
  }
));
`;
    const filePath = createTempFile(content);

    try {
      const functions = extractRolloutFunctions(filePath);
      const metadata = functions.get('complexNestedAgent')!;

      assert.equal(metadata.params.length, 1);
      assert.equal(metadata.params[0].name, 'config');
      assert.ok(metadata.params[0].nested);
      assert.equal(metadata.params[0].nested.length, 2);

      // Check api field (nested object)
      assert.equal(metadata.params[0].nested[0].name, 'api');
      assert.ok(metadata.params[0].nested[0].type?.includes('url'));
      assert.ok(metadata.params[0].nested[0].type?.includes('timeout'));

      // Check retry field
      assert.equal(metadata.params[0].nested[1].name, 'retry');
      assert.equal(metadata.params[0].nested[1].type, 'boolean');
    } finally {
      cleanupTempFile(filePath);
    }
  });

  void it('handles both destructured and non-destructured object params', () => {
    const content = `
import { observe } from '@lmnr-ai/lmnr';

export const mixedAgent = observe({ rolloutEntrypoint: true }, (
  async (
    { query, limit = 10 }: { query: string; limit?: number },
    model: {
      provider: string;
      name: string;
    }
  ) => {
    return { result: query };
  }
));
`;
    const filePath = createTempFile(content);

    try {
      const functions = extractRolloutFunctions(filePath);
      const metadata = functions.get('mixedAgent')!;

      assert.equal(metadata.params.length, 2);

      // First param - destructured
      assert.equal(metadata.params[0].name, '_destructured');
      assert.ok(metadata.params[0].nested);
      assert.equal(metadata.params[0].nested.length, 2);
      assert.equal(metadata.params[0].nested[0].name, 'query');
      assert.equal(metadata.params[0].nested[1].name, 'limit');

      // Second param - non-destructured with nested
      assert.equal(metadata.params[1].name, 'model');
      assert.ok(metadata.params[1].nested);
      assert.equal(metadata.params[1].nested.length, 2);
      assert.equal(metadata.params[1].nested[0].name, 'provider');
      assert.equal(metadata.params[1].nested[1].name, 'name');
    } finally {
      cleanupTempFile(filePath);
    }
  });
});
