import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  BusinessSummaryResponse,
  ClaimResponse,
  TicketResponse,
  TruckSummaryResponse,
  UnpaidLoadsResponse,
} from '../src/ledger-schemas.js';
import { rangeBounds } from '../src/lib/ranges.js';
import {
  actor,
  agent,
  agentWrite,
  closeContext,
  eventsOfType,
  expireSandbox,
  fakePhone,
  first,
  loadId,
  makeContext,
  newSandbox,
  truckId,
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

async function businessId(sandboxId: string): Promise<string> {
  const { rows } = await ctx.pool.query<{ id: string }>('select id from businesses where sandbox_id = $1', [sandboxId]);
  return first(rows).id;
}

async function fleet() {
  const sb = await newSandbox(ctx, 'small_fleet');
  return {
    sb,
    ray: await actor(ctx, sb.id, 'ray'),
    tommy: await actor(ctx, sb.id, 'tommy'),
    business: await businessId(sb.id),
    truck2: await truckId(ctx, sb.id, '2'),
  };
}

// Small-fleet seed, this week. Revenue is per ton: lbs * rate / 2000, plus 7708's flat $780.
const T1_REVENUE = 78_000 + 36_680 + 38_100 + 37_240; // 7708, 7701, 7703, 7707
const T1_COSTS = 53_900 + 37_152; // fuel on 7708, overhead fuel
const T2_REVENUE = 36_260 + 38_430; // 7704, 7705; 7712 waits on its ticket
const T2_COSTS = 44_840 + 33_880; // fuel
const T3_REVENUE = 36_400 + 37_170 + 37_520; // 7702, 7710, 7706
const T3_COSTS = 48_250 + 78_000; // fuel, repair

const ok = async <T>(a: Actor, url: string): Promise<T> => {
  const res = await agent(ctx, a, 'GET', url);
  expect(res.statusCode, res.body).toBe(200);
  return res.json<T>();
};

describe('rangeBounds', () => {
  it.each([
    ['Wednesday', '2026-10-28T14:00:00-05:00', '2026-10-26T00:00:00-05:00'],
    ['Monday 00:05', '2026-10-26T00:05:00-05:00', '2026-10-26T00:00:00-05:00'],
    ['Sunday across the end of DST', '2026-11-01T23:30:00-06:00', '2026-10-26T00:00:00-05:00'],
  ])('starts the week on Monday 00:00 in the business timezone (%s)', async (_label, now, start) => {
    const b = await rangeBounds(ctx.pool, 'America/Chicago', 'week', new Date(now));
    expect(b.start.toISOString()).toBe(new Date(start).toISOString());
    expect(b.end.toISOString()).toBe(new Date(now).toISOString());
  });

  it('uses the business timezone', async () => {
    const b = await rangeBounds(ctx.pool, 'America/New_York', 'week', new Date('2026-10-28T14:00:00-05:00'));
    expect(b.start.toISOString()).toBe(new Date('2026-10-26T00:00:00-04:00').toISOString());
  });

  it('covers the last 7 days', async () => {
    const now = new Date('2026-10-28T14:00:00-05:00');
    const b = await rangeBounds(ctx.pool, 'America/Chicago', 'last_7_days', now);
    expect(now.getTime() - b.start.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe('GET /trucks/:id/summary', () => {
  it('nets delivered loads against costs this week, and names loads waiting on a ticket', async () => {
    const { ray, truck2 } = await fleet();
    // Truck 2: 7704 pays $362.60 and 7705 $384.30; fuel is $448.40 + $338.80; 7712 has no ticket.
    const s = await ok<TruckSummaryResponse>(ray, `/trucks/${truck2}/summary`);
    expect(s).toMatchObject({
      truck_unit: '2',
      range: 'week',
      revenue_cents: T2_REVENUE,
      costs_cents: T2_COSTS,
      net_cents: -4030,
      net_display: 'minus 40 dollars and 30 cents',
      open_loads_with_costs: [],
    });
    expect(s.delivered_loads.map((l) => [l.load_number, l.revenue_status])).toEqual([
      ['7704', 'final'],
      ['7705', 'final'],
      ['7712', 'pending_scale_ticket'],
    ]);
    expect(s.summary).toBe(
      'Truck 2 grossed 747 this week, spent 787, so it lost 40. Load 7712 is still waiting on its scale ticket.',
    );
  });

  it("Story B: the owner's answer includes what the driver just logged", async () => {
    const { sb, ray, tommy, truck2 } = await fleet();
    const load7712 = await loadId(ctx, sb.id, '7712');
    const ticket = await agentWrite(ctx, tommy, 'POST', `/loads/${load7712}/scale-tickets`, 'log_scale_ticket', {
      net_weight_lbs: '52,800',
    });
    const fuel = await agentWrite(ctx, tommy, 'POST', '/expenses', 'log_expense', {
      category: 'fuel',
      amount: '180',
      gallons: '47',
      load_id: load7712,
    });
    const washout = await agentWrite(ctx, tommy, 'POST', '/expenses', 'log_expense', {
      category: 'washout',
      amount: '45',
      load_id: load7712,
    });

    // Pending records don't count yet; the pending ticket shows as a projection.
    const before = await ok<TruckSummaryResponse>(ray, `/trucks/${truck2}/summary`);
    expect(before.revenue_cents).toBe(T2_REVENUE);
    expect(before.delivered_loads.find((l) => l.load_number === '7712')?.projected_revenue_cents).toBe(36_960);

    await agentWrite(ctx, tommy, 'POST', '/scale-tickets/confirm', 'confirm_records', {
      ids: [ticket.json<TicketResponse>().id],
    });
    await agentWrite(ctx, tommy, 'POST', '/expenses/confirm', 'confirm_records', {
      ids: [fuel.json<{ id: string }>().id, washout.json<{ id: string }>().id],
    });

    const after = await ok<TruckSummaryResponse>(ray, `/trucks/${truck2}/summary`);
    expect(after).toMatchObject({ revenue_cents: T2_REVENUE + 36_960, costs_cents: T2_COSTS + 18_000 + 4500 });
    expect(after.summary).toBe('Truck 2 grossed 1,117 this week, spent 1,012, so it netted 104.');
  });

  it('mentions costs on a load still in transit, and counts reimbursable costs as pending', async () => {
    const sb = await newSandbox(ctx, 'owner_operator');
    const mike = await actor(ctx, sb.id, 'mike');
    const lumper = await agentWrite(ctx, mike, 'POST', '/expenses', 'log_expense', {
      category: 'lumper',
      amount: '85',
      payment_method: 'cash',
      load_id: await loadId(ctx, sb.id, '4471'),
    });
    await agentWrite(ctx, mike, 'POST', '/expenses/confirm', 'confirm_records', { ids: [lumper.json<{ id: string }>().id] });

    const s = await ok<TruckSummaryResponse>(mike, `/trucks/${await truckId(ctx, sb.id, '1')}/summary`);
    expect(s).toMatchObject({ revenue_cents: 0, costs_cents: 3175, pending_revenue_cents: 8500, delivered_loads: [] });
    expect(s.open_loads_with_costs).toMatchObject([{ load_number: '4471', status: 'in_transit', costs_cents: 3175 }]);
    expect(s.summary).toBe(
      'Truck 1 has no delivered loads this week yet and spent 32. That includes 32 on load 4471, still in transit.',
    );
  });

  it('counts revenue in the range that contains the delivery departure', async () => {
    const sb = await newSandbox(ctx, 'owner_operator');
    const mike = await actor(ctx, sb.id, 'mike');
    const truck = await truckId(ctx, sb.id, '1');
    // Move 4390's delivery to 3 days ago: inside the last 7 days.
    await ctx.pool.query(
      `update stops set arrived_at = now() - interval '3 days 1 hour', departed_at = now() - interval '3 days'
        where sandbox_id = $1 and type = 'delivery'
          and load_id = (select id from loads where sandbox_id = $1 and load_number = '4390')`,
      [sb.id],
    );
    const last7 = await ok<TruckSummaryResponse>(mike, `/trucks/${truck}/summary?range=last_7_days`);
    expect(last7.delivered_loads.map((l) => l.load_number)).toEqual(['4390']);
    expect(last7.revenue_cents).toBe(210_000);
    expect(last7.summary).toMatch(/^Truck 1 grossed 2,100 in the last 7 days, spent 32, so it netted 2,068\./);
  });

  it('is owner-only, and 404s a truck from another sandbox', async () => {
    const a = await fleet();
    const b = await fleet();
    const res = await agent(ctx, a.tommy, 'GET', `/trucks/${a.truck2}/summary`);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'owner_only', message: "That's one for the owner to check." });
    expect((await agent(ctx, a.ray, 'GET', `/trucks/${b.truck2}/summary`)).statusCode).toBe(404);
    expect((await agent(ctx, a.ray, 'GET', `/trucks/${a.truck2}/summary?range=month`)).statusCode).toBe(400);
  });
});

describe('GET /businesses/:id/summary', () => {
  it('totals every truck plus overhead, with best and worst', async () => {
    const { ray, business } = await fleet();
    const s = await ok<BusinessSummaryResponse>(ray, `/businesses/${business}/summary`);
    expect(s).toMatchObject({
      business_name: 'Cedar Fork Hauling LLC',
      revenue_cents: T1_REVENUE + T2_REVENUE + T3_REVENUE,
      costs_cents: T1_COSTS + T2_COSTS + T3_COSTS,
      overhead_costs_cents: 0,
    });
    expect(s.trucks.map((t) => [t.truck_unit, t.net_cents])).toEqual([
      ['1', T1_REVENUE - T1_COSTS],
      ['2', T2_REVENUE - T2_COSTS],
      ['3', T3_REVENUE - T3_COSTS],
    ]);
    expect(s.best_truck?.truck_unit).toBe('1');
    expect(s.worst_truck?.truck_unit).toBe('3');
    expect(s.summary).toBe(
      'Cedar Fork Hauling LLC grossed 3,758 this week, spent 2,960, so it netted 798. ' +
        'Best was truck 1, netting 990; worst was truck 3, which lost 152, after 780 dollars in repairs. ' +
        'Load 7712 is still waiting on its scale ticket.',
    );
  });

  it('tells the harvest-week story: profitable, truck 3 weakest, truck 2 flips on the ticket', async () => {
    const { sb, ray, tommy, business, truck2 } = await fleet();
    const truck3 = await truckId(ctx, sb.id, '3');
    const biz = () => ok<BusinessSummaryResponse>(ray, `/businesses/${business}/summary`);

    const before = await biz();
    expect(before.net_cents).toBeGreaterThan(0);
    expect(before.worst_truck?.truck_unit).toBe('3');
    expect(before.trucks.find((t) => t.truck_unit === '2')?.net_cents).toBeLessThan(0);

    // Truck 3 is weakest mainly because of its repair: without it, it would be profitable.
    const t3 = await ok<TruckSummaryResponse>(ray, `/trucks/${truck3}/summary`);
    expect(t3.net_cents).toBeLessThan(0);
    expect(t3.net_cents + 78_000).toBeGreaterThan(0);
    expect(t3.summary).toBe('Truck 3 grossed 1,111 this week, spent 1,263, so it lost 152. That includes 780 in repairs.');

    const ticket = await agentWrite(ctx, tommy, 'POST', `/loads/${await loadId(ctx, sb.id, '7712')}/scale-tickets`, 'log_scale_ticket', {
      net_weight_lbs: '52,800',
    });
    expect((await ok<TruckSummaryResponse>(ray, `/trucks/${truck2}/summary`)).net_cents).toBeLessThan(0);
    await agentWrite(ctx, tommy, 'POST', '/scale-tickets/confirm', 'confirm_records', {
      ids: [ticket.json<TicketResponse>().id],
    });

    const t2 = await ok<TruckSummaryResponse>(ray, `/trucks/${truck2}/summary`);
    expect(t2.net_cents).toBeGreaterThan(0);
    const after = await biz();
    expect(after.net_cents).toBeGreaterThan(before.net_cents);
    expect(after.worst_truck?.truck_unit).toBe('3');
    expect(after.best_truck?.truck_unit).toBe('1');
    expect(after.summary).toMatch(/so it netted [\d,]+\. .*worst was truck 3, which lost 152, after 780 dollars in repairs\.$/);
  });

  it('includes business overhead not tied to a truck', async () => {
    const { sb, ray, business } = await fleet();
    await ctx.pool.query(
      `insert into expenses (sandbox_id, business_id, person_id, category, amount_cents, occurred_at, status, source)
       values ($1, $2, $3, 'other', 25000, now() - interval '1 minute', 'confirmed', 'seed')`,
      [sb.id, business, ray.personId],
    );
    const s = await ok<BusinessSummaryResponse>(ray, `/businesses/${business}/summary`);
    expect(s.overhead_costs_cents).toBe(25_000);
    expect(s.costs_cents).toBe(T1_COSTS + T2_COSTS + T3_COSTS + 25_000);
  });

  it('has no best or worst for a single truck', async () => {
    const sb = await newSandbox(ctx, 'owner_operator');
    const mike = await actor(ctx, sb.id, 'mike');
    const s = await ok<BusinessSummaryResponse>(mike, `/businesses/${await businessId(sb.id)}/summary`);
    expect(s).toMatchObject({ best_truck: null, worst_truck: null });
    expect(s.summary).toBe(
      'Kestrel Line Freight LLC has no delivered loads this week yet and spent 32. That includes 32 on load 4471, still in transit.',
    );
  });

  it("is owner-only, and 404s another business's id", async () => {
    const a = await fleet();
    const b = await fleet();
    expect((await agent(ctx, a.tommy, 'GET', `/businesses/${a.business}/summary`)).statusCode).toBe(403);
    expect((await agent(ctx, a.ray, 'GET', `/businesses/${b.business}/summary`)).statusCode).toBe(404);
  });
});

describe('GET /businesses/:id/unpaid-loads', () => {
  it('lists delivered and invoiced loads not yet paid', async () => {
    const { ray, business } = await fleet();
    const u = await ok<UnpaidLoadsResponse>(ray, `/businesses/${business}/unpaid-loads`);
    expect(u.loads.map((l) => [l.load_number, l.status, l.amount_cents])).toEqual([
      ['7705', 'delivered', 38_430],
      ['7706', 'invoiced', 37_520],
      ['7712', 'delivered', null],
    ]);
    expect(u.total_cents).toBe(38_430 + 37_520);
    expect(u.summary).toMatch(
      new RegExp(
        "^3 loads haven't been paid: 7705, 384 dollars from Millbrook Grain Co\\., not invoiced yet; " +
          '7706, 375 dollars from Millbrook Grain Co\\., invoiced (today|1 day ago|\\d+ days ago); ' +
          '7712, from Millbrook Grain Co\\., waiting on its scale ticket\\. ' +
          "That's 760 dollars, not counting loads waiting on a scale ticket\\.$",
      ),
    );
  });

  it('says how long ago an unpaid load was invoiced', async () => {
    const sb = await newSandbox(ctx, 'owner_operator');
    const mike = await actor(ctx, sb.id, 'mike');
    await ctx.pool.query("update loads set invoiced_at = now() - interval '5 days 2 hours' where sandbox_id = $1 and load_number = '4390'", [
      sb.id,
    ]);
    const u = await ok<UnpaidLoadsResponse>(mike, `/businesses/${await businessId(sb.id)}/unpaid-loads`);
    expect(u.loads).toMatchObject([{ load_number: '4390', status: 'invoiced', days_since_invoiced: 5 }]);
    expect(u.summary).toBe(
      "1 load hasn't been paid: 4390, 2,100 dollars from Bluegate Freight Partners, invoiced 5 days ago.",
    );
  });

  it('is owner-only', async () => {
    const { tommy, business } = await fleet();
    expect((await agent(ctx, tommy, 'GET', `/businesses/${business}/unpaid-loads`)).statusCode).toBe(403);
  });
});

describe('demo controls for the mocks', () => {
  const pay = (sandboxId: string, load: string) =>
    ctx.app.inject({ method: 'POST', url: `/sandboxes/${sandboxId}/loads/${load}/simulate-payment` });

  it('simulates a payment, which drops the load from unpaid', async () => {
    const { sb, ray, business } = await fleet();
    const load7705 = await loadId(ctx, sb.id, '7705');
    const res = await pay(sb.id, load7705);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ load_id: load7705, load_number: '7705', status: 'paid' });

    const u = await ok<UnpaidLoadsResponse>(ray, `/businesses/${business}/unpaid-loads`);
    expect(u.loads.map((l) => l.load_number)).toEqual(['7706', '7712']);
    expect(await eventsOfType(ctx, sb.id, 'load.paid')).toMatchObject([{ payload: { load_number: '7705', source: 'mock_payments' } }]);

    expect((await pay(sb.id, load7705)).json().error).toBe('already_paid');
  });

  it('refuses loads not yet delivered, from another sandbox, or in an expired sandbox', async () => {
    const a = await newSandbox(ctx, 'owner_operator');
    const b = await newSandbox(ctx, 'owner_operator');
    const in4471 = await loadId(ctx, a.id, '4471');
    expect((await pay(a.id, in4471)).statusCode).toBe(409);
    expect((await pay(a.id, await loadId(ctx, b.id, '4390'))).statusCode).toBe(404);
    await expireSandbox(ctx, a.id);
    expect((await pay(a.id, await loadId(ctx, a.id, '4390'))).statusCode).toBe(410);
  });

  it('sends a draft detention claim once, without leaving the system', async () => {
    const sb = await newSandbox(ctx, 'owner_operator');
    const other = await newSandbox(ctx, 'owner_operator');
    const mike = await actor(ctx, sb.id, 'mike');
    const { rows } = await ctx.pool.query<{ id: string; appointment_at: Date }>(
      `select s.id, s.appointment_at from stops s join loads l on l.id = s.load_id and l.sandbox_id = s.sandbox_id
        where s.sandbox_id = $1 and l.load_number = '4471' and s.type = 'pickup'`,
      [sb.id],
    );
    const pickup = first(rows);
    const appt = pickup.appointment_at.getTime();
    await agentWrite(ctx, mike, 'POST', `/stops/${pickup.id}/times`, 'log_stop_times', {
      arrived_at: new Date(appt - 10 * 60_000).toISOString(),
      departed_at: new Date(appt + 185 * 60_000).toISOString(),
    });
    const claim = (
      await agentWrite(ctx, mike, 'POST', `/stops/${pickup.id}/detention-claims`, 'create_detention_claim', {})
    ).json<ClaimResponse>();

    const send = (sandboxId: string) =>
      ctx.app.inject({ method: 'POST', url: `/sandboxes/${sandboxId}/detention-claims/${claim.id}/send` });
    expect((await send(other.id)).statusCode).toBe(404);
    const sent = await send(sb.id);
    expect(sent.statusCode, sent.body).toBe(200);
    expect(sent.json()).toEqual({ id: claim.id, load_number: '4471', status: 'sent' });
    expect((await send(sb.id)).json()).toMatchObject({ error: 'claim_not_draft', status: 'sent' });
    expect(await eventsOfType(ctx, sb.id, 'detention_claim.sent')).toHaveLength(1);
  });

  it('never puts a phone number in an event payload', async () => {
    const sb = await newSandbox(ctx, 'small_fleet', 'phone');
    const phone = fakePhone();
    await ctx.app.inject({ method: 'POST', url: `/sandboxes/${sb.id}/phones`, payload: { phone, seed_key: 'tommy' } });
    const tommy = await actor(ctx, sb.id, 'tommy');
    const load7712 = await loadId(ctx, sb.id, '7712');
    await agentWrite(ctx, tommy, 'POST', `/loads/${load7712}/scale-tickets`, 'log_scale_ticket', { net_weight_lbs: 52_800 });
    await pay(sb.id, await loadId(ctx, sb.id, '7705'));

    const { rows } = await ctx.pool.query<{ payload: unknown }>('select payload from events where sandbox_id = $1', [sb.id]);
    expect(rows.length).toBeGreaterThan(0);
    // Only the last 4 digits are ever logged (phone.registered); never the full number.
    const all = JSON.stringify(rows);
    expect(all).not.toContain(phone.slice(2));
    expect(all).not.toContain(phone.slice(2, 8));
    expect(all).toContain(`"phone_last4":"${phone.slice(-4)}"`);
  });
});
