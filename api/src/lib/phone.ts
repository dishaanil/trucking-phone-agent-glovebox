/**
 * Normalize a phone number to E.164. Bare 10-digit numbers are treated as US (+1).
 * Returns null if the input can't be a valid number.
 */
export function toE164(input: string): string | null {
  const trimmed = input.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (trimmed.startsWith('+')) {
    return /^[1-9]\d{7,14}$/.test(digits) ? `+${digits}` : null;
  }
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

/** Last four digits only, for responses and events. Full numbers live only in sandbox_phones. */
export function last4(e164: string): string {
  return e164.slice(-4);
}
