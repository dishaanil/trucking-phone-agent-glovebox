import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  ClaimResponse,
  DetentionResponse,
  ProfitabilityResponse,
  StopTimesResponse,
} from '../src/ledger-schemas.js';
import {
  actor,
  agent,
  agentWrite,
  closeContext,
  eventsOfType,
  first,
  loadId,
  makeContext,
  newSandbox,
  type Actor,
  type TestContext,
} from './helpers.js';

let ctx: TestContext;
beforeAll(() => {
  ctx = makeContext();
});
afterAll(async () => {
  await closeContext(ctx);
});

const MIN = 60_000;

/** "HH:MM" as a caller would say it, in the given timezone. */
const hhmm = (d: Date, timeZone: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);

interface StopRef {
  id: string;
  appointment_at: Date | null;
}

async function stopOf(sandboxId: string, loadNumber: string, type: 'pickup' | 'delivery'): Promise<StopRef> {
  const { rows } = await ctx.pool.query<StopRef>(
    `select s.id, s.appointment_at from stops s join loads l on l.id = s.load_id and l.sandbox_id = s.sandbox_id
      where s.sandbox_id = $1 and l.load_number = $2 and s.type = $3`,
    [sandboxId, loadNumber, type],
  );
  return first(rows);
}

async function storedTimes(stopId: string) {
  const { rows } = await ctx.pool.query<{ arrived_at: Date | null; departed_at: Date | null }>(
    'select arrived_at, departed_at from stops where id = $1',
    [stopId],
  );
  return first(rows);
}

const logTimes = (a: Actor, stopId: string, payload: Record<string, unknown>) =>
  agentWrite(ctx, a, 'POST', `/stops/${stopId}/times`, 'log_stop_times', payload);
const detention = (a: Actor, stopId: string) => agent(ctx, a, 'GET', `/stops/${stopId}/detention`);
const claim = (a: Actor, stopId: string, payload: Record<string, unknown> = {}) =>
  agentWrite(ctx, a, 'POST', `/stops/${stopId}/detention-claims`, 'create_detention_claim', payload);

async function storyA() {
  const sb = await newSandbox(ctx, 'owner_operator');
  const mike = await actor(ctx, sb.id, 'mike');
  const pickup = await stopOf(sb.id, '4471', 'pickup');
  if (!pickup.appointment_at) throw new Error('4471 pickup has no appointment');
  return { sb, mike, pickup, appt: pickup.appointment_at.getTime() };
}

