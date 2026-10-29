import { groupThousands } from './money.js';

/** Absolute cap on a scale ticket net weight; anything larger is rejected, not flagged. */
export const MAX_WEIGHT_LBS = 100_000;
export const MAX_GALLONS_MILLI = 1_000_000; // 1,000 gallons

/** Parse gallons like "140" or "140.5" (up to 3 decimals) into thousandths of a gallon. */
export function parseGallonsMilli(input: string): number | null {
  const cleaned = input.trim().replace(/,/g, '');
  const match = /^(\d{1,6})(?:\.(\d{1,3}))?$/.exec(cleaned);
  if (!match) return null;
  const milli = Number(match[1]) * 1000 + Number((match[2] ?? '').padEnd(3, '0'));
  return milli > 0 ? milli : null;
}

/** Thousandths of a gallon as the decimal string Postgres stores, e.g. 140500 -> "140.5". */
export function gallonsDecimal(milli: number): string {
  const whole = Math.floor(milli / 1000);
  const fraction = String(milli % 1000).padStart(3, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

/** Parse a Postgres numeric gallons value ("140.000") back into thousandths. */
export function gallonsMilliFromDb(value: string): number {
  const parsed = parseGallonsMilli(value);
  if (parsed === null) throw new Error(`invalid stored gallons: ${value}`);
  return parsed;
}

export function spokenGallons(milli: number): string {
  return milli === 1000 ? '1 gallon' : `${gallonsDecimal(milli)} gallons`;
}

/** Parse a whole-pound weight like "52800" or "52,800". */
export function parseWeightLbs(input: string | number): number | null {
  const cleaned = String(input).trim().replace(/,/g, '');
  if (!/^\d{1,7}$/.test(cleaned)) return null;
  const lbs = Number(cleaned);
  return lbs > 0 ? lbs : null;
}

export function spokenWeight(lbs: number): string {
  return lbs === 1 ? '1 pound' : `${groupThousands(lbs)} pounds`;
}
