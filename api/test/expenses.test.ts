import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConfirmResponse, DiscardResponse, ExpenseResponse } from '../src/ledger-schemas.js';
import {
  actor,
  agent,
  agentWrite,
  closeContext,
  eventsOfType,
  expireSandbox,
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

const fuel = { category: 'fuel', amount: '512.40', vendor: "Love's", city: 'Joplin', state: 'MO', gallons: '140', payment_method: 'fuel_card' };

async function logExpense(a: Actor, payload: Record<string, unknown>) {
  return agentWrite(ctx, a, 'POST', '/expenses', 'log_expense', payload);
}

async function created(a: Actor, payload: Record<string, unknown>): Promise<ExpenseResponse> {
  const res = await logExpense(a, payload);
  expect(res.statusCode, res.body).toBe(201);
  return res.json<ExpenseResponse>();
}

async function countExpenses(sandboxId: string): Promise<number> {
  const { rows } = await ctx.pool.query<{ n: number }>('select count(*)::int as n from expenses where sandbox_id = $1', [
    sandboxId,
  ]);
  return rows[0]?.n ?? 0;
}

async function fleet() {
  const sb = await newSandbox(ctx, 'small_fleet');
  return {
    sb,
    ray: await actor(ctx, sb.id, 'ray'),
    tommy: await actor(ctx, sb.id, 'tommy'),
    luis: await actor(ctx, sb.id, 'luis'),
    load7712: await loadId(ctx, sb.id, '7712'),
    load7710: await loadId(ctx, sb.id, '7710'),
  };
}

describe('agent caller context', () => {
  it('requires the token, the caller headers, a person in the sandbox, and a live sandbox', async () => {
    const sb = await newSandbox(ctx, 'owner_operator');
    const mike = await actor(ctx, sb.id, 'mike');
    const body = { ...fuel, call_id: 'c', idempotency_key: 'c:1:0:log_expense' };

    const noToken = await ctx.app.inject({ method: 'POST', url: '/expenses', payload: body });
    expect(noToken.statusCode).toBe(401);

    const noHeaders = await ctx.app.inject({
      method: 'POST',
      url: '/expenses',
      headers: { authorization: 'Bearer test-service-token-0123456789' },
      payload: body,
    });
    expect(noHeaders.statusCode).toBe(400);

    const other = await newSandbox(ctx, 'small_fleet');
    const stranger = await actor(ctx, other.id, 'tommy');
    const crossed = await agent(ctx, { ...stranger, sandboxId: sb.id }, 'POST', '/expenses', body);
    expect(crossed.statusCode).toBe(403);

    await expireSandbox(ctx, sb.id);
    expect((await agent(ctx, mike, 'POST', '/expenses', body)).statusCode).toBe(410);
  });
});

describe('POST /expenses', () => {
  it('creates a pending expense on the load with the SPEC readback', async () => {
    const sb = await newSandbox(ctx, 'owner_operator');
    const mike = await actor(ctx, sb.id, 'mike');
    const load = await loadId(ctx, sb.id, '4471');
    const e = await created(mike, { ...fuel, load_id: load, occurred_at: new Date().toISOString() });
    expect(e).toMatchObject({
      status: 'pending',
      amount_cents: 51240,
      amount_display: '512 dollars and 40 cents',
      gallons: '140',
      load_number: '4471',
      truck_unit: '1',
      readback: "Fuel, 512 dollars and 40 cents, 140 gallons at Love's in Joplin, Missouri.",
      needs_confirmation: false,
      confirmation_reasons: [],
      confirmation_prompt: null,
    });
    const events = await eventsOfType(ctx, sb.id, 'expense.created');
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ id: e.id, amount_cents: 51240 });
  });

  it('parses $ and commas, and accepts full state names', async () => {
    const { tommy } = await fleet();
    const e = await created(tommy, { category: 'repair', amount: '$1,250.5', state: 'Kentucky' });
    expect(e.amount_cents).toBe(125050);
    expect(e.state).toBe('KY');
  });

  it.each(['512.405', '-5', 'abc', '0', '100,000.01'])('rejects amount %s', async (amount) => {
    const { tommy, sb } = await fleet();
    const res = await logExpense(tommy, { category: 'toll', amount });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/amount/);
    expect(await countExpenses(sb.id)).toBe(5);
  });

  it('flags but still creates amounts over the ceiling and odd fuel prices', async () => {
    const { tommy } = await fleet();
    const toll = await created(tommy, { category: 'toll', amount: '250' });
    expect(toll).toMatchObject({ status: 'pending', needs_confirmation: true, confirmation_reasons: ['amount_over_ceiling'] });
    expect(toll.confirmation_prompt).toMatch(/amount/);

    const cheap = await created(tommy, { category: 'fuel', amount: '51.24', gallons: '140' });
    expect(cheap.confirmation_reasons).toEqual(['price_per_gallon_out_of_range']);
  });

  it('rejects times more than 5 minutes ahead and flags dates over 30 days old', async () => {
    const { tommy } = await fleet();
    const future = new Date(Date.now() + 10 * 60_000).toISOString();
    expect((await logExpense(tommy, { category: 'food', amount: '12', occurred_at: future })).statusCode).toBe(400);

    const old = new Date(Date.now() - 31 * 24 * 3600_000).toISOString();
    expect((await created(tommy, { category: 'food', amount: '12', occurred_at: old })).confirmation_reasons).toEqual([
      'occurred_long_ago',
    ]);
  });

  it('rejects gallons on non-fuel expenses and unknown states', async () => {
    const { tommy } = await fleet();
    expect((await logExpense(tommy, { category: 'toll', amount: '12', gallons: '3' })).statusCode).toBe(400);
    expect((await logExpense(tommy, { category: 'toll', amount: '12', state: 'Atlantis' })).statusCode).toBe(400);
  });

  it('makes cash lumper fees reimbursable by default, with an override', async () => {
    const { tommy } = await fleet();
    const lumper = await created(tommy, { category: 'lumper', amount: '150', payment_method: 'cash' });
    expect(lumper.reimbursable).toBe(true);
    expect(lumper.readback).toBe('Lumper, 150 dollars, paid cash.');
    expect((await created(tommy, { category: 'lumper', amount: '150', payment_method: 'cash', reimbursable: false })).reimbursable).toBe(false);
    expect((await created(tommy, { category: 'lumper', amount: '150', payment_method: 'card' })).reimbursable).toBe(false);
  });
});

