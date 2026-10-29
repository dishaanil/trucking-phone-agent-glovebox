import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Pool, Queryable } from '../db.js';
import { ApiError } from '../errors.js';
import { getLiveSandbox } from '../services/sandboxes.js';
import { requireServiceToken } from './auth.js';

/** Who is making an agent request. Roles come from the database, never from the request. */
export interface Caller {
  sandboxId: string;
  personId: string;
  businessId: string;
  isOwner: boolean;
  isDriver: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    caller?: Caller;
  }
}

const CallerHeaders = z.object({
  'x-sandbox-id': z.uuid(),
  'x-person-id': z.uuid(),
});

export async function loadCaller(db: Queryable, sandboxId: string, personId: string): Promise<Caller> {
  await getLiveSandbox(db, sandboxId);
  const { rows } = await db.query<{ business_id: string; is_owner: boolean; is_driver: boolean }>(
    'select business_id, is_owner, is_driver from people where sandbox_id = $1 and id = $2',
    [sandboxId, personId],
  );
  const person = rows[0];
  if (!person) throw new ApiError(403, 'unknown_caller', "I couldn't find you in this demo.");
  return { sandboxId, personId, businessId: person.business_id, isOwner: person.is_owner, isDriver: person.is_driver };
}

/** preHandler for agent endpoints: service token, then `x-sandbox-id` and `x-person-id`. */
export function requireCaller(pool: Pool, serviceToken: string) {
  const checkToken = requireServiceToken(serviceToken);
  return async (req: FastifyRequest): Promise<void> => {
    await checkToken(req);
    const parsed = CallerHeaders.safeParse(req.headers);
    if (!parsed.success) {
      throw new ApiError(400, 'missing_caller', 'This request needs x-sandbox-id and x-person-id headers.');
    }
    req.caller = await loadCaller(pool, parsed.data['x-sandbox-id'], parsed.data['x-person-id']);
  };
}

export function getCaller(req: FastifyRequest): Caller {
  if (!req.caller) throw new Error('requireCaller preHandler did not run');
  return req.caller;
}
