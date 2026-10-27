import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SandboxView } from '../src/schemas.js';
import { closeContext, expireSandbox, fakePhone, first, makeContext, newSandbox, type TestContext } from './helpers.js';

let ctx: TestContext;
beforeAll(() => {
  ctx = makeContext();
});
afterAll(async () => {
  await closeContext(ctx);
});

async function count(table: string, sandboxId: string): Promise<number> {
  const sql: Record<string, string> = {
    loads: 'select count(*)::int as n from loads where sandbox_id = $1',
    expenses: 'select count(*)::int as n from expenses where sandbox_id = $1',
    people: 'select count(*)::int as n from people where sandbox_id = $1',
    trucks: 'select count(*)::int as n from trucks where sandbox_id = $1',
    scale_tickets: 'select count(*)::int as n from scale_tickets where sandbox_id = $1',
    events: 'select count(*)::int as n from events where sandbox_id = $1',
  };
  const query = sql[table];
  if (!query) throw new Error(`no count query for ${table}`);
  const { rows } = await ctx.pool.query<{ n: number }>(query, [sandboxId]);
  return rows[0]?.n ?? 0;
}

describe('POST /sandboxes', () => {
  it('creates an owner-operator sandbox with Mike as the default person', async () => {
    const sb = await newSandbox(ctx, 'owner_operator');
    expect(sb.demo_code).toMatch(/^\d{4}$/);
    expect(sb.business).toEqual({ name: 'Kestrel Line Freight LLC', demo_dot: 'DEMO-0001' });
    expect(sb.active_person_seed_key).toBe('mike');
    expect(sb.people).toEqual([
      { seed_key: 'mike', full_name: 'Mike Delgren', is_owner: true, is_driver: true, truck_unit: '1' },
    ]);
    expect(await count('loads', sb.id)).toBe(3);
    expect(await count('expenses', sb.id)).toBe(2);
    const hours = (Date.parse(sb.expires_at) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThanOrEqual(24);
  });

  it('creates a small-fleet sandbox with three people, three trucks and no default person', async () => {
    const sb = await newSandbox(ctx, 'small_fleet', 'phone');
    expect(sb.access_mode).toBe('phone');
    expect(sb.business.name).toBe('Cedar Fork Hauling LLC');
    expect(sb.active_person_seed_key).toBeNull();
    expect(sb.people.map((p) => [p.seed_key, p.is_owner, p.truck_unit])).toEqual([
      ['ray', true, '1'],
      ['luis', false, '3'],
      ['tommy', false, '2'],
    ]);
    expect(await count('trucks', sb.id)).toBe(3);
    expect(await count('loads', sb.id)).toBe(4);
    expect(await count('scale_tickets', sb.id)).toBe(2);
  });

  it('gives every sandbox its own demo code', async () => {
    const a = await newSandbox(ctx, 'owner_operator');
    const b = await newSandbox(ctx, 'owner_operator');
    expect(a.demo_code).not.toBe(b.demo_code);
  });

  it('seeds load 4471 pickup at 8:00 AM today, Chicago time', async () => {
    const sb = await newSandbox(ctx, 'owner_operator');
    const { rows } = await ctx.pool.query<{ appointment_at: Date }>(
      `select s.appointment_at from stops s join loads l on l.id = s.load_id and l.sandbox_id = s.sandbox_id
        where s.sandbox_id = $1 and l.load_number = '4471' and s.type = 'pickup'`,
      [sb.id],
    );
    const fmt = (d: Date) =>
      new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', dateStyle: 'short', timeStyle: 'short', hourCycle: 'h23' }).format(d);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', dateStyle: 'short' }).format(new Date());
    expect(fmt(first(rows).appointment_at)).toBe(`${today}, 08:00`);
  });

  it('removes expired visitor sandboxes when a new one is created', async () => {
    const old = await newSandbox(ctx, 'owner_operator');
    await expireSandbox(ctx, old.id);
    await newSandbox(ctx, 'owner_operator');
    const { rowCount } = await ctx.pool.query('select 1 from sandboxes where id = $1', [old.id]);
    expect(rowCount).toBe(0);
  });

  it('rejects an unknown scenario', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/sandboxes',
      payload: { scenario: 'mega_fleet', access_mode: 'code' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_request');
  });
});

