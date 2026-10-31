import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EndCallResponse } from '../src/schemas.js';
import { withTransaction } from '../src/db.js';
import { endStaleCalls } from '../src/services/calls.js';
import {
  actor,
  agent,
  closeContext,
  eventsOfType,
  fakePhone,
  makeContext,
  newSandbox,
  resolve,
  type TestContext,
} from './helpers.js';

let ctx: TestContext;
beforeAll(() => {
  ctx = makeContext();
});
afterAll(async () => {
  await closeContext(ctx);
});

const callRow = async (sandboxId: string, callId: string) =>
  (
    await ctx.pool.query<{ access: string; ended_at: Date | null; end_reason: string | null }>(
      'select access, ended_at, end_reason from calls where sandbox_id = $1 and call_id = $2',
      [sandboxId, callId],
    )
  ).rows[0];

describe('call start via /callers/resolve', () => {
  it('records call.started for a demo-code call, once', async () => {
    const sb = await newSandbox(ctx, 'small_fleet');
    const payload = { demo_code: sb.demo_code, seed_key: 'tommy', call_id: 'call_abc' };
    expect((await resolve(ctx, payload)).json().status).toBe('resolved');
    await resolve(ctx, payload);
    expect(await callRow(sb.id, 'call_abc')).toMatchObject({ access: 'demo_code', ended_at: null });
    const events = await eventsOfType(ctx, sb.id, 'call.started');
    expect(events).toEqual([
      { call_id: 'call_abc', payload: { call_id: 'call_abc', seed_key: 'tommy', full_name: 'Tommy Reece', access: 'demo_code' } },
    ]);
  });

  it('records a phone call without the phone number', async () => {
    const sb = await newSandbox(ctx, 'small_fleet', 'phone');
    const phone = fakePhone();
    await ctx.app.inject({ method: 'POST', url: `/sandboxes/${sb.id}/phones`, payload: { phone, seed_key: 'ray' } });
    await resolve(ctx, { phone, call_id: 'call_phone' });
    expect((await callRow(sb.id, 'call_phone'))?.access).toBe('phone');
    const [event] = await eventsOfType(ctx, sb.id, 'call.started');
    expect(JSON.stringify(event)).not.toContain(phone.slice(2));
  });

  it('records nothing without a call_id or when the caller is not resolved', async () => {
    const sb = await newSandbox(ctx, 'small_fleet');
    await resolve(ctx, { demo_code: sb.demo_code, seed_key: 'tommy' });
    await resolve(ctx, { demo_code: sb.demo_code, call_id: 'call_choose' }); // small fleet, no role: choose_person
    expect(await eventsOfType(ctx, sb.id, 'call.started')).toEqual([]);
    expect((await resolve(ctx, { demo_code: sb.demo_code, call_id: 'bad id!' })).statusCode).toBe(400);
  });
});

describe('POST /calls/:call_id/end', () => {
  async function started() {
    const sb = await newSandbox(ctx, 'small_fleet');
    await resolve(ctx, { demo_code: sb.demo_code, seed_key: 'tommy', call_id: 'call_1' });
    return { sb, tommy: await actor(ctx, sb.id, 'tommy', 'call_1'), ray: await actor(ctx, sb.id, 'ray') };
  }

  it('ends the call once, keeping the first reason', async () => {
    const { sb, tommy } = await started();
    const res = await agent(ctx, tommy, 'POST', '/calls/call_1/end', { reason: 'completed' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<EndCallResponse>()).toMatchObject({ call_id: 'call_1', end_reason: 'completed' });
    expect(res.json<EndCallResponse>().duration_seconds).toBeGreaterThanOrEqual(0);

    const again = await agent(ctx, tommy, 'POST', '/calls/call_1/end', { reason: 'caller_hung_up' });
    expect(again.json()).toEqual(res.json());
    expect(await eventsOfType(ctx, sb.id, 'call.ended')).toHaveLength(1);
  });

  it("404s another person's call or an unknown one, and rejects a timeout reason from the agent", async () => {
    const { tommy, ray } = await started();
    expect((await agent(ctx, ray, 'POST', '/calls/call_1/end', { reason: 'completed' })).statusCode).toBe(404);
    expect((await agent(ctx, tommy, 'POST', '/calls/call_nope/end', { reason: 'completed' })).statusCode).toBe(404);
    expect((await agent(ctx, tommy, 'POST', '/calls/call_1/end', { reason: 'timeout' })).statusCode).toBe(400);
    const noToken = await ctx.app.inject({ method: 'POST', url: '/calls/call_1/end', payload: { reason: 'completed' } });
    expect(noToken.statusCode).toBe(401);
  });

  it('ends calls that never report their end after the timeout', async () => {
    const { sb } = await started();
    await resolve(ctx, { demo_code: sb.demo_code, seed_key: 'ray', call_id: 'call_fresh' });
    await ctx.pool.query("update calls set started_at = now() - interval '31 minutes' where sandbox_id = $1 and call_id = 'call_1'", [
      sb.id,
    ]);
    const ended = await withTransaction(ctx.pool, (db) => endStaleCalls(db, 30));
    expect(ended).toBeGreaterThanOrEqual(1);
    expect(await callRow(sb.id, 'call_1')).toMatchObject({ end_reason: 'timeout' });
    expect((await callRow(sb.id, 'call_fresh'))?.ended_at).toBeNull();
    const [event] = await eventsOfType(ctx, sb.id, 'call.ended');
    expect(event).toMatchObject({ call_id: 'call_1', payload: { end_reason: 'timeout' } });
  });

  it('is cleared by a sandbox reset', async () => {
    const { sb } = await started();
    await ctx.app.inject({ method: 'POST', url: `/sandboxes/${sb.id}/reset` });
    expect(await callRow(sb.id, 'call_1')).toBeUndefined();
  });
});
