import { describe, expect, it } from 'vitest';
import { computeDetention, detentionSummary, type DetentionTerms } from '../src/lib/detention.js';
import {
  localDayDiff,
  parseTimeInput,
  resolveArrival,
  resolveDeparture,
  spokenDuration,
  spokenTime,
  type TimeInput,
} from '../src/lib/times.js';

const CHI = 'America/Chicago';

// Bluegate Freight Partners in the owner-operator seed.
const bluegate: DetentionTerms = {
  payer_name: 'Bluegate Freight Partners',
  pays_detention: true,
  detention_free_minutes: 120,
  detention_rate_cents_per_hour: 5000,
  detention_increment_minutes: 15,
  detention_requires_on_time: true,
  late_grace_minutes: 15,
};

const at = (local: string) => new Date(`2026-10-28T${local}:00-05:00`);
const stop = (arrived: string | null, departed: string | null, appointment: string | null = '08:00') => ({
  appointment_at: appointment ? at(appointment) : null,
  arrived_at: arrived ? at(arrived) : null,
  departed_at: departed ? at(departed) : null,
});

describe('computeDetention', () => {
  it('matches the SPEC example: 185 minutes waited, 60 billable, $50', () => {
    const d = computeDetention(stop('07:50', '11:05'), bluegate);
    expect(d).toMatchObject({
      eligible: true,
      reason: null,
      on_time: true,
      late_arrival: false,
      waited_minutes: 185,
      billable_minutes: 60,
      amount_cents: 5000,
      notes: null,
    });
    // Arriving early doesn't start the clock early.
    expect(d.clock_start).toEqual(at('08:00'));
    expect(detentionSummary(d, bluegate.payer_name)).toBe(
      'Detention is billable: 1 hour, 50 dollars. Want me to draft the claim?',
    );
  });

  it('rounds billable time down to the increment and pays by the minute', () => {
    expect(computeDetention(stop('08:00', '11:14'), bluegate).billable_minutes).toBe(60);
    expect(computeDetention(stop('08:00', '11:15'), bluegate)).toMatchObject({ billable_minutes: 75, amount_cents: 6250 });
    const noIncrement = { ...bluegate, detention_increment_minutes: null };
    expect(computeDetention(stop('08:00', '11:07'), noIncrement)).toMatchObject({ billable_minutes: 67, amount_cents: 5583 });
  });

  it('is not billable inside free time', () => {
    const d = computeDetention(stop('07:50', '09:45'), bluegate);
    expect(d).toMatchObject({ eligible: false, reason: 'under_free_time', waited_minutes: 105, billable_minutes: 0, amount_cents: 0 });
    expect(detentionSummary(d, bluegate.payer_name)).toBe(
      'You waited 1 hour 45 minutes, inside the 2 hours of free time, so no detention.',
    );
  });

  it('keeps a late arrival eligible, with a note the agent says out loud', () => {
    const d = computeDetention(stop('08:20', '11:35'), bluegate);
    expect(d).toMatchObject({
      eligible: true,
      on_time: false,
      late_arrival: true,
      waited_minutes: 195,
      billable_minutes: 75,
      amount_cents: 6250,
      notes: 'late arrival, detention may be disputed',
    });
    expect(d.clock_start).toEqual(at('08:20'));
    expect(detentionSummary(d, bluegate.payer_name)).toBe(
      'Detention is billable: 1 hour 15 minutes, 62 dollars and 50 cents. You arrived late, so detention may be disputed. Want me to draft the claim anyway?',
    );
  });

  it('counts arrival within the grace period as on time', () => {
    expect(computeDetention(stop('08:15', '11:30'), bluegate)).toMatchObject({ on_time: true, late_arrival: false });
    expect(computeDetention(stop('08:16', '11:30'), bluegate)).toMatchObject({ on_time: false, late_arrival: true });
  });

  it("doesn't flag lateness when the payer doesn't require on-time arrival", () => {
    const d = computeDetention(stop('09:00', '12:00'), { ...bluegate, detention_requires_on_time: false });
    expect(d).toMatchObject({ on_time: false, late_arrival: false, notes: null, billable_minutes: 60 });
  });

  it('starts the clock at arrival when there is no appointment', () => {
    const d = computeDetention(stop('09:10', '12:25', null), bluegate);
    expect(d).toMatchObject({ on_time: true, waited_minutes: 195, billable_minutes: 75 });
  });

  it("explains when the payer doesn't pay detention or times are missing", () => {
    const none = computeDetention(stop('07:50', '11:05'), { ...bluegate, pays_detention: false });
    expect(none).toMatchObject({ eligible: false, reason: 'payer_no_detention', amount_cents: 0 });
    expect(detentionSummary(none, 'Millbrook Grain Co.')).toBe(
      "Millbrook Grain Co. doesn't pay detention, so there's nothing to claim.",
    );
    const missing = computeDetention(stop('07:50', null), bluegate);
    expect(missing.reason).toBe('missing_times');
    expect(detentionSummary(missing, bluegate.payer_name)).toMatch(/arrival and departure/);
  });
});

