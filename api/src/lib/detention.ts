import { spokenAmount } from './money.js';
import { spokenDuration } from './times.js';

// Detention terms live on the payer record (SPEC section 9), never in code.

export interface DetentionTerms {
  payer_name: string;
  pays_detention: boolean;
  detention_free_minutes: number | null;
  detention_rate_cents_per_hour: number | null;
  detention_increment_minutes: number | null;
  detention_requires_on_time: boolean | null;
  late_grace_minutes: number | null;
}

export interface StopTimes {
  appointment_at: Date | null;
  arrived_at: Date | null;
  departed_at: Date | null;
}

export type NotBillableReason = 'payer_no_detention' | 'missing_times' | 'under_free_time';

export interface Detention {
  /** Billable time exists and the payer pays detention. A late arrival is still eligible, with a note. */
  eligible: boolean;
  reason: NotBillableReason | null;
  on_time: boolean | null;
  late_arrival: boolean;
  clock_start: Date | null;
  waited_minutes: number;
  free_minutes: number;
  billable_minutes: number;
  amount_cents: number;
  notes: string | null;
}

export const LATE_ARRIVAL_NOTE = 'late arrival, detention may be disputed';

const MINUTE_MS = 60_000;

export function computeDetention(stop: StopTimes, terms: DetentionTerms): Detention {
  const free = terms.detention_free_minutes ?? 0;
  const none = (reason: NotBillableReason, extra: Partial<Detention> = {}): Detention => ({
    eligible: false,
    reason,
    on_time: null,
    late_arrival: false,
    clock_start: null,
    waited_minutes: 0,
    free_minutes: free,
    billable_minutes: 0,
    amount_cents: 0,
    notes: null,
    ...extra,
  });

  if (!terms.pays_detention) return none('payer_no_detention');
  if (!stop.arrived_at || !stop.departed_at) return none('missing_times');

  const grace = terms.late_grace_minutes ?? 0;
  const appt = stop.appointment_at;
  const onTime = appt ? stop.arrived_at.getTime() <= appt.getTime() + grace * MINUTE_MS : true;
  // Arriving early doesn't start the clock early.
  const clockStart = appt && appt.getTime() > stop.arrived_at.getTime() ? appt : stop.arrived_at;
  const waited = Math.max(0, Math.floor((stop.departed_at.getTime() - clockStart.getTime()) / MINUTE_MS));
  const increment = terms.detention_increment_minutes ?? 0;
  const over = Math.max(0, waited - free);
  const billable = increment > 0 ? Math.floor(over / increment) * increment : over;
  const lateArrival = !onTime && (terms.detention_requires_on_time ?? false);
  const base = { on_time: onTime, late_arrival: lateArrival, clock_start: clockStart, waited_minutes: waited };

  if (billable === 0) return none('under_free_time', base);
  return {
    eligible: true,
    reason: null,
    ...base,
    free_minutes: free,
    billable_minutes: billable,
    amount_cents: Math.round((billable * (terms.detention_rate_cents_per_hour ?? 0)) / 60),
    notes: lateArrival ? LATE_ARRIVAL_NOTE : null,
  };
}

/** One sentence for the agent to speak. The late-arrival note is always said out loud. */
export function detentionSummary(d: Detention, payerName: string): string {
  switch (d.reason) {
    case 'payer_no_detention':
      return `${payerName} doesn't pay detention, so there's nothing to claim.`;
    case 'missing_times':
      return 'I need both your arrival and departure times to check detention.';
    case 'under_free_time':
      return `You waited ${spokenDuration(d.waited_minutes)}, inside the ${spokenDuration(d.free_minutes)} of free time, so no detention.`;
    case null: {
      const billable = `Detention is billable: ${spokenDuration(d.billable_minutes)}, ${spokenAmount(d.amount_cents)}.`;
      return d.late_arrival
        ? `${billable} You arrived late, so detention may be disputed. Want me to draft the claim anyway?`
        : `${billable} Want me to draft the claim?`;
    }
  }
}
