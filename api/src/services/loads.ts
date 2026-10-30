import type { Queryable } from '../db.js';
import { ApiError } from '../errors.js';
import type { LoadResponse, ProfitabilityResponse, StopResponse } from '../ledger-schemas.js';
import { canUseLoad, forbiddenLoad } from '../lib/access.js';
import type { Caller } from '../lib/caller.js';
import { spokenAmount } from '../lib/money.js';
import { baseRevenueCents, costPerMileCents, perTonCents, spokenDollars, type RateType } from '../lib/revenue.js';

const notFound = (): ApiError => new ApiError(404, 'load_not_found', "I can't find that load.");

type LoadRow = Omit<LoadResponse, 'stops'>;

interface StopRow extends Omit<StopResponse, 'appointment_at' | 'arrived_at' | 'departed_at'> {
  appointment_at: Date | null;
  arrived_at: Date | null;
  departed_at: Date | null;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** A load by its human number, with stops. Drivers can look up only their own loads. */
export async function findLoadByNumber(db: Queryable, caller: Caller, number: string): Promise<LoadResponse> {
  const { rows } = await db.query<LoadRow>(
    `select l.id, l.load_number, l.status, l.commodity, l.rate_type, l.rate_cents, l.loaded_miles,
            l.truck_id, t.unit_number as truck_unit, l.driver_id, p.full_name as driver_name,
            py.name as payer_name
       from loads l
       join trucks t on t.id = l.truck_id and t.sandbox_id = l.sandbox_id
       join people p on p.id = l.driver_id and p.sandbox_id = l.sandbox_id
       join payers py on py.id = l.payer_id and py.sandbox_id = l.sandbox_id
      where l.sandbox_id = $1 and l.business_id = $2 and lower(l.load_number) = lower($3)`,
    [caller.sandboxId, caller.businessId, number],
  );
  const load = rows[0];
  if (!load) throw notFound();
  if (!canUseLoad(caller, load)) throw forbiddenLoad();

  const stops = await db.query<StopRow>(
    `select s.id, s.type, s.sequence, s.facility_name, s.city, s.state,
            coalesce(s.timezone, b.timezone) as timezone, s.appointment_at, s.arrived_at, s.departed_at
       from stops s
       join loads l on l.id = s.load_id and l.sandbox_id = s.sandbox_id
       join businesses b on b.id = l.business_id and b.sandbox_id = l.sandbox_id
      where s.sandbox_id = $1 and s.load_id = $2
      order by s.sequence`,
    [caller.sandboxId, load.id],
  );
  return {
    ...load,
    stops: stops.rows.map((s) => ({
      ...s,
      appointment_at: iso(s.appointment_at),
      arrived_at: iso(s.arrived_at),
      departed_at: iso(s.departed_at),
    })),
  };
}

interface ProfitRow {
  id: string;
  load_number: string;
  status: ProfitabilityResponse['status'];
  driver_id: string;
  rate_type: RateType;
  rate_cents: number;
  loaded_miles: number;
  confirmed_ticket_lbs: number | null;
  pending_ticket_lbs: number | null;
  costs_cents: number;
  reimbursable_cents: number;
  detention_earned_cents: number;
  detention_pending_cents: number;
}

// Only confirmed expenses count. Reimbursable ones are pending revenue, not costs.
const PROFIT_SELECT = `
  select l.id, l.load_number, l.status, l.driver_id, l.rate_type, l.rate_cents, l.loaded_miles,
         (select st.net_weight_lbs from scale_tickets st
           where st.sandbox_id = l.sandbox_id and st.load_id = l.id and st.status = 'confirmed') as confirmed_ticket_lbs,
         (select st.net_weight_lbs from scale_tickets st
           where st.sandbox_id = l.sandbox_id and st.load_id = l.id and st.status = 'pending') as pending_ticket_lbs,
         coalesce((select sum(e.amount_cents) from expenses e
                    where e.sandbox_id = l.sandbox_id and e.load_id = l.id
                      and e.status = 'confirmed' and not e.reimbursable), 0)::int as costs_cents,
         coalesce((select sum(e.amount_cents) from expenses e
                    where e.sandbox_id = l.sandbox_id and e.load_id = l.id
                      and e.status = 'confirmed' and e.reimbursable), 0)::int as reimbursable_cents,
         coalesce((select sum(dc.amount_cents) from detention_claims dc
                    where dc.sandbox_id = l.sandbox_id and dc.load_id = l.id
                      and dc.status in ('approved', 'paid')), 0)::int as detention_earned_cents,
         coalesce((select sum(dc.amount_cents) from detention_claims dc
                    where dc.sandbox_id = l.sandbox_id and dc.load_id = l.id
                      and dc.status in ('draft', 'sent')), 0)::int as detention_pending_cents
    from loads l
   where l.sandbox_id = $1 and l.business_id = $2 and l.id = $3`;

const signedDisplay = (cents: number): string => (cents < 0 ? `minus ${spokenAmount(-cents)}` : spokenAmount(cents));

function profitSummary(p: {
  loadNumber: string;
  revenue: number | null;
  projected: number | null;
  costs: number;
  net: number | null;
  reimbursable: number;
  detentionPending: number;
}): string {
  const costs = p.costs === 0 ? 'No costs logged yet.' : `Costs so far are ${spokenDollars(p.costs)} dollars.`;
  let sentence: string;
  if (p.revenue === null || p.net === null) {
    sentence =
      p.projected === null
        ? `Load ${p.loadNumber}'s pay is pending the scale ticket. ${costs}`
        : `Load ${p.loadNumber} would pay about ${spokenDollars(p.projected)} dollars once the scale ticket is confirmed. ${costs}`;
  } else if (p.costs === 0) {
    sentence = `Load ${p.loadNumber} pays ${spokenDollars(p.revenue)} dollars, with no costs logged yet.`;
  } else {
    const result = p.net < 0 ? `it's down ${spokenDollars(p.net)}` : `it nets ${spokenDollars(p.net)}`;
    sentence = `Load ${p.loadNumber} pays ${spokenDollars(p.revenue)} dollars, costs so far are ${spokenDollars(p.costs)}, so ${result}.`;
  }

  const pending = [
    p.reimbursable > 0 ? `${spokenDollars(p.reimbursable)} in reimbursements` : null,
    p.detentionPending > 0 ? `${spokenDollars(p.detentionPending)} in detention` : null,
  ].filter((x): x is string => x !== null);
  return pending.length > 0 ? `${sentence} Still pending: ${pending.join(' and ')}.` : sentence;
}

/** Revenue, costs, net and cost per mile for one load (SPEC section 8). */
export async function loadProfitability(db: Queryable, caller: Caller, loadId: string): Promise<ProfitabilityResponse> {
  const { rows } = await db.query<ProfitRow>(PROFIT_SELECT, [caller.sandboxId, caller.businessId, loadId]);
  const row = rows[0];
  if (!row) throw notFound();
  if (!canUseLoad(caller, row)) throw forbiddenLoad();

  const base = baseRevenueCents(row);
  const revenue = base === null ? null : base + row.detention_earned_cents;
  const projected =
    base === null && row.pending_ticket_lbs !== null
      ? perTonCents(row.pending_ticket_lbs, row.rate_cents) + row.detention_earned_cents
      : null;
  const net = revenue === null ? null : revenue - row.costs_cents;

  return {
    load_id: row.id,
    load_number: row.load_number,
    status: row.status,
    rate_type: row.rate_type,
    loaded_miles: row.loaded_miles,
    revenue_status: base === null ? 'pending_scale_ticket' : 'final',
    revenue_cents: revenue,
    revenue_display: revenue === null ? null : spokenAmount(revenue),
    projected_revenue_cents: projected,
    projected_revenue_display: projected === null ? null : spokenAmount(projected),
    detention_revenue_cents: row.detention_earned_cents,
    pending_revenue_cents: row.reimbursable_cents + row.detention_pending_cents,
    costs_cents: row.costs_cents,
    costs_display: spokenAmount(row.costs_cents),
    net_cents: net,
    net_display: net === null ? null : signedDisplay(net),
    cost_per_mile_cents: costPerMileCents(row.costs_cents, row.loaded_miles),
    summary: profitSummary({
      loadNumber: row.load_number,
      revenue,
      projected,
      costs: row.costs_cents,
      net,
      reimbursable: row.reimbursable_cents,
      detentionPending: row.detention_pending_cents,
    }),
  };
}
