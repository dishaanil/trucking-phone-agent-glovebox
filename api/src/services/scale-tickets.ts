import type { DatabaseError } from 'pg';
import type { Queryable } from '../db.js';
import { ApiError } from '../errors.js';
import type { ConfirmResponse, CreateTicketBody, PatchTicketBody, TicketResponse } from '../ledger-schemas.js';
import { canUseLoad, findLoad, forbiddenLoad, forbiddenRecord } from '../lib/access.js';
import type { Caller } from '../lib/caller.js';
import { recordEvent } from '../lib/events.js';
import type { WriteResult } from '../lib/idempotency.js';
import { confirmationPrompt, weightFlags } from '../lib/limits.js';
import { MAX_WEIGHT_LBS, parseWeightLbs, spokenWeight } from '../lib/quantity.js';
import { ticketReadback } from '../lib/readback.js';

interface TicketRow {
  id: string;
  load_id: string;
  person_id: string | null;
  ticket_number: string | null;
  net_weight_lbs: number;
  location: string | null;
  status: TicketResponse['status'];
  load_number: string;
  load_driver_id: string;
  trailer_type: string;
}

const TICKET_SELECT = `
  select st.id, st.load_id, st.person_id, st.ticket_number, st.net_weight_lbs, st.location, st.status,
         l.load_number, l.driver_id as load_driver_id, t.trailer_type
    from scale_tickets st
    join loads l on l.id = st.load_id and l.sandbox_id = st.sandbox_id
    join trucks t on t.id = l.truck_id and t.sandbox_id = l.sandbox_id
   where st.sandbox_id = $1 and l.business_id = $2`;
const TICKET_BY_ID = `${TICKET_SELECT} and st.id = $3 for update of st`;
const ACTIVE_TICKET_FOR_LOAD = `${TICKET_SELECT} and st.load_id = $3 and st.status in ('pending', 'confirmed')`;

async function findTicket(db: Queryable, caller: Caller, id: string): Promise<TicketRow | null> {
  const { rows } = await db.query<TicketRow>(TICKET_BY_ID, [caller.sandboxId, caller.businessId, id]);
  return rows[0] ?? null;
}

function canEdit(caller: Caller, t: TicketRow): boolean {
  return caller.isOwner || t.person_id === caller.personId || t.load_driver_id === caller.personId;
}

function parseWeight(input: string | number): number {
  const lbs = parseWeightLbs(input);
  if (lbs === null) throw new ApiError(400, 'invalid_weight', "I didn't catch the weight. What's the net on the ticket?");
  if (lbs > MAX_WEIGHT_LBS) throw new ApiError(400, 'weight_too_large', "That weight is too large. What's the net on the ticket?");
  return lbs;
}

const readbackOf = (t: TicketRow): string =>
  ticketReadback({ loadNumber: t.load_number, netWeightLbs: t.net_weight_lbs, ticketNumber: t.ticket_number });

function toResponse(t: TicketRow): TicketResponse {
  const reasons = weightFlags(t.net_weight_lbs, t.trailer_type);
  return {
    id: t.id,
    status: t.status,
    load_id: t.load_id,
    load_number: t.load_number,
    net_weight_lbs: t.net_weight_lbs,
    weight_display: spokenWeight(t.net_weight_lbs),
    ticket_number: t.ticket_number,
    location: t.location,
    readback: readbackOf(t),
    needs_confirmation: reasons.length > 0,
    confirmation_reasons: reasons,
    confirmation_prompt: confirmationPrompt(reasons),
  };
}

async function ticketExists(db: Queryable, caller: Caller, loadId: string): Promise<ApiError | null> {
  const { rows } = await db.query<TicketRow>(ACTIVE_TICKET_FOR_LOAD, [caller.sandboxId, caller.businessId, loadId]);
  const existing = rows[0];
  if (!existing) return null;
  return new ApiError(
    409,
    'ticket_exists',
    `Load ${existing.load_number} already has a scale ticket: ${readbackOf(existing)} Want to correct it?`,
    { existing: { id: existing.id, status: existing.status, readback: readbackOf(existing) } },
  );
}

const isUniqueViolation = (err: unknown): boolean => (err as DatabaseError | undefined)?.code === '23505';

