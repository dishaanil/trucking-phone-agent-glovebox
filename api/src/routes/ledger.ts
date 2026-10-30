import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type pg from 'pg';
import type { Pool } from '../db.js';
import {
  ClaimResponse,
  ConfirmBody,
  ConfirmResponse,
  CreateClaimBody,
  CreateExpenseBody,
  CreateTicketBody,
  DetentionResponse,
  DiscardBody,
  DiscardResponse,
  ExpenseResponse,
  IdParams,
  PatchExpenseBody,
  PatchTicketBody,
  StopTimesBody,
  StopTimesResponse,
  TicketResponse,
} from '../ledger-schemas.js';
import { getCaller, requireCaller, type Caller } from '../lib/caller.js';
import { idempotentWrite, type WriteResult } from '../lib/idempotency.js';
import { confirmExpenses, correctExpense, createExpense, discardExpense } from '../services/expenses.js';
import { confirmTickets, correctTicket, createTicket } from '../services/scale-tickets.js';
import { checkDetention, createDetentionClaim, recordStopTimes } from '../services/stops.js';

export function ledgerRoutes(app: FastifyInstance, pool: Pool, serviceToken: string): void {
  const preHandler = requireCaller(pool, serviceToken);

  /**
   * Validate, then run the write once per idempotency key. The request hash covers the route,
   * path params, caller and body (without the key), so reusing a key for anything else is a 409.
   */
  async function write<B extends { idempotency_key: string }, T>(
    req: FastifyRequest,
    reply: FastifyReply,
    route: string,
    body: B,
    params: Record<string, string>,
    responseSchema: z.ZodType<T>,
    run: (client: pg.PoolClient, caller: Caller) => Promise<WriteResult<T>>,
  ): Promise<FastifyReply> {
    const caller = getCaller(req);
    const { idempotency_key: key, ...rest } = body;
    const result = await idempotentWrite(
      pool,
      { sandboxId: caller.sandboxId, key, request: { route, params, person_id: caller.personId, body: rest } },
      (client) => run(client, caller),
    );
    if (result.replayed) reply.header('idempotent-replayed', 'true');
    return reply.code(result.statusCode).send(responseSchema.parse(result.body));
  }

  app.post('/expenses', { preHandler }, async (req, reply) => {
    const body = CreateExpenseBody.parse(req.body);
    return write(req, reply, 'POST /expenses', body, {}, ExpenseResponse, (db, caller) =>
      createExpense(db, caller, body),
    );
  });

  app.patch('/expenses/:id', { preHandler }, async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const body = PatchExpenseBody.parse(req.body);
    return write(req, reply, 'PATCH /expenses/:id', body, { id }, ExpenseResponse, (db, caller) =>
      correctExpense(db, caller, id, body),
    );
  });

  app.post('/expenses/confirm', { preHandler }, async (req, reply) => {
    const body = ConfirmBody.parse(req.body);
    return write(req, reply, 'POST /expenses/confirm', body, {}, ConfirmResponse, (db, caller) =>
      confirmExpenses(db, caller, body.ids, body.call_id),
    );
  });

  app.post('/expenses/:id/discard', { preHandler }, async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const body = DiscardBody.parse(req.body);
    return write(req, reply, 'POST /expenses/:id/discard', body, { id }, DiscardResponse, (db, caller) =>
      discardExpense(db, caller, id, body),
    );
  });

  app.post('/loads/:id/scale-tickets', { preHandler }, async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const body = CreateTicketBody.parse(req.body);
    return write(req, reply, 'POST /loads/:id/scale-tickets', body, { id }, TicketResponse, (db, caller) =>
      createTicket(db, caller, id, body),
    );
  });

  app.patch('/scale-tickets/:id', { preHandler }, async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const body = PatchTicketBody.parse(req.body);
    return write(req, reply, 'PATCH /scale-tickets/:id', body, { id }, TicketResponse, (db, caller) =>
      correctTicket(db, caller, id, body),
    );
  });

  app.post('/scale-tickets/confirm', { preHandler }, async (req, reply) => {
    const body = ConfirmBody.parse(req.body);
    return write(req, reply, 'POST /scale-tickets/confirm', body, {}, ConfirmResponse, (db, caller) =>
      confirmTickets(db, caller, body.ids, body.call_id),
    );
  });

  app.post('/stops/:id/times', { preHandler }, async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const body = StopTimesBody.parse(req.body);
    return write(req, reply, 'POST /stops/:id/times', body, { id }, StopTimesResponse, (db, caller) =>
      recordStopTimes(db, caller, id, body),
    );
  });

  app.get('/stops/:id/detention', { preHandler }, async (req) => {
    const { id } = IdParams.parse(req.params);
    return DetentionResponse.parse(await checkDetention(pool, getCaller(req), id));
  });

  app.post('/stops/:id/detention-claims', { preHandler }, async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const body = CreateClaimBody.parse(req.body);
    return write(req, reply, 'POST /stops/:id/detention-claims', body, { id }, ClaimResponse, (db, caller) =>
      createDetentionClaim(db, caller, id, body),
    );
  });
}
