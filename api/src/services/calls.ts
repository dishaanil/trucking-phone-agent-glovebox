import type { Queryable } from '../db.js';
import { ApiError } from '../errors.js';
import type { Caller } from '../lib/caller.js';
import { recordEvent } from '../lib/events.js';
import type { EndCallResponse } from '../schemas.js';

export type EndReason = EndCallResponse['end_reason'];

/** Record that an agent call started (from /callers/resolve). Repeated starts are ignored. */
export async function startCall(
  db: Queryable,
  call: { sandboxId: string; callId: string; personId: string; access: 'phone' | 'demo_code' },
): Promise<void> {
  const { rows } = await db.query<{ seed_key: string; full_name: string }>(
    `with inserted as (
       insert into calls (sandbox_id, call_id, person_id, access) values ($1, $2, $3, $4)
       on conflict (sandbox_id, call_id) do nothing
       returning person_id
     )
     select p.seed_key, p.full_name from inserted i join people p on p.id = i.person_id and p.sandbox_id = $1`,
    [call.sandboxId, call.callId, call.personId, call.access],
  );
  const person = rows[0];
  if (!person) return;
  // Never the phone number: only who is calling and how they got in.
  await recordEvent(db, {
    sandboxId: call.sandboxId,
    type: 'call.started',
    callId: call.callId,
    actorPersonId: call.personId,
    payload: { call_id: call.callId, seed_key: person.seed_key, full_name: person.full_name, access: call.access },
  });
}

interface CallRow {
  call_id: string;
  started_at: Date;
  ended_at: Date | null;
  end_reason: EndReason | null;
}

function view(c: CallRow & { ended_at: Date; end_reason: EndReason }): EndCallResponse {
  return {
    call_id: c.call_id,
    ended_at: c.ended_at.toISOString(),
    end_reason: c.end_reason,
    duration_seconds: Math.round((c.ended_at.getTime() - c.started_at.getTime()) / 1000),
  };
}

/** End a call. Ending one that already ended returns its first ending, without a new event. */
export async function endCall(db: Queryable, caller: Caller, callId: string, reason: EndReason): Promise<EndCallResponse> {
  const { rows } = await db.query<CallRow>(
    `select call_id, started_at, ended_at, end_reason from calls
      where sandbox_id = $1 and call_id = $2 and person_id = $3
      for update`,
    [caller.sandboxId, callId, caller.personId],
  );
  const call = rows[0];
  if (!call) throw new ApiError(404, 'call_not_found', "I can't find that call.");
  if (call.ended_at && call.end_reason) return view({ ...call, ended_at: call.ended_at, end_reason: call.end_reason });

  const updated = await db.query<{ ended_at: Date }>(
    `update calls set ended_at = now(), end_reason = $3
      where sandbox_id = $1 and call_id = $2
      returning ended_at`,
    [caller.sandboxId, callId, reason],
  );
  const endedAt = updated.rows[0]?.ended_at;
  if (!endedAt) throw new Error('call end update returned no row');
  const ended = view({ ...call, ended_at: endedAt, end_reason: reason });
  await recordEvent(db, {
    sandboxId: caller.sandboxId,
    type: 'call.ended',
    callId,
    actorPersonId: caller.personId,
    payload: { ...ended },
  });
  return ended;
}

/**
 * End calls still open after `timeoutMinutes` (the agent crashed or lost its connection).
 * Housekeeping across all sandboxes, like the expired-sandbox cleanup; run inside a transaction.
 */
export async function endStaleCalls(db: Queryable, timeoutMinutes: number): Promise<number> {
  const { rows } = await db.query<CallRow & { sandbox_id: string; person_id: string; ended_at: Date }>(
    `update calls set ended_at = now(), end_reason = 'timeout'
      where ended_at is null and started_at < now() - make_interval(mins => $1)
      returning sandbox_id, call_id, person_id, started_at, ended_at, end_reason`,
    [timeoutMinutes],
  );
  for (const call of rows) {
    await recordEvent(db, {
      sandboxId: call.sandbox_id,
      type: 'call.ended',
      callId: call.call_id,
      actorPersonId: call.person_id,
      payload: { ...view({ ...call, end_reason: 'timeout' }) },
    });
  }
  return rows.length;
}
