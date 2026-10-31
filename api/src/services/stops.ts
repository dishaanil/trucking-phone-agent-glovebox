import type { Queryable } from '../db.js';
import { ApiError } from '../errors.js';
import type {
  ClaimResponse,
  CreateClaimBody,
  DetentionResponse,
  StopResponse,
  StopTimesBody,
  StopTimesResponse,
} from '../ledger-schemas.js';
import { canUseLoad, forbiddenLoad } from '../lib/access.js';
import type { Caller } from '../lib/caller.js';
import { computeDetention, detentionSummary, LATE_ARRIVAL_NOTE, type DetentionTerms } from '../lib/detention.js';
import { recordEvent } from '../lib/events.js';
import type { WriteResult } from '../lib/idempotency.js';
import { FUTURE_TOLERANCE_MS } from '../lib/limits.js';
import { spokenAmount } from '../lib/money.js';
import {
  localDayDiff,
  parseTimeInput,
  resolveArrival,
  resolveDeparture,
  spokenDuration,
  spokenTime,
  type TimeInput,
} from '../lib/times.js';

interface StopRow extends DetentionTerms {
  id: string;
  load_id: string;
  type: StopResponse['type'];
  sequence: number;
  facility_name: string;
  city: string;
  state: string;
  timezone: string;
  appointment_at: Date | null;
  arrived_at: Date | null;
  departed_at: Date | null;
  load_number: string;
  load_status: StopTimesResponse['load_status'];
  driver_id: string;
  is_final_delivery: boolean;
}

// Stop, load, payer terms and the effective timezone (the stop's, else the business's).
const STOP_SELECT = `
  select s.id, s.load_id, s.type, s.sequence, s.facility_name, s.city, s.state,
         coalesce(s.timezone, b.timezone) as timezone, s.appointment_at, s.arrived_at, s.departed_at,
         l.load_number, l.status as load_status, l.driver_id,
         (s.type = 'delivery' and s.sequence = (
            select max(s2.sequence) from stops s2 where s2.sandbox_id = s.sandbox_id and s2.load_id = s.load_id
         )) as is_final_delivery,
         py.name as payer_name, py.pays_detention, py.detention_free_minutes, py.detention_rate_cents_per_hour,
         py.detention_increment_minutes, py.detention_requires_on_time, py.late_grace_minutes
    from stops s
    join loads l on l.id = s.load_id and l.sandbox_id = s.sandbox_id
    join businesses b on b.id = l.business_id and b.sandbox_id = l.sandbox_id
    join payers py on py.id = l.payer_id and py.sandbox_id = l.sandbox_id
   where s.sandbox_id = $1 and l.business_id = $2 and s.id = $3`;
const STOP_FOR_UPDATE = `${STOP_SELECT} for update of s`;

interface ClaimRow {
  id: string;
  stop_id: string;
  load_id: string;
  status: ClaimResponse['status'];
  billable_minutes: number;
  amount_cents: number;
  notes: string | null;
}

const CLAIM_FOR_STOP = `
  select id, stop_id, load_id, status, billable_minutes, amount_cents, notes
    from detention_claims where sandbox_id = $1 and stop_id = $2`;

async function findStop(db: Queryable, caller: Caller, stopId: string, lock: boolean): Promise<StopRow> {
  const { rows } = await db.query<StopRow>(lock ? STOP_FOR_UPDATE : STOP_SELECT, [
    caller.sandboxId,
    caller.businessId,
    stopId,
  ]);
  const stop = rows[0];
  if (!stop) throw new ApiError(404, 'stop_not_found', "I can't find that stop.");
  if (!canUseLoad(caller, stop)) throw forbiddenLoad();
  return stop;
}

