import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ResolveCallerResponse } from '../src/schemas.js';
import {
  closeContext,
  expireSandbox,
  first,
  fakePhone,
  makeContext,
  newSandbox,
  resolve,
  type TestContext,
} from './helpers.js';

type Resolved = Extract<ResolveCallerResponse, { status: 'resolved' }>;

let ctx: TestContext;
beforeAll(() => {
  ctx = makeContext();
});
afterAll(async () => {
  await closeContext(ctx);
});

async function register(sandboxId: string, seedKey: string): Promise<string> {
  const phone = fakePhone();
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/sandboxes/${sandboxId}/phones`,
    payload: { phone, seed_key: seedKey },
  });
  expect(res.statusCode).toBe(200);
  return phone;
}

async function resolved(payload: Record<string, unknown>): Promise<Resolved> {
  const res = await resolve(ctx, payload);
  expect(res.statusCode).toBe(200);
  const body = res.json<ResolveCallerResponse>();
  if (body.status !== 'resolved') throw new Error(`expected resolved, got ${body.status}`);
  return body;
}

describe('POST /callers/resolve: auth', () => {
  it('requires the service token', async () => {
    const none = await ctx.app.inject({ method: 'POST', url: '/callers/resolve', payload: { demo_code: '1234' } });
    expect(none.statusCode).toBe(401);
    const wrong = await ctx.app.inject({
      method: 'POST',
      url: '/callers/resolve',
      headers: { authorization: 'Bearer not-the-token' },
      payload: { demo_code: '1234' },
    });
    expect(wrong.statusCode).toBe(401);
  });

  it('rejects a body with both or neither of phone and demo code', async () => {
    expect((await resolve(ctx, {})).statusCode).toBe(400);
    expect((await resolve(ctx, { phone: fakePhone(), demo_code: '1234' })).statusCode).toBe(400);
  });
});

describe('POST /callers/resolve: owner-operator', () => {
  it('resolves a registered phone to Mike with his truck and active loads', async () => {
    const sb = await newSandbox(ctx, 'owner_operator', 'phone');
    const phone = await register(sb.id, 'mike');
    // Caller ID formatting differs by carrier; any format of the same number resolves.
    const body = await resolved({ phone: `(${phone.slice(2, 5)}) ${phone.slice(5, 8)}-${phone.slice(8)}` });

    expect(body.sandbox).toEqual({ id: sb.id, scenario: 'owner_operator', access_mode: 'phone' });
    expect(body.business.name).toBe('Kestrel Line Freight LLC');
    expect(body.person).toMatchObject({ seed_key: 'mike', first_name: 'Mike', is_owner: true, is_driver: true });
    expect(body.trucks.map((t) => t.unit_number)).toEqual(['1']);
    // 4390 is delivered and invoiced, so it is not active.
    expect(body.active_loads.map((l) => [l.load_number, l.status])).toEqual([
      ['4471', 'in_transit'],
      ['4502', 'booked'],
    ]);
    const l4471 = first(body.active_loads);
    expect(l4471.payer_name).toBe('Bluegate Freight Partners');
    expect(l4471.needs_scale_ticket).toBe(false);
    expect(l4471.stops.map((s) => [s.type, s.facility_name])).toEqual([
      ['pickup', 'Harlan Point Cold Storage'],
      ['delivery', 'Southmere Distribution'],
    ]);
  });

  it('resolves a demo code straight to Mike', async () => {
    const sb = await newSandbox(ctx, 'owner_operator', 'code');
    const body = await resolved({ demo_code: sb.demo_code });
    expect(body.person.seed_key).toBe('mike');
  });
});

describe('POST /callers/resolve: small fleet', () => {
  it('resolves each registered phone to the right person', async () => {
    const sb = await newSandbox(ctx, 'small_fleet', 'phone');
    const rayPhone = await register(sb.id, 'ray');
    const tommyPhone = await register(sb.id, 'tommy');

    const ray = await resolved({ phone: rayPhone });
    expect(ray.person).toMatchObject({ seed_key: 'ray', is_owner: true, is_driver: true });
    expect(ray.trucks.map((t) => t.unit_number)).toEqual(['1', '2', '3']);

    const tommy = await resolved({ phone: tommyPhone });
    expect(tommy.person).toMatchObject({ seed_key: 'tommy', first_name: 'Tommy', is_owner: false, is_driver: true });
    expect(tommy.trucks).toEqual([expect.objectContaining({ unit_number: '2', assigned_seed_key: 'tommy' })]);
    // 7712 is delivered but still needs a scale ticket; 7705 already has one.
    expect(tommy.active_loads.map((l) => [l.load_number, l.needs_scale_ticket])).toEqual([['7712', true]]);
    expect(first(tommy.active_loads).payer_name).toBe('Millbrook Grain Co.');
  });

  it('asks who is calling when a demo code has no active person', async () => {
    const sb = await newSandbox(ctx, 'small_fleet', 'code');
    const res = await resolve(ctx, { demo_code: sb.demo_code });
    const body = res.json<ResolveCallerResponse>();
    expect(body.status).toBe('choose_person');
    if (body.status !== 'choose_person') return;
    expect(body.people.map((p) => p.seed_key)).toEqual(['ray', 'luis', 'tommy']);
  });

  it('resolves a demo code with an explicit person, or the active role', async () => {
    const sb = await newSandbox(ctx, 'small_fleet', 'code');
    expect((await resolved({ demo_code: sb.demo_code, seed_key: 'tommy' })).person.seed_key).toBe('tommy');

    await ctx.app.inject({ method: 'POST', url: `/sandboxes/${sb.id}/role`, payload: { seed_key: 'ray' } });
    expect((await resolved({ demo_code: sb.demo_code })).person.seed_key).toBe('ray');
  });
});

describe('POST /callers/resolve: not found', () => {
  it('does not resolve unknown phones or codes', async () => {
    expect((await resolve(ctx, { phone: fakePhone() })).json()).toEqual({ status: 'not_found' });
    expect((await resolve(ctx, { phone: 'garbage' })).json()).toEqual({ status: 'not_found' });
  });

  it('does not resolve an expired sandbox by phone or code', async () => {
    const sb = await newSandbox(ctx, 'small_fleet', 'phone');
    const phone = await register(sb.id, 'luis');
    await expireSandbox(ctx, sb.id);
    expect((await resolve(ctx, { phone })).json()).toEqual({ status: 'not_found' });
    expect((await resolve(ctx, { demo_code: sb.demo_code, seed_key: 'luis' })).json()).toEqual({ status: 'not_found' });
  });

  it('resolves a phone to the newest sandbox after it moves', async () => {
    const first = await newSandbox(ctx, 'owner_operator', 'phone');
    const second = await newSandbox(ctx, 'small_fleet', 'phone');
    const phone = await register(first.id, 'mike');
    await ctx.app.inject({ method: 'POST', url: `/sandboxes/${second.id}/phones`, payload: { phone, seed_key: 'ray' } });
    const body = await resolved({ phone });
    expect(body.sandbox.id).toBe(second.id);
    expect(body.person.seed_key).toBe('ray');
  });

  it('still resolves after a reset', async () => {
    const sb = await newSandbox(ctx, 'small_fleet', 'phone');
    const phone = await register(sb.id, 'tommy');
    await ctx.app.inject({ method: 'POST', url: `/sandboxes/${sb.id}/reset` });
    expect((await resolved({ phone })).person.seed_key).toBe('tommy');
  });
});
