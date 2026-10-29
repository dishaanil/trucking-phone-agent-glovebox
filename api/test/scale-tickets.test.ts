import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConfirmResponse, TicketResponse } from '../src/ledger-schemas.js';
import {
  actor,
  agentWrite,
  closeContext,
  eventsOfType,
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

async function fleet() {
  const sb = await newSandbox(ctx, 'small_fleet');
  return {
    sb,
    ray: await actor(ctx, sb.id, 'ray'),
    tommy: await actor(ctx, sb.id, 'tommy'),
    luis: await actor(ctx, sb.id, 'luis'),
    load7712: await loadId(ctx, sb.id, '7712'),
    load7705: await loadId(ctx, sb.id, '7705'),
  };
}

const logTicket = (a: Actor, load: string, payload: Record<string, unknown>) =>
  agentWrite(ctx, a, 'POST', `/loads/${load}/scale-tickets`, 'log_scale_ticket', payload);

async function created(a: Actor, load: string, payload: Record<string, unknown>): Promise<TicketResponse> {
  const res = await logTicket(a, load, payload);
  expect(res.statusCode, res.body).toBe(201);
  return res.json<TicketResponse>();
}

describe('POST /loads/:id/scale-tickets', () => {
  it('creates a pending ticket with a readback', async () => {
    const { sb, tommy, load7712 } = await fleet();
    const t = await created(tommy, load7712, { net_weight_lbs: '52,800', location: 'Paducah, KY' });
    expect(t).toMatchObject({
      status: 'pending',
      load_number: '7712',
      net_weight_lbs: 52_800,
      weight_display: '52,800 pounds',
      readback: 'Scale ticket for load 7712, 52,800 pounds net.',
      needs_confirmation: false,
    });
    expect(await eventsOfType(ctx, sb.id, 'ticket.created')).toHaveLength(1);
  });

  it("returns 409 with the existing ticket's readback instead of a second ticket", async () => {
    const { tommy, load7712, load7705 } = await fleet();
    const first = await created(tommy, load7712, { net_weight_lbs: 52_800 });
    const res = await logTicket(tommy, load7712, { net_weight_lbs: 52_080 });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: 'ticket_exists',
      existing: { id: first.id, status: 'pending', readback: 'Scale ticket for load 7712, 52,800 pounds net.' },
    });
    expect(res.json().message).toMatch(/already has a scale ticket/);

    // 7705 was seeded with a confirmed ticket.
    expect((await logTicket(tommy, load7705, { net_weight_lbs: 50_000 })).json().existing.status).toBe('confirmed');
  });

  it('allows a new ticket once the old one is no longer active', async () => {
    const { tommy, load7712 } = await fleet();
    const t = await created(tommy, load7712, { net_weight_lbs: 52_800 });
    await ctx.pool.query("update scale_tickets set status = 'discarded' where id = $1", [t.id]);
    expect((await logTicket(tommy, load7712, { net_weight_lbs: 52_080 })).statusCode).toBe(201);
  });

  it('flags implausible weights and rejects impossible ones', async () => {
    const { tommy, load7712 } = await fleet();
    const light = await created(tommy, load7712, { net_weight_lbs: 15_000 });
    expect(light.confirmation_reasons).toEqual(['weight_out_of_range']);

    const other = await fleet();
    expect((await logTicket(other.tommy, other.load7712, { net_weight_lbs: 120_000 })).statusCode).toBe(400);
    expect((await logTicket(other.tommy, other.load7712, { net_weight_lbs: '52800.5' })).statusCode).toBe(400);
  });

  it("stops a driver logging a ticket on another driver's load, but not the owner", async () => {
    const { luis, ray, load7712 } = await fleet();
    expect((await logTicket(luis, load7712, { net_weight_lbs: 52_800 })).statusCode).toBe(403);
    expect((await logTicket(ray, load7712, { net_weight_lbs: 52_800 })).statusCode).toBe(201);
  });

  it('404s an unknown load', async () => {
    const { tommy } = await fleet();
    const res = await logTicket(tommy, '00000000-0000-4000-8000-000000000000', { net_weight_lbs: 52_800 });
    expect(res.statusCode).toBe(404);
  });
});

describe('PATCH /scale-tickets/:id', () => {
  it('corrects the same ticket and logs old and new values', async () => {
    const { sb, tommy, load7712 } = await fleet();
    const t = await created(tommy, load7712, { net_weight_lbs: 52_800 });
    const res = await agentWrite(ctx, tommy, 'PATCH', `/scale-tickets/${t.id}`, 'correct_scale_ticket', {
      net_weight_lbs: '52,080',
    });
    expect(res.json<TicketResponse>()).toMatchObject({
      id: t.id,
      net_weight_lbs: 52_080,
      readback: 'Scale ticket for load 7712, 52,080 pounds net.',
    });
    const { rows } = await ctx.pool.query('select count(*)::int as n from scale_tickets where load_id = $1', [load7712]);
    expect(rows[0]).toEqual({ n: 1 });
    const [event] = await eventsOfType(ctx, sb.id, 'ticket.corrected');
    expect(event?.payload).toMatchObject({ old: { net_weight_lbs: 52_800 }, new: { net_weight_lbs: 52_080 } });
  });

  it('sends a confirmed ticket back to pending', async () => {
    const { tommy, load7712 } = await fleet();
    const t = await created(tommy, load7712, { net_weight_lbs: 52_800 });
    await agentWrite(ctx, tommy, 'POST', '/scale-tickets/confirm', 'confirm_records', { ids: [t.id] });
    const res = await agentWrite(ctx, tommy, 'PATCH', `/scale-tickets/${t.id}`, 'correct_scale_ticket', {
      ticket_number: 'MB-20500',
    });
    expect(res.json<TicketResponse>()).toMatchObject({ status: 'pending', ticket_number: 'MB-20500' });
  });

  it("stops a driver correcting another driver's ticket", async () => {
    const { tommy, luis, load7712 } = await fleet();
    const t = await created(tommy, load7712, { net_weight_lbs: 52_800 });
    const res = await agentWrite(ctx, luis, 'PATCH', `/scale-tickets/${t.id}`, 'correct_scale_ticket', { net_weight_lbs: 1 });
    expect(res.statusCode).toBe(403);
  });
});

describe('POST /scale-tickets/confirm', () => {
  it('returns a result per id', async () => {
    const { sb, tommy, luis, load7712 } = await fleet();
    const t = await created(tommy, load7712, { net_weight_lbs: 52_800 });
    const { rows } = await ctx.pool.query<{ id: string }>(
      `select st.id from scale_tickets st join loads l on l.id = st.load_id
        where st.sandbox_id = $1 and l.load_number = '7710'`,
      [sb.id],
    );
    const luisSeeded = rows[0]?.id ?? '';

    const res = await agentWrite(ctx, tommy, 'POST', '/scale-tickets/confirm', 'confirm_records', { ids: [t.id, luisSeeded] });
    expect(res.json<ConfirmResponse>()).toEqual({
      results: [
        { id: t.id, result: 'confirmed' },
        { id: luisSeeded, result: 'forbidden' },
      ],
      confirmed_count: 1,
    });
    const again = await agentWrite(ctx, luis, 'POST', '/scale-tickets/confirm', 'confirm_records', { ids: [luisSeeded] });
    expect(again.json<ConfirmResponse>().results).toEqual([{ id: luisSeeded, result: 'already_confirmed' }]);
  });
});