async function findClaim(db: Queryable, caller: Caller, stopId: string): Promise<ClaimRow | null> {
  const { rows } = await db.query<ClaimRow>(CLAIM_FOR_STOP, [caller.sandboxId, stopId]);
  return rows[0] ?? null;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

function stopView(s: StopRow): StopResponse {
  return {
    id: s.id,
    type: s.type,
    sequence: s.sequence,
    facility_name: s.facility_name,
    city: s.city,
    state: s.state,
    timezone: s.timezone,
    appointment_at: iso(s.appointment_at),
    arrived_at: iso(s.arrived_at),
    departed_at: iso(s.departed_at),
  };
}

function parseTime(input: string, which: 'arrival' | 'departure'): TimeInput {
  const parsed = parseTimeInput(input);
  if (!parsed) {
    const ask = which === 'arrival' ? 'What time did you get there?' : 'What time did you leave?';
    throw new ApiError(400, 'invalid_time', `I didn't catch that time. ${ask}`);
  }
  return parsed;
}

function stopTimesReadback(s: { facility_name: string; timezone: string; arrived_at: Date | null; departed_at: Date | null }): string {
  const parts: string[] = [];
  if (s.arrived_at) parts.push(`arrived ${spokenTime(s.arrived_at, s.timezone)}`);
  if (s.departed_at) {
    const days = s.arrived_at ? localDayDiff(s.arrived_at, s.departed_at, s.timezone) : 0;
    const later = days === 1 ? ' the next day' : days > 1 ? ` ${days} days later` : '';
    parts.push(`left ${spokenTime(s.departed_at, s.timezone)}${later}`);
  }
  return `${s.facility_name}: ${parts.join(', ')}.`;
}

/** Notes on a claim: the late-arrival note (when it applies) plus anything the caller added. */
function claimNotes(lateArrival: boolean, callerNotes: string | null): string | null {
  const parts = [lateArrival ? LATE_ARRIVAL_NOTE : null, callerNotes].filter((x): x is string => !!x);
  return parts.length > 0 ? parts.join('; ') : null;
}

const callerNotesOf = (notes: string | null): string | null =>
  notes
    ?.split('; ')
    .filter((n) => n !== LATE_ARRIVAL_NOTE)
    .join('; ') || null;

function claimView(c: ClaimRow, stop: StopRow, opts: { drafted?: boolean } = {}): ClaimResponse {
  const late = c.notes?.split('; ').includes(LATE_ARRIVAL_NOTE) ?? false;
  return {
    id: c.id,
    stop_id: c.stop_id,
    load_id: c.load_id,
    load_number: stop.load_number,
    facility_name: stop.facility_name,
    status: c.status,
    billable_minutes: c.billable_minutes,
    amount_cents: c.amount_cents,
    amount_display: spokenAmount(c.amount_cents),
    notes: c.notes,
    readback:
      `${opts.drafted ? 'Drafted a detention claim' : 'Detention claim'} for load ${stop.load_number} at ${stop.facility_name}: ` +
      `${spokenDuration(c.billable_minutes)}, ${spokenAmount(c.amount_cents)}.` +
      (late ? ' I noted the late arrival, so it may be disputed.' : ''),
  };
}

/** Record arrival and/or departure. A correction overwrites the stored time. */
export async function recordStopTimes(
  db: Queryable,
  caller: Caller,
  stopId: string,
  body: StopTimesBody,
): Promise<WriteResult<StopTimesResponse>> {
  const stop = await findStop(db, caller, stopId, true);
  const now = new Date();

  let arrived = stop.arrived_at;
  if (body.arrived_at !== undefined) {
    arrived = resolveArrival(parseTime(body.arrived_at, 'arrival'), stop.appointment_at ?? now, stop.timezone);
  }
  let departed = stop.departed_at;
  if (body.departed_at !== undefined) {
    const input = parseTime(body.departed_at, 'departure');
    departed = arrived
      ? resolveDeparture(input, arrived, stop.timezone)
      : resolveArrival(input, stop.appointment_at ?? now, stop.timezone);
  }

  const future = now.getTime() + FUTURE_TOLERANCE_MS;
  if (arrived && arrived.getTime() > future) {
    throw new ApiError(400, 'time_in_future', "That arrival time hasn't happened yet. What time did you get there?");
  }
  if (departed && departed.getTime() > future) {
    throw new ApiError(400, 'time_in_future', "That departure time hasn't happened yet. What time did you leave?");
  }
  if (arrived && departed && departed.getTime() <= arrived.getTime()) {
    throw new ApiError(400, 'departure_before_arrival', 'The departure has to be after the arrival. What time did you leave?');
  }

  const changed =
    arrived?.getTime() !== stop.arrived_at?.getTime() || departed?.getTime() !== stop.departed_at?.getTime();
  const updated = { ...stop, arrived_at: arrived, departed_at: departed };
  let loadStatus = stop.load_status;
  let loadDelivered = false;
  let claimRecalculated = false;

  if (changed) {
    await db.query('update stops set arrived_at = $3, departed_at = $4 where sandbox_id = $1 and id = $2', [
      caller.sandboxId,
      stop.id,
      arrived,
      departed,
    ]);
    await recordEvent(db, {
      sandboxId: caller.sandboxId,
      type: 'stop.times_recorded',
      actorPersonId: caller.personId,
      callId: body.call_id,
      payload: {
        stop_id: stop.id,
        load_id: stop.load_id,
        load_number: stop.load_number,
        facility_name: stop.facility_name,
        old: { arrived_at: iso(stop.arrived_at), departed_at: iso(stop.departed_at) },
        new: { arrived_at: iso(arrived), departed_at: iso(departed) },
      },
    });

    // Leaving the final delivery stop delivers an in-transit load.
    if (stop.is_final_delivery && departed && stop.load_status === 'in_transit') {
      await db.query("update loads set status = 'delivered' where sandbox_id = $1 and id = $2", [
        caller.sandboxId,
        stop.load_id,
      ]);
      loadStatus = 'delivered';
      loadDelivered = true;
      await recordEvent(db, {
        sandboxId: caller.sandboxId,
        type: 'load.delivered',
        actorPersonId: caller.personId,
        callId: body.call_id,
        payload: { load_id: stop.load_id, load_number: stop.load_number, stop_id: stop.id, departed_at: iso(departed) },
      });
    }

    // A draft claim follows the times; sent or settled claims are left alone.
    const claim = await findClaim(db, caller, stop.id);
    if (claim?.status === 'draft') {
      const d = computeDetention(updated, stop);
      const notes = claimNotes(d.late_arrival, callerNotesOf(claim.notes));
      if (d.billable_minutes !== claim.billable_minutes || d.amount_cents !== claim.amount_cents || notes !== claim.notes) {
        await db.query(
          `update detention_claims set billable_minutes = $3, amount_cents = $4, notes = $5
            where sandbox_id = $1 and id = $2`,
          [caller.sandboxId, claim.id, d.billable_minutes, d.amount_cents, notes],
        );
        await recordEvent(db, {
          sandboxId: caller.sandboxId,
          type: 'detention_claim.recalculated',
          actorPersonId: caller.personId,
          callId: body.call_id,
          payload: {
            claim_id: claim.id,
            stop_id: stop.id,
            load_number: stop.load_number,
            old: { billable_minutes: claim.billable_minutes, amount_cents: claim.amount_cents, notes: claim.notes },
            new: { billable_minutes: d.billable_minutes, amount_cents: d.amount_cents, notes },
          },
        });
        claimRecalculated = true;
      }
    }
  }

  return {
    statusCode: 200,
    body: {
      stop: stopView(updated),
      load_id: stop.load_id,
      load_number: stop.load_number,
      load_status: loadStatus,
      load_delivered: loadDelivered,
      claim_recalculated: claimRecalculated,
      readback: stopTimesReadback(updated),
    },
  };
}

/** Compute detention for a stop from its times and the payer's terms. No write. */
export async function checkDetention(db: Queryable, caller: Caller, stopId: string): Promise<DetentionResponse> {
  const stop = await findStop(db, caller, stopId, false);
  const d = computeDetention(stop, stop);
  const claim = await findClaim(db, caller, stop.id);
  const existing = claim ? claimView(claim, stop) : null;
  const summary = existing
    ? `There's already a ${existing.status} detention claim on this stop for ${existing.amount_display}.`
    : detentionSummary(d, stop.payer_name);
  return {
    stop_id: stop.id,
    load_id: stop.load_id,
    load_number: stop.load_number,
    facility_name: stop.facility_name,
    payer_name: stop.payer_name,
    eligible: d.eligible,
    reason: d.reason,
    on_time: d.on_time,
    late_arrival: d.late_arrival,
    clock_start: iso(d.clock_start),
    waited_minutes: d.waited_minutes,
    free_minutes: d.free_minutes,
    billable_minutes: d.billable_minutes,
    billable_display: spokenDuration(d.billable_minutes),
    amount_cents: d.amount_cents,
    amount_display: spokenAmount(d.amount_cents),
    notes: d.notes,
    claim: existing,
    summary,
  };
}

/** Draft a detention claim. One claim per stop; nothing is sent anywhere. */
export async function createDetentionClaim(
  db: Queryable,
  caller: Caller,
  stopId: string,
  body: CreateClaimBody,
): Promise<WriteResult<ClaimResponse>> {
  // The stop row lock serializes claim creation for this stop.
  const stop = await findStop(db, caller, stopId, true);
  const existing = await findClaim(db, caller, stop.id);
  if (existing) {
    const view = claimView(existing, stop);
    throw new ApiError(409, 'claim_exists', `There's already a ${view.status} detention claim on this stop for ${view.amount_display}.`, {
      existing: view,
    });
  }

  const d = computeDetention(stop, stop);
  if (!d.eligible) throw new ApiError(409, 'not_billable', detentionSummary(d, stop.payer_name), { reason: d.reason });

  const notes = claimNotes(d.late_arrival, body.notes ?? null);
  const { rows } = await db.query<ClaimRow>(
    `insert into detention_claims (sandbox_id, load_id, stop_id, billable_minutes, amount_cents, status, notes)
     values ($1, $2, $3, $4, $5, 'draft', $6)
     returning id, stop_id, load_id, status, billable_minutes, amount_cents, notes`,
    [caller.sandboxId, stop.load_id, stop.id, d.billable_minutes, d.amount_cents, notes],
  );
  const claim = rows[0];
  if (!claim) throw new Error('claim insert returned no row');
  await recordEvent(db, {
    sandboxId: caller.sandboxId,
    type: 'detention_claim.created',
    actorPersonId: caller.personId,
    callId: body.call_id,
    payload: {
      claim_id: claim.id,
      stop_id: stop.id,
      load_id: stop.load_id,
      load_number: stop.load_number,
      billable_minutes: claim.billable_minutes,
      amount_cents: claim.amount_cents,
      status: claim.status,
      notes,
    },
  });
  return { statusCode: 201, body: claimView(claim, stop, { drafted: true }) };
}
