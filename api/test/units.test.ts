import { describe, expect, it } from 'vitest';
import { confirmationPrompt, expenseFlags, weightFlags } from '../src/lib/limits.js';
import { parseAmountCents, spokenAmount } from '../src/lib/money.js';
import { gallonsDecimal, parseGallonsMilli, parseWeightLbs, spokenWeight } from '../src/lib/quantity.js';
import { expenseReadback, ticketReadback } from '../src/lib/readback.js';
import { stateName, toStateCode } from '../src/lib/states.js';

describe('parseAmountCents', () => {
  it.each([
    ['512.40', 51240],
    ['512.4', 51240],
    ['512', 51200],
    ['$512.40', 51240],
    ['1,250.50', 125050],
    ['$1,250', 125000],
    ['0.5', 50],
    ['.99', 99],
    [' 14.00 ', 1400],
  ])('parses %s', (input, cents) => {
    expect(parseAmountCents(input)).toBe(cents);
  });

  it.each(['512.405', '-5', '0', '0.00', 'abc', '', '.', '12.3.4', '5e3', '1 2', '512.'])('rejects %s', (input) => {
    expect(parseAmountCents(input)).toBeNull();
  });
});

describe('spokenAmount', () => {
  it.each([
    [51240, '512 dollars and 40 cents'],
    [100, '1 dollar'],
    [101, '1 dollar and 1 cent'],
    [40, '40 cents'],
    [125000, '1,250 dollars'],
  ])('%i cents', (cents, text) => {
    expect(spokenAmount(cents)).toBe(text);
  });
});

describe('quantities', () => {
  it('parses gallons up to three decimals', () => {
    expect(parseGallonsMilli('140')).toBe(140_000);
    expect(parseGallonsMilli('140.5')).toBe(140_500);
    expect(parseGallonsMilli('0.125')).toBe(125);
    expect(parseGallonsMilli('1.2345')).toBeNull();
    expect(parseGallonsMilli('0')).toBeNull();
    expect(gallonsDecimal(140_500)).toBe('140.5');
    expect(gallonsDecimal(140_000)).toBe('140');
  });

  it('parses whole-pound weights', () => {
    expect(parseWeightLbs('52,800')).toBe(52_800);
    expect(parseWeightLbs(52_080)).toBe(52_080);
    expect(parseWeightLbs('52800.5')).toBeNull();
    expect(parseWeightLbs('0')).toBeNull();
    expect(spokenWeight(52_800)).toBe('52,800 pounds');
  });
});

describe('states', () => {
  it('accepts codes and names', () => {
    expect(toStateCode('mo')).toBe('MO');
    expect(toStateCode('Missouri')).toBe('MO');
    expect(toStateCode('new york')).toBe('NY');
    expect(toStateCode('Atlantis')).toBeNull();
    expect(stateName('KY')).toBe('Kentucky');
  });
});

describe('readbacks', () => {
  it('matches the SPEC example', () => {
    expect(
      expenseReadback({
        category: 'fuel',
        amountCents: 51240,
        gallonsMilli: 140_000,
        vendor: "Love's",
        city: 'Joplin',
        state: 'MO',
        paymentMethod: 'fuel_card',
      }),
    ).toBe("Fuel, 512 dollars and 40 cents, 140 gallons at Love's in Joplin, Missouri.");
  });

  it('mentions cash and skips missing parts', () => {
    expect(
      expenseReadback({ category: 'lumper', amountCents: 15000, gallonsMilli: null, vendor: null, city: null, state: null, paymentMethod: 'cash' }),
    ).toBe('Lumper, 150 dollars, paid cash.');
  });

  it('reads back a scale ticket', () => {
    expect(ticketReadback({ loadNumber: '7712', netWeightLbs: 52_800, ticketNumber: null })).toBe(
      'Scale ticket for load 7712, 52,800 pounds net.',
    );
  });
});

describe('confirmation flags', () => {
  const now = new Date('2026-10-27T12:00:00Z');
  const base = { gallonsMilli: null, occurredAt: now, now };

  it('flags amounts over the category ceiling, not at it', () => {
    expect(expenseFlags({ ...base, category: 'toll', amountCents: 200_00 })).toEqual([]);
    expect(expenseFlags({ ...base, category: 'toll', amountCents: 200_01 })).toEqual(['amount_over_ceiling']);
  });

  it('flags implausible fuel prices', () => {
    expect(expenseFlags({ ...base, category: 'fuel', amountCents: 51240, gallonsMilli: 140_000 })).toEqual([]);
    expect(expenseFlags({ ...base, category: 'fuel', amountCents: 5124, gallonsMilli: 140_000 })).toEqual([
      'price_per_gallon_out_of_range',
    ]);
    expect(expenseFlags({ ...base, category: 'fuel', amountCents: 140_000, gallonsMilli: 140_000 })).toEqual([
      'price_per_gallon_out_of_range',
    ]);
  });

  it('flags dates more than 30 days old', () => {
    const old = new Date(now.getTime() - 31 * 24 * 3600 * 1000);
    expect(expenseFlags({ ...base, category: 'food', amountCents: 1200, occurredAt: old })).toEqual(['occurred_long_ago']);
  });

  it('flags weights outside the trailer range', () => {
    expect(weightFlags(52_800, 'hopper_bottom')).toEqual([]);
    expect(weightFlags(15_000, 'hopper_bottom')).toEqual(['weight_out_of_range']);
    expect(weightFlags(52_800, 'dry_van')).toEqual(['weight_out_of_range']);
  });

  it('turns reasons into one speakable prompt', () => {
    expect(confirmationPrompt([])).toBeNull();
    expect(confirmationPrompt(['weight_out_of_range'])).toMatch(/weight/);
    expect(confirmationPrompt(['amount_over_ceiling', 'occurred_long_ago'])).toMatch(/double-check/);
  });
});