describe('POST /sandboxes/:id/phones', () => {
  it('registers a phone to a seeded person and only returns the last four digits', async () => {
    const sb = await newSandbox(ctx, 'small_fleet', 'phone');
    const phone = fakePhone();
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/sandboxes/${sb.id}/phones`,
      payload: { phone, seed_key: 'tommy' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ seed_key: 'tommy', phone_last4: phone.slice(-4), moved_from_other_sandbox: false });
    expect(res.body).not.toContain(phone);
  });

  it('moves a phone out of an older sandbox instead of refusing', async () => {
    const phone = fakePhone();
    const first = await newSandbox(ctx, 'small_fleet', 'phone');
    const second = await newSandbox(ctx, 'owner_operator', 'phone');
    await ctx.app.inject({ method: 'POST', url: `/sandboxes/${first.id}/phones`, payload: { phone, seed_key: 'ray' } });
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/sandboxes/${second.id}/phones`,
      payload: { phone, seed_key: 'mike' },
    });
    expect(res.json().moved_from_other_sandbox).toBe(true);
    const { rows } = await ctx.pool.query('select sandbox_id from sandbox_phones where phone_e164 = $1', [phone]);
    expect(rows).toEqual([{ sandbox_id: second.id }]);
  });

  it('rejects an invalid phone, an unknown person, and an expired sandbox', async () => {
    const sb = await newSandbox(ctx, 'small_fleet', 'phone');
    const url = `/sandboxes/${sb.id}/phones`;
    const bad = await ctx.app.inject({ method: 'POST', url, payload: { phone: '12345', seed_key: 'ray' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('invalid_phone');

    const nobody = await ctx.app.inject({ method: 'POST', url, payload: { phone: fakePhone(), seed_key: 'mike' } });
    expect(nobody.statusCode).toBe(404);

    await expireSandbox(ctx, sb.id);
    const expired = await ctx.app.inject({ method: 'POST', url, payload: { phone: fakePhone(), seed_key: 'ray' } });
    expect(expired.statusCode).toBe(410);
  });

  it('returns 404 for a sandbox that does not exist', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/sandboxes/00000000-0000-4000-8000-000000000000/phones',
      payload: { phone: fakePhone(), seed_key: 'ray' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /sandboxes/:id/role', () => {
  it('switches the active person', async () => {
    const sb = await newSandbox(ctx, 'small_fleet');
    const res = await ctx.app.inject({ method: 'POST', url: `/sandboxes/${sb.id}/role`, payload: { seed_key: 'luis' } });
    expect(res.statusCode).toBe(200);
    expect(res.json<SandboxView>().active_person_seed_key).toBe('luis');
  });

  it('rejects a person who is not in this scenario', async () => {
    const sb = await newSandbox(ctx, 'owner_operator');
    const res = await ctx.app.inject({ method: 'POST', url: `/sandboxes/${sb.id}/role`, payload: { seed_key: 'ray' } });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /sandboxes/:id/reset', () => {
  it('restores seed data, keeps code, role and phones, and leaves other sandboxes alone', async () => {
    const sb = await newSandbox(ctx, 'small_fleet', 'phone');
    const other = await newSandbox(ctx, 'small_fleet', 'phone');
    const phone = fakePhone();
    await ctx.app.inject({ method: 'POST', url: `/sandboxes/${sb.id}/phones`, payload: { phone, seed_key: 'tommy' } });
    await ctx.app.inject({ method: 'POST', url: `/sandboxes/${sb.id}/role`, payload: { seed_key: 'tommy' } });

    // Simulate a demo: a new pending expense in both sandboxes.
    for (const id of [sb.id, other.id]) {
      await ctx.pool.query(
        `insert into expenses (sandbox_id, business_id, person_id, category, amount_cents, occurred_at)
         select p.sandbox_id, p.business_id, p.id, 'washout', 3500, now()
           from people p where p.sandbox_id = $1 and p.seed_key = 'tommy'`,
        [id],
      );
    }
    const before = await ctx.pool.query<{ id: string }>(
      "select id from people where sandbox_id = $1 and seed_key = 'tommy'",
      [sb.id],
    );

    const res = await ctx.app.inject({ method: 'POST', url: `/sandboxes/${sb.id}/reset` });
    expect(res.statusCode).toBe(200);
    const view = res.json<SandboxView>();
    expect(view.demo_code).toBe(sb.demo_code);
    expect(view.expires_at).toBe(sb.expires_at);
    expect(view.active_person_seed_key).toBe('tommy');

    expect(await count('expenses', sb.id)).toBe(5);
    expect(await count('expenses', other.id)).toBe(6);
    expect(await count('events', sb.id)).toBe(1);

    // Phone survives and points at the re-seeded Tommy (a new person id).
    const after = await ctx.pool.query<{ person_id: string; seed_key: string }>(
      `select sp.person_id, p.seed_key from sandbox_phones sp
         join people p on p.id = sp.person_id and p.sandbox_id = sp.sandbox_id
        where sp.sandbox_id = $1 and sp.phone_e164 = $2`,
      [sb.id, phone],
    );
    expect(after.rows).toHaveLength(1);
    expect(first(after.rows).seed_key).toBe('tommy');
    expect(first(after.rows).person_id).not.toBe(first(before.rows).id);
  });

  it('rejects reset of an expired sandbox', async () => {
    const sb = await newSandbox(ctx, 'owner_operator');
    await expireSandbox(ctx, sb.id);
    const res = await ctx.app.inject({ method: 'POST', url: `/sandboxes/${sb.id}/reset` });
    expect(res.statusCode).toBe(410);
  });
});
