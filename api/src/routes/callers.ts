import type { FastifyInstance } from 'fastify';
import { withTransaction, type Pool } from '../db.js';
import { requireServiceToken } from '../lib/auth.js';
import { getCaller, requireCaller } from '../lib/caller.js';
import { CallIdParams, EndCallBody, EndCallResponse, ResolveCallerBody, ResolveCallerResponse } from '../schemas.js';
import { endCall, startCall } from '../services/calls.js';
import { resolveCaller } from '../services/callers.js';

export function callerRoutes(app: FastifyInstance, pool: Pool, serviceToken: string): void {
  app.post('/callers/resolve', { preHandler: requireServiceToken(serviceToken) }, async (req) => {
    const body = ResolveCallerBody.parse(req.body);
    const { call_id: callId, ...input } = body;
    const result = await resolveCaller(pool, input);
    if (callId && result.status === 'resolved') {
      await startCall(pool, {
        sandboxId: result.sandbox.id,
        callId,
        personId: result.person.id,
        access: 'phone' in input ? 'phone' : 'demo_code',
      });
    }
    return ResolveCallerResponse.parse(result);
  });

  app.post('/calls/:call_id/end', { preHandler: requireCaller(pool, serviceToken) }, async (req) => {
    const { call_id: callId } = CallIdParams.parse(req.params);
    const { reason } = EndCallBody.parse(req.body);
    const caller = getCaller(req);
    return EndCallResponse.parse(await withTransaction(pool, (db) => endCall(db, caller, callId, reason)));
  });
}
