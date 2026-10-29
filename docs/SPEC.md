# Glovebox: Build Spec

Voice bookkeeping for owner-operators and small trucking fleets. The driver talks; the books update.

Place this file at `docs/SPEC.md`. Rules for working on the code live in `CLAUDE.md`.

---

## 1. Problem

Small trucking businesses run their books from the cab. On the road, drivers:

- Pay for fuel, tolls, scales, parking, lumpers and repairs, often with cash or paper receipts that get lost
- Collect scale tickets that determine pay on per-ton loads, then lose track of them
- Wait hours at shippers and receivers, but rarely record times well enough to bill detention

Owners, whether they drive themselves or employ a couple of drivers, don't know which truck or load made money until long after the fact.

Drivers can't type while driving, and mobile data is unreliable on rural routes. A phone call works in both cases.

## 2. Goals and non-goals

### Goals (demo must do these)
1. Recognize the caller (phone number or demo code) and load their role, truck and active loads
2. Capture one or more expenses from natural speech, with readback and confirmation
3. Capture scale tickets on per-ton loads and update load revenue
4. Handle corrections mid-call by updating the existing record
5. Capture stop times, compute billable detention, draft a detention claim (owner-operator scenario)
6. Answer money questions at the right level: load (anyone), truck and business (owners only)
7. Show every change live on a dashboard during the call
8. Let any visitor try either scenario in their own sandbox, choose how to call in, and reset

### Stretch (in priority order)
1. Text the caller after the call asking for a receipt photo, attach it to the expense
2. "Did they pay us yet?" payment status lookups beyond the seeded basics
3. Fuel purchases by state, rolled up into an IFTA-style quarterly view
4. Driver pay (percentage or per mile) as a cost in per-truck profit

### Non-goals
- Load booking, dispatch, hours-of-service tracking
- Any real bank, card, fuel card, ELD, broker or payment integration (all mocked, see section 6)
- Real user accounts or authentication beyond sandbox caller recognition
- Outbound calls

## 3. Users and roles

Roles belong to people. A person can hold one or both.

| Scenario | Person | Roles | Truck |
|---|---|---|---|
| Owner-operator | Mike (owner who drives) | owner + driver | Truck 1 |
| Small fleet | Ray (owner who drives) | owner + driver | Truck 1 |
| Small fleet | Tommy (hired driver) | driver | Truck 2 |
| Small fleet | Luis (hired driver) | driver | Truck 3 |

| Capability | Driver | Owner |
|---|---|---|
| Log expenses, scale tickets, stop times | Own truck and loads | Any truck |
| Detention check and claim draft | Own loads | Any load |
| Load profitability | Own loads | Any load |
| Truck summary (week, month) | No | Yes |
| Business summary, unpaid loads | No | Yes |

A solo owner-operator holds both roles, so every capability is available in one call. Role checks are enforced in the API; the agent also hides tools the caller can't use.

## 4. Architecture

```
 Caller's phone
      |
      v
 LiveKit Cloud (phone number, SIP, media)
      |
      v
 /agent  (Python, LiveKit Agents)
   Deepgram STT -> Gemini (tool calling) -> Cartesia TTS
      |
      |  HTTPS, typed client, idempotency keys, caller context
      v
 /api  (TypeScript, Fastify, zod) <------ /web (Next.js: demo flow + dashboard)
   business rules, role checks,                 ^
   mock integrations                            |
      |                                  SSE stream of events
      v
 Postgres (every row scoped to a sandbox)
```

**Why this split**
- The agent is a thin conversation layer. It decides what to ask and which tool to call. It never computes money or decides permissions.
- The API owns every business rule and role check, so the dashboard and the agent always agree, and a prompt mistake can't leak owner-only data.
- This mirrors how a company with an existing TypeScript + Postgres product would add voice: a new service calling an existing ledger API.

**Hosting**
- Agent: LiveKit Cloud, using the free US phone number on the Build plan
- API: Google Cloud Run, same region as the database
- Postgres: Supabase or Neon free tier
- Web: Vercel

## 5. Data model