describe('Story A: stop times, detention and a claim', () => {
  it('records spoken times, finds 1 hour of detention, and drafts a $50 claim', async () => {
    const { sb, mike, pickup, appt } = await storyA();
    const arrived = new Date(appt - 10 * MIN);
    const departed = new Date(appt + 185 * MIN);

    const times = await logTimes(mike, pickup.id, {
      arrived_at: hhmm(arrived, 'America/Chicago'),
      departed_at: hhmm(departed, 'America/Chicago'),
    });
    expect(times.statusCode, times.body).toBe(200);
    const body = times.json<StopTimesResponse>();
    expect(body).toMatchObject({ load_number: '4471', load_status: 'in_transit', load_delivered: false });
    expect(body.readback).toMatch(/^Harlan Point Cold Storage: arrived \d{1,2}:\d{2} [AP]M, left \d{1,2}:\d{2} [AP]M( the next day)?\.$/);
    expect(await storedTimes(pickup.id)).toEqual({ arrived_at: arrived, departed_at: departed });

    const check = await detention(mike, pickup.id);
    expect(check.statusCode, check.body).toBe(200);
    expect(check.json<DetentionResponse>()).toMatchObject({
      eligible: true,
      payer_name: 'Bluegate Freight Partners',
      waited_minutes: 185,
      billable_minutes: 60,
      billable_display: '1 hour',
      amount_cents: 5000,
      amount_display: '50 dollars',
      claim: null,
      summary: 'Detention is billable: 1 hour, 50 dollars. Want me to draft the claim?',
    });

    const drafted = await claim(mike, pickup.id);
    expect(drafted.statusCode, drafted.body).toBe(201);
    expect(drafted.json<ClaimResponse>()).toMatchObject({
      status: 'draft',
      billable_minutes: 60,
      amount_cents: 5000,
      notes: null,
      readback: 'Drafted a detention claim for load 4471 at Harlan Point Cold Storage: 1 hour, 50 dollars.',
    });
    expect(await eventsOfType(ctx, sb.id, 'detention_claim.created')).toHaveLength(1);

    const p = await agent(ctx, mike, 'GET', `/loads/${await loadId(ctx, sb.id, '4471')}/profitability`);
    expect(p.json<ProfitabilityResponse>().pending_revenue_cents).toBe(5000);

    const again = await detention(mike, pickup.id);
    expect(again.json<DetentionResponse>().summary).toBe(
      "There's already a draft detention claim on this stop for 50 dollars.",
    );
  });

  it('refuses a second claim on the same stop, with the existing one', async () => {
    const { mike, pickup, appt } = await storyA();
    await logTimes(mike, pickup.id, {
      arrived_at: new Date(appt - 10 * MIN).toISOString(),
      departed_at: new Date(appt + 185 * MIN).toISOString(),
    });
    const firstClaim = (await claim(mike, pickup.id)).json<ClaimResponse>();
    const second = await claim(mike, pickup.id);
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: 'claim_exists', existing: { id: firstClaim.id, status: 'draft' } });
  });

  it('recalculates a draft claim when the times are corrected', async () => {
    const { sb, mike, pickup, appt } = await storyA();
    await logTimes(mike, pickup.id, {
      arrived_at: new Date(appt - 10 * MIN).toISOString(),
      departed_at: new Date(appt + 185 * MIN).toISOString(),
    });
    const drafted = (await claim(mike, pickup.id)).json<ClaimResponse>();

    // Left at 3 hours 20 minutes instead: 80 billable, rounded to 75.
    const res = await logTimes(mike, pickup.id, { departed_at: new Date(appt + 200 * MIN).toISOString() });
    expect(res.json<StopTimesResponse>().claim_recalculated).toBe(true);
    const { rows } = await ctx.pool.query('select billable_minutes, amount_cents from detention_claims where id = $1', [
      drafted.id,
    ]);
    expect(rows[0]).toEqual({ billable_minutes: 75, amount_cents: 6250 });
    const [event] = await eventsOfType(ctx, sb.id, 'detention_claim.recalculated');
    expect(event?.payload).toMatchObject({
      old: { billable_minutes: 60, amount_cents: 5000 },
      new: { billable_minutes: 75, amount_cents: 6250 },
    });
  });

  it('drafts a claim on a late arrival with the note, and says it out loud', async () => {
    const { mike, pickup, appt } = await storyA();
    await logTimes(mike, pickup.id, {
      arrived_at: new Date(appt + 20 * MIN).toISOString(),
      departed_at: new Date(appt + 210 * MIN).toISOString(),
    });
    const check = (await detention(mike, pickup.id)).json<DetentionResponse>();
    expect(check).toMatchObject({ eligible: true, on_time: false, late_arrival: true, billable_minutes: 60 });
    expect(check.summary).toMatch(/You arrived late, so detention may be disputed\. Want me to draft the claim anyway\?$/);

    const drafted = (await claim(mike, pickup.id, { notes: 'dock was backed up' })).json<ClaimResponse>();
    expect(drafted.notes).toBe('late arrival, detention may be disputed; dock was backed up');
    expect(drafted.readback).toMatch(/I noted the late arrival, so it may be disputed\.$/);
  });
});

