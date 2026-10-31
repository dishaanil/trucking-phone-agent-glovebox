import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeContext, first, makeContext, type TestContext } from './helpers.js';

let ctx: TestContext;
beforeAll(() => {
  ctx = makeContext();
});
afterAll(async () => {
  await closeContext(ctx);
});

// "Now" values in America/Chicago, with the Monday 00:00 that starts their week.
const CASES = [
  { label: 'Monday 00:30', now: '2026-10-26T00:30:00-05:00', weekStart: '2026-10-26T00:00:00-05:00' },
  { label: 'Monday 00:05 (CST)', now: '2026-12-07T00:05:00-06:00', weekStart: '2026-12-07T00:00:00-06:00' },
  { label: 'Wednesday 14:00', now: '2026-10-28T14:00:00-05:00', weekStart: '2026-10-26T00:00:00-05:00' },
  { label: 'Sunday 23:30 (across DST end)', now: '2026-11-01T23:30:00-06:00', weekStart: '2026-10-26T00:00:00-05:00' },
];

/** Run a seed at a fixed "now" inside a transaction that is always rolled back. */
async function withSeed<T>(
  scenario: 'owner_operator' | 'small_fleet',
  now: string,
  fn: (client: pg.PoolClient, sandboxId: string) => Promise<T>,
): Promise<T> {
  const client = await ctx.pool.connect();
  try {
    await client.query('begin');
    const sandboxId = randomUUID();
    await client.query('insert into sandboxes (id, scenario, access_mode, is_recording) values ($1, $2, $3, true)', [
      sandboxId,
      scenario,
      'code',
    ]);
    const seedSql =
      scenario === 'small_fleet' ? 'select seed_small_fleet($1, $2)' : 'select seed_owner_operator($1, $2)';
    await client.query(seedSql, [sandboxId, now]);
    return await fn(client, sandboxId);
  } finally {
    await client.query('rollback');
    client.release();
  }
}

describe('seed_week_start and seed_this_week', () => {
  it.each(CASES)('starts the week on Monday 00:00 Chicago time ($label)', async ({ now, weekStart }) => {
    const { rows } = await ctx.pool.query<{ start: Date }>(
      "select seed_week_start($1, 'America/Chicago') as start",
      [now],
    );
    expect(first(rows).start.toISOString()).toBe(new Date(weekStart).toISOString());
  });

  it.each(CASES)('stays between the week start and now, in order ($label)', async ({ now, weekStart }) => {
    const { rows } = await ctx.pool.query<{ t: Date }>(
      `select seed_this_week($1, 'America/Chicago', f, ago) as t
         from (values (0.05, interval '3 days'), (0.5, interval '1 day'), (0.97, interval '1 hour')) v(f, ago)`,
      [now],
    );
    const times = rows.map((r) => r.t.getTime());
    for (const t of times) {
      expect(t).toBeGreaterThanOrEqual(Date.parse(weekStart));
      expect(t).toBeLessThanOrEqual(Date.parse(now));
    }
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });
});

describe('small fleet seed: everything happens this week', () => {
  it.each(CASES)('$label', async ({ now, weekStart }) => {
    await withSeed('small_fleet', now, async (client, sandboxId) => {
      const { rows } = await client.query<{ what: string; t: Date }>(
        `select 'stop ' || l.load_number || ' ' || s.type || ' arrived' as what, s.arrived_at as t
           from stops s join loads l on l.id = s.load_id and l.sandbox_id = s.sandbox_id where s.sandbox_id = $1
         union all
         select 'stop ' || l.load_number || ' ' || s.type || ' departed', s.departed_at
           from stops s join loads l on l.id = s.load_id and l.sandbox_id = s.sandbox_id where s.sandbox_id = $1
         union all
         select 'load ' || load_number || ' invoiced', invoiced_at from loads where sandbox_id = $1 and invoiced_at is not null
         union all
         select 'load ' || load_number || ' paid', paid_at from loads where sandbox_id = $1 and paid_at is not null
         union all
         select 'expense ' || category || ' ' || coalesce(state, ''), occurred_at from expenses where sandbox_id = $1
         union all
         select 'ticket ' || ticket_number, created_at from scale_tickets where sandbox_id = $1`,
        [sandboxId],
      );
      // 16 stop times, 2 invoiced, 2 paid, 5 expenses, 2 tickets.
      expect(rows.length).toBe(27);
      for (const { what, t } of rows) {
        expect(t.getTime(), `${what} before week start`).toBeGreaterThanOrEqual(Date.parse(weekStart));
        expect(t.getTime(), `${what} after now`).toBeLessThanOrEqual(Date.parse(now));
      }

      // Each load's events happen in a sensible order.
      const order = await client.query<{ load_number: string; ok: boolean }>(
        `select l.load_number,
                p.arrived_at <= p.departed_at and p.departed_at <= d.arrived_at and d.arrived_at <= d.departed_at
                and (l.invoiced_at is null or d.departed_at <= l.invoiced_at)
                and (l.paid_at is null or l.invoiced_at <= l.paid_at) as ok
           from loads l
           join stops p on p.load_id = l.id and p.sandbox_id = l.sandbox_id and p.type = 'pickup'
           join stops d on d.load_id = l.id and d.sandbox_id = l.sandbox_id and d.type = 'delivery'
          where l.sandbox_id = $1`,
        [sandboxId],
      );
      expect(order.rows.filter((r) => !r.ok).map((r) => r.load_number)).toEqual([]);
    });
  });
});

