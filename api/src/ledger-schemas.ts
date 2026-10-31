import { z } from 'zod';

export const ExpenseCategory = z.enum([
  'fuel', 'def', 'toll', 'scale_fee', 'parking', 'lumper', 'repair', 'washout', 'food', 'other',
]);
export const PaymentMethod = z.enum(['card', 'cash', 'fuel_card', 'unknown']);
export const RecordStatus = z.enum(['pending', 'confirmed', 'discarded']);
export const ConfirmationReason = z.enum([
  'amount_over_ceiling', 'price_per_gallon_out_of_range', 'weight_out_of_range', 'occurred_long_ago',
]);

export const IdParams = z.object({ id: z.uuid() });

// Every agent write carries the call and a key unique to that tool call.
const WriteMeta = {
  call_id: z.string().min(1).max(128),
  idempotency_key: z.string().min(1).max(256),
};

const text = (max: number) => z.string().trim().min(1).max(max);

// ---------- Requests ----------

export const CreateExpenseBody = z
  .object({
    category: ExpenseCategory,
    amount: z.string().min(1).max(32),
    vendor: text(100).optional(),
    city: text(100).optional(),
    state: text(40).optional(),
    gallons: z.string().min(1).max(16).optional(),
    payment_method: PaymentMethod.optional(),
    load_id: z.uuid().optional(),
    truck_id: z.uuid().optional(),
    reimbursable: z.boolean().optional(),
    occurred_at: z.iso.datetime({ offset: true }).optional(),
    ...WriteMeta,
  })
  .strict();
export type CreateExpenseBody = z.infer<typeof CreateExpenseBody>;

export const PatchExpenseBody = z
  .object({
    category: ExpenseCategory.optional(),
    amount: z.string().min(1).max(32).optional(),
    vendor: text(100).nullable().optional(),
    city: text(100).nullable().optional(),
    state: text(40).nullable().optional(),
    gallons: z.string().min(1).max(16).nullable().optional(),
    payment_method: PaymentMethod.optional(),
    load_id: z.uuid().nullable().optional(),
    truck_id: z.uuid().nullable().optional(),
    reimbursable: z.boolean().optional(),
    occurred_at: z.iso.datetime({ offset: true }).optional(),
    ...WriteMeta,
  })
  .strict();
export type PatchExpenseBody = z.infer<typeof PatchExpenseBody>;

export const ConfirmBody = z.object({ ids: z.array(z.uuid()).min(1).max(50), ...WriteMeta }).strict();

export const DiscardBody = z.object({ reason: text(200).optional(), ...WriteMeta }).strict();

const Weight = z.union([z.string().min(1).max(16), z.number().int()]);

export const CreateTicketBody = z
  .object({
    net_weight_lbs: Weight,
    ticket_number: text(40).optional(),
    location: text(100).optional(),
    ...WriteMeta,
  })
  .strict();
export type CreateTicketBody = z.infer<typeof CreateTicketBody>;

export const PatchTicketBody = z
  .object({
    net_weight_lbs: Weight.optional(),
    ticket_number: text(40).nullable().optional(),
    location: text(100).nullable().optional(),
    ...WriteMeta,
  })
  .strict();
export type PatchTicketBody = z.infer<typeof PatchTicketBody>;

// ---------- Responses ----------

const Flags = {
  needs_confirmation: z.boolean(),
  confirmation_reasons: z.array(ConfirmationReason),
  confirmation_prompt: z.string().nullable(),
};

export const ExpenseResponse = z.object({
  id: z.uuid(),
  status: RecordStatus,
  category: ExpenseCategory,
  amount_cents: z.number().int().positive(),
  amount_display: z.string(),
  gallons: z.string().nullable(),
  vendor: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  payment_method: PaymentMethod,
  reimbursable: z.boolean(),
  occurred_at: z.iso.datetime(),
  load_id: z.uuid().nullable(),
  load_number: z.string().nullable(),
  truck_id: z.uuid().nullable(),
  truck_unit: z.string().nullable(),
  receipt_status: z.string(),
  readback: z.string(),
  ...Flags,
});
export type ExpenseResponse = z.infer<typeof ExpenseResponse>;

export const TicketResponse = z.object({
  id: z.uuid(),
  status: RecordStatus,
  load_id: z.uuid(),
  load_number: z.string(),
  net_weight_lbs: z.number().int().positive(),
  weight_display: z.string(),
  ticket_number: z.string().nullable(),
  location: z.string().nullable(),
  readback: z.string(),
  ...Flags,
});
export type TicketResponse = z.infer<typeof TicketResponse>;