describe('POST /stops/:id/times', () => {
  it('handles an overnight wait: arrive 22:00, leave 02:00', async () => {
    const sb = await newSandbox(ctx, 'owner_operator');
    const mike = await actor(ctx, sb.id, 'mike');
    // 4390 pickup at Orrin Valley Foods, Indianapolis, appointment 07:00 local last week.
    const pickup = await stopOf(sb.id, '4390', 'pickup');
    const appt = pickup.appointment_at?.getTime() ?? 0;

    const res = await logTimes(mike, pickup.id, { arrived_at: '22:00', departed_at: '02:00' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<StopTimesResponse>().readback).toBe('Orrin Valley Foods: arrived 10:00 PM, left 2:00 AM the next day.');
    // 22:00 the night before the appointment, then 02:00 that morning.
    expect(await storedTimes(pickup.id)).toEqual({
      arrived_at: new Date(appt - 9 * 60 * MIN),
      departed_at: new Date(appt - 5 * 60 * MIN),
    });
  });

  it("resolves local times in the stop's timezone", async () => {
    const sb = await newSandbox(ctx, 'owner_operator');
    const mike = await actor(ctx, sb.id, 'mike');
    const pickup = await stopOf(sb.id, '4390', 'pickup');
    const appt = pickup.appointment_at?.getTime() ?? 0;
    // 06:45 Indianapolis time is 15 minutes before the 07:00 appointment.
    await logTimes(mike, pickup.id, { arrived_at: '6:45 AM' });
    expect((await storedTimes(pickup.id)).arrived_at).toEqual(new Date(appt - 15 * MIN));
  });

  it('rejects future times, departures before arrival, and unreadable times', async () => {
    const { mike, pickup, appt } = await storyA();
    const future = await logTimes(mike, pickup.id, { arrived_at: new Date(Date.now() + 60 * MIN).toISOString() });
    expect(future.statusCode).toBe(400);
    expect(future.json().error).toBe('time_in_future');

    const backwards = await logTimes(mike, pickup.id, {
      arrived_at: new Date(appt).toISOString(),
      departed_at: new Date(appt - 30 * MIN).toISOString(),
    });
    expect(backwards.json().error).toBe('departure_before_arrival');

    const unreadable = await logTimes(mike, pickup.id, { departed_at: 'after 11' });
    expect(unreadable.json()).toMatchObject({ error: 'invalid_time' });
    expect(unreadable.json().message).toMatch(/What time did you leave\?/);

    expect((await logTimes(mike, pickup.id, {})).statusCode).toBe(400);
    expect(await storedTimes(pickup.id)).toEqual({ arrived_at: null, departed_at: null });
  });

  it('overwrites on correction with an old and new event, and skips no-op writes', async () => {
    const { sb, mike, pickup, appt } = await storyA();
    const t1 = new Date(appt - 10 * MIN).toISOString();
    const t2 = new Date(appt - 5 * MIN).toISOString();
    await logTimes(mike, pickup.id, { arrived_at: t1 });
    await logTimes(mike, pickup.id, { arrived_at: t2 });
    await logTimes(mike, pickup.id, { arrived_at: t2 });
    const events = await eventsOfType(ctx, sb.id, 'stop.times_recorded');
    expect(events).toHaveLength(2);
    expect(events[1]?.payload).toMatchObject({ old: { arrived_at: t1 }, new: { arrived_at: t2 } });
  });

  it('delivers an in-transit load on departure from the final delivery stop', async () => {
    const sb = await newSandbox(ctx, 'owner_operator');
    const mike = await actor(ctx, sb.id, 'mike');
    const pickup = await stopOf(sb.id, '4471', 'pickup');
    const delivery = await stopOf(sb.id, '4471', 'delivery');

    const leftPickup = await logTimes(mike, pickup.id, {
      arrived_at: new Date(Date.now() - 120 * MIN).toISOString(),
      departed_at: new Date(Date.now() - 90 * MIN).toISOString(),
    });
    expect(leftPickup.json<StopTimesResponse>()).toMatchObject({ load_status: 'in_transit', load_delivered: false });

    const arrivedOnly = await logTimes(mike, delivery.id, { arrived_at: new Date(Date.now() - 30 * MIN).toISOString() });
    expect(arrivedOnly.json<StopTimesResponse>().load_delivered).toBe(false);

    const left = await logTimes(mike, delivery.id, { departed_at: new Date(Date.now() - 10 * MIN).toISOString() });
    expect(left.json<StopTimesResponse>()).toMatchObject({ load_status: 'delivered', load_delivered: true });
    const { rows } = await ctx.pool.query("select status from loads where sandbox_id = $1 and load_number = '4471'", [sb.id]);
    expect(rows[0]).toEqual({ status: 'delivered' });
    const [event] = await eventsOfType(ctx, sb.id, 'load.delivered');
    expect(event?.payload).toMatchObject({ load_number: '4471', stop_id: delivery.id });
  });

  it("doesn't change a load that is already delivered", async () => {
    const sb = await newSandbox(ctx, 'small_fleet');
    const tommy = await actor(ctx, sb.id, 'tommy');
    const delivery = await stopOf(sb.id, '7712', 'delivery');
    const res = await logTimes(tommy, delivery.id, { departed_at: new Date(Date.now() - 5 * MIN).toISOString() });
    expect(res.json<StopTimesResponse>()).toMatchObject({ load_status: 'delivered', load_delivered: false });
    expect(await eventsOfType(ctx, sb.id, 'load.delivered')).toHaveLength(0);
  });

  it('replays the same request without writing twice', async () => {
    const { sb, mike, pickup, appt } = await storyA();
    const body = {
      arrived_at: new Date(appt - 10 * MIN).toISOString(),
      call_id: mike.callId,
      idempotency_key: `${mike.callId}:2:0:log_stop_times`,
    };
    const a = await agent(ctx, mike, 'POST', `/stops/${pickup.id}/times`, body);
    const b = await agent(ctx, mike, 'POST', `/stops/${pickup.id}/times`, body);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.json()).toEqual(a.json());
    expect(await eventsOfType(ctx, sb.id, 'stop.times_recorded')).toHaveLength(1);
  });
});

