import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExpenseResponse } from '../src/ledger-schemas.js';
import {
  actor,
  agent,
  closeContext,
  eventsOfType,
  loadId,
  makeContext,
  newSandbox,
  type TestContext,
} from './helpers.js';

let ctx: TestContext;
beforeAll(() => {
  ctx = makeContext();
});
afterAll(async () => {
  await closeContext(ctx);
});

const toll = { category: 'toll', amount: '12.50' };

async function setup() {
  const sb = await newSandbox(ctx, 'small_fleet');
  return { sb, tommy: await actor(ctx, sb.id, 'tommy') };
}

async function count(sql: string, sandboxId: string): Promise<number> {
  const { rows } = await ctx.pool.query<{ n: number }>(sql, [sandboxId]);
  return rows[0]?.n ?? 0;
}
const expenseCount = (id: string) => count("select count(*)::int as n from expenses where sandbox_id = $1 and source = 'voice'", id);

describe('idempotency', () => {
  it('replays the same request without writing twice', async () => {
    const { sb, tommy } = await setup();
    const body = { ...toll, call_id: tommy.callId, idempotency_key: `${tommy.callId}:3:0:log_expense` };
    const first = await agent(ctx, tommy, 'POST', '/expenses', body);
    const second = await agent(ctx, tommy, 'POST', '/expenses', body);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.json<ExpenseResponse>()).toEqual(first.json<ExpenseResponse>());
    expect(await expenseCount(sb.id)).toBe(1);
    expect(await eventsOfType(ctx, sb.id, 'expense.created')).toHaveLength(1);
  });

  it('treats several calls to one tool in the same turn as separate writes', async () => {
    const { sb, tommy } = await setup();
    for (const [i, amount] of ['12', '13', '14'].entries()) {
      const res = await agent(ctx, tommy, 'POST', '/expenses', {
        category: 'toll',
        amount,
        call_id: tommy.callId,
        idempotency_key: `${tommy.callId}:5:${i}:log_expense`,
      });
      expect(res.statusCode).toBe(201);
    }
    expect(await expenseCount(sb.id)).toBe(3);
  });

  it('rejects the same key with a different request', async () => {
    const { sb, tommy } = await setup();
    const key = `${tommy.callId}:4:0:log_expense`;
    await agent(ctx, tommy, 'POST', '/expenses', { ...toll, call_id: tommy.callId, idempotency_key: key });
    const res = await agent(ctx, tommy, 'POST', '/expenses', {
      ...toll,
      amount: '99',
      call_id: tommy.callId,
      idempotency_key: key,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('idempotency_conflict');
    expect(await expenseCount(sb.id)).toBe(1);
  });

  it('rejects the same key on a different route', async () => {
    const { tommy } = await setup();
    const key = `${tommy.callId}:4:0:log_expense`;
    const res = await agent(ctx, tommy, 'POST', '/expenses', { ...toll, call_id: tommy.callId, idempotency_key: key });
    const id = res.json<ExpenseResponse>().id;
    const other = await agent(ctx, tommy, 'PATCH', `/expenses/${id}`, { amount: '1', call_id: tommy.callId, idempotency_key: key });
    expect(other.statusCode).toBe(409);
  });

  it('scopes keys per sandbox', async () => {
    const a = await setup();
    const b = await setup();
    const key = 'call_shared:1:0:log_expense';
    const ra = await agent(ctx, a.tommy, 'POST', '/expenses', { ...toll, call_id: 'call_shared', idempotency_key: key });
    const rb = await agent(ctx, b.tommy, 'POST', '/expenses', { ...toll, call_id: 'call_shared', idempotency_key: key });
    expect(ra.statusCode).toBe(201);
    expect(rb.statusCode).toBe(201);
    expect(rb.headers['idempotent-replayed']).toBeUndefined();
    expect(ra.json<ExpenseResponse>().id).not.toBe(rb.json<ExpenseResponse>().id);
  });

  it('does not keep the key when the write fails, so a retry can succeed', async () => {
    const { sb, tommy } = await setup();
    const key = `${tommy.callId}:6:0:log_expense`;
    const bad = await agent(ctx, tommy, 'POST', '/expenses', { ...toll, amount: '12.505', call_id: tommy.callId, idempotency_key: key });
    expect(bad.statusCode).toBe(400);
    const forbidden = await agent(ctx, tommy, 'POST', '/expenses', {
      ...toll,
      load_id: await loadId(ctx, sb.id, '7710'),
      call_id: tommy.callId,
      idempotency_key: key,
    });
    expect(forbidden.statusCode).toBe(403);
    expect(await count('select count(*)::int as n from idempotency_keys where sandbox_id = $1', sb.id)).toBe(0);

    const good = await agent(ctx, tommy, 'POST', '/expenses', { ...toll, call_id: tommy.callId, idempotency_key: key });
    expect(good.statusCode).toBe(201);
  });

  it('writes once when the same request arrives concurrently', async () => {
    const { sb, tommy } = await setup();
    const body = { ...toll, call_id: tommy.callId, idempotency_key: `${tommy.callId}:7:0:log_expense` };
    const results = await Promise.all(Array.from({ length: 5 }, () => agent(ctx, tommy, 'POST', '/expenses', body)));
    expect(results.map((r) => r.statusCode)).toEqual([201, 201, 201, 201, 201]);
    expect(new Set(results.map((r) => r.json<ExpenseResponse>().id)).size).toBe(1);
    expect(await expenseCount(sb.id)).toBe(1);
  });

  it('is cleared by a sandbox reset', async () => {
    const { sb, tommy } = await setup();
    await agent(ctx, tommy, 'POST', '/expenses', { ...toll, call_id: tommy.callId, idempotency_key: 'k:1:0:log_expense' });
    await ctx.app.inject({ method: 'POST', url: `/sandboxes/${sb.id}/reset` });
    expect(await count('select count(*)::int as n from idempotency_keys where sandbox_id = $1', sb.id)).toBe(0);
  });
});
