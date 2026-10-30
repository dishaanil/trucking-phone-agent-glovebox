import { groupThousands } from './money.js';

export type RateType = 'flat' | 'per_ton' | 'per_mile';

export const LBS_PER_TON = 2000;

/** Per-ton pay in integer cents: round(lbs / 2000 * rate), halves rounded up. */
export function perTonCents(netWeightLbs: number, rateCentsPerTon: number): number {
  return Math.floor((netWeightLbs * rateCentsPerTon + LBS_PER_TON / 2) / LBS_PER_TON);
}

/**
 * Base revenue for a load (SPEC section 8). A per-ton load without a confirmed scale
 * ticket has no revenue yet: null, not zero.
 */
export function baseRevenueCents(load: {
  rate_type: RateType;
  rate_cents: number;
  loaded_miles: number;
  confirmed_ticket_lbs: number | null;
}): number | null {
  switch (load.rate_type) {
    case 'flat':
      return load.rate_cents;
    case 'per_mile':
      return load.loaded_miles * load.rate_cents;
    case 'per_ton':
      return load.confirmed_ticket_lbs === null ? null : perTonCents(load.confirmed_ticket_lbs, load.rate_cents);
  }
}

/** Cost per loaded mile in cents, rounded; null when there are no miles. */
export function costPerMileCents(costsCents: number, loadedMiles: number): number | null {
  if (loadedMiles <= 0) return null;
  return Math.round(costsCents / loadedMiles);
}

/** Whole dollars for spoken summaries: 236850 -> "2,369". Halves round away from zero. */
export function spokenDollars(cents: number): string {
  const dollars = Math.round(Math.abs(cents) / 100);
  return groupThousands(dollars);
}
