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
