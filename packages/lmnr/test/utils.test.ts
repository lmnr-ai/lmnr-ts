import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { z } from 'zod/v3';

import { modelToProvider, prettyPrintZodSchema } from '../src/browser/utils';

void describe('prettyPrintZodSchema', () => {
  void it('formats a simple object schema', () => {
    const schema = z.object({
      name: z.string(),
      age: z.number(),
      isActive: z.boolean(),
    });

    const result = prettyPrintZodSchema(schema);
    assert.equal(result,
      'z.object({\n  name: z.string(),\n  age: z.number(),\n  isActive: z.boolean(),\n})',
    );
  });

  void it('handles optional fields', () => {
    const schema = z.object({
      name: z.string(),
      email: z.string().optional(),
    });

    const result = prettyPrintZodSchema(schema);
    assert.equal(result,
      'z.object({\n  name: z.string(),\n  email: z.string().optional(),\n})',
    );
  });

  void it('handles nullable fields', () => {
    const schema = z.object({
      name: z.string(),
      middleName: z.string().optional().nullable(),
    });

    const result = prettyPrintZodSchema(schema);
    assert.equal(result,
      'z.object({\n  name: z.string(),\n  middleName: z.string().optional().nullable(),\n})',
    );
  });

  void it('handles descriptions', () => {
    const schema = z.object({
      name: z.string().describe('User\'s full name'),
      age: z.number().describe('Age in years'),
    });

    const result = prettyPrintZodSchema(schema);
    assert.equal(result,
      'z.object({\n  name: z.string().describe(\'User\\\'s full name\'),\n' +
      '  age: z.number().describe(\'Age in years\'),\n})',
    );
  });

  void it('handles nested objects', () => {
    const schema = z.object({
      user: z.object({
        name: z.string(),
        address: z.object({
          street: z.string(),
          city: z.string(),
        }),
      }),
    });

    const result = prettyPrintZodSchema(schema);
    assert.equal(result,
      'z.object({\n  user: z.object({\n  name: z.string(),\n' +
      '  address: z.object({\n  street: z.string(),\n  city: z.string(),\n}),\n}),\n})',
    );
  });

  void it('handles arrays', () => {
    const schema = z.object({
      names: z.array(z.string()),
      users: z.array(z.object({
        id: z.number(),
        name: z.string(),
      })),
    });

    const result = prettyPrintZodSchema(schema);
    assert.equal(result,
      'z.object({\n  names: z.array(z.string()),\n  users: z.array(z.object({\n' +
      '  id: z.number(),\n  name: z.string(),\n})),\n})',
    );
  });

  void it('handles enums', () => {
    const schema = z.object({
      role: z.enum(['admin', 'user', 'guest']),
    });

    const result = prettyPrintZodSchema(schema);
    assert.equal(result,
      'z.object({\n  role: z.enum([\'admin\', \'user\', \'guest\']),\n})',
    );
  });

  void it('handles literals', () => {
    const schema = z.object({
      status: z.literal('active'),
      code: z.literal(200),
    });

    const result = prettyPrintZodSchema(schema);
    assert.equal(result,
      'z.object({\n  status: z.literal(\'active\'),\n  code: z.literal(200),\n})',
    );
  });

  void it('handles unions', () => {
    const schema = z.object({
      status: z.union([z.literal('active'), z.literal('inactive')]),
    });

    const result = prettyPrintZodSchema(schema);
    assert.equal(result,
      'z.object({\n  status: z.union([z.literal(\'active\'), z.literal(\'inactive\')]),\n})',
    );
  });

  void it('handles records', () => {
    const schema = z.object({
      metadata: z.record(z.string()),
      counts: z.record(z.string(), z.number()),
    });

    const result = prettyPrintZodSchema(schema);
    assert.equal(result,
      // TS / Zod defaults unknown value type to z.string()
      'z.object({\n  metadata: z.record(z.string(), z.string()),\n' +
      '  counts: z.record(z.string(), z.number()),\n})',
    );
  });

  void it('handles maps', () => {
    const schema = z.object({
      userMap: z.map(z.string(), z.number()),
    });

    const result = prettyPrintZodSchema(schema);
    assert.equal(result,
      'z.object({\n  userMap: z.map(z.string(), z.number()),\n})',
    );
  });

  void it('handles tuples', () => {
    const schema = z.object({
      point: z.tuple([z.number(), z.number()]),
      record: z.tuple([z.string(), z.boolean(), z.number()]),
    });

    const result = prettyPrintZodSchema(schema);
    assert.equal(result,
      'z.object({\n  point: z.tuple([z.number(), z.number()]),\n' +
      '  record: z.tuple([z.string(), z.boolean(), z.number()]),\n})',
    );
  });

  void it('handles dates', () => {
    const schema = z.object({
      createdAt: z.date(),
      updatedAt: z.date().optional(),
    });

    const result = prettyPrintZodSchema(schema);
    assert.equal(result,
      'z.object({\n  createdAt: z.date(),\n  updatedAt: z.date().optional(),\n})',
    );
  });

  void it('handles complex combinations', () => {
    const schema = z.object({
      id: z.string(),
      user: z.object({
        name: z.string(),
        email: z.string().optional(),
        roles: z.array(z.enum(['admin', 'user', 'guest'])),
      }),
      metadata: z.record(z.string(), z.any()).optional(),
      settings: z.map(z.string(), z.boolean()).nullable(),
      tags: z.array(z.string()).nullable().describe('User tags'),
      coordinates: z.tuple([z.number(), z.number()]).optional(),
      status: z.union([
        z.literal('active'),
        z.literal('inactive'),
        z.literal('pending'),
      ]),
    });

    const result = prettyPrintZodSchema(schema);
    // We're not checking the exact string here due to complexity
    // But we'll check that all fields are present
    assert.ok(result.includes('id: z.string()'));
    assert.ok(result.includes('user: z.object('));
    assert.ok(result.includes('name: z.string()'));
    assert.ok(result.includes('email: z.string().optional()'));
    assert.ok(result.includes('roles: z.array(z.enum([\'admin\', \'user\', \'guest\']))'));
    assert.ok(result.includes('metadata: z.record(z.string(), z.any()).optional()'));
    assert.ok(result.includes('settings: z.map(z.string(), z.boolean()).nullable()'));
    assert.ok(result.includes('tags: z.array(z.string()).nullable().describe(\'User tags\')'));
    assert.ok(result.includes('coordinates: z.tuple([z.number(), z.number()]).optional()'));
    assert.ok(result.includes(
      'status: z.union([z.literal(\'active\'), z.literal(\'inactive\'), z.literal(\'pending\')])',
    ));
  });
});

void describe('modelToProvider', () => {
  void it('returns the correct provider for a model', () => {
    assert.equal(modelToProvider('gpt-4'), 'openai');
    assert.equal(modelToProvider('o1-mini'), 'openai');
    assert.equal(modelToProvider('claude-3.5-sonnet'), 'anthropic');
    assert.equal(modelToProvider('gemini-1.5-pro'), 'google');
    assert.equal(modelToProvider('cerebras-2.5-sonnet'), 'cerebras');
    assert.equal(modelToProvider('groq-3.5-sonnet'), 'groq');
    assert.equal(modelToProvider('command-r7b'), undefined);
  });
});