export const ConfirmResult = z.enum(['confirmed', 'already_confirmed', 'discarded', 'not_found', 'forbidden']);
export const ConfirmResponse = z.object({
  results: z.array(z.object({ id: z.uuid(), result: ConfirmResult })),
  confirmed_count: z.number().int(),
});
export type ConfirmResponse = z.infer<typeof ConfirmResponse>;

export const DiscardResponse = z.object({
  id: z.uuid(),
  status: z.literal('discarded'),
  previous_status: RecordStatus,
  message: z.string(),
});
export type DiscardResponse = z.infer<typeof DiscardResponse>;

// ---------- Loads ----------

export const LoadStatus = z.enum(['booked', 'in_transit', 'delivered', 'invoiced', 'paid']);
export const RateType = z.enum(['flat', 'per_ton', 'per_mile']);

export const LoadsQuery = z.object({ number: z.string().trim().regex(/^[A-Za-z0-9-]{1,20}$/) }).strict();

export const StopResponse = z.object({
  id: z.uuid(),
  type: z.enum(['pickup', 'delivery']),
  sequence: z.number().int(),
  facility_name: z.string(),
  city: z.string(),
  state: z.string(),
  timezone: z.string(),
  appointment_at: z.iso.datetime().nullable(),
  arrived_at: z.iso.datetime().nullable(),
  departed_at: z.iso.datetime().nullable(),
});
export type StopResponse = z.infer<typeof StopResponse>;

export const LoadResponse = z.object({
  id: z.uuid(),
  load_number: z.string(),
  status: LoadStatus,
  commodity: z.string().nullable(),
  rate_type: RateType,
  rate_cents: z.number().int(),
  loaded_miles: z.number().int(),
  truck_id: z.uuid(),
  truck_unit: z.string(),
  driver_id: z.uuid(),
  driver_name: z.string(),
  payer_name: z.string(),
  stops: z.array(StopResponse),
});
export type LoadResponse = z.infer<typeof LoadResponse>;

const cents = z.number().int();

export const ProfitabilityResponse = z.object({
  load_id: z.uuid(),
  load_number: z.string(),
  status: LoadStatus,
  rate_type: RateType,
  loaded_miles: z.number().int(),
  revenue_status: z.enum(['final', 'pending_scale_ticket']),
  /** Base pay plus approved or paid detention; null while a per-ton load has no confirmed ticket. */
  revenue_cents: cents.nullable(),
  revenue_display: z.string().nullable(),
  /** What a pending (unconfirmed) scale ticket would pay, for the dashboard to show as pending. */
  projected_revenue_cents: cents.nullable(),
  projected_revenue_display: z.string().nullable(),
  detention_revenue_cents: cents,
  /** Reimbursable expenses plus draft or sent detention. */
  pending_revenue_cents: cents,
  costs_cents: cents,
  costs_display: z.string(),
  net_cents: cents.nullable(),
  net_display: z.string().nullable(),
  cost_per_mile_cents: cents.nullable(),
  summary: z.string(),
});
export type ProfitabilityResponse = z.infer<typeof ProfitabilityResponse>;

// ---------- Stops and detention ----------

/** "07:50", "7:50 PM", or an ISO timestamp with an offset. Local times resolve in the stop's timezone. */
const StopTime = z.string().trim().min(1).max(40);

export const StopTimesBody = z
  .object({ arrived_at: StopTime.optional(), departed_at: StopTime.optional(), ...WriteMeta })
  .strict()
  .refine((b) => b.arrived_at !== undefined || b.departed_at !== undefined, {
    message: 'arrived_at or departed_at is required',
  });
export type StopTimesBody = z.infer<typeof StopTimesBody>;

export const StopTimesResponse = z.object({
  stop: StopResponse,
  load_id: z.uuid(),
  load_number: z.string(),
  load_status: LoadStatus,
  /** This departure from the final delivery stop moved the load from in transit to delivered. */
  load_delivered: z.boolean(),
  /** A draft detention claim on this stop was recalculated from the new times. */
  claim_recalculated: z.boolean(),
  readback: z.string(),
});
export type StopTimesResponse = z.infer<typeof StopTimesResponse>;

export const ClaimStatus = z.enum(['draft', 'sent', 'approved', 'rejected', 'paid']);

