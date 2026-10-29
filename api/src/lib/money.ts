/** Absolute cap on any single amount; anything larger is rejected, not flagged. */
export const MAX_AMOUNT_CENTS = 100_000_00;

/**
 * Parse a decimal string like "512.40", "$1,250" or "0.5" into integer cents, using string
 * math only. Strips `$` and commas. Returns null for anything else, including more than two
 * decimals, negatives and zero.
 */
export function parseAmountCents(input: string): number | null {
  const cleaned = input.trim().replace(/[$,]/g, '');
  const match = /^(\d*)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match || cleaned === '' || cleaned === '.') return null;
  const dollars = match[1] ?? '';
  const fraction = match[2] ?? '';
  if (dollars === '' && fraction === '') return null;
  if (dollars.length > 9) return null;
  const cents = Number(dollars || '0') * 100 + Number(fraction.padEnd(2, '0'));
  return cents > 0 ? cents : null;
}

const groupThousands = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** Spoken form for readbacks: "512 dollars and 40 cents", "1 dollar", "40 cents". */
export function spokenAmount(cents: number): string {
  const dollars = Math.floor(cents / 100);
  const rest = cents % 100;
  const dollarPart = dollars === 1 ? '1 dollar' : `${groupThousands(dollars)} dollars`;
  const centPart = rest === 1 ? '1 cent' : `${rest} cents`;
  if (dollars === 0) return centPart;
  if (rest === 0) return dollarPart;
  return `${dollarPart} and ${centPart}`;
}

export { groupThousands };