describe('expense truck and load rules', () => {
  it("uses the load's truck and rejects a mismatched truck", async () => {
    const { sb, ray, load7712 } = await fleet();
    const e = await created(ray, { category: 'washout', amount: '35', load_id: load7712 });
    expect(e.truck_unit).toBe('2');

    const truck1 = await truckId(ctx, sb.id, '1');
    const res = await logExpense(ray, { category: 'washout', amount: '35', load_id: load7712, truck_id: truck1 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('truck_load_mismatch');
  });

  it("defaults to the caller's own truck without a load", async () => {
    const { tommy } = await fleet();
    const e = await created(tommy, { category: 'parking', amount: '20' });
    expect(e).toMatchObject({ load_id: null, truck_unit: '2' });
  });

  it("stops drivers logging on another driver's load or truck", async () => {
    const { sb, tommy, load7710 } = await fleet();
    const onLoad = await logExpense(tommy, { category: 'washout', amount: '35', load_id: load7710 });
    expect(onLoad.statusCode).toBe(403);
    expect(onLoad.json().message).toMatch(/owner/);

    const onTruck = await logExpense(tommy, { category: 'washout', amount: '35', truck_id: await truckId(ctx, sb.id, '3') });
    expect(onTruck.statusCode).toBe(403);
  });

  it('lets owners log on any load, and 404s loads from other sandboxes', async () => {
    const { ray, load7710 } = await fleet();
    expect((await created(ray, { category: 'washout', amount: '35', load_id: load7710 })).truck_unit).toBe('3');

    const other = await fleet();
    expect((await logExpense(ray, { category: 'washout', amount: '35', load_id: other.load7710 })).statusCode).toBe(404);
  });
});

describe('PATCH /expenses/:id', () => {
  it('updates the same row, returns a new readback, and logs old and new values', async () => {
    const { sb, tommy, load7712 } = await fleet();
    const e = await created(tommy, { ...fuel, load_id: load7712 });
    const before = await countExpenses(sb.id);

    const res = await agentWrite(ctx, tommy, 'PATCH', `/expenses/${e.id}`, 'correct_expense', { amount: '521.40' });
    expect(res.statusCode).toBe(200);
    const fixed = res.json<ExpenseResponse>();
    expect(fixed).toMatchObject({ id: e.id, amount_cents: 52140, status: 'pending' });
    expect(fixed.readback).toMatch(/^Fuel, 521 dollars and 40 cents/);
    expect(await countExpenses(sb.id)).toBe(before);

    const [event] = await eventsOfType(ctx, sb.id, 'expense.corrected');
    expect(event?.payload).toEqual({
      id: e.id,
      old: { amount_cents: 51240 },
      new: { amount_cents: 52140 },
      status_before: 'pending',
      status_after: 'pending',
    });
  });

  it('sends a confirmed expense back to pending', async () => {
    const { sb, tommy } = await fleet();
    const e = await created(tommy, { category: 'toll', amount: '12' });
    await agentWrite(ctx, tommy, 'POST', '/expenses/confirm', 'confirm_records', { ids: [e.id] });
    const res = await agentWrite(ctx, tommy, 'PATCH', `/expenses/${e.id}`, 'correct_expense', { amount: '21' });
    expect(res.json<ExpenseResponse>().status).toBe('pending');
    const [event] = await eventsOfType(ctx, sb.id, 'expense.corrected');
    expect(event?.payload).toMatchObject({ status_before: 'confirmed', status_after: 'pending' });
  });

  it('does nothing when no value changes', async () => {
    const { sb, tommy } = await fleet();
    const e = await created(tommy, { category: 'toll', amount: '12' });
    const res = await agentWrite(ctx, tommy, 'PATCH', `/expenses/${e.id}`, 'correct_expense', { amount: '12.00' });
    expect(res.statusCode).toBe(200);
    expect(await eventsOfType(ctx, sb.id, 'expense.corrected')).toHaveLength(0);
  });

  it('clears gallons when the category changes away from fuel, and moves the truck with the load', async () => {
    const { tommy, ray, load7712, load7710 } = await fleet();
    const e = await created(tommy, { ...fuel, load_id: load7712 });
    const food = await agentWrite(ctx, tommy, 'PATCH', `/expenses/${e.id}`, 'correct_expense', { category: 'food', amount: '14' });
    expect(food.json<ExpenseResponse>()).toMatchObject({ category: 'food', gallons: null });

    const moved = await agentWrite(ctx, ray, 'PATCH', `/expenses/${e.id}`, 'correct_expense', { load_id: load7710 });
    expect(moved.json<ExpenseResponse>()).toMatchObject({ load_number: '7710', truck_unit: '3' });
  });

  it("stops a driver correcting another driver's expense, but not the owner", async () => {
    const { tommy, luis, ray } = await fleet();
    const e = await created(tommy, { category: 'toll', amount: '12' });
    expect((await agentWrite(ctx, luis, 'PATCH', `/expenses/${e.id}`, 'correct_expense', { amount: '13' })).statusCode).toBe(403);
    expect((await agentWrite(ctx, ray, 'PATCH', `/expenses/${e.id}`, 'correct_expense', { amount: '13' })).statusCode).toBe(200);
  });

  it('refuses to correct a discarded expense', async () => {
    const { tommy } = await fleet();
    const e = await created(tommy, { category: 'toll', amount: '12' });
    await agentWrite(ctx, tommy, 'POST', `/expenses/${e.id}/discard`, 'discard_expense', {});
    const res = await agentWrite(ctx, tommy, 'PATCH', `/expenses/${e.id}`, 'correct_expense', { amount: '13' });
    expect(res.statusCode).toBe(409);
  });
});

describe('POST /expenses/confirm', () => {
  it('returns a result per id', async () => {
    const { sb, tommy, luis } = await fleet();
    const a = await created(tommy, { category: 'toll', amount: '12' });
    const b = await created(tommy, { category: 'toll', amount: '13' });
    const gone = await created(tommy, { category: 'toll', amount: '14' });
    const luisOwn = await created(luis, { category: 'toll', amount: '15' });
    await agentWrite(ctx, tommy, 'POST', '/expenses/confirm', 'confirm_records', { ids: [b.id] });
    await agentWrite(ctx, tommy, 'POST', `/expenses/${gone.id}/discard`, 'discard_expense', {});
    const missing = '00000000-0000-4000-8000-000000000000';

    const res = await agentWrite(ctx, tommy, 'POST', '/expenses/confirm', 'confirm_records', {
      ids: [a.id, b.id, gone.id, luisOwn.id, missing],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<ConfirmResponse>()).toEqual({
      results: [
        { id: a.id, result: 'confirmed' },
        { id: b.id, result: 'already_confirmed' },
        { id: gone.id, result: 'discarded' },
        { id: luisOwn.id, result: 'forbidden' },
        { id: missing, result: 'not_found' },
      ],
      confirmed_count: 1,
    });
    expect(await eventsOfType(ctx, sb.id, 'expense.confirmed')).toHaveLength(2);
  });
});

describe('POST /expenses/:id/discard (void)', () => {
  it('voids a pending expense and writes an audit event', async () => {
    const { sb, tommy } = await fleet();
    const e = await created(tommy, { category: 'toll', amount: '12', payment_method: 'cash' });
    const res = await agentWrite(ctx, tommy, 'POST', `/expenses/${e.id}/discard`, 'discard_expense', { reason: 'logged twice' });
    expect(res.json<DiscardResponse>()).toEqual({
      id: e.id,
      status: 'discarded',
      previous_status: 'pending',
      message: 'Okay, I removed the toll, 12 dollars.',
    });
    const [event] = await eventsOfType(ctx, sb.id, 'expense.discarded');
    expect(event?.payload).toMatchObject({ id: e.id, previous_status: 'pending', reason: 'logged twice' });
  });

  it('lets the driver void a confirmed expense only during the same call', async () => {
    const { sb, tommy } = await fleet();
    const e = await created(tommy, { category: 'toll', amount: '12' });
    await agentWrite(ctx, tommy, 'POST', '/expenses/confirm', 'confirm_records', { ids: [e.id] });
    const sameCall = await agentWrite(ctx, tommy, 'POST', `/expenses/${e.id}/discard`, 'discard_expense', {});
    expect(sameCall.json<DiscardResponse>().previous_status).toBe('confirmed');

    const f = await created(tommy, { category: 'toll', amount: '13' });
    await agentWrite(ctx, tommy, 'POST', '/expenses/confirm', 'confirm_records', { ids: [f.id] });
    const laterCall = await actor(ctx, sb.id, 'tommy');
    const res = await agentWrite(ctx, laterCall, 'POST', `/expenses/${f.id}/discard`, 'discard_expense', {});
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('confirmed_record');
  });

  it('lets an owner void a confirmed expense any time', async () => {
    const { sb, tommy, ray } = await fleet();
    const e = await created(tommy, { category: 'toll', amount: '12' });
    await agentWrite(ctx, tommy, 'POST', '/expenses/confirm', 'confirm_records', { ids: [e.id] });
    const res = await agentWrite(ctx, ray, 'POST', `/expenses/${e.id}/discard`, 'discard_expense', {});
    expect(res.statusCode).toBe(200);
    const [event] = await eventsOfType(ctx, sb.id, 'expense.discarded');
    expect(event?.payload).toMatchObject({ previous_status: 'confirmed', logged_by: tommy.personId });
  });

  it("stops a driver voiding another driver's expense", async () => {
    const { tommy, luis } = await fleet();
    const e = await created(tommy, { category: 'toll', amount: '12' });
    expect((await agentWrite(ctx, luis, 'POST', `/expenses/${e.id}/discard`, 'discard_expense', {})).statusCode).toBe(403);
  });
});
