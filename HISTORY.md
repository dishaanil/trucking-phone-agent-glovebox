# HISTORY.md

Project memory for Glovebox across build sessions. Rules for maintaining this file are in `CLAUDE.md` under "Project memory".

---

## Current state

*Overwritten each session.*

- **Phase:** Day 3a (profitability) built on `feat/day3-profitability`, awaiting commit approval.
- **Done:** Days 1 and 2 merged (PR #1, #2, #3). 3a: `db/migrations/003_timezones.sql` (`businesses.timezone`, `stops.timezone`); seeds set both and compute appointments in facility local time; `GET /loads/:id/profitability` and `GET /loads?number=`. 158 vitest tests pass; lint and typecheck clean.
- **Next:** 3b stop times, detention and claims (incl. `HH:MM` resolution, overnight wait test, delivery sets status, Story A pickup relative to now); 3c summaries, unpaid loads, mocks and demo endpoints; 3d SSE. Day 5: call screen suggested stop times from seed data.
- **Not built:** scale ticket discard (not in the SPEC endpoint list); `/api/src/integrations` (3c).
- **Blockers:** none.

---

## Decisions

*Append-only. To reverse a decision, add a new entry that supersedes the old one.*

### 2026-10-26: Build a trucking voice agent first
- **Choice:** Prioritize the trucking phone agent over the appliance repair agent.
- **Why:** Mentioned the idea to Ambrook's founder; they plan to build something similar. Ambrook is expanding from farm accounting into trucking.
- **Alternatives:** Appliance repair intake agent (still planned for the Take2 hackathon).

### 2026-10-26: Position as voice bookkeeping, not dispatch
- **Choice:** Expense capture, scale tickets, detention, profitability. No dispatch or hours-of-service logic.
- **Why:** Ambrook is an accounting and payments company. Their trucking customers are small family-run businesses whose pain is money, not routing.
- **Alternatives:** Dispatch check-in line (better fit for larger carriers with a dispatch office).

### 2026-10-26: Python voice agent plus TypeScript ledger API
- **Choice:** Agent in Python (LiveKit Agents). Business logic in a TypeScript (Fastify, zod) API over Postgres. Dashboard in Next.js.
- **Why:** LiveKit's Python SDK is the most mature. Ambrook's stack is mostly TypeScript on Postgres and GCP, so a thin voice layer over a typed ledger API mirrors how they would add voice. Keeps money logic testable without voice.
- **Alternatives:** Single Python service (simpler, but less aligned and mixes conversation with business rules).
- **Cost accepted:** one network hop per tool call; mitigated by same-region hosting and filler lines.

### 2026-10-26: Voice providers
- **Choice:** LiveKit (transport, turn-taking, phone number), Deepgram (STT), Gemini Flash (LLM with tool calling), Cartesia (TTS). Deepgram TTS during development to save Cartesia's small free tier.
- **Why:** Matches the Take2 starter kit and credits; all have free tiers.

### 2026-10-27: The API writes the readback sentence
- **Choice:** Write endpoints return a `readback` string the agent speaks verbatim.
- **Why:** Guarantees spoken numbers match stored numbers. The LLM never formats or computes money.

### 2026-10-27: Pending vs confirmed records
- **Choice:** Expenses and scale tickets are created `pending`, confirmed only after readback.
- **Why:** Makes the confirmation rule enforceable in data, and gives a clear audit trail of what the caller approved.

### 2026-10-27: Name is Glovebox
- **Why:** Where every trucker's receipts end up. Easy to remember.
- **Alternatives:** Haulbook, Ten-Four, Shotgun, Breaker. Avoided "Logbook" because truckers use that word for their legal driving-hours log.

### 2026-10-27: Any clear affirmative confirms
- **Choice:** "Yes", "yep", "yup", "that's right", "ten-four" count, including mid-sentence.
- **Why:** Natural for drivers. The readback still always happens first.

### 2026-10-27: Cash lumper fees are reimbursable by default
- **Choice:** `reimbursable = true`, counted as pending revenue.
- **Why:** Lumper fees are commonly billed back to the payer.

### 2026-10-27: Stretch priority order
- **Choice:** Receipt SMS, then payment status, then fuel by state (IFTA), then driver pay.

### 2026-10-27: Support owner-operators and small fleets with one design
- **Choice:** Roles belong to people (`is_owner`, `is_driver`). An owner-operator is a fleet of one. Trucks table added; profitability at load, truck and business levels.
- **Why:** Research on a real Ambrook trucking customer showed a small multi-truck grain hauler, not a solo operator. One model covers both.
- **Note:** That customer's real identity is never used in data or demos.

### 2026-10-27: Rate types
- **Choice:** Loads have `rate_type`: `flat`, `per_ton`, `per_mile`. Per-ton revenue comes from the confirmed scale ticket weight.
- **Why:** Grain hauling is often paid by weight. Assumption to verify with Ambrook.

### 2026-10-27: Two demo scenarios
- **Choice:** Scenario A, owner-operator (Kestrel Line Freight LLC, Mike Delgren, brokered dry van, includes detention). Scenario B, small fleet (Cedar Fork Hauling LLC, Ray, Tommy, Luis, three hopper bottoms, grain). Story B is the main recorded video; its punchline is the owner's answer including what the driver logged minutes earlier.
- **Why:** Each scenario shows a different buyer. Detention is excluded from Story B until confirmed for grain hauls.

### 2026-10-27: Fictional data only, all integrations mocked
- **Choice:** All names, phone numbers (555-01xx), DOT numbers (`DEMO-000x`) and amounts are made up. Payments, bank feeds, fuel card, mileage, broker submission and SMS are mocked behind interfaces.
- **Why:** A public demo must not expose real customers or call real systems.
- **Note:** Renamed the original "Alvarez Freight LLC" because many real carriers share the Alvarez name. Name check against FMCSA SAFER required before publishing.

### 2026-10-27: Sandboxes instead of a demo branch
- **Choice:** One codebase on `main`. Each visitor gets an isolated sandbox (copy of a seed template, 24-hour expiry, own reset). The recorded video uses a non-expiring recording sandbox. Tag the commit used for each recording.
- **Why:** A separate demo branch drifts from main. Shared seed data breaks when two visitors try the demo at once.
- **Alternatives:** Long-lived demo branch (rejected), single shared seed with global reset (rejected).

### 2026-10-27: Visible demo choices
- **Choice:** Visitors choose scenario and access mode (own phone number, or demo code) on large cards. The dashboard header always shows scenario, mode and role with Switch buttons, plus Reset.
- **Why:** The choice should be impossible to miss, not a hidden toggle.

### 2026-10-27: Commits and PRs are authored as Disha only
- **Choice:** No AI attribution in commits or PRs. Claude Code attribution disabled in settings, plus git hooks to strip trailers and block Claude identities. No push, merge, tag or PR without explicit approval in the current conversation.
- **Why:** Personal portfolio repo; authorship must be hers.

### 2026-10-27: Project memory in HISTORY.md
- **Choice:** Maintain this file across sessions with current state, append-only decisions, learnings, open threads and a session log.
- **Why:** Preserve reasoning across build sessions and make decisions easy to defend in interviews.

### 2026-10-27: Seed phone numbers use NXX-555-0100 to 0199
- **Choice:** Seed phones are like (270) 555-0101, stored as E.164 (`+12705550101`). Mike 0101, Ray 0111, Tommy 0112, Luis 0113.
- **Why:** The reserved fictional range is the 555-01xx line block inside an area code. SPEC's original `(555) 010-0101` used area code 555, which is not that range.

### 2026-10-27: Stable `people.seed_key`
- **Choice:** `people.seed_key` (`mike`, `ray`, `tommy`, `luis`), unique per sandbox. Reset saves phone registrations by seed_key and re-attaches them to the re-seeded people.
- **Why:** Reset re-creates people with new UUIDs, and `sandbox_phones` cascades from `people`, so phone registrations would vanish on reset.
- **Alternatives:** Keep person UUIDs fixed across resets (would need deterministic UUIDs in seeds; more fragile).

### 2026-10-27: `sandboxes.active_person_seed_key` stores the visitor's role
- **Choice:** New column, set by `POST /sandboxes/:id/role`. Defaults to `mike` for owner-operator, null for small fleet. Code-mode calls resolve to this person; if null, resolve returns `choose_person` and the agent asks.
- **Why:** CLAUDE.md says the role lives on the sandbox, but the schema had no column for it. Stored by seed_key so it survives reset.

### 2026-10-27: Seed templates are Postgres functions
- **Choice:** `seed_owner_operator(uuid)` and `seed_small_fleet(uuid)`, defined with `create or replace` in `/db/seeds/*.sql` and re-applied on every `db/migrate.sh` run. The API calls `select seed_small_fleet($1)`.
- **Why:** A normal parameterized call that is easy to test and needs no hidden session state, unlike `set_config`, which silently breaks if it runs outside the seeding transaction. Keeping them in `/db/seeds/` (not numbered migrations) means changing seed data doesn't need a new migration each time.
- **Alternatives:** `set_config('glovebox.sandbox_id', ...)` plus `current_setting` in plain SQL seeds; functions created in numbered migrations (every seed tweak would be a new migration).

### 2026-10-27: Day 1 sandbox and caller rules
- **Choice:** Registering a phone already used in another sandbox moves it to the new one (newest wins). Every sandbox gets a demo code regardless of access mode, so switching modes just works. Expired visitor sandboxes are deleted when a new one is created. `/callers/resolve` requires a service token (`Authorization: Bearer`); sandbox endpoints are public for the web. Resolve returns a `status` union (`resolved`, `choose_person`, `not_found`) instead of 404s. Active loads are the caller's own booked, in-transit, or delivered per-ton loads still missing a confirmed scale ticket.
- **Why:** Proposed as Day 1 assumptions and approved. A visitor who starts over shouldn't get stuck.
- **Deferred:** Rate limiting on public sandbox endpoints (Day 7, deploy).

### 2026-10-27: "This week" is the calendar week from Monday
- **Choice:** "This week" means Monday 00:00 to now, in the business's timezone. "Last 7 days" is supported when the caller says it. Seed timestamps for this week must fall between the start of the current week and now, so summaries are never empty.
- **Why:** Matches how owners talk about a week. Resolves the open thread about Monday seed data falling into last week.
- **Alternatives:** Rolling 7 days as the default (rejected; supported only when asked).
- **Implementation:** `seed_this_week()` in `db/seeds/00_helpers.sql` uses a realistic offset ("60 minutes ago") but never earlier than Monday 00:00; early in the week it falls back to a proportional position between Monday and now, keeping events in order. Seed functions take an optional `p_now` so tests can simulate any time (`api/test/seeds.test.ts`). Applying "this week" in summaries is Day 3.

### 2026-10-27: Phones in a recording sandbox are pinned
- **Choice:** A phone registered in a recording sandbox (`is_recording = true`) can't be moved by public registration. The request is refused with a generic message that doesn't reveal the number is registered elsewhere. Supersedes "newest wins" (Day 1 sandbox and caller rules) for recording phones only; visitor phones still move to the newest sandbox.
- **Why:** A visitor demo must not be able to break the recorded video setup, or learn which numbers are in use.
- **Implementation:** `registerPhone` returns 409 `phone_unavailable` ("That number can't be used for this demo. Try a demo code instead.") when the number is in another sandbox that is recording. A recording sandbox can still re-map its own phones and take phones from visitor sandboxes. Also removed `moved_from_other_sandbox` from the response, since it revealed whether a number was in use in another visitor's demo.

### 2026-10-27: CLAUDE.md describes seed functions
- **Choice:** Updated "Conventions > SQL" to say seed templates are Postgres functions called with a parameterized select, replacing the `:sandbox_id` parameter wording.
- **Why:** Matches the seed functions decision. Resolves the open thread.

### 2026-10-27: Push over SSH
- **Choice:** `origin` is `git@github.com:dishaanil/trucking-phone-agent-glovebox.git`.
- **Why:** The HTTPS credential in the macOS keychain belongs to a different GitHub account and got a 403. The SSH key authenticates as dishaanil, matching `gh`.

### 2026-10-27: Idempotency keys are unique per tool call and scoped per sandbox
- **Choice:** Key format `{call_id}:{turn_index}:{tool_call_index}:{tool_name}`, where `tool_call_index` counts tool calls within the turn. Keys are unique per `(sandbox_id, key)`. The `idempotency_keys` table is the single source (the per-table `idempotency_key` columns are dropped). The key is inserted in the same transaction as the write; a replay with the same request returns the stored response, a different request with the same key returns 409.
- **Why:** The spec's `{call_id}:{turn_index}:{tool_name}` collides when one turn makes several calls to the same tool (three expenses in one breath). One table and one transaction means a key can never exist without its write, or the reverse.
- **Supersedes:** the key format in SPEC section 7 and CLAUDE.md core invariants.

### 2026-10-27: Day 2 ledger rules
- **Load references:** the API takes UUIDs (`load_id`, `truck_id`); the agent maps human numbers using caller context. `GET /loads?number=` is added to the Day 3 plan for loads outside the caller's active list.
- **Expense truck:** an expense with a load uses the load's truck; a `truck_id` that doesn't match is a 400. Without a load, it defaults to the caller's assigned truck, else business overhead.
- **Corrections:** allowed on pending and confirmed records; a confirmed record goes back to `pending` with a new readback. Every correction writes an event with old and new values.
- **Discard is a void:** pending records can be voided by anyone allowed to edit them. Confirmed records can be voided by the person who logged them during the same call, and by owners anytime. Always writes an audit event.
- **Second scale ticket:** logging a ticket when the load already has a pending or confirmed one returns 409 with the existing ticket's id and readback.
- **Validation:** fictional ceilings (fuel $2,000, DEF $300, toll $200, scale fee $50, parking $100, lumper $500, repair $5,000, washout $150, food $100, other $1,000), fuel $2.00 to $7.00 per gallon, net weight 20,000 to 60,000 lb for hopper bottoms and 1,000 to 48,000 lb for dry vans. Outside these the record is still created pending with `needs_confirmation`. Hard 400s: over $100,000 or 100,000 lb, `occurred_at` more than 5 minutes in the future. `occurred_at` older than 30 days is flagged for confirmation. `occurred_at` defaults to now.
- **Amount parsing:** strips `$` and commas, rejects more than two decimals.
- **Confirm:** returns a result per id.
- **Cash lumper:** reimbursable by default; the caller can override.
- **Why:** Proposed as Day 2 assumptions; approved with the changes above.

### 2026-10-27: Stop-time demo timing
- **Choice:** Seed Story A's pickup relative to now (Day 3), and have the call screen generate the suggested stop times from seed data (Day 5).
- **Why:** A fixed "8:00 AM today" pickup with "left after 11" is in the future if the demo runs before 11 AM Chicago time, and stop-time validation rejects future times.

### 2026-10-29: Day 3 split into four PRs
- **Choice:** 3a profitability and `GET /loads?number=`; 3b stop times, detention and claims; 3c truck and business summaries, unpaid loads and mocks; 3d SSE.
- **Why:** Day 3 is too large for one reviewable change.

### 2026-10-29: Timezones for businesses and stops
- **Choice:** Add `businesses.timezone` (default `America/Chicago`) for "this week" ranges, and `stops.timezone`, seeded per facility. Local `HH:MM` stop times resolve in the stop's timezone, falling back to the business timezone.
- **Why:** SPEC says "business timezone" but the table had none, and loads cross time zones (Chicago to Atlanta).
- **Alternatives:** the owner's `people.timezone`.

### 2026-10-29: Resolving `HH:MM` stop times
- **Choice:** Arrival resolves to the occurrence nearest the appointment (nearest now if there is no appointment). Departure resolves to the first occurrence after arrival that isn't in the future. An overnight wait (arrive 22:00, leave 02:00) is tested.
- **Why:** The LLM passes the caller's words, not dates; the API does the date math.

### 2026-10-29: Revenue counts in the week of delivery
- **Choice:** A load's revenue counts in the range containing its delivery stop's departure. Expenses count by `occurred_at`, including those on loads not yet delivered. Seeds set delivery departure times on every delivered load. Spoken summaries mention in-transit loads whose costs are included.
- **Why:** Revenue is earned at delivery; costs happen when they happen.

### 2026-10-29: Revenue uses confirmed scale tickets only, with a projection
- **Choice:** Per-ton revenue uses only a confirmed ticket. With a pending ticket, profitability also returns a projected amount so the dashboard can show it as pending. Story B step 3 is reworded so revenue switches at confirmation.
- **Why:** Keeps "nothing counts until read back and confirmed" while the dashboard still shows the change.

### 2026-10-29: Detention claims on late arrivals
- **Choice:** When the payer requires on-time arrival and the driver was late, a claim can still be drafted, with the note "late arrival, detention may be disputed". The agent says the note out loud.
- **Why:** The driver decides; the note sets expectations.

### 2026-10-29: Stop times, delivery and access
- **Choice:** Stop times have no pending or confirmed state; they are written with a readback and a correction overwrites them, with an event carrying old and new values. A departure from the final delivery stop sets an in-transit load to `delivered`, with an event. Stop times, detention checks and claims are open to drivers on their own loads and to owners; summaries and unpaid loads are owner-only.
- **Why:** Proposed as Day 3 assumptions 5 to 7; assumption 6 (no status change) was reversed.

### 2026-10-29: Demo endpoints for mocks
- **Choice:** `POST /sandboxes/:id/loads/:loadId/simulate-payment` and `POST /sandboxes/:id/detention-claims/:id/send`, public by sandbox id like the other sandbox routes. Each checks that the record belongs to the sandbox. Event payloads never contain phone numbers.
- **Why:** The Day 5 dashboard needs visible, testable mock controls.

### 2026-10-29: SSE via Postgres LISTEN/NOTIFY
- **Choice:** A trigger on `events` sends `pg_notify` with sandbox and event id only; one listener connection fans out to streams, which honor `Last-Event-ID`. The listener uses a direct (non-pooled) `DATABASE_URL`. Heartbeat every 20 seconds.
- **Why:** Works with more than one API instance; notify payloads are capped at 8 KB.
- **Alternatives:** an in-process emitter (breaks with two instances).

---

## Learnings and gotchas

*Append-only, dated.*

- **2026-10-27:** Claude Code's `attribution` setting (`"commit": ""`, `"pr": ""`) disables the Co-Authored-By trailer and PR footer, but there are public reports of a `Claude-Session:` trailer still being added. The `commit-msg` hook strips it.
- **2026-10-27:** Free tiers: LiveKit Build plan includes agent minutes and one free US phone number; Deepgram gives one-time signup credit; Gemini free tier has low requests-per-minute without billing enabled; Cartesia free tier is small (roughly half an hour of speech) and non-commercial. Verify current limits before relying on them.
- **2026-10-27:** Ambrook's stack (from job postings): Next.js and React in TypeScript, Expo and React Native, Firestore, PostgreSQL and Cloud Storage, GCP, BigQuery and Hex.

- **2026-10-27:** Corepack bundled with Node 24.5 can't run pnpm 12.x (it looks for `bin/pnpm.cjs`; pnpm 12 ships `pnpm.mjs`). `api/package.json` pins `"packageManager": "pnpm@11.15.0"`. Updating corepack (`npm i -g corepack@latest`) should allow pnpm 12. Assumption, not tested.
- **2026-10-27:** TypeScript 7 is out, but typescript-eslint 8.72 supports only `<6.1`. Pinned `typescript ~6.0.3`.
- **2026-10-27:** pnpm 11 blocks dependency build scripts by default; `api/pnpm-workspace.yaml` sets `allowBuilds: { esbuild: true }` (needed by tsx and vitest).
- **2026-10-27:** The local Postgres server's session timezone is not UTC (+11). The API pool sets `timezone=UTC` on every connection. Seeds compute local times explicitly in America/Chicago.

- **2026-10-27:** HTTPS pushes on this machine use a keychain credential for a different GitHub account (403). Use the SSH remote.

- **2026-10-27:** Changing a Postgres function's argument list with `create or replace` adds an overload instead of replacing it, which makes calls with the old arguments ambiguous. Seed files `drop function if exists` the old signature first.
- **2026-10-27:** `db/migrate.sh` runs seed files in name order, so shared helpers live in `00_helpers.sql` (digits sort before letters in every locale; `_` does not).

- **2026-10-27:** A unique violation inside a Postgres transaction aborts it. `createTicket` wraps the insert in a savepoint so a concurrent duplicate can still be answered with a 409 that includes the existing ticket.
- **2026-10-27:** With `insert ... on conflict do nothing` on the idempotency key, a concurrent request with the same key blocks until the first transaction commits, then reads the stored response. Tested with 5 parallel identical requests.

- **2026-10-29 (Day 7 deploy gotcha):** The SSE listener needs a direct, non-pooled Postgres connection; LISTEN does not work through a transaction-mode pooler.
- **2026-10-29 (Day 7 deploy gotcha):** Cloud Run closes requests at its request timeout (default 5 minutes), which cuts SSE streams. Raise the timeout on deploy; clients reconnect with `Last-Event-ID`.

---

## Open threads

*Remove an item only when resolved, and log the resolution under Decisions.*

- How common is detention billing on grain hauls to elevators? Ask Ambrook. Until then, detention stays out of Story B.
- Are per-ton rates the usual pay model for small grain haulers, or mixed with flat rates?
- Should owners review and approve driver-logged expenses? Not in the demo.
- Run the FMCSA SAFER and web name check on all seed business and facility names before publishing. New Day 1 names to include: Corliss Packaging, Tamsin Foods Warehouse, Orrin Valley Foods, Lakemont Grocery DC, Sutter Ridge Farm, Dellacourt Farm, Ostrander Fertilizer Depot, Halvern Farm Co-op, Benton Truck and Trailer Repair.
- Truck 2 loses money in the small-fleet seed: load 7705 pays $384.30 against $448.40 of seeded fuel (118 gallons for 92 loaded miles). With Story B's new fuel and washout, "How did truck 2 do this week?" may answer with a loss. Retune the seed amounts in 3c, or keep it?

---

## Session log

*One short entry per session, newest last.*

### 2026-10-27: Design session
- Chose the trucking agent, positioning, stack, scenarios, demo stories and data model.
- Created CLAUDE.md, docs/SPEC.md, HISTORY.md, `.claude/settings.json`, `.githooks/commit-msg`, `.githooks/pre-commit`.
- No code yet. No commits yet.

### 2026-10-27: Day 1 build
- Fixed three schema gaps (phone range, `people.seed_key`, `sandboxes.active_person_seed_key`); updated SPEC sections 5 and 12. Chose seed functions over `set_config`.
- Added `.gitignore`, `db/` (migration, seeds, `migrate.sh`), `api/` (config, db, schemas, sandbox and caller services and routes, service-token auth, tests).
- Commits: `00a90cb` on `main` (original docs, settings, hooks, .gitignore); Day 1 work as one commit on `feat/day1-scaffold`. Not pushed.
- Hooks: `core.hooksPath` was not set during the Day 1 commits (the setup command was blocked for Claude), so both hooks were run by hand. Disha set it afterwards.
- Pushed `main` and `feat/day1-scaffold` with approval. Logged decisions on "this week", pinned recording phones, and the CLAUDE.md seeds wording.

### 2026-10-27: Day 1 follow-ups
- After PR #1 was merged: pinned recording-sandbox phones, kept seed timestamps inside the current week, and updated CLAUDE.md (seeds wording), SPEC sections 5, 8, 11 and 12, and HISTORY.md.
- Files: `db/seeds/00_helpers.sql` (new), `db/seeds/owner_operator.sql`, `db/seeds/small_fleet.sql`, `api/src/services/sandboxes.ts`, `api/src/schemas.ts`, `api/test/sandboxes.test.ts`, `api/test/seeds.test.ts` (new).
- Branch `fix/day1-followups`, one commit.

### 2026-10-27: Day 2 ledger
- Logged the Day 2 decisions (idempotency per tool call, ledger rules, stop-time demo timing). Built migration 002 and the 7 ledger endpoints with tests (unit, endpoint, idempotency incl. concurrency). Checked three key rules by breaking them on purpose and confirming tests fail.
- Assumption (not discussed): DEF price per gallon range $1.50 to $8.00, alongside the approved fuel range.
- Updated SPEC sections 5, 7 and 10, and the CLAUDE.md idempotency invariant.
- Files: `db/migrations/002_ledger.sql`; `api/src/ledger-schemas.ts`, `api/src/routes/ledger.ts`, `api/src/services/{expenses,scale-tickets}.ts`, `api/src/lib/{access,caller,idempotency,limits,money,quantity,readback,states}.ts`; `api/src/{app,errors}.ts`, `api/src/services/sandboxes.ts`; tests in `api/test/`.
- Branch `feat/day2-ledger`: `6b6ca21` (Day 2 work), plus a docs commit updating this file. Pushed with approval; PR #3 into `main`.

### 2026-10-29: Day 3a profitability
- Planned Day 3 as four PRs and logged the Day 3 decisions (timezones, `HH:MM` resolution, revenue by delivery week, projected per-ton revenue, late-arrival claims, delivery status change, demo endpoints, SSE) and two Day 7 deploy gotchas.
- Built migration 003, seed timezones, revenue math (`api/src/lib/revenue.ts`), `api/src/services/loads.ts`, `api/src/routes/loads.ts`, schemas, tests (`api/test/loads.test.ts`, seed checks). Checked two rules (confirmed-only costs, driver access) by breaking them and confirming tests fail.
- Updated SPEC sections 5, 7, 8 and 13 (Story B step 3 and 4 wording).
- Branch `feat/day3-profitability`, one commit.
