import type { Queryable } from '../db.js';
import { ApiError } from '../errors.js';
import type {
  BusinessSummaryResponse,
  TruckSummaryResponse,
  UnpaidLoadsResponse,
} from '../ledger-schemas.js';
import { findTruck } from '../lib/access.js';
import type { Caller } from '../lib/caller.js';
import { spokenAmount } from '../lib/money.js';
import { rangeBounds, spokenRange, type Bounds, type Range } from '../lib/ranges.js';
import { baseRevenueCents, perTonCents, spokenDollars, type RateType } from '../lib/revenue.js';

const ownerOnly = (): ApiError => new ApiError(403, 'owner_only', "That's one for the owner to check.");

function requireOwner(caller: Caller): void {
  if (!caller.isOwner) throw ownerOnly();
}

// ---------- Figures for a range ----------

interface LoadMoneyRow {
  id: string;
  load_number: string;
  truck_id: string;
  truck_unit: string;
  rate_type: RateType;
  rate_cents: number;
  loaded_miles: number;
  confirmed_ticket_lbs: number | null;
  pending_ticket_lbs: number | null;
  detention_earned_cents: number;
  detention_pending_cents: number;
}

// Loads whose final delivery stop was departed in the range: that's when revenue counts.
const DELIVERED_IN_RANGE = `
  select l.id, l.load_number, l.truck_id, t.unit_number as truck_unit, l.rate_type, l.rate_cents, l.loaded_miles,
         (select st.net_weight_lbs from scale_tickets st
           where st.sandbox_id = l.sandbox_id and st.load_id = l.id and st.status = 'confirmed') as confirmed_ticket_lbs,
         (select st.net_weight_lbs from scale_tickets st
           where st.sandbox_id = l.sandbox_id and st.load_id = l.id and st.status = 'pending') as pending_ticket_lbs,
         coalesce((select sum(dc.amount_cents) from detention_claims dc
                    where dc.sandbox_id = l.sandbox_id and dc.load_id = l.id
                      and dc.status in ('approved', 'paid')), 0)::int as detention_earned_cents,
         coalesce((select sum(dc.amount_cents) from detention_claims dc
                    where dc.sandbox_id = l.sandbox_id and dc.load_id = l.id
                      and dc.status in ('draft', 'sent')), 0)::int as detention_pending_cents
    from loads l
    join trucks t on t.id = l.truck_id and t.sandbox_id = l.sandbox_id
    join stops d on d.load_id = l.id and d.sandbox_id = l.sandbox_id and d.type = 'delivery'
     and d.sequence = (select max(s2.sequence) from stops s2 where s2.sandbox_id = l.sandbox_id and s2.load_id = l.id)
   where l.sandbox_id = $1 and l.business_id = $2 and d.departed_at >= $3 and d.departed_at <= $4
   order by d.departed_at, l.load_number`;

// Confirmed expenses by when they happened. Reimbursable ones are pending revenue, not costs.
const EXPENSES_IN_RANGE = `
  select e.truck_id,
         coalesce(sum(e.amount_cents) filter (where not e.reimbursable), 0)::int as costs_cents,
         coalesce(sum(e.amount_cents) filter (where e.reimbursable), 0)::int as reimbursable_cents,
         coalesce(sum(e.amount_cents) filter (where e.category = 'repair' and not e.reimbursable), 0)::int as repair_cents
    from expenses e
   where e.sandbox_id = $1 and e.business_id = $2 and e.status = 'confirmed'
     and e.occurred_at >= $3 and e.occurred_at <= $4
   group by e.truck_id`;

const OPEN_LOADS_WITH_COSTS = `
  select l.id as load_id, l.load_number, l.truck_id, t.unit_number as truck_unit, l.status,
         sum(e.amount_cents)::int as costs_cents
    from loads l
    join trucks t on t.id = l.truck_id and t.sandbox_id = l.sandbox_id
    join expenses e on e.load_id = l.id and e.sandbox_id = l.sandbox_id
   where l.sandbox_id = $1 and l.business_id = $2 and l.status in ('booked', 'in_transit')
     and e.status = 'confirmed' and not e.reimbursable and e.occurred_at >= $3 and e.occurred_at <= $4
   group by l.id, l.load_number, l.truck_id, t.unit_number, l.status
   order by l.load_number`;

interface DeliveredLoad {
  load_id: string;
  load_number: string;
  truck_id: string;
  truck_unit: string;
  revenue_status: 'final' | 'pending_scale_ticket';
  revenue_cents: number | null;
  projected_revenue_cents: number | null;
  detention_pending_cents: number;
}

