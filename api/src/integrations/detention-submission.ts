import type { Queryable } from '../db.js';
import { ApiError } from '../errors.js';
import { recordEvent } from '../lib/events.js';

export interface SubmissionResult {
  id: string;
  load_number: string;
  status: 'sent';
}

/** How detention claims reach the payer. A real version would email or use a broker portal. */
export interface DetentionSubmitter {
  send(db: Queryable, sandboxId: string, claimId: string): Promise<SubmissionResult>;
}

/** Demo submission: marks a draft claim sent and logs an event. Nothing leaves the system. */
export class MockDetentionSubmitter implements DetentionSubmitter {
  async send(db: Queryable, sandboxId: string, claimId: string): Promise<SubmissionResult> {
    const { rows } = await db.query<{ id: string; status: string; amount_cents: number; load_number: string }>(
      `select dc.id, dc.status, dc.amount_cents, l.load_number
         from detention_claims dc join loads l on l.id = dc.load_id and l.sandbox_id = dc.sandbox_id
        where dc.sandbox_id = $1 and dc.id = $2
        for update of dc`,
      [sandboxId, claimId],
    );
    const claim = rows[0];
    if (!claim) throw new ApiError(404, 'claim_not_found', "That claim isn't in this demo.");
    if (claim.status !== 'draft') {
      throw new ApiError(409, 'claim_not_draft', `That claim is already ${claim.status}.`, { status: claim.status });
    }
    await db.query("update detention_claims set status = 'sent' where sandbox_id = $1 and id = $2", [sandboxId, claimId]);
    await recordEvent(db, {
      sandboxId,
      type: 'detention_claim.sent',
      payload: { claim_id: claim.id, load_number: claim.load_number, amount_cents: claim.amount_cents, channel: 'mock' },
    });
    return { id: claim.id, load_number: claim.load_number, status: 'sent' };
  }
}
