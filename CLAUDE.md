# CLAUDE.md

Project rules for AI-assisted development. Read this before every task.

## What we are building

**Glovebox**: a phone-based voice bookkeeper for owner-operators and small trucking fleets.

A driver calls one number and talks naturally ("fueled up in Joplin, 140 gallons, 512 bucks, and the scale ticket says 52,800 net"). The agent captures expenses, scale tickets and stop times, detects billable detention, and answers money questions. Owners can call the same number and ask fleet-level questions ("How did truck 2 do this week?"). A live dashboard shows the books updating during the call.

Two demo scenarios share one codebase:
- **Owner-operator:** one person who owns and drives one truck.
- **Small fleet:** an owner (who also drives) plus hired drivers, three trucks, grain hauling.

Target audience for the demo: Ambrook (accounting and payments for family-run businesses, expanding into trucking). Full spec: `docs/SPEC.md`.

## Start of every session

1. Read this file.
2. Read `HISTORY.md`, especially "Current state" and "Open threads".
3. Read the relevant section of `docs/SPEC.md` for the task.
4. If anything in HISTORY.md contradicts the spec, the newer HISTORY.md decision wins. Point it out and ask whether the spec should be updated.

## Repo layout

```
/agent                  Python. LiveKit voice agent. Conversation only, no business logic.
/api                    TypeScript. Ledger API. All money math, business rules, and role checks.
/api/src/integrations   Mock providers for every external system (see "Mocked integrations").
/web                    TypeScript. Next.js dashboard and demo flow. Reads from /api only.
/db                     SQL migrations and seed templates.
/evals                  Python. Caller simulator and scoring scripts.
/docs                   SPEC.md, design notes, demo scripts.
HISTORY.md              Project memory across build sessions (see "Project memory").
/.claude/settings.json  Claude Code settings (commit and PR attribution disabled).
/.githooks              Git hooks that enforce authorship rules.
```

Each package is independent. Do not edit files outside the package named in the task unless the task says so.

## How to work with me

1. **Plan first.** Before writing code, list the files you will touch, the approach, and every assumption you are making. Wait for my go-ahead.
2. **Small units.** One feature or fix per task. No drive-by refactors.
3. **Tests with every change.** New logic in /api ships with unit tests. Agent prompt changes ship with at least one eval scenario.
4. **Ask, don't guess.** If the spec is ambiguous or contradicts itself, stop and ask.
5. **Explain trade-offs briefly.** If you pick between two approaches, say why in one or two sentences.

## Project memory (HISTORY.md)

`HISTORY.md` is the shared memory between build sessions. Keep it current; a new session should be able to pick up the work from it alone.

**Update it:**
- When a decision is made or changed (by me, or proposed by you and approved by me)
- When something is learned that a future session would otherwise rediscover (a library quirk, an API limit, a failed approach and why it failed)
- When a task finishes or is left half-done
- At the end of every session, before the final message

**What goes where:**
- **Current state:** short, overwritten each session. What works, what's in progress, what's next.
- **Decisions:** append-only. One entry per decision with date, the choice, the reasoning, and alternatives considered. If a decision is reversed, add a new entry that supersedes the old one; never edit or delete old entries.
- **Learnings and gotchas:** append-only, dated.
- **Open threads:** questions waiting on me or on outside input. Remove an item only when it's resolved, and record the resolution as a decision.
- **Session log:** one short dated entry per session: what was done, files touched, commits made.

**Rules:**
- Record only what was actually decided or observed. Mark guesses as assumptions.
- Keep entries short. Link to code paths or commits instead of pasting code.
- Never put secrets, API keys, or real phone numbers in it.
- Commit HISTORY.md changes together with the work they describe.

## Git, commits, and pull requests

All commits, pushes and pull requests must be authored as me. Never as Claude.

**Identity**
- Use the git identity already configured in this repo (`git config user.name` and `git config user.email`). Never change it.
- Never pass `--author`, set `GIT_AUTHOR_*` or `GIT_COMMITTER_*`, or edit git config.
- If the configured identity is missing, or looks like Claude or Anthropic, stop and tell me. Do not commit.

