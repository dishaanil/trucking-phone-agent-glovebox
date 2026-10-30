// Stop times arrive as the caller said them ("7:50", "11:05 pm") or as ISO timestamps.
// Local times resolve in the stop's timezone; the LLM never does date math.

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

export type TimeInput = { kind: 'instant'; at: Date } | { kind: 'local'; hour: number; minute: number };

/** "07:50", "7:50", "11:05 PM", "11:05pm", or an ISO timestamp with an offset. Null if unreadable. */
export function parseTimeInput(input: string): TimeInput | null {
  const text = input.trim();
  const local = /^(\d{1,2}):(\d{2})\s*(?:([ap])\.?\s*m\.?)?$/i.exec(text);
  if (local) {
    let hour = Number(local[1]);
    const minute = Number(local[2]);
    const meridiem = local[3]?.toLowerCase();
    if (minute > 59) return null;
    if (meridiem) {
      if (hour < 1 || hour > 12) return null;
      hour = (hour % 12) + (meridiem === 'p' ? 12 : 0);
    } else if (hour > 23) {
      return null;
    }
    return { kind: 'local', hour, minute };
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(text)) {
    const at = new Date(text);
    return Number.isNaN(at.getTime()) ? null : { kind: 'instant', at };
  }
  return null;
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function wallClock(at: Date, timeZone: string): WallClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute') };
}

/** Offset of `timeZone` from UTC at `at`, in ms (Chicago in summer: -5 hours). */
function offsetMs(at: Date, timeZone: string): number {
  const w = wallClock(at, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  return asUtc - Math.floor(at.getTime() / MINUTE_MS) * MINUTE_MS;
}

/** The instant a wall-clock time occurs in `timeZone`. Times skipped by DST move forward. */
function fromWallClock(w: WallClock, timeZone: string): Date {
  const guess = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  const first = guess - offsetMs(new Date(guess), timeZone);
  return new Date(guess - offsetMs(new Date(first), timeZone));
}

/** Occurrences of hour:minute on the local dates from `from` days to `to` days around `ref`. */
function occurrences(local: { hour: number; minute: number }, ref: Date, timeZone: string, from: number, to: number): Date[] {
  // Step by calendar date, not by 24 hours: DST days are 23 or 25 hours long.
  const base = wallClock(ref, timeZone);
  const out: Date[] = [];
  for (let d = from; d <= to; d++) {
    const date = new Date(Date.UTC(base.year, base.month - 1, base.day + d));
    const day = { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
    out.push(fromWallClock({ ...day, hour: local.hour, minute: local.minute }, timeZone));
  }
  return out;
}

/** Arrival: the occurrence nearest the reference (the appointment, or now if there is none). */
export function resolveArrival(input: TimeInput, ref: Date, timeZone: string): Date {
  if (input.kind === 'instant') return input.at;
  const candidates = occurrences(input, ref, timeZone, -1, 1);
  return candidates.reduce((best, c) =>
    Math.abs(c.getTime() - ref.getTime()) < Math.abs(best.getTime() - ref.getTime()) ? c : best,
  );
}

/** Departure: the first occurrence after arrival. The caller checks it isn't in the future. */
export function resolveDeparture(input: TimeInput, arrival: Date, timeZone: string): Date {
  if (input.kind === 'instant') return input.at;
  const next = occurrences(input, arrival, timeZone, 0, 2).find((c) => c.getTime() > arrival.getTime());
  if (!next) throw new Error('no occurrence after arrival within two days');
  return next;
}

/** "7:50 AM" in the stop's timezone. */
export function spokenTime(at: Date, timeZone: string): string {
  // Some ICU versions put a narrow no-break space before AM/PM.
  return new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' })
    .format(at)
    .replace(/\u202f/g, ' ');
}

/** Calendar days between two instants, as seen in `timeZone` (0 = same local date). */
export function localDayDiff(a: Date, b: Date, timeZone: string): number {
  const da = wallClock(a, timeZone);
  const db = wallClock(b, timeZone);
  return Math.round((Date.UTC(db.year, db.month - 1, db.day) - Date.UTC(da.year, da.month - 1, da.day)) / DAY_MS);
}

/** "1 hour 5 minutes", "45 minutes", "2 hours". */
export function spokenDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const hours = h === 0 ? '' : h === 1 ? '1 hour' : `${h} hours`;
  const mins = m === 0 ? '' : m === 1 ? '1 minute' : `${m} minutes`;
  return [hours, mins].filter(Boolean).join(' ') || '0 minutes';
}