interface OpenLoad {
  load_id: string;
  load_number: string;
  truck_id: string;
  truck_unit: string;
  status: TruckSummaryResponse['open_loads_with_costs'][number]['status'];
  costs_cents: number;
}

interface Figures {
  delivered: DeliveredLoad[];
  expenses: { truck_id: string | null; costs_cents: number; reimbursable_cents: number; repair_cents: number }[];
  open: OpenLoad[];
}

async function figures(db: Queryable, caller: Caller, bounds: Bounds): Promise<Figures> {
  const params = [caller.sandboxId, caller.businessId, bounds.start, bounds.end];
  const [loads, expenses, open] = await Promise.all([
    db.query<LoadMoneyRow>(DELIVERED_IN_RANGE, params),
    db.query<Figures['expenses'][number]>(EXPENSES_IN_RANGE, params),
    db.query<OpenLoad>(OPEN_LOADS_WITH_COSTS, params),
  ]);
  return {
    delivered: loads.rows.map((l) => {
      const base = baseRevenueCents(l);
      return {
        load_id: l.id,
        load_number: l.load_number,
        truck_id: l.truck_id,
        truck_unit: l.truck_unit,
        revenue_status: base === null ? 'pending_scale_ticket' : 'final',
        revenue_cents: base === null ? null : base + l.detention_earned_cents,
        projected_revenue_cents:
          base === null && l.pending_ticket_lbs !== null ? perTonCents(l.pending_ticket_lbs, l.rate_cents) : null,
        detention_pending_cents: l.detention_pending_cents,
      };
    }),
    expenses: expenses.rows,
    open: open.rows,
  };
}

interface Totals {
  revenue: number;
  costs: number;
  /** Part of costs; named in summaries because one repair can sink a truck's week. */
  repairs: number;
  pending: number;
  delivered: DeliveredLoad[];
  open: OpenLoad[];
}

/** Totals for one truck, or for the whole business when `truckId` is undefined. */
function totals(f: Figures, truckId?: string): Totals {
  const mine = <T extends { truck_id: string | null }>(rows: T[]) =>
    truckId === undefined ? rows : rows.filter((r) => r.truck_id === truckId);
  const delivered = mine(f.delivered);
  const expenses = mine(f.expenses);
  return {
    revenue: delivered.reduce((sum, l) => sum + (l.revenue_cents ?? 0), 0),
    costs: expenses.reduce((sum, e) => sum + e.costs_cents, 0),
    repairs: expenses.reduce((sum, e) => sum + e.repair_cents, 0),
    pending:
      expenses.reduce((sum, e) => sum + e.reimbursable_cents, 0) +
      delivered.reduce((sum, l) => sum + l.detention_pending_cents, 0),
    delivered,
    open: mine(f.open),
  };
}

const signedDisplay = (cents: number): string => (cents < 0 ? `minus ${spokenAmount(-cents)}` : spokenAmount(cents));