/** A load has at most one pending or confirmed ticket; a second one is a 409 pointing at the first. */
export async function createTicket(
  db: Queryable,
  caller: Caller,
  loadId: string,
  body: CreateTicketBody,
): Promise<WriteResult<TicketResponse>> {
  const netWeight = parseWeight(body.net_weight_lbs);
  const load = await findLoad(db, caller, loadId);
  if (!canUseLoad(caller, load)) throw forbiddenLoad();

  const conflict = await ticketExists(db, caller, load.id);
  if (conflict) throw conflict;

  // A concurrent insert can still win the unique index; recover inside the transaction.
  await db.query('savepoint create_ticket');
  let id: string | undefined;
  try {
    const { rows } = await db.query<{ id: string }>(
      `insert into scale_tickets (sandbox_id, load_id, person_id, ticket_number, net_weight_lbs, location, call_id)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [caller.sandboxId, load.id, caller.personId, body.ticket_number ?? null, netWeight, body.location ?? null, body.call_id],
    );
    id = rows[0]?.id;
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    await db.query('rollback to savepoint create_ticket');
    throw (await ticketExists(db, caller, load.id)) ?? err;
  }
  if (!id) throw new Error('insert returned no id');

  const ticket = await findTicket(db, caller, id);
  if (!ticket) throw new Error(`ticket ${id} vanished`);
  await recordEvent(db, {
    sandboxId: caller.sandboxId,
    callId: body.call_id,
    actorPersonId: caller.personId,
    type: 'ticket.created',
    payload: { id, load_number: ticket.load_number, net_weight_lbs: netWeight, status: ticket.status },
  });
  return { statusCode: 201, body: toResponse(ticket) };
}

/** Correct a ticket in place; a confirmed ticket goes back to pending. Logs old and new values. */
export async function correctTicket(
  db: Queryable,
  caller: Caller,
  id: string,
  body: PatchTicketBody,
): Promise<WriteResult<TicketResponse>> {
  const existing = await findTicket(db, caller, id);
  if (!existing) throw new ApiError(404, 'ticket_not_found', "I can't find that scale ticket.");
  if (!canEdit(caller, existing)) throw forbiddenRecord();
  if (existing.status === 'discarded') {
    throw new ApiError(409, 'record_discarded', 'That ticket was already removed. Want me to log it again?');
  }

  const before = {
    net_weight_lbs: existing.net_weight_lbs,
    ticket_number: existing.ticket_number,
    location: existing.location,
  };
  const after = {
    net_weight_lbs: body.net_weight_lbs === undefined ? existing.net_weight_lbs : parseWeight(body.net_weight_lbs),
    ticket_number: body.ticket_number === undefined ? existing.ticket_number : body.ticket_number,
    location: body.location === undefined ? existing.location : body.location,
  };
  const changed = (Object.keys(after) as (keyof typeof after)[]).filter((k) => after[k] !== before[k]);
  if (changed.length === 0) return { statusCode: 200, body: toResponse(existing) };

  await db.query(
    `update scale_tickets
        set net_weight_lbs = $3, ticket_number = $4, location = $5, status = 'pending', updated_at = now()
      where sandbox_id = $1 and id = $2`,
    [caller.sandboxId, id, after.net_weight_lbs, after.ticket_number, after.location],
  );
  await recordEvent(db, {
    sandboxId: caller.sandboxId,
    callId: body.call_id,
    actorPersonId: caller.personId,
    type: 'ticket.corrected',
    payload: {
      id,
      old: Object.fromEntries(changed.map((k) => [k, before[k]])),
      new: Object.fromEntries(changed.map((k) => [k, after[k]])),
      status_before: existing.status,
      status_after: 'pending',
    },
  });
  return { statusCode: 200, body: toResponse({ ...existing, ...after, status: 'pending' }) };
}

export async function confirmTickets(
  db: Queryable,
  caller: Caller,
  ids: string[],
  callId: string,
): Promise<WriteResult<ConfirmResponse>> {
  const results: ConfirmResponse['results'] = [];
  for (const id of [...new Set(ids)]) {
    const t = await findTicket(db, caller, id);
    if (!t) {
      results.push({ id, result: 'not_found' });
    } else if (!canEdit(caller, t)) {
      results.push({ id, result: 'forbidden' });
    } else if (t.status !== 'pending') {
      results.push({ id, result: t.status === 'confirmed' ? 'already_confirmed' : 'discarded' });
    } else {
      await db.query(
        `update scale_tickets set status = 'confirmed', updated_at = now() where sandbox_id = $1 and id = $2`,
        [caller.sandboxId, id],
      );
      await recordEvent(db, {
        sandboxId: caller.sandboxId,
        callId,
        actorPersonId: caller.personId,
        type: 'ticket.confirmed',
        payload: { id, load_number: t.load_number, net_weight_lbs: t.net_weight_lbs },
      });
      results.push({ id, result: 'confirmed' });
    }
  }
  return {
    statusCode: 200,
    body: { results, confirmed_count: results.filter((r) => r.result === 'confirmed').length },
  };
}