describe('parseTimeInput', () => {
  it.each([
    ['7:50', 7, 50],
    ['07:50', 7, 50],
    ['23:05', 23, 5],
    ['11:05 PM', 23, 5],
    ['11:05pm', 23, 5],
    ['11:05 p.m.', 23, 5],
    ['12:00 am', 0, 0],
    ['12:30 PM', 12, 30],
  ])('reads %s as %i:%i', (input, hour, minute) => {
    expect(parseTimeInput(input)).toEqual({ kind: 'local', hour, minute });
  });

  it('reads ISO timestamps with an offset', () => {
    expect(parseTimeInput('2026-10-28T07:50:00-05:00')).toEqual({ kind: 'instant', at: at('07:50') });
    expect(parseTimeInput('2026-10-28T12:50:00Z')).toEqual({ kind: 'instant', at: at('07:50') });
  });

  it.each(['24:00', '7:60', '13:00 pm', '0:30 am', 'after 11', '2026-10-28T07:50:00', 'tomorrow', ''])(
    'rejects %j',
    (input) => {
      expect(parseTimeInput(input)).toBeNull();
    },
  );
});

const local = (hour: number, minute: number): TimeInput => ({ kind: 'local', hour, minute });

describe('resolving local times', () => {
  it('resolves arrival to the occurrence nearest the appointment', () => {
    expect(resolveArrival(local(7, 50), at('08:00'), CHI)).toEqual(at('07:50'));
    // 23:50 the night before is closer to an 8:00 appointment than 23:50 that day.
    expect(resolveArrival(local(23, 50), at('08:00'), CHI)).toEqual(new Date('2026-10-27T23:50:00-05:00'));
  });

  it('resolves departure to the first occurrence after arrival', () => {
    expect(resolveDeparture(local(11, 5), at('07:50'), CHI)).toEqual(at('11:05'));
  });

  it('handles an overnight wait: arrive 22:00, leave 02:00', () => {
    const arrived = resolveArrival(local(22, 0), at('22:30'), CHI);
    expect(arrived).toEqual(at('22:00'));
    const departed = resolveDeparture(local(2, 0), arrived, CHI);
    expect(departed).toEqual(new Date('2026-10-29T02:00:00-05:00'));
    expect(localDayDiff(arrived, departed, CHI)).toBe(1);
  });

  it('handles an overnight wait across the end of daylight saving time', () => {
    // 2026-11-01: clocks fall back from 2:00 CDT to 1:00 CST.
    const arrived = resolveArrival(local(22, 0), new Date('2026-10-31T22:00:00-05:00'), CHI);
    expect(arrived).toEqual(new Date('2026-10-31T22:00:00-05:00'));
    expect(resolveDeparture(local(2, 0), arrived, CHI)).toEqual(new Date('2026-11-01T02:00:00-06:00'));
  });

  it("resolves in the stop's timezone", () => {
    const appt = new Date('2026-10-29T14:00:00-04:00');
    expect(resolveArrival(local(13, 40), appt, 'America/New_York')).toEqual(new Date('2026-10-29T13:40:00-04:00'));
  });

  it('passes ISO instants through unchanged', () => {
    const input: TimeInput = { kind: 'instant', at: at('07:50') };
    expect(resolveArrival(input, at('20:00'), CHI)).toEqual(at('07:50'));
    expect(resolveDeparture(input, at('20:00'), CHI)).toEqual(at('07:50'));
  });
});

describe('spoken times and durations', () => {
  it('speaks times in the stop timezone', () => {
    expect(spokenTime(at('07:50'), CHI)).toBe('7:50 AM');
    expect(spokenTime(at('07:50'), 'America/New_York')).toBe('8:50 AM');
  });

  it.each([
    [60, '1 hour'],
    [75, '1 hour 15 minutes'],
    [45, '45 minutes'],
    [120, '2 hours'],
    [61, '1 hour 1 minute'],
    [0, '0 minutes'],
  ])('%i minutes is %j', (minutes, text) => {
    expect(spokenDuration(minutes)).toBe(text);
  });
});