describe('owner-operator seed', () => {
  it.each(CASES)('puts 4390 last week and the 4471 expenses this week ($label)', async ({ now, weekStart }) => {
    await withSeed('owner_operator', now, async (client, sandboxId) => {
      const last = await client.query<{ t: Date }>(
        `select unnest(array[s.arrived_at, s.departed_at, l.invoiced_at]) as t
           from loads l join stops s on s.load_id = l.id and s.sandbox_id = l.sandbox_id
          where l.sandbox_id = $1 and l.load_number = '4390'`,
        [sandboxId],
      );
      expect(last.rows).toHaveLength(6);
      for (const { t } of last.rows) expect(t.getTime()).toBeLessThan(Date.parse(weekStart));

      const expenses = await client.query<{ t: Date }>(
        'select occurred_at as t from expenses where sandbox_id = $1',
        [sandboxId],
      );
      expect(expenses.rows).toHaveLength(2);
      for (const { t } of expenses.rows) {
        expect(t.getTime()).toBeGreaterThanOrEqual(Date.parse(weekStart));
        expect(t.getTime()).toBeLessThanOrEqual(Date.parse(now));
      }
    });
  });
});

describe('both seeds: stops and timezones', () => {
  const scenarios = ['owner_operator', 'small_fleet'] as const;
  const WEDNESDAY = '2026-10-28T14:00:00-05:00';

  it.each(scenarios)('sets a delivery departure on every delivered load (%s)', async (scenario) => {
    await withSeed(scenario, WEDNESDAY, async (client, sandboxId) => {
      const { rows } = await client.query<{ load_number: string }>(
        `select l.load_number from loads l
           join stops d on d.load_id = l.id and d.sandbox_id = l.sandbox_id and d.type = 'delivery'
          where l.sandbox_id = $1 and l.status in ('delivered', 'invoiced', 'paid') and d.departed_at is null`,
        [sandboxId],
      );
      expect(rows).toEqual([]);
    });
  });

  it.each(scenarios)('gives the business and every stop a timezone (%s)', async (scenario) => {
    await withSeed(scenario, WEDNESDAY, async (client, sandboxId) => {
      const stops = await client.query('select 1 from stops where sandbox_id = $1 and timezone is null', [sandboxId]);
      expect(stops.rows).toEqual([]);
      const biz = await client.query<{ timezone: string }>('select timezone from businesses where sandbox_id = $1', [
        sandboxId,
      ]);
      expect(biz.rows).toEqual([{ timezone: 'America/Chicago' }]);
    });
  });

  it('sets appointments in local facility time', async () => {
    await withSeed('owner_operator', WEDNESDAY, async (client, sandboxId) => {
      const { rows } = await client.query<{ facility_name: string; local: string }>(
        `select s.facility_name, to_char(s.appointment_at at time zone s.timezone, 'HH24:MI') as local
           from stops s join loads l on l.id = s.load_id and l.sandbox_id = s.sandbox_id
          where s.sandbox_id = $1 and l.load_number in ('4471', '4502') order by l.load_number, s.sequence`,
        [sandboxId],
      );
      // The 4471 pickup is relative to now: 14:00 minus 3.5 hours, rounded down to 10:30.
      expect(rows.map((r) => [r.facility_name, r.local])).toEqual([
        ['Harlan Point Cold Storage', '10:30'],
        ['Southmere Distribution', '14:00'],
        ['Corliss Packaging', '09:00'],
        ['Tamsin Foods Warehouse', '07:00'],
      ]);
    });
  });
});

describe('owner-operator seed: Story A pickup', () => {
  it.each(CASES)('leaves room for the Story A stop times before now ($label)', async ({ now }) => {
    await withSeed('owner_operator', now, async (client, sandboxId) => {
      const { rows } = await client.query<{ appointment_at: Date }>(
        `select s.appointment_at from stops s join loads l on l.id = s.load_id and l.sandbox_id = s.sandbox_id
          where s.sandbox_id = $1 and l.load_number = '4471' and s.type = 'pickup'`,
        [sandboxId],
      );
      const appt = first(rows).appointment_at.getTime();
      expect(appt % (15 * 60_000)).toBe(0);
      // Story A: arrive 10 minutes early, leave 3 hours 5 minutes after the appointment.
      expect(appt + (3 * 60 + 5) * 60_000).toBeLessThanOrEqual(Date.parse(now));
      expect(Date.parse(now) - appt).toBeLessThan(3.75 * 3_600_000);
    });
  });
});
