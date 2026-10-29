import type { ExpenseCategory } from './limits.js';
import { spokenAmount } from './money.js';
import { spokenGallons, spokenWeight } from './quantity.js';
import { stateName } from './states.js';

const CATEGORY_LABEL: Record<ExpenseCategory, string> = {
  fuel: 'Fuel',
  def: 'DEF',
  toll: 'Toll',
  scale_fee: 'Scale fee',
  parking: 'Parking',
  lumper: 'Lumper',
  repair: 'Repair',
  washout: 'Washout',
  food: 'Food',
  other: 'Other expense',
};

/** e.g. "Fuel, 512 dollars and 40 cents, 140 gallons at Love's in Joplin, Missouri." */
export function expenseReadback(e: {
  category: ExpenseCategory;
  amountCents: number;
  gallonsMilli: number | null;
  vendor: string | null;
  city: string | null;
  state: string | null;
  paymentMethod: string;
}): string {
  let text = `${CATEGORY_LABEL[e.category]}, ${spokenAmount(e.amountCents)}`;
  if (e.gallonsMilli) text += `, ${spokenGallons(e.gallonsMilli)}`;
  if (e.vendor) text += ` at ${e.vendor}`;
  const place = [e.city, e.state ? stateName(e.state) : null].filter(Boolean).join(', ');
  if (place) text += ` in ${place}`;
  if (e.paymentMethod === 'cash') text += ', paid cash';
  return `${text}.`;
}

/** e.g. "Scale ticket for load 7712, 52,800 pounds net." */
export function ticketReadback(t: { loadNumber: string; netWeightLbs: number; ticketNumber: string | null }): string {
  let text = `Scale ticket for load ${t.loadNumber}, ${spokenWeight(t.netWeightLbs)} net`;
  if (t.ticketNumber) text += `, ticket ${t.ticketNumber}`;
  return `${text}.`;
}

export function categoryLabel(category: ExpenseCategory): string {
  return CATEGORY_LABEL[category];
}
