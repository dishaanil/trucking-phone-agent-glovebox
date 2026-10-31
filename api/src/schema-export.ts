import { z } from 'zod';
import * as ledger from './ledger-schemas.js';
import * as api from './schemas.js';

// The request and response shapes the agent uses, exported to JSON Schema so its Python models
// are generated, not hand-copied (CLAUDE.md). Regenerate with `pnpm schemas:export`.

const ErrorResponse = z.object({ error: z.string(), message: z.string() }).loose();

const REQUESTS = {
  ResolveCallerBody: api.ResolveCallerBody,
  EndCallBody: api.EndCallBody,
  CreateExpenseBody: ledger.CreateExpenseBody,
  PatchExpenseBody: ledger.PatchExpenseBody,
  ConfirmBody: ledger.ConfirmBody,
  DiscardBody: ledger.DiscardBody,
  CreateTicketBody: ledger.CreateTicketBody,
  PatchTicketBody: ledger.PatchTicketBody,
  StopTimesBody: ledger.StopTimesBody,
  CreateClaimBody: ledger.CreateClaimBody,
} as const;

const RESPONSES = {
  ErrorResponse,
  ResolveCallerResponse: api.ResolveCallerResponse,
  EndCallResponse: api.EndCallResponse,
  ExpenseResponse: ledger.ExpenseResponse,
  TicketResponse: ledger.TicketResponse,
  ConfirmResponse: ledger.ConfirmResponse,
  DiscardResponse: ledger.DiscardResponse,
  LoadResponse: ledger.LoadResponse,
  ProfitabilityResponse: ledger.ProfitabilityResponse,
  StopTimesResponse: ledger.StopTimesResponse,
  DetentionResponse: ledger.DetentionResponse,
  ClaimResponse: ledger.ClaimResponse,
  TruckSummaryResponse: ledger.TruckSummaryResponse,
  BusinessSummaryResponse: ledger.BusinessSummaryResponse,
  UnpaidLoadsResponse: ledger.UnpaidLoadsResponse,
} as const;

function def(schema: z.ZodType, io: 'input' | 'output'): Record<string, unknown> {
  const json = z.toJSONSchema(schema, {
    io,
    target: 'draft-2020-12',
    // Drop noise that makes generated models awkward: zod's safe-integer bounds on every int,
    // and the regex it adds next to `format: uuid` and `format: date-time`.
    override: ({ jsonSchema }) => {
      if (jsonSchema.type === 'integer') {
        if (jsonSchema.minimum === Number.MIN_SAFE_INTEGER) delete jsonSchema.minimum;
        if (jsonSchema.maximum === Number.MAX_SAFE_INTEGER) delete jsonSchema.maximum;
      }
      if (jsonSchema.format === 'uuid' || jsonSchema.format === 'date-time') delete jsonSchema.pattern;
    },
  }) as Record<string, unknown>;
  delete json.$schema; // only the root document carries $schema
  return json;
}

/** One JSON Schema document; every model is a property of the root so code generators emit all of them. */
export function apiSchemaDocument(): Record<string, unknown> {
  const defs: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(REQUESTS)) defs[name] = def(schema, 'input');
  for (const [name, schema] of Object.entries(RESPONSES)) defs[name] = def(schema, 'output');
  const names = Object.keys(defs).sort();
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'GloveboxApi',
    description: 'Generated from api/src zod schemas by api/scripts/export-schemas.ts. Do not edit.',
    type: 'object',
    properties: Object.fromEntries(names.map((n) => [n, { $ref: `#/$defs/${n}` }])),
    $defs: Object.fromEntries(names.map((n) => [n, defs[n]])),
  };
}

export const SCHEMA_PATH = new URL('../schemas/api.schema.json', import.meta.url);

export function serialize(doc: Record<string, unknown>): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}
