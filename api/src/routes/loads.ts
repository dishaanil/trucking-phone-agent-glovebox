import type { FastifyInstance } from 'fastify';
import type { Pool } from '../db.js';
import { IdParams, LoadResponse, LoadsQuery, ProfitabilityResponse } from '../ledger-schemas.js';
import { getCaller, requireCaller } from '../lib/caller.js';
import { findLoadByNumber, loadProfitability } from '../services/loads.js';

export function loadRoutes(app: FastifyInstance, pool: Pool, serviceToken: string): void {
  const preHandler = requireCaller(pool, serviceToken);

  // For loads outside the caller's active list ("the one from last week, 4390").
  app.get('/loads', { preHandler }, async (req) => {
    const { number } = LoadsQuery.parse(req.query);
    return LoadResponse.parse(await findLoadByNumber(pool, getCaller(req), number));
  });

  app.get('/loads/:id/profitability', { preHandler }, async (req) => {
    const { id } = IdParams.parse(req.params);
    return ProfitabilityResponse.parse(await loadProfitability(pool, getCaller(req), id));
  });
}
