import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Pool } from '../db.js';
import {
  BusinessSummaryResponse,
  IdParams,
  RangeQuery,
  TruckSummaryResponse,
  UnpaidLoadsResponse,
} from '../ledger-schemas.js';
import { getCaller, requireCaller } from '../lib/caller.js';
import { businessSummary, truckSummary, unpaidLoads } from '../services/summaries.js';

// Owner-only questions. The API rejects drivers regardless of what the agent offers.
export function summaryRoutes(app: FastifyInstance, pool: Pool, serviceToken: string): void {
  const preHandler = requireCaller(pool, serviceToken);

  app.get('/trucks/:id/summary', { preHandler }, async (req) => {
    const { id } = IdParams.parse(req.params);
    const { range } = RangeQuery.parse(req.query);
    return TruckSummaryResponse.parse(await truckSummary(pool, getCaller(req), id, range));
  });

  app.get('/businesses/:id/summary', { preHandler }, async (req) => {
    const { id } = IdParams.parse(req.params);
    const { range } = RangeQuery.parse(req.query);
    return BusinessSummaryResponse.parse(await businessSummary(pool, getCaller(req), id, range));
  });

  app.get('/businesses/:id/unpaid-loads', { preHandler }, async (req) => {
    const { id } = IdParams.parse(req.params);
    z.object({}).strict().parse(req.query);
    return UnpaidLoadsResponse.parse(await unpaidLoads(pool, getCaller(req), id));
  });
}
