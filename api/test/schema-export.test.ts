import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { apiSchemaDocument, SCHEMA_PATH, serialize } from '../src/schema-export.js';

describe('exported JSON Schema', () => {
  it('matches the zod schemas (run `pnpm schemas:export` if this fails)', () => {
    expect(readFileSync(SCHEMA_PATH, 'utf8')).toBe(serialize(apiSchemaDocument()));
  });

  it('includes every model the agent uses', () => {
    const defs = Object.keys((apiSchemaDocument() as { $defs: Record<string, unknown> }).$defs);
    expect(defs).toEqual(expect.arrayContaining(['CreateExpenseBody', 'ExpenseResponse', 'ResolveCallerResponse', 'ErrorResponse']));
  });
});
