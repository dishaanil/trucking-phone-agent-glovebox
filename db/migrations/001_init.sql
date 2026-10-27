-- 001_init.sql
-- Initial schema. See docs/SPEC.md section 5.

-- Sandboxes: one per visitor or recording session
create type scenario as enum ('owner_operator', 'small_fleet');
create type access_mode as enum ('phone', 'code');

create table sandboxes (
  id uuid primary key default gen_random_uuid(),
  scenario scenario not null,
  access_mode access_mode not null,
  demo_code char(4) unique,                    -- for code mode
  active_person_seed_key text,                 -- who the visitor plays; survives reset
  is_recording boolean not null default false, -- recording sandboxes don't expire
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '24 hours'
);

create table businesses (
  id uuid primary key default gen_random_uuid(),
  sandbox_id uuid not null references sandboxes(id) on delete cascade,
  name text not null,
  demo_dot text not null default 'DEMO-0001'   -- never a realistic DOT number
);

create table people (
  id uuid primary key default gen_random_uuid(),
  sandbox_id uuid not null references sandboxes(id) on delete cascade,
  business_id uuid not null references businesses(id) on delete cascade,
  seed_key text not null,                      -- stable across resets: 'mike', 'ray', 'tommy', 'luis'
  full_name text not null,
  is_owner boolean not null default false,
  is_driver boolean not null default false,
  seed_phone text,                             -- fictional NXX-555-01xx number, E.164
  timezone text not null default 'America/Chicago',
  unique (sandbox_id, seed_key)
);

-- Which real phone maps to which seeded person, per sandbox (phone mode)
create table sandbox_phones (
  sandbox_id uuid not null references sandboxes(id) on delete cascade,
  phone_e164 text not null,
  person_id uuid not null references people(id) on delete cascade,
  primary key (sandbox_id, phone_e164)
);
-- A phone number may be active in only one unexpired sandbox at a time (enforced in API)
create index sandbox_phones_phone_idx on sandbox_phones (phone_e164);

create table trucks (
  id uuid primary key default gen_random_uuid(),
  sandbox_id uuid not null references sandboxes(id) on delete cascade,
  business_id uuid not null references businesses(id) on delete cascade,
  unit_number text not null,                   -- "1", "2", "3"
  assigned_person_id uuid references people(id),
  trailer_type text not null                   -- 'dry_van', 'hopper_bottom'
);

create type payer_type as enum ('broker', 'shipper', 'receiver');

create table payers (
  id uuid primary key default gen_random_uuid(),
  sandbox_id uuid not null references sandboxes(id) on delete cascade,
  name text not null,
  type payer_type not null,
  pays_detention boolean not null default false,
  detention_free_minutes int,
  detention_rate_cents_per_hour int,
  detention_increment_minutes int default 15,
  detention_requires_on_time boolean default true,
  late_grace_minutes int default 15
);

create type load_status as enum ('booked', 'in_transit', 'delivered', 'invoiced', 'paid');
create type rate_type as enum ('flat', 'per_ton', 'per_mile');

create table loads (
  id uuid primary key default gen_random_uuid(),
  sandbox_id uuid not null references sandboxes(id) on delete cascade,
  business_id uuid not null references businesses(id) on delete cascade,
  truck_id uuid not null references trucks(id),
  driver_id uuid not null references people(id),
  payer_id uuid not null references payers(id),
  load_number text not null,
  commodity text,                              -- 'general freight', 'corn', 'soybeans'
  rate_type rate_type not null,
  rate_cents int not null,                     -- flat: total; per_ton: per ton; per_mile: per mile
  loaded_miles int not null,
  status load_status not null default 'booked',
  invoiced_at timestamptz,
  paid_at timestamptz,                         -- set by the mock payments provider
  unique (sandbox_id, load_number)
);

create type stop_type as enum ('pickup', 'delivery');

create table stops (
  id uuid primary key default gen_random_uuid(),
  sandbox_id uuid not null references sandboxes(id) on delete cascade,
  load_id uuid not null references loads(id) on delete cascade,
  type stop_type not null,
  sequence int not null,
  facility_name text not null,
  city text not null,
  state char(2) not null,
  appointment_at timestamptz,
  arrived_at timestamptz,
  departed_at timestamptz
);

create type record_status as enum ('pending', 'confirmed', 'discarded');

create table scale_tickets (
  id uuid primary key default gen_random_uuid(),
  sandbox_id uuid not null references sandboxes(id) on delete cascade,
  load_id uuid not null references loads(id) on delete cascade,
  ticket_number text,
  net_weight_lbs int not null check (net_weight_lbs > 0),
  location text,
  status record_status not null default 'pending',
  call_id text,
  idempotency_key text unique,
  created_at timestamptz not null default now()
);

create type expense_category as enum
  ('fuel', 'def', 'toll', 'scale_fee', 'parking', 'lumper', 'repair', 'washout', 'food', 'other');
create type payment_method as enum ('card', 'cash', 'fuel_card', 'unknown');

create table expenses (
  id uuid primary key default gen_random_uuid(),
  sandbox_id uuid not null references sandboxes(id) on delete cascade,
  business_id uuid not null references businesses(id) on delete cascade,
  truck_id uuid references trucks(id),
  person_id uuid not null references people(id),
  load_id uuid references loads(id),           -- null = overhead, not tied to a load
  category expense_category not null,
  amount_cents int not null check (amount_cents > 0),
  vendor text,
  city text,
  state char(2),
  gallons numeric(8,3),                        -- fuel/def only
  payment_method payment_method not null default 'unknown',
  reimbursable boolean not null default false, -- cash lumper defaults to true
  occurred_at timestamptz not null,
  status record_status not null default 'pending',
  receipt_status text not null default 'missing', -- missing | requested | attached
  source text not null default 'voice',
  call_id text,
  idempotency_key text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create type claim_status as enum ('draft', 'sent', 'approved', 'rejected', 'paid');

create table detention_claims (
  id uuid primary key default gen_random_uuid(),
  sandbox_id uuid not null references sandboxes(id) on delete cascade,
  load_id uuid not null references loads(id) on delete cascade,
  stop_id uuid not null references stops(id) on delete cascade unique,
  billable_minutes int not null,
  amount_cents int not null,
  status claim_status not null default 'draft',
  notes text
);

create table events (                          -- audit log + dashboard feed
  id bigserial primary key,
  sandbox_id uuid not null references sandboxes(id) on delete cascade,
  call_id text,
  actor_person_id uuid,
  type text not null,                          -- expense.created, ticket.confirmed, call.started, ...
  payload jsonb not null,
  created_at timestamptz not null default now()
);
create index events_sandbox_idx on events (sandbox_id, id);