```sql
-- 001_init.sql

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
-- A phone number may be active in only one unexpired sandbox at a time (enforced in API).
-- Registering it moves it to the newest sandbox, except phones in a recording sandbox, which are pinned.

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
  person_id uuid references people(id),        -- who logged it (002); null for seed data
  call_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()  -- (002)
);
-- One active ticket per load (002): unique (sandbox_id, load_id) where status in ('pending', 'confirmed')

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

-- 002_ledger.sql: single source of idempotency for agent writes
create table idempotency_keys (
  sandbox_id uuid not null references sandboxes(id) on delete cascade,
  key text not null,                           -- {call_id}:{turn_index}:{tool_call_index}:{tool_name}
  request_hash text not null,
  status_code int,
  response jsonb,
  created_at timestamptz not null default now(),
  primary key (sandbox_id, key)
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
```

**Design notes**
- `sandbox_id` on every table makes isolation a property of the schema, and `on delete cascade` makes cleanup and reset a single delete.
- `pending` vs `confirmed` makes the readback rule enforceable in data, not just in the prompt.
- `scale_tickets` is separate from expenses because it changes revenue, not cost.
- `payers` covers brokers and direct customers; detention terms are nullable because not every payer pays detention.
- `load_id` on expenses is nullable so overhead (a truck wash between loads) can still be captured, attributed to a truck.
- `people.seed_key` is stable across resets. Reset re-seeds people with new UUIDs, so registered phones and the active role are stored by `seed_key` and re-attached after reset.
- `sandboxes.active_person_seed_key` is the visitor's current role (`POST /sandboxes/:id/role`). Code-mode calls resolve to this person; when it is unset in the small fleet, the agent asks who is calling.

## 6. Mocked integrations

Every external system sits behind an interface in `/api/src/integrations` with a `Mock*` implementation. Nothing real is called.

| Integration | Real-world source | Mock behavior |
|---|---|---|
| Payments | Broker or customer payment | Reads `loads.paid_at` from seed data; dashboard "simulate payment" button sets it |
| Bank and card feeds | Bank, card networks | Not used in demo; seed includes a few already-confirmed expenses |
| Fuel card | Fuel card provider | Seed fuel purchases tagged `payment_method = 'fuel_card'` |
| Mileage | ELD or GPS | `loads.loaded_miles` from seed |
| Broker detention submission | Email or broker portal | Claim stays `draft`; "send" marks it `sent` and logs an event, nothing leaves the system |
| SMS receipt request (stretch) | SMS provider | Default: logs an event and shows "receipt requested" on the dashboard. Optional real SMS only to the visitor's own verified sandbox number |

