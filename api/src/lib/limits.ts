// Fictional plausibility limits. Values outside them still create a pending record, flagged
// with `needs_confirmation` so the agent double-checks with the caller.

export type ExpenseCategory =
  | 'fuel' | 'def' | 'toll' | 'scale_fee' | 'parking' | 'lumper' | 'repair' | 'washout' | 'food' | 'other';

export const CATEGORY_CEILING_CENTS: Record<ExpenseCategory, number> = {
  fuel: 2_000_00,
  def: 300_00,
  toll: 200_00,
  scale_fee: 50_00,
  parking: 100_00,
  lumper: 500_00,
  repair: 5_000_00,
  washout: 150_00,
  food: 100_00,
  other: 1_000_00,
};

/** Plausible price per gallon, in cents, for categories that carry gallons. */
export const PRICE_PER_GALLON_CENTS: Partial<Record<ExpenseCategory, { min: number; max: number }>> = {
  fuel: { min: 200, max: 700 },
  def: { min: 150, max: 800 },
};

/** Plausible scale ticket net weight by trailer type, in pounds. */
export const NET_WEIGHT_RANGE_LBS: Record<string, { min: number; max: number }> = {
  hopper_bottom: { min: 20_000, max: 60_000 },
  dry_van: { min: 1_000, max: 48_000 },
};
export const DEFAULT_NET_WEIGHT_RANGE_LBS = { min: 1_000, max: 60_000 };

export const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
export const OLD_RECORD_MS = 30 * 24 * 60 * 60 * 1000;

export type ConfirmationReason =
  | 'amount_over_ceiling'
  | 'price_per_gallon_out_of_range'
  | 'weight_out_of_range'
  | 'occurred_long_ago';

const PROMPTS: Record<ConfirmationReason, string> = {
  amount_over_ceiling: "That's more than usual for that kind of expense. Is the amount right?",
  price_per_gallon_out_of_range: "That works out to an unusual price per gallon. Are the amount and gallons right?",
  weight_out_of_range: "That's an unusual weight for this trailer. Is the weight right?",
  occurred_long_ago: 'That date is more than a month ago. Is the date right?',
};

/** One speakable sentence asking the caller to double-check, or null if nothing is flagged. */
export function confirmationPrompt(reasons: readonly ConfirmationReason[]): string | null {
  const firstReason = reasons[0];
  if (!firstReason) return null;
  return reasons.length === 1 ? PROMPTS[firstReason] : 'A couple of those numbers look unusual. Can you double-check them?';
}

export function expenseFlags(e: {
  category: ExpenseCategory;
  amountCents: number;
  gallonsMilli: number | null;
  occurredAt: Date;
  now: Date;
}): ConfirmationReason[] {
  const reasons: ConfirmationReason[] = [];
  if (e.amountCents > CATEGORY_CEILING_CENTS[e.category]) reasons.push('amount_over_ceiling');
  const range = PRICE_PER_GALLON_CENTS[e.category];
  if (range && e.gallonsMilli) {
    // cents per gallon = amountCents / (gallonsMilli / 1000); compared without division.
    const scaled = e.amountCents * 1000;
    if (scaled < range.min * e.gallonsMilli || scaled > range.max * e.gallonsMilli) {
      reasons.push('price_per_gallon_out_of_range');
    }
  }
  if (e.now.getTime() - e.occurredAt.getTime() > OLD_RECORD_MS) reasons.push('occurred_long_ago');
  return reasons;
}

export function weightFlags(netWeightLbs: number, trailerType: string): ConfirmationReason[] {
  const range = NET_WEIGHT_RANGE_LBS[trailerType] ?? DEFAULT_NET_WEIGHT_RANGE_LBS;
  return netWeightLbs < range.min || netWeightLbs > range.max ? ['weight_out_of_range'] : [];
}
