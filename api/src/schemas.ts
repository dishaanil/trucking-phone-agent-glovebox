import { z } from 'zod';

export const Scenario = z.enum(['owner_operator', 'small_fleet']);
export const AccessMode = z.enum(['phone', 'code']);
export const SeedKey = z.string().regex(/^[a-z]+$/, 'seed_key must be lowercase letters');
export const DemoCode = z.string().regex(/^\d{4}$/, 'demo_code must be 4 digits');

export const SandboxIdParams = z.object({ id: z.uuid() });

// ---------- Requests ----------

export const CreateSandboxBody = z.object({
  scenario: Scenario,
  access_mode: AccessMode,
});

export const RegisterPhoneBody = z.object({
  phone: z.string().min(1).max(32),
  seed_key: SeedKey,
});

export const SetRoleBody = z.object({ seed_key: SeedKey });

export const ResolveCallerBody = z.union([
  z.object({ phone: z.string().min(1).max(32) }).strict(),
  z.object({ demo_code: DemoCode, seed_key: SeedKey.optional() }).strict(),
]);

// ---------- Responses ----------

const PersonSummary = z.object({
  seed_key: z.string(),
  full_name: z.string(),
  is_owner: z.boolean(),
  is_driver: z.boolean(),
  truck_unit: z.string().nullable(),
});

export const SandboxView = z.object({
  id: z.uuid(),
  scenario: Scenario,
  access_mode: AccessMode,
  demo_code: DemoCode,
  active_person_seed_key: z.string().nullable(),
  is_recording: z.boolean(),
  expires_at: z.iso.datetime(),
  business: z.object({ name: z.string(), demo_dot: z.string() }),
  people: z.array(PersonSummary),
});
export type SandboxView = z.infer<typeof SandboxView>;

export const RegisterPhoneResponse = z.object({
  seed_key: z.string(),
  phone_last4: z.string(),
  moved_from_other_sandbox: z.boolean(),
});

const StopView = z.object({
  id: z.uuid(),
  type: z.enum(['pickup', 'delivery']),
  sequence: z.number().int(),
  facility_name: z.string(),
  city: z.string(),
  state: z.string(),
  appointment_at: z.iso.datetime().nullable(),
});

const ActiveLoad = z.object({
  id: z.uuid(),
  load_number: z.string(),
  status: z.enum(['booked', 'in_transit', 'delivered', 'invoiced', 'paid']),
  commodity: z.string().nullable(),
  rate_type: z.enum(['flat', 'per_ton', 'per_mile']),
  truck_unit: z.string(),
  payer_name: z.string(),
  needs_scale_ticket: z.boolean(),
  stops: z.array(StopView),
});

export const ResolveCallerResponse = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('resolved'),
    sandbox: z.object({ id: z.uuid(), scenario: Scenario, access_mode: AccessMode }),
    business: z.object({ id: z.uuid(), name: z.string() }),
    person: z.object({
      id: z.uuid(),
      seed_key: z.string(),
      full_name: z.string(),
      first_name: z.string(),
      is_owner: z.boolean(),
      is_driver: z.boolean(),
      timezone: z.string(),
    }),
    trucks: z.array(
      z.object({
        id: z.uuid(),
        unit_number: z.string(),
        trailer_type: z.string(),
        assigned_seed_key: z.string().nullable(),
      }),
    ),
    active_loads: z.array(ActiveLoad),
  }),
  z.object({
    status: z.literal('choose_person'),
    sandbox: z.object({ id: z.uuid(), scenario: Scenario, access_mode: AccessMode }),
    people: z.array(PersonSummary),
  }),
  z.object({ status: z.literal('not_found') }),
]);
export type ResolveCallerResponse = z.infer<typeof ResolveCallerResponse>;
