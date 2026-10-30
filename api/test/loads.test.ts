import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LoadResponse, ProfitabilityResponse, TicketResponse } from '../src/ledger-schemas.js';
import { baseRevenueCents, costPerMileCents, perTonCents, spokenDollars } from '../src/lib/revenue.js';
import {
  actor,
  agent,
  agentWrite,
  closeContext,
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

describe('revenue math', () => {
  it('pays per ton from pounds in integer cents', () => {
    // SPEC Story B: 52,800 lb at $14.00 a ton is 26.4 tons, $369.60.
    expect(perTonCents(52_800, 1400)).toBe(36_960);
    expect(perTonCents(51_240, 1500)).toBe(38_430);
    // Halves round up, anything less rounds down.
    expect(perTonCents(1, 1000)).toBe(1);
    expect(perTonCents(1, 999)).toBe(0);
  });

  it('computes base revenue for each rate type', () => {
    const load = { rate_cents: 1400, loaded_miles: 85, confirmed_ticket_lbs: null };
    expect(baseRevenueCents({ ...load, rate_type: 'flat', rate_cents: 240_000 })).toBe(240_000);
    expect(baseRevenueCents({ ...load, rate_type: 'per_mile', rate_cents: 250 })).toBe(21_250);
    expect(baseRevenueCents({ ...load, rate_type: 'per_ton' })).toBeNull();
    expect(baseRevenueCents({ ...load, rate_type: 'per_ton', confirmed_ticket_lbs: 52_800 })).toBe(36_960);
  });

  it('rounds cost per mile and spoken dollars', () => {
    expect(costPerMileCents(3175, 715)).toBe(4);
    expect(costPerMileCents(3175, 0)).toBeNull();
    expect(spokenDollars(236_825)).toBe('2,368');
    expect(spokenDollars(3150)).toBe('32');
    expect(spokenDollars(-6410)).toBe('64');
  });
});

const profit = async (a: Actor, id: string) => {
  const res = await agent(ctx, a, 'GET', `/loads/${id}/profitability`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json<ProfitabilityResponse>();
};

async function owner() {
  const sb = await newSandbox(ctx, 'owner_operator');
  return { sb, mike: await actor(ctx, sb.id, 'mike'), load4471: await loadId(ctx, sb.id, '4471') };
}

async function fleet() {
  const sb = await newSandbox(ctx, 'small_fleet');
  return {
    sb,
    ray: await actor(ctx, sb.id, 'ray'),
    tommy: await actor(ctx, sb.id, 'tommy'),
    luis: await actor(ctx, sb.id, 'luis'),
    load7712: await loadId(ctx, sb.id, '7712'),
  };
}

describe('GET /loads/:id/profitability', () => {
  it('nets a flat load against its confirmed expenses', async () => {
    const { mike, load4471 } = await owner();
    // Seeded: toll $16.75 and scale fee $15.00.
    expect(await profit(mike, load4471)).toMatchObject({
      revenue_status: 'final',
      revenue_cents: 240_000,
      revenue_display: '2,400 dollars',
      costs_cents: 3175,
      net_cents: 236_825,
      cost_per_mile_cents: 4,
      projected_revenue_cents: null,
      pending_revenue_cents: 0,
      summary: 'Load 4471 pays 2,400 dollars, costs so far are 32, so it nets 2,368.',
    });
  });

  it('counts only confirmed expenses, and reimbursable ones as pending revenue', async () => {
    const { mike, load4471 } = await owner();
    const fuel = await agentWrite(ctx, mike, 'POST', '/expenses', 'log_expense', {
      category: 'fuel',
      amount: '512.40',
      gallons: '140',
      load_id: load4471,
    });
    const lumper = await agentWrite(ctx, mike, 'POST', '/expenses', 'log_expense', {
      category: 'lumper',
      amount: '85',
      payment_method: 'cash',
      load_id: load4471,
    });
    expect((await profit(mike, load4471)).costs_cents).toBe(3175);

    await agentWrite(ctx, mike, 'POST', '/expenses/confirm', 'confirm_records', {
      ids: [fuel.json<{ id: string }>().id, lumper.json<{ id: string }>().id],
    });
    const p = await profit(mike, load4471);
    expect(p).toMatchObject({ costs_cents: 3175 + 51_240, pending_revenue_cents: 8500, net_cents: 240_000 - 54_415 });
    expect(p.summary).toBe('Load 4471 pays 2,400 dollars, costs so far are 544, so it nets 1,856. Still pending: 85 in reimbursements.');
  });

  it('adds approved detention to revenue and draft detention to pending', async () => {
    const { sb, mike, load4471 } = await owner();
    const stops = await ctx.pool.query<{ id: string; type: string }>(
      'select id, type from stops where sandbox_id = $1 and load_id = $2',
      [sb.id, load4471],
    );
    const [pickup, delivery] = [stops.rows.find((s) => s.type === 'pickup'), stops.rows.find((s) => s.type === 'delivery')];
    await ctx.pool.query(
      `insert into detention_claims (sandbox_id, load_id, stop_id, billable_minutes, amount_cents, status)
       values ($1, $2, $3, 60, 5000, 'approved'), ($1, $2, $4, 30, 2500, 'draft')`,
      [sb.id, load4471, pickup?.id, delivery?.id],
    );
    expect(await profit(mike, load4471)).toMatchObject({
      revenue_cents: 245_000,
      detention_revenue_cents: 5000,
      pending_revenue_cents: 2500,
    });
  });

  it('pays per mile', async () => {
    const { sb, mike, load4471 } = await owner();
    await ctx.pool.query("update loads set rate_type = 'per_mile', rate_cents = 325 where sandbox_id = $1 and id = $2", [
      sb.id,
      load4471,
    ]);
    expect((await profit(mike, load4471)).revenue_cents).toBe(715 * 325);
  });

  it('waits on a confirmed scale ticket for per-ton pay, projecting from a pending one', async () => {
    const { tommy, load7712 } = await fleet();
    expect(await profit(tommy, load7712)).toMatchObject({
      revenue_status: 'pending_scale_ticket',
      revenue_cents: null,
      net_cents: null,
      projected_revenue_cents: null,
      summary: "Load 7712's pay is pending the scale ticket. No costs logged yet.",
    });

    const ticket = await agentWrite(ctx, tommy, 'POST', `/loads/${load7712}/scale-tickets`, 'log_scale_ticket', {
      net_weight_lbs: '52,800',
    });
    expect(await profit(tommy, load7712)).toMatchObject({
      revenue_cents: null,
      projected_revenue_cents: 36_960,
      projected_revenue_display: '369 dollars and 60 cents',
      summary: 'Load 7712 would pay about 370 dollars once the scale ticket is confirmed. No costs logged yet.',
    });

    await agentWrite(ctx, tommy, 'POST', '/scale-tickets/confirm', 'confirm_records', {
      ids: [ticket.json<TicketResponse>().id],
    });
    expect(await profit(tommy, load7712)).toMatchObject({
      revenue_status: 'final',
      revenue_cents: 36_960,
      net_cents: 36_960,
      projected_revenue_cents: null,
      summary: 'Load 7712 pays 370 dollars, with no costs logged yet.',
    });
  });

  it('says when a load is down', async () => {
    const { sb, ray } = await fleet();
    // 7705: 51,240 lb at $15.00 a ton is $384.30, against $448.40 of seeded fuel.
    const p = await profit(ray, await loadId(ctx, sb.id, '7705'));
    expect(p).toMatchObject({ revenue_cents: 38_430, costs_cents: 44_840, net_cents: -6410, net_display: 'minus 64 dollars and 10 cents' });
    expect(p.summary).toBe("Load 7705 pays 384 dollars, costs so far are 448, so it's down 64.");
  });

  it("stops a driver reading another driver's load, but not the owner", async () => {
    const { ray, luis, load7712 } = await fleet();
    const res = await agent(ctx, luis, 'GET', `/loads/${load7712}/profitability`);
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toMatch(/one for the owner/);
    expect((await profit(ray, load7712)).load_number).toBe('7712');
  });

  it('404s a load from another sandbox', async () => {
    const a = await fleet();
    const b = await fleet();
    expect((await agent(ctx, a.ray, 'GET', `/loads/${b.load7712}/profitability`)).statusCode).toBe(404);
  });
});

describe('GET /loads?number=', () => {
  it('finds a load outside the active list, with stops in local timezones', async () => {
    const { sb, mike } = await owner();
    const res = await agent(ctx, mike, 'GET', '/loads?number=4390');
    expect(res.statusCode, res.body).toBe(200);
    const load = res.json<LoadResponse>();
    expect(load).toMatchObject({ id: await loadId(ctx, sb.id, '4390'), status: 'invoiced', truck_unit: '1', payer_name: 'Bluegate Freight Partners' });
    expect(load.stops.map((s) => [s.type, s.city, s.timezone])).toEqual([
      ['pickup', 'Indianapolis', 'America/Indiana/Indianapolis'],
      ['delivery', 'Joliet', 'America/Chicago'],
    ]);
    expect(load.stops[1]?.departed_at).not.toBeNull();
  });

  it('falls back to the business timezone when a stop has none', async () => {
    const { sb, mike } = await owner();
    await ctx.pool.query('update stops set timezone = null where sandbox_id = $1', [sb.id]);
    await ctx.pool.query("update businesses set timezone = 'America/Denver' where sandbox_id = $1", [sb.id]);
    const load = (await agent(ctx, mike, 'GET', '/loads?number=4471')).json<LoadResponse>();
    expect(load.stops.map((s) => s.timezone)).toEqual(['America/Denver', 'America/Denver']);
  });

  it('lets drivers find only their own loads', async () => {
    const { tommy, luis, ray } = await fleet();
    expect((await agent(ctx, tommy, 'GET', '/loads?number=7705')).statusCode).toBe(200);
    expect((await agent(ctx, luis, 'GET', '/loads?number=7705')).statusCode).toBe(403);
    expect((await agent(ctx, ray, 'GET', '/loads?number=7705')).statusCode).toBe(200);
  });

  it('404s an unknown number and rejects a malformed one', async () => {
    const { ray } = await fleet();
    expect((await agent(ctx, ray, 'GET', '/loads?number=9999')).statusCode).toBe(404);
    expect((await agent(ctx, ray, 'GET', '/loads?number=77%2012')).statusCode).toBe(400);
    expect((await agent(ctx, ray, 'GET', '/loads')).statusCode).toBe(400);
  });
});
