import type { Queryable } from '../db.js';
import { ApiError } from '../errors.js';
import { recordEvent } from '../lib/events.js';

export interface PaymentResult {
  load_id: string;
  load_number: string;
  status: 'paid';
  paid_at: string;
}

/** Where load payments come from. A real version would read a bank or payments feed. */
export interface PaymentsProvider {
  /** Record that a delivered or invoiced load has been paid. */
  markPaid(db: Queryable, sandboxId: string, loadId: string): Promise<PaymentResult>;
}

/** Demo payments: the dashboard's "simulate payment received" button. Nothing real is called. */
export class MockPayments implements PaymentsProvider {
  async markPaid(db: Queryable, sandboxId: string, loadId: string): Promise<PaymentResult> {
    const { rows } = await db.query<{ id: string; load_number: string; status: string; paid_at: Date | null }>(
      'select id, load_number, status, paid_at from loads where sandbox_id = $1 and id = $2 for update',
      [sandboxId, loadId],
    );
    const load = rows[0];
    if (!load) throw new ApiError(404, 'load_not_found', "That load isn't in this demo.");
    if (load.paid_at) throw new ApiError(409, 'already_paid', `Load ${load.load_number} is already paid.`);
    if (load.status !== 'delivered' && load.status !== 'invoiced') {
      throw new ApiError(409, 'not_delivered', `Load ${load.load_number} hasn't been delivered yet.`);
    }

    const paid = await db.query<{ paid_at: Date }>(
      `update loads set status = 'paid', paid_at = now() where sandbox_id = $1 and id = $2 returning paid_at`,
      [sandboxId, loadId],
    );
    const paidAt = paid.rows[0]?.paid_at;
    if (!paidAt) throw new Error('payment update returned no row');
    await recordEvent(db, {
      sandboxId,
      type: 'load.paid',
      payload: { load_id: load.id, load_number: load.load_number, source: 'mock_payments' },
    });
    return { load_id: load.id, load_number: load.load_number, status: 'paid', paid_at: paidAt.toISOString() };
  }
}