export const ClaimResponse = z.object({
  id: z.uuid(),
  stop_id: z.uuid(),
  load_id: z.uuid(),
  load_number: z.string(),
  facility_name: z.string(),
  status: ClaimStatus,
  billable_minutes: z.number().int(),
  amount_cents: z.number().int(),
  amount_display: z.string(),
  notes: z.string().nullable(),
  readback: z.string(),
});
export type ClaimResponse = z.infer<typeof ClaimResponse>;

export const DetentionResponse = z.object({
  stop_id: z.uuid(),
  load_id: z.uuid(),
  load_number: z.string(),
  facility_name: z.string(),
  payer_name: z.string(),
  eligible: z.boolean(),
  reason: z.enum(['payer_no_detention', 'missing_times', 'under_free_time']).nullable(),
  on_time: z.boolean().nullable(),
  late_arrival: z.boolean(),
  clock_start: z.iso.datetime().nullable(),
  waited_minutes: z.number().int(),
  free_minutes: z.number().int(),
  billable_minutes: z.number().int(),
  billable_display: z.string(),
  amount_cents: z.number().int(),
  amount_display: z.string(),
  notes: z.string().nullable(),
  claim: ClaimResponse.nullable(),
  summary: z.string(),
});
export type DetentionResponse = z.infer<typeof DetentionResponse>;

export const CreateClaimBody = z.object({ notes: text(500).optional(), ...WriteMeta }).strict();
export type CreateClaimBody = z.infer<typeof CreateClaimBody>;

// ---------- Owner summaries ----------

export const RangeQuery = z.object({ range: z.enum(['week', 'last_7_days']).default('week') }).strict();

const Money = { cents: z.number().int(), display: z.string() };

export const DeliveredLoad = z.object({
  load_id: z.uuid(),
  load_number: z.string(),
  truck_unit: z.string(),
  revenue_status: z.enum(['final', 'pending_scale_ticket']),
  revenue_cents: z.number().int().nullable(),
  projected_revenue_cents: z.number().int().nullable(),
});

export const OpenLoadCosts = z.object({
  load_id: z.uuid(),
  load_number: z.string(),
  truck_unit: z.string(),
  status: LoadStatus,
  costs_cents: z.number().int(),
});

const Totals = {
  range: z.enum(['week', 'last_7_days']),
  start: z.iso.datetime(),
  end: z.iso.datetime(),
  revenue_cents: Money.cents,
  revenue_display: Money.display,
  costs_cents: Money.cents,
  costs_display: Money.display,
  net_cents: Money.cents,
  net_display: Money.display,
  /** Reimbursable expenses in range plus draft or sent detention on loads delivered in range. */
  pending_revenue_cents: Money.cents,
  delivered_loads: z.array(DeliveredLoad),
  /** Loads not yet delivered whose costs in range are included. */
  open_loads_with_costs: z.array(OpenLoadCosts),
  summary: z.string(),
};

export const TruckSummaryResponse = z.object({ truck_id: z.uuid(), truck_unit: z.string(), ...Totals });
export type TruckSummaryResponse = z.infer<typeof TruckSummaryResponse>;

const TruckLine = z.object({
  truck_id: z.uuid(),
  truck_unit: z.string(),
  revenue_cents: z.number().int(),
  costs_cents: z.number().int(),
  net_cents: z.number().int(),
});

export const BusinessSummaryResponse = z.object({
  business_id: z.uuid(),
  business_name: z.string(),
  ...Totals,
  /** Expenses not tied to a truck. Included in costs_cents. */
  overhead_costs_cents: z.number().int(),
  trucks: z.array(TruckLine),
  best_truck: TruckLine.nullable(),
  worst_truck: TruckLine.nullable(),
});
export type BusinessSummaryResponse = z.infer<typeof BusinessSummaryResponse>;

export const UnpaidLoad = z.object({
  load_id: z.uuid(),
  load_number: z.string(),
  truck_unit: z.string(),
  payer_name: z.string(),
  status: LoadStatus,
  revenue_status: z.enum(['final', 'pending_scale_ticket']),
  amount_cents: z.number().int().nullable(),
  amount_display: z.string().nullable(),
  projected_amount_cents: z.number().int().nullable(),
  delivered_at: z.iso.datetime().nullable(),
  invoiced_at: z.iso.datetime().nullable(),
  days_since_invoiced: z.number().int().nullable(),
});

export const UnpaidLoadsResponse = z.object({
  loads: z.array(UnpaidLoad),
  /** Known amounts only; loads waiting on a scale ticket are listed but not totaled. */
  total_cents: z.number().int(),
  total_display: z.string(),
  summary: z.string(),
});
export type UnpaidLoadsResponse = z.infer<typeof UnpaidLoadsResponse>;
