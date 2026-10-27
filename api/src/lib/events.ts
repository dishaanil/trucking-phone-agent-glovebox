import type { Queryable } from '../db.js';

export async function recordEvent(
  db: Queryable,
  event: {
    sandboxId: string;
    type: string;
    payload: Record<string, unknown>;
    actorPersonId?: string | null;
    callId?: string | null;
  },
): Promise<void> {
  await db.query(
    `insert into events (sandbox_id, call_id, actor_person_id, type, payload)
     values ($1, $2, $3, $4, $5)`,
    [event.sandboxId, event.callId ?? null, event.actorPersonId ?? null, event.type, event.payload],
  );
}
