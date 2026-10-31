import type { Queryable } from '../db.js';

/** "this week" (calendar week from Monday 00:00 in the business timezone) or the last 7 days. */
export type Range = 'week' | 'last_7_days';

export interface Bounds {
  start: Date;
  end: Date;
}

/** Start and end of a range ending now. Week math runs in Postgres, which knows every timezone's DST rules. */
export async function rangeBounds(db: Queryable, timeZone: string, range: Range, now = new Date()): Promise<Bounds> {
  if (range === 'last_7_days') return { start: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000), end: now };
  const { rows } = await db.query<{ start: Date }>(
    "select date_trunc('week', $1::timestamptz at time zone $2) at time zone $2 as start",
    [now, timeZone],
  );
  const start = rows[0]?.start;
  if (!start) throw new Error('week start query returned no row');
  return { start, end: now };
}

export function spokenRange(range: Range): string {
  return range === 'week' ? 'this week' : 'in the last 7 days';
}