**Commit messages**
- No `Co-Authored-By` trailers, no `Claude-Session` trailers, no "Generated with Claude Code" lines, no AI attribution of any kind.
- Format: a short imperative subject line under 72 characters (e.g. `Add detention calculation to ledger API`), a blank line, then a body explaining what changed and why.
- One logical change per commit. Commit HISTORY.md updates with the work.

**Before committing**
- Run the tests and linters for the packages you touched. Do not commit failing tests.
- Show me `git status` and the proposed commit message, and wait for my approval.

**Pushing and pull requests**
- Never push, open a PR, merge, or create a tag without my explicit go-ahead in the current conversation. Approval for one push does not carry over to the next.
- Never force-push. Never push directly to `main`; work on a feature branch.
- Branch names: `feat/...`, `fix/...`, `chore/...`, `docs/...`.
- PR descriptions: what changed, why, how it was tested, and anything I should check. No "Generated with Claude Code" footer or other attribution.
- Use the GitHub CLI (`gh`) with my existing authentication. Never add credentials or tokens to the repo.

**Enforcement**
- `.claude/settings.json` disables Claude Code's commit and PR attribution.
- `.githooks/commit-msg` strips any Claude attribution trailers that slip through.
- `.githooks/pre-commit` blocks commits whose author or committer looks like Claude or Anthropic.
- Never bypass hooks with `--no-verify`. If a hook blocks a commit, stop and tell me.

**Branching and releases**
- `main` is always deployable. All work happens on short-lived feature branches, merged when tests pass.
- No long-lived "demo" branch. Recorded and live demos are the same code with different configuration.
- Tag the exact commit used for a recorded video (`recording-v1`, `recording-v2`, ...).
- Deployment-level settings come from environment variables. Per-visitor choices (scenario, access mode, role) are stored on the sandbox.

## Core invariants (never break these)

### Data integrity
- **The API is the single source of truth.** The agent and dashboard never compute money values themselves.
- **The LLM never does money math.** It passes raw values (decimal strings, weights, times) to the API. The API parses, validates, and computes.
- **Money is integer cents** in the database and API internals. Never floats. The API accepts decimal strings like `"512.40"` and converts.
- **Weights are integer pounds.** Tons are derived (2,000 lb per ton) only inside the API.
- **Nothing is confirmed without a readback.** Expenses and scale tickets are created `pending` and become `confirmed` only after the caller confirms the readback. Any clear affirmative counts ("yes", "yep", "yup", "that's right", "ten-four"), including mid-sentence.
- **Corrections update, never duplicate.** A correction modifies the existing pending record.
- **Every write from the agent carries an idempotency key** (`{call_id}:{turn_index}:{tool_name}`).
- **Timestamps are `timestamptz`, stored in UTC.** Convert using the person's timezone at the edges.
- **IDs are UUIDs.** Human-facing identifiers (load "4471", truck "2") are separate fields.

### Sandboxes and access
- **Every row belongs to a sandbox.** Every query in /api is scoped by `sandbox_id`. A missing sandbox filter is a bug.
- **Role checks happen in the API, not just the agent.** The agent hides tools a caller can't use, but the API rejects unauthorized requests regardless. Drivers see only their own truck and loads. Owners see the whole business.
- **Reset touches one sandbox only.** It deletes that sandbox's rows and re-copies the selected seed template.
- **Visitor phone numbers expire with their sandbox** (24 hours). They are used only to recognize calls. Never log them in plain text outside the `sandbox_phones` table.

### Fictional data and mocks
- **All seed data is fictional.** Every business, person, broker, facility, phone number, DOT/MC number, and amount is made up. Never use a real company or person, including real customers of any company.
- **Seed phone numbers use the 555-0100 to 555-0199 range**, which is reserved for fiction.
- **Never generate realistic DOT or MC numbers.** Use clearly fake values like `DEMO-0001`.
- **Before publishing, check every business and facility name** against FMCSA SAFER and a web search. Rename anything that matches a real company.
- **The dashboard always shows a "Fictional demo data" label.**
- **Every external system is mocked** behind an interface in `/api/src/integrations`. No real bank, card, fuel card, ELD, broker, or payments calls anywhere. The only real external services are LiveKit, Deepgram, Gemini, Cartesia, and (stretch) SMS to a visitor's own verified sandbox number.

## Conventions