function listOf(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`;
}

/** Follow-up sentences: loads waiting on a scale ticket, and open loads whose costs are included. */
function caveats(t: Totals): string {
  const out: string[] = [];
  const waiting = t.delivered.filter((l) => l.revenue_status === 'pending_scale_ticket').map((l) => l.load_number);
  if (waiting.length === 1) out.push(`Load ${waiting[0] ?? ''} is still waiting on its scale ticket.`);
  if (waiting.length > 1) out.push(`Loads ${listOf(waiting)} are still waiting on scale tickets.`);
  if (t.open.length > 0) {
    const parts = t.open.map((l) => `${spokenDollars(l.costs_cents)} on load ${l.load_number}`);
    const still = t.open.every((l) => l.status === 'in_transit') ? ', still in transit' : ', not delivered yet';
    out.push(`That includes ${listOf(parts)}${still}.`);
  }
  return out.map((s) => ` ${s}`).join('');
}

function netPhrase(net: number, past: boolean): string {
  if (net < 0) return `${past ? 'lost' : 'is down'} ${spokenDollars(net)}`;
  return `${past ? 'netted' : 'nets'} ${spokenDollars(net)}`;
}

function totalsSentence(subject: string, t: Totals, range: Range): string {
  const when = spokenRange(range);
  const net = t.revenue - t.costs;
  if (t.delivered.length === 0) {
    return t.costs === 0
      ? `${subject} has no delivered loads or costs ${when}.`
      : `${subject} has no delivered loads ${when} yet and spent ${spokenDollars(t.costs)}.`;
  }
  return `${subject} grossed ${spokenDollars(t.revenue)} ${when}, spent ${spokenDollars(t.costs)}, so it ${netPhrase(net, true)}.`;
}

function totalsBody(t: Totals, range: Range, bounds: Bounds, summary: string) {
  return {
    range,
    start: bounds.start.toISOString(),
    end: bounds.end.toISOString(),
    revenue_cents: t.revenue,
    revenue_display: spokenAmount(t.revenue),
    costs_cents: t.costs,
    costs_display: spokenAmount(t.costs),
    net_cents: t.revenue - t.costs,
    net_display: signedDisplay(t.revenue - t.costs),
    pending_revenue_cents: t.pending,
    delivered_loads: t.delivered.map((l) => ({
      load_id: l.load_id,
      load_number: l.load_number,
      truck_unit: l.truck_unit,
      revenue_status: l.revenue_status,
      revenue_cents: l.revenue_cents,
      projected_revenue_cents: l.projected_revenue_cents,
    })),
    open_loads_with_costs: t.open.map((l) => ({
      load_id: l.load_id,
      load_number: l.load_number,
      truck_unit: l.truck_unit,
      status: l.status,
      costs_cents: l.costs_cents,
    })),
    summary,
  };
}

async function businessInfo(db: Queryable, caller: Caller): Promise<{ name: string; timezone: string }> {
  const { rows } = await db.query<{ name: string; timezone: string }>(
    'select name, timezone from businesses where sandbox_id = $1 and id = $2',
    [caller.sandboxId, caller.businessId],
  );
  const business = rows[0];
  if (!business) throw new Error(`business ${caller.businessId} not found`);
  return business;
}

// ---------- Endpoints ----------

export async function truckSummary(
  db: Queryable,
  caller: Caller,
  truckId: string,
  range: Range,
): Promise<TruckSummaryResponse> {
  requireOwner(caller);
  const truck = await findTruck(db, caller, truckId);
  const business = await businessInfo(db, caller);
  const bounds = await rangeBounds(db, business.timezone, range);
  const t = totals(await figures(db, caller, bounds), truck.id);
  const repairs = t.repairs > 0 ? ` That includes ${spokenDollars(t.repairs)} in repairs.` : '';
  const summary = totalsSentence(`Truck ${truck.unit_number}`, t, range) + repairs + caveats(t);
  return { truck_id: truck.id, truck_unit: truck.unit_number, ...totalsBody(t, range, bounds, summary) };
}

export async function businessSummary(
  db: Queryable,
  caller: Caller,
  businessId: string,
  range: Range,
): Promise<BusinessSummaryResponse> {
  requireOwner(caller);
  if (businessId !== caller.businessId) throw new ApiError(404, 'business_not_found', "I can't find that business.");
  const business = await businessInfo(db, caller);
  const bounds = await rangeBounds(db, business.timezone, range);
  const f = await figures(db, caller, bounds);
  const all = totals(f);

  const trucks = await db.query<{ id: string; unit_number: string }>(
    'select id, unit_number from trucks where sandbox_id = $1 and business_id = $2 order by unit_number',
    [caller.sandboxId, caller.businessId],
  );
  const repairsByTruck = new Map<string, number>();
  const lines = trucks.rows.map((truck) => {
    const t = totals(f, truck.id);
    repairsByTruck.set(truck.id, t.repairs);
    return {
      truck_id: truck.id,
      truck_unit: truck.unit_number,
      revenue_cents: t.revenue,
      costs_cents: t.costs,
      net_cents: t.revenue - t.costs,
    };
  });
  const overhead = f.expenses.filter((e) => e.truck_id === null).reduce((sum, e) => sum + e.costs_cents, 0);

  // Best and worst only mean something with more than one truck.
  const ranked = [...lines].sort((a, b) => b.net_cents - a.net_cents);
  const best = lines.length > 1 ? (ranked[0] ?? null) : null;
  const worst = lines.length > 1 ? (ranked.at(-1) ?? null) : null;

  let summary = totalsSentence(business.name, all, range);
  if (best && worst && best.truck_id !== worst.truck_id) {
    const result = (net: number) => (net < 0 ? `which lost ${spokenDollars(net)}` : `netting ${spokenDollars(net)}`);
    const worstRepairs = repairsByTruck.get(worst.truck_id) ?? 0;
    const why = worstRepairs > 0 ? `, after ${spokenDollars(worstRepairs)} dollars in repairs` : '';
    summary += ` Best was truck ${best.truck_unit}, ${result(best.net_cents)}; worst was truck ${worst.truck_unit}, ${result(worst.net_cents)}${why}.`;
  }
  summary += caveats(all);

  return {
    business_id: caller.businessId,
    business_name: business.name,
    ...totalsBody(all, range, bounds, summary),
    overhead_costs_cents: overhead,
    trucks: lines,
    best_truck: best,
    worst_truck: worst,
  };
}

interface UnpaidRow extends LoadMoneyRow {
  payer_name: string;
  status: UnpaidLoadsResponse['loads'][number]['status'];
  delivered_at: Date | null;
  invoiced_at: Date | null;
}

const UNPAID = `
  select l.id, l.load_number, l.truck_id, t.unit_number as truck_unit, l.rate_type, l.rate_cents, l.loaded_miles,
         l.status, l.invoiced_at, py.name as payer_name,
         (select st.net_weight_lbs from scale_tickets st
           where st.sandbox_id = l.sandbox_id and st.load_id = l.id and st.status = 'confirmed') as confirmed_ticket_lbs,
         (select st.net_weight_lbs from scale_tickets st
           where st.sandbox_id = l.sandbox_id and st.load_id = l.id and st.status = 'pending') as pending_ticket_lbs,
         coalesce((select sum(dc.amount_cents) from detention_claims dc
                    where dc.sandbox_id = l.sandbox_id and dc.load_id = l.id
                      and dc.status in ('approved', 'paid')), 0)::int as detention_earned_cents,
         0 as detention_pending_cents,
         (select max(s.departed_at) from stops s
           where s.sandbox_id = l.sandbox_id and s.load_id = l.id and s.type = 'delivery') as delivered_at
    from loads l
    join trucks t on t.id = l.truck_id and t.sandbox_id = l.sandbox_id
    join payers py on py.id = l.payer_id and py.sandbox_id = l.sandbox_id
   where l.sandbox_id = $1 and l.business_id = $2 and l.status in ('delivered', 'invoiced') and l.paid_at is null
   order by delivered_at nulls last, l.load_number`;

const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(days: number): string {
  if (days === 0) return 'today';
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

/** Delivered or invoiced loads not yet paid (owner only). */
export async function unpaidLoads(db: Queryable, caller: Caller, businessId: string): Promise<UnpaidLoadsResponse> {
  requireOwner(caller);
  if (businessId !== caller.businessId) throw new ApiError(404, 'business_not_found', "I can't find that business.");
  const { rows } = await db.query<UnpaidRow>(UNPAID, [caller.sandboxId, caller.businessId]);
  const now = Date.now();

  const loads = rows.map((l) => {
    const base = baseRevenueCents(l);
    const amount = base === null ? null : base + l.detention_earned_cents;
    return {
      load_id: l.id,
      load_number: l.load_number,
      truck_unit: l.truck_unit,
      payer_name: l.payer_name,
      status: l.status,
      revenue_status: base === null ? ('pending_scale_ticket' as const) : ('final' as const),
      amount_cents: amount,
      amount_display: amount === null ? null : spokenAmount(amount),
      projected_amount_cents:
        base === null && l.pending_ticket_lbs !== null ? perTonCents(l.pending_ticket_lbs, l.rate_cents) : null,
      delivered_at: l.delivered_at ? l.delivered_at.toISOString() : null,
      invoiced_at: l.invoiced_at ? l.invoiced_at.toISOString() : null,
      days_since_invoiced: l.invoiced_at ? Math.floor((now - l.invoiced_at.getTime()) / DAY_MS) : null,
    };
  });
  const total = loads.reduce((sum, l) => sum + (l.amount_cents ?? 0), 0);

  let summary: string;
  if (loads.length === 0) {
    summary = 'Everything delivered has been paid.';
  } else {
    const items = loads.map((l) => {
      if (l.amount_cents === null) return `${l.load_number}, from ${l.payer_name}, waiting on its scale ticket`;
      const invoiced = l.days_since_invoiced === null ? 'not invoiced yet' : `invoiced ${daysAgo(l.days_since_invoiced)}`;
      return `${l.load_number}, ${spokenDollars(l.amount_cents)} dollars from ${l.payer_name}, ${invoiced}`;
    });
    const count = loads.length === 1 ? "1 load hasn't been paid" : `${loads.length} loads haven't been paid`;
    const waiting = loads.some((l) => l.amount_cents === null);
    const totalSentence =
      loads.length > 1 && total > 0
        ? ` That's ${spokenDollars(total)} dollars${waiting ? ', not counting loads waiting on a scale ticket' : ''}.`
        : '';
    summary = `${count}: ${items.join('; ')}.${totalSentence}`;
  }

  return { loads, total_cents: total, total_display: spokenAmount(total), summary };
}
