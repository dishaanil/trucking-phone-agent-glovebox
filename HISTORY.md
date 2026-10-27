# HISTORY.md

Project memory for Glovebox across build sessions. Rules for maintaining this file are in `CLAUDE.md` under "Project memory".

---

## Current state

*Overwritten each session.*

- **Phase:** design locked, build not started.
- **Done:** CLAUDE.md, docs/SPEC.md, HISTORY.md, Claude Code settings, git hooks.
- **Next:** Day 1 of the build plan (SPEC section 15): repo scaffold, migrations, both seed templates, sandbox create/reset, caller resolve.
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

---

## Learnings and gotchas

*Append-only, dated.*

- **2026-10-27:** Claude Code's `attribution` setting (`"commit": ""`, `"pr": ""`) disables the Co-Authored-By trailer and PR footer, but there are public reports of a `Claude-Session:` trailer still being added. The `commit-msg` hook strips it.
- **2026-10-27:** Free tiers: LiveKit Build plan includes agent minutes and one free US phone number; Deepgram gives one-time signup credit; Gemini free tier has low requests-per-minute without billing enabled; Cartesia free tier is small (roughly half an hour of speech) and non-commercial. Verify current limits before relying on them.
- **2026-10-27:** Ambrook's stack (from job postings): Next.js and React in TypeScript, Expo and React Native, Firestore, PostgreSQL and Cloud Storage, GCP, BigQuery and Hex.

---

## Open threads

*Remove an item only when resolved, and log the resolution under Decisions.*

- How common is detention billing on grain hauls to elevators? Ask Ambrook. Until then, detention stays out of Story B.
- Are per-ton rates the usual pay model for small grain haulers, or mixed with flat rates?
- Should owners review and approve driver-logged expenses? Not in the demo.
- Run the FMCSA SAFER and web name check on all seed business and facility names before publishing.

---

## Session log

*One short entry per session, newest last.*

### 2026-10-27: Design session
- Chose the trucking agent, positioning, stack, scenarios, demo stories and data model.
- Created CLAUDE.md, docs/SPEC.md, HISTORY.md, `.claude/settings.json`, `.githooks/commit-msg`, `.githooks/pre-commit`.
- No code yet. No commits yet.