### Python (/agent, /evals)
- Python 3.11+, managed with `uv`
- Type hints everywhere, `ruff` for lint and format, `pytest` for tests
- Config via environment variables, loaded once in `config.py`
- API calls go through one typed client module (`api_client.py`); no raw HTTP elsewhere

### TypeScript (/api, /web)
- `strict: true`, no `any`
- /api: Fastify, `zod` for every request and response schema, `vitest` for tests
- /api: parameterized SQL or a query builder; no string-built queries
- /api: integrations are interfaces with a `Mock*` implementation selected by config
- /web: Next.js App Router, server components by default, live updates via the API's SSE endpoint
- Shared types: generate from zod schemas; do not hand-copy types between packages

### SQL (/db)
- Numbered migrations (`001_init.sql`, `002_...`); never edit an applied migration
- Seed templates in `/db/seeds/owner_operator.sql` and `/db/seeds/small_fleet.sql`, written against a `:sandbox_id` parameter so they can be copied into any sandbox

## Voice behavior rules (agent prompt must follow)

- Responses are short: one or two sentences. The caller is often driving.
- Never ask a driver to read, look at, or type anything while moving. Defer receipt photos to "when you're parked."
- Read back every amount and weight before confirming, using the API's `readback` text verbatim.
- If several items are mentioned at once, capture all of them, then read them back together.
- Ask a follow-up only when a required field is missing or ambiguous.
- If the caller has more than one active load and the load is unclear, ask which one.
- Pauses are normal. Do not fill short silences. After a long silence, one gentle check-in.
- When interrupted, stop speaking and listen. Respond to the new input, not the old sentence.
- If a driver asks an owner-only question, decline in one friendly sentence ("That's one for the owner to check").
- Never invent numbers. If the API fails, say so briefly and offer to try again.
- Escalate to a human when asked, or after two failed attempts at the same thing.

## Domain glossary

- **Owner-operator:** a driver who owns their truck and runs their own small trucking business.
- **Small fleet:** a business with a few trucks, an owner (who may also drive), and hired drivers.
- **Power unit / truck:** the tractor. Fleets track profit per truck.
- **Hopper bottom:** a trailer that unloads through the bottom, used for grain and other bulk agricultural freight.
- **Load:** one shipment from pickup to delivery.
- **Rate type:** how a load pays. `flat` (fixed amount), `per_ton` (by weight on the scale ticket), or `per_mile`.
- **Scale ticket:** the weight record from the elevator or receiver scale. For per-ton loads, it determines pay. Not the same as a **scale fee**, which is an expense for using a truck scale.
- **Broker:** middleman who arranged the load and pays the carrier.
- **Shipper / receiver:** pickup and delivery facilities. Each stop may have an appointment time.
- **Payer:** whoever pays for a load. A broker, or the shipper/receiver directly.
- **Detention:** paid waiting time beyond the free time at a stop. Common with brokered freight; terms live on the payer record.
- **Free time:** waiting time allowed before detention starts.
- **Lumper fee:** fee paid to workers who unload the truck. Cash lumper fees are reimbursable by default.
- **Accessorial:** any charge beyond the base rate (detention, lumper reimbursement, layover).
- **IFTA:** quarterly fuel tax report for interstate carriers, based on gallons bought and miles driven per state.

## Commands

```
# one-time setup after cloning
git config core.hooksPath .githooks
chmod +x .githooks/*
# api
cd api && pnpm dev
cd api && pnpm test
# web
cd web && pnpm dev
# agent
cd agent && uv run python main.py dev     # LiveKit dev mode
cd agent && uv run pytest
# db
psql "$DATABASE_URL" -f db/migrations/001_init.sql
# evals
cd evals && uv run python run_evals.py
```

## Do not

- Put business logic or role checks only in the agent or dashboard
- Store money as floats or weights as tons
- Write to the database from anywhere except /api
- Query without a `sandbox_id` filter
- Call any real external system other than the voice providers listed above
- Use real company names, people, phone numbers, addresses, or DOT/MC numbers
- Commit, push, or open a PR as Claude, or with any AI attribution
- Push, merge, tag, or open a PR without my explicit go-ahead
- Force-push, push to `main`, or use `--no-verify`
- Add a dependency without saying why
- Commit secrets; use `.env` files, which are gitignored
- Use em dashes in any user-facing text, prompts, or docs