describe('detention outside Story A', () => {
  it("says when the payer doesn't pay detention and refuses the claim", async () => {
    const sb = await newSandbox(ctx, 'small_fleet');
    const tommy = await actor(ctx, sb.id, 'tommy');
    const delivery = await stopOf(sb.id, '7712', 'delivery');
    const check = (await detention(tommy, delivery.id)).json<DetentionResponse>();
    expect(check).toMatchObject({ eligible: false, reason: 'payer_no_detention' });
    expect(check.summary).toBe("Millbrook Grain Co. doesn't pay detention, so there's nothing to claim.");
    const res = await claim(tommy, delivery.id);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'not_billable', reason: 'payer_no_detention' });
  });

  it('asks for times when they are missing', async () => {
    const { mike, pickup } = await storyA();
    const check = (await detention(mike, pickup.id)).json<DetentionResponse>();
    expect(check).toMatchObject({ eligible: false, reason: 'missing_times' });
    expect((await claim(mike, pickup.id)).json().error).toBe('not_billable');
  });

  it("stops a driver touching another driver's stop, but not the owner", async () => {
    const sb = await newSandbox(ctx, 'small_fleet');
    const [luis, ray] = [await actor(ctx, sb.id, 'luis'), await actor(ctx, sb.id, 'ray')];
    const delivery = await stopOf(sb.id, '7712', 'delivery');
    const departed = { departed_at: new Date(Date.now() - 5 * MIN).toISOString() };
    expect((await logTimes(luis, delivery.id, departed)).statusCode).toBe(403);
    expect((await detention(luis, delivery.id)).statusCode).toBe(403);
    expect((await claim(luis, delivery.id)).statusCode).toBe(403);
    expect((await logTimes(ray, delivery.id, departed)).statusCode).toBe(200);
    expect((await detention(ray, delivery.id)).statusCode).toBe(200);
  });

  it('404s a stop from another sandbox and requires the service token', async () => {
    const a = await storyA();
    const b = await storyA();
    expect((await detention(a.mike, b.pickup.id)).statusCode).toBe(404);
    const noToken = await ctx.app.inject({ method: 'GET', url: `/stops/${a.pickup.id}/detention` });
    expect(noToken.statusCode).toBe(401);
  });
});