The interface boundary is also a pitch point: real integrations (for example, an existing ledger's bank feeds) would replace the mocks without touching the agent.

## 7. API

All requests and responses validated with zod. Every request carries a caller context (`sandbox_id`, `person_id`), and the API checks roles on every call. Money and weights are returned with display strings, and writes return a `readback` sentence the agent speaks verbatim.

### Demo and sandbox
| Method | Path | Purpose |
|---|---|---|
| POST | `/sandboxes` | Create a sandbox from a scenario template; returns id and demo code |
| POST | `/sandboxes/:id/phones` | Register a visitor phone to a seeded person (phone mode) |
| POST | `/sandboxes/:id/role` | Switch which seeded person the visitor plays |
| POST | `/sandboxes/:id/reset` | Delete and re-copy this sandbox's seed data |
| POST | `/callers/resolve` | Agent call start: phone number or demo code to sandbox + person + roles + context |
| GET | `/sandboxes/:id/events` | SSE stream for the dashboard |

### Ledger (driver and owner)
| Method | Path | Purpose |
|---|---|---|
| POST | `/expenses` | Create a pending expense |
| PATCH | `/expenses/:id` | Correct a pending expense |
| POST | `/expenses/confirm` | Confirm pending expenses |
| POST | `/expenses/:id/discard` | Discard a pending expense |
| POST | `/loads/:id/scale-tickets` | Create a pending scale ticket |
| PATCH | `/scale-tickets/:id` | Correct a pending scale ticket |
| POST | `/scale-tickets/confirm` | Confirm pending tickets |
| POST | `/stops/:id/times` | Record arrival and/or departure |
| GET | `/stops/:id/detention` | Compute detention (no write) |
| POST | `/stops/:id/detention-claims` | Create a draft detention claim |
| GET | `/loads/:id/profitability` | Load revenue, costs, net, cost per mile |

### Owner only
| Method | Path | Purpose |
|---|---|---|
| GET | `/trucks/:id/summary?range=week` | Truck revenue, costs, net for a period |
| GET | `/businesses/:id/summary?range=week` | Business totals, best and worst truck |
| GET | `/businesses/:id/unpaid-loads` | Delivered or invoiced loads not yet paid |

### POST /expenses (example)

Request (from agent):
```json
{
  "category": "fuel",
  "amount": "512.40",
  "vendor": "Love's",
  "city": "Joplin",
  "state": "MO",
  "gallons": "140",
  "payment_method": "fuel_card",
  "load_id": "6f1c...",
  "occurred_at": "2026-10-27T14:05:00-05:00",
  "call_id": "call_abc",
  "idempotency_key": "call_abc:7:0:log_expense"
}
```

Response:
```json
{
  "id": "...",
  "status": "pending",
  "amount_cents": 51240,
  "amount_display": "512 dollars and 40 cents",
  "load_number": "4471",
  "truck_unit": "1",
  "readback": "Fuel, 512 dollars and 40 cents, 140 gallons at Love's in Joplin, Missouri.",
  "needs_confirmation": false,
  "confirmation_reasons": [],
  "confirmation_prompt": null
}
```

The API takes UUIDs (`load_id`, `truck_id`); the agent maps human load and truck numbers using the caller context. An expense with a load uses the load's truck, and a different `truck_id` is a 400. Without a load, it defaults to the caller's own truck, else business overhead (owners only).

### Caller context and idempotency
- Agent endpoints require the service token plus `x-sandbox-id` and `x-person-id` headers. Roles are read from the database, never from the request.
- Every agent write carries `call_id` and an `idempotency_key` of the form `{call_id}:{turn_index}:{tool_call_index}:{tool_name}`, where `tool_call_index` counts tool calls within the turn (so three expenses in one breath get three keys).
- Keys are unique per `(sandbox_id, key)` in the `idempotency_keys` table, the single source of idempotency. The key is inserted in the same transaction as the write; if the write fails, neither is kept.
- A replay with the same request returns the stored response (header `idempotent-replayed: true`). The same key with a different request, route or caller is a 409.

### Corrections, confirmation and voids
- **Correct** (`PATCH`): updates the record in place, never a duplicate. Allowed on pending and confirmed records; a confirmed record goes back to `pending` with a new readback. Every correction writes an event with old and new values. A correction that changes nothing is a no-op.
- **Confirm**: returns a result per id (`confirmed`, `already_confirmed`, `discarded`, `not_found`, `forbidden`).
- **Discard is a void**: pending records can be voided by anyone allowed to edit them. Confirmed records can be voided by the person who logged them during the same call, and by owners anytime. Always writes an audit event.
- **Scale tickets**: a load has at most one pending or confirmed ticket. Logging another returns 409 `ticket_exists` with the existing ticket's id and readback, so the agent corrects it instead.
- **Who can edit**: drivers, records they logged or that are on their own load or truck; owners, anything in the business. Otherwise 403 with a speakable `message`.

### Validation rules
- Amounts are decimal strings: `$` and commas are stripped, more than two decimals is a 400, and so is anything over $100,000.
- Over a per-category ceiling (fuel $2,000, DEF $300, toll $200, scale fee $50, parking $100, lumper $500, repair $5,000, washout $150, food $100, other $1,000), the record is still created pending with `needs_confirmation: true`, a reason code and a speakable `confirmation_prompt`, so the agent double-checks.
- Price per gallon outside $2.00 to $7.00 (fuel) or $1.50 to $8.00 (DEF) is flagged the same way. Gallons on any other category is a 400.
- Scale ticket net weight outside 20,000 to 60,000 lb (hopper bottom) or 1,000 to 48,000 lb (dry van) is flagged; over 100,000 lb is a 400. Weights are whole pounds.
- `occurred_at` defaults to now. More than 5 minutes in the future is a 400; more than 30 days ago is flagged.
- Cash lumper fees are reimbursable by default; the caller can override.
- `departed_at` must be after `arrived_at`; neither may be in the future.
- Confirming a record that is not `pending` is a no-op, not an error.
- Owner-only endpoints return `403` with a speakable `message` for driver-only callers.

## 8. Revenue and profitability

### Load revenue by rate type
```
flat:     revenue = rate_cents
per_ton:  revenue = round(confirmed_ticket_net_weight_lbs / 2000 * rate_cents)
per_mile: revenue = loaded_miles * rate_cents
```
A per-ton load with no confirmed scale ticket has `revenue = null` and the agent says pay is pending the scale ticket.

### Profitability at three levels
```
load:
  revenue         = load revenue + approved/paid detention
  pending_revenue = draft/sent detention + reimbursable expenses
  costs           = confirmed, non-reimbursable expenses on the load
  net             = revenue - costs
  cost_per_mile   = costs / loaded_miles

truck (range):    sum over loads on the truck in range + truck overhead expenses in range
business (range): sum over trucks + business overhead
```
**Ranges:** "this week" is the calendar week from Monday 00:00 to now, in the business's timezone. "Last 7 days" is supported when the caller says it.

Each response includes a one-sentence `summary` for the agent to speak, e.g. "Truck 2 grossed 1,850 this week, spent 640, so it netted 1,210."

## 9. Detention

Detention applies only when the payer has `pays_detention = true`. It is part of the owner-operator scenario (brokered freight) and available but not demoed in the small-fleet scenario until we confirm how common it is for grain hauling.

```
on_time     = arrived_at <= appointment_at + late_grace_minutes
clock_start = max(arrived_at, appointment_at)   // arriving early doesn't start the clock early
waited      = departed_at - clock_start
billable    = max(0, waited - free_minutes)
billable    = floor(billable / increment) * increment
amount      = billable / 60 * rate_per_hour
if requires_on_time and not on_time: eligible = false, note "late arrival, detention may be disputed"
```

Example (owner-operator seed): appointment 8:00, arrived 7:50, departed 11:05, 120 free minutes, $50/hr, 15-minute increments. Clock starts 8:00, waited 185 minutes, billable 65, rounded to 60, amount $50.00.

All terms are fictional seed values stored on the payer record, not code constants.

## 10. Agent design

### Caller resolution at call start
```
caller ID matches an unexpired sandbox phone?
  yes -> load that person's sandbox, roles, truck, active loads
  no  -> "Welcome to the Glovebox demo. What's your 4-digit demo code?"
         (spoken or keypad)
         valid code -> small fleet: "Are you calling as the owner or as a driver?"
                       owner-operator: continue as Mike
         invalid twice -> point them to the website, end call politely
```

### Call flow
```
greet by name, state current load
 -> listen
 -> [expense]         log_expense (pending) ... readback all -> confirm / correct
 -> [scale ticket]    log_scale_ticket -> readback -> confirm -> load revenue updates
 -> [stop times]      log_stop_times -> check_detention -> offer claim -> create claim
 -> [load money]      get_load_profitability -> speak summary
 -> [owner money]     get_truck_summary / get_business_summary / list_unpaid_loads
 -> [not allowed]     one friendly sentence, offer what they can do
 -> "Anything else?" -> wrap up, mention receipt photo if any are missing
```

### Tools (each maps to one API call)

| Tool | Available to | API |
|---|---|---|
| `log_expense` | driver, owner | POST /expenses |
| `correct_expense` | driver, owner | PATCH /expenses/:id |
| `confirm_records` | driver, owner | POST /expenses/confirm, /scale-tickets/confirm |
| `discard_expense` | driver, owner | POST /expenses/:id/discard |
| `log_scale_ticket` | driver, owner | POST /loads/:id/scale-tickets |
| `correct_scale_ticket` | driver, owner | PATCH /scale-tickets/:id |
| `log_stop_times` | driver, owner | POST /stops/:id/times |
| `check_detention` | driver, owner | GET /stops/:id/detention |
| `create_detention_claim` | driver, owner | POST /stops/:id/detention-claims |
| `get_load_profitability` | driver, owner | GET /loads/:id/profitability |
| `get_truck_summary` | owner | GET /trucks/:id/summary |
| `get_business_summary` | owner | GET /businesses/:id/summary |
| `list_unpaid_loads` | owner | GET /businesses/:id/unpaid-loads |
| `request_receipt_photo` | driver, owner (stretch) | POST /expenses/:id/receipt-request |
| `transfer_to_human` | all | none (demo: ends call with a message) |

The agent resolves load numbers, truck numbers and stop names to IDs using the context fetched at call start, so the LLM works with human terms, not UUIDs.

### Session state (per call)
- `call_id`, `turn_index`, `tool_call_index` (per turn, for idempotency keys), `sandbox_id`, `person_id`, roles
- active loads and trucks from caller resolution
- pending record IDs awaiting confirmation
- tool error counts, for the two-strikes escalation rule

### Voice and turn-taking
- Start with LiveKit's turn detector and default endpointing, then tune with evals. Drivers pause mid-thought, so lean toward waiting slightly longer before responding.
- Allow interruptions at all times.
- Long silence: one check-in ("Still there?"), then wrap up politely after a second long silence.
- Short filler line before slow tool calls ("Got it, one sec").
- Deepgram keyword boosting for truck stop chains, seeded facility names, commodity words and category words.

### Latency budget (targets, measured in evals)
- Caller stops speaking to agent's first audio: under about 1 second typical
- Agent to API tool round trip: under about 150 ms (same region)

## 11. Web: demo flow and dashboard

### Landing and setup (no hidden toggles)
1. **Landing page:** what Glovebox does in one sentence, a "Fictional demo data" note, and a large **Start a demo** button.
2. **Choose a scenario:** two large cards.
   - **Owner-operator:** "Kestrel Line Freight. One truck, one owner who drives."
   - **Small fleet:** "Cedar Fork Hauling. Three hopper bottom trucks, an owner and two hired drivers."
3. **Choose how to call:** two large cards.
   - **Use my phone number:** enter your number, pick who you are (small fleet: owner or a driver), call. Recognized by caller ID, like the real product. Note on the page: your number is only used to recognize your call and is deleted when the demo expires in 24 hours.
   - **Use a demo code:** no number needed. Call and say or key in your 4-digit code.
4. **Call screen:** the phone number in large type, your demo code if using one, and three suggested things to say for your role.

### Dashboard
- **Persistent header:** scenario, access mode, current role, each with a clearly labeled **Switch** button. Also **Reset demo** (with a confirm dialog) and the "Fictional demo data" label.
- **Live call panel:** call status, who is calling, latest agent action.
- **Ledger:** expenses and scale tickets with status chips (pending amber, confirmed green, discarded struck through), newest first, highlight on change.
- **Load card:** rate type, revenue (or "pending scale ticket"), costs, net, cost per mile.
- **Detention card** (owner-operator): stop times, billable time, claim draft and notes.
- **Fleet view** (small fleet, owner role): one row per truck with revenue, costs, net this week; unpaid loads list.
- **Mock controls:** "simulate payment received" on unpaid loads, so the payments mock is visible and testable.

Updates arrive via SSE. No polling.

### Recording mode
A recording sandbox is a normal sandbox with `is_recording = true` (never expires) and your two real phones registered: one to the owner, one to a hired driver. Created by a script, not through the public UI. Its phones are pinned: public registration of a pinned number is refused with a generic message that doesn't reveal it's registered elsewhere.

## 12. Seed scenarios

All names, numbers and amounts below are fictional. Before publishing, run the name check in CLAUDE.md and rename anything that matches a real company.

### Scenario A: owner-operator
- **Business:** Kestrel Line Freight LLC, DOT `DEMO-0001`
- **Person:** Mike Delgren (`mike`), owner + driver, (270) 555-0101 (seed only), America/Chicago
- **Truck 1:** dry van
- **Payer:** Bluegate Freight Partners (broker), pays detention: 120 free minutes, $50/hr, 15-minute increments, on time required, 15-minute grace
- **Load 4471:** Chicago, IL to Atlanta, GA, flat rate $2,400, 715 loaded miles, in transit
  - Pickup: Harlan Point Cold Storage, Chicago, appointment 8:00 AM today
  - Delivery: Southmere Distribution, Atlanta, appointment tomorrow 2:00 PM
- **Load 4502:** booked for later this week (tests "which load?")
- **Load 4390:** delivered last week, invoiced, unpaid
- **Existing confirmed expenses on 4471:** one toll, one scale fee

### Scenario B: small fleet (grain hauling)
- **Business:** Cedar Fork Hauling LLC, western Kentucky, DOT `DEMO-0002`
- **People:**
  - Ray Whitlock (`ray`), owner + driver, Truck 1, (270) 555-0111
  - Tommy Reece (`tommy`), driver, Truck 2, (270) 555-0112
  - Luis Ortega (`luis`), driver, Truck 3, (270) 555-0113
- **Trucks 1 to 3:** hopper bottom
- **Payers:** Millbrook Grain Co. (receiver, pays per ton, no detention); Prairie Run Brokerage (broker, flat rate, pays detention)
- **Loads this week:**
  - 7712, Truck 2 (Tommy): corn to Millbrook Grain Co. river terminal, per ton $14.00, 85 loaded miles, delivered, **no scale ticket yet** (demo fills it)
  - 7705, Truck 2: soybeans, per ton, delivered, ticket confirmed, unpaid
  - 7708, Truck 1 (Ray): fertilizer backhaul, flat $780, Prairie Run Brokerage, delivered, paid
  - 7710, Truck 3 (Luis): corn, per ton, delivered, paid
- **Existing confirmed expenses:** a few fuel purchases across Kentucky, Tennessee, Illinois and Indiana (for the fuel by state stretch), one repair on Truck 3

Seed templates are deterministic and use relative dates ("today", "this week") computed at copy time, so the demo always looks current. Seed activity for this week falls between Monday 00:00 (business timezone) and now, so weekly summaries are never empty, even early on a Monday. Load 4390 falls in the previous week.

Seed phone numbers use the reserved fictional range NXX-555-0100 to 0199 (for example (270) 555-0101), never area code 555.

Each seed template is a Postgres function, `seed_owner_operator(sandbox_id uuid)` and `seed_small_fleet(sandbox_id uuid)`, defined with `create or replace` in `/db/seeds/` and re-applied by `db/migrate.sh`. The API calls it with a parameterized `select seed_small_fleet($1)`.

## 13. Demo stories

### Story A: owner-operator (one call, about 2 minutes)
1. Mike calls. Agent: "Hey Mike, you're on load 4471, Chicago to Atlanta. What've you got?"
2. Mike: fuel at Love's in Joplin, a lumper paid cash, and "they held me at the shipper, got there 7:50, didn't leave till after 11."
3. Three pending rows appear; agent reads them back together.
4. Mike corrects the fuel amount; the same row updates. He confirms; rows turn green.
5. Agent: detention is billable, 1 hour, 50 dollars, want me to draft the claim? Mike: yes. Claim card appears.
6. Mike: "How am I doing on this load?" Load card updates; agent answers in one sentence.
7. Wrap up with a receipt reminder for the cash lumper.

### Story B: small fleet (two calls, about 3 minutes)
**Call 1, Tommy (hired driver, Truck 2):**
1. Agent greets Tommy, confirms load 7712 is delivered and needs a scale ticket.
2. Tommy gives the ticket weight, a fuel stop and a washout fee in one breath.
3. Pending rows appear; load 7712's revenue switches from "pending scale ticket" to a dollar amount.
4. Tommy corrects the weight mid-readback; same row updates. He confirms.
5. Curveball: "How much did we make this week?" Agent: "That's one for Ray to check. Want the numbers on your load instead?"

**Call 2, Ray (owner, Truck 1):**
1. "How did truck 2 do this week?" Agent answers with revenue, costs and net, including what Tommy just logged.
2. "Anything we haven't been paid for?" Agent names the unpaid loads and amounts.
3. Dashboard shows the fleet view throughout.

The punchline: the owner's answer includes what the driver logged two minutes earlier.

### Recorded video
- Main: Story B, using two real phones registered in a recording sandbox
- Optional short clip: Story A
- Tag the commit used (`recording-v1`)

### Live demo
- Visitors choose scenario, access mode and role on the website, then call
- Planned curveballs work in both: interruptions, corrections, an owner-only question from a driver

## 14. Evals

### Caller simulator
Text mode first (fast, cheap): an LLM plays the caller using a persona and a goal list, talking to the agent's prompt and tools against a fresh sandbox. Voice mode later for latency and turn-taking.

Personas:
1. **Clean:** one item at a time, clear numbers
2. **Dumper:** three or four items in one breath
3. **Corrector:** changes numbers mid-sentence ("52,800, no, 52,080")
4. **Rambler:** long stories with the facts buried inside
5. **Vague:** "the usual place," "a couple hundred"
6. **Grumpy:** short, impatient, interrupts readbacks
7. **Two loads:** expense without saying which load
8. **Overreaching driver:** asks owner-only questions
9. **Owner:** fleet questions with relative dates ("this week," "last Tuesday")

Realistic phrasing can be seeded from public call center transcripts (CallCenterEN, SpokenWOZ) for disfluencies and interruptions.

### Metrics
- **Field accuracy:** category, amount, vendor, state, weight match ground truth
- **Amount and weight accuracy:** tracked separately; the most important numbers
- **Duplicate rate:** corrections that created a second record (target 0)
- **Unconfirmed writes:** confirmed records without a readback in the transcript (target 0)
- **Permission leaks:** owner-only data spoken to a driver (target 0)
- **Turns to completion** and **escalation rate**
- **Voice mode:** response latency p50 and p95, interruptions handled correctly

Every bug found in a rehearsal becomes a new eval case.

## 15. Build plan

| Day | Focus | Done when |
|---|---|---|
| 1 | Repo scaffold, migrations, both seed templates, sandbox create/reset, caller resolve | A new sandbox of either scenario resolves a seed phone and a demo code to the right person |
| 2 | Expenses and scale tickets (create, correct, confirm, discard), validation, readbacks, role checks, tests | All ledger endpoints tested, including idempotency and 403s |
| 3 | Rate types, profitability at three levels, detention, unpaid loads, mock integrations, SSE | Detention and per-ton examples pass as tests |
| 4 | Agent: LiveKit starter, caller resolution, role-filtered tools, system prompt; test in browser playground | Both demo stories work end to end in the browser |
| 5 | Web: landing, scenario and access cards, call screen, dashboard, header with Switch and Reset; phone number connected | A visitor can set up a sandbox, call, and watch it update live |
| 6 | Text-mode simulator, metrics, fixes, turn-taking tuning | All personas pass; zero duplicates, unconfirmed writes and permission leaks |
| 7 | Deploy, name check, recording sandbox, record video, tag, rehearse | Video recorded, public demo live, reset and expiry verified |

## 16. Decisions log

| Decision | Choice | Reason |
|---|---|---|
| Name | Glovebox | Where every trucker's receipts end up |
| Confirmation | Any clear affirmative counts, including mid-sentence "yup" | Natural for drivers; readback still always happens |
| Cash lumper | Reimbursable by default, counted as pending revenue | Lumper fees are commonly billed back to the payer |
| Stretch order | Receipt SMS, payment status, fuel by state, driver pay | Most demo value first |
| Users | Roles per person; owner-operator is a fleet of one | One design serves both segments |
| Demo versions | One codebase, configuration and sandboxes, no demo branch | Avoids drift; recorded video is just a sandbox |
| Data | Fully fictional, all integrations mocked | No real customers or systems in a public demo |

## 17. Open questions

- How common is detention billing on grain hauls to elevators? (Good question for Ambrook.) Until confirmed, detention is not part of Story B.
- Are per-ton rates the usual pay model for small grain haulers, or mixed with flat rates? Seed currently mixes both.
- Should owners be able to review and approve driver-logged expenses? Not in the demo; worth asking.
