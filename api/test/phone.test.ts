import { describe, expect, it } from 'vitest';
import { last4, toE164 } from '../src/lib/phone.js';

describe('toE164', () => {
  it.each([
    ['(270) 555-0101', '+12705550101'],
    ['270-555-0101', '+12705550101'],
    ['2705550101', '+12705550101'],
    ['1 270 555 0101', '+12705550101'],
    ['+1 (270) 555-0101', '+12705550101'],
    ['+44 20 7946 0958', '+442079460958'],
  ])('normalizes %s', (input, expected) => {
    expect(toE164(input)).toBe(expected);
  });

  it.each(['', '555-0101', '12345', '+0123456789', 'call me', '22705550101'])('rejects %s', (input) => {
    expect(toE164(input)).toBeNull();
  });

  it('keeps only the last four digits for display', () => {
    expect(last4('+12705550101')).toBe('0101');
  });
});
