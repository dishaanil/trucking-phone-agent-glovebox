import type { FastifyInstance } from 'fastify';
import type { Pool } from '../db.js';
import { requireServiceToken } from '../lib/auth.js';
import { ResolveCallerBody, ResolveCallerResponse } from '../schemas.js';
import { resolveCaller } from '../services/callers.js';

export function callerRoutes(app: FastifyInstance, pool: Pool, serviceToken: string): void {
  app.post('/callers/resolve', { preHandler: requireServiceToken(serviceToken) }, async (req) => {
    const body = ResolveCallerBody.parse(req.body);
    return ResolveCallerResponse.parse(await resolveCaller(pool, body));
  });
}
