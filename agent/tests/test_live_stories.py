"""SPEC section 13 demo stories, text only, against a running API and the real LLM.

User turns use what Deepgram actually returns for spoken amounts ("5 12 40"), see test_live_stt.py.

These are the eval scenarios for the system prompt (CLAUDE.md). Each run saves a transcript
under /evals/transcripts. Checks are on the ledger afterwards, not on exact wording.
"""

from __future__ import annotations

import uuid
from datetime import timedelta
from zoneinfo import ZoneInfo

import httpx
import pytest
from livekit.agents import AgentSession
from livekit.plugins import google

from glovebox_agent.agent import GloveboxAgent
from glovebox_agent.api_client import ApiClient
from glovebox_agent.config import Config
from glovebox_agent.session import CallState
from glovebox_agent.tools import GloveboxTools

from .live import Transcript, calls, new_sandbox, require_api, require_env

pytestmark = pytest.mark.live


@pytest.fixture
def env() -> dict[str, str]:
    found = require_env("API_URL", "SERVICE_TOKEN", "GOOGLE_API_KEY")
    require_api(found["API_URL"])
    return found


class Call:
    """One text-only call: resolve the caller, start the agent, send turns."""

    def __init__(self, env: dict[str, str], demo_code: str, seed_key: str | None, transcript: Transcript):
        self.env = env
        self.demo_code = demo_code
        self.seed_key = seed_key
        self.transcript = transcript
        self.escalations: list[str] = []
        self.events: list[dict] = []

    async def __aenter__(self) -> Call:
        self.client = ApiClient(self.env["API_URL"], self.env["SERVICE_TOKEN"])
        self.call_id = f"call_live_{uuid.uuid4().hex[:10]}"
        resolved = await self.client.resolve(
            call_id=self.call_id, demo_code=self.demo_code, seed_key=self.seed_key
        )
        assert resolved.status == "resolved"
        self.state = CallState.from_resolved(self.call_id, resolved)

        async def escalate(reason: str) -> None:
            self.escalations.append(reason)

        svc = GloveboxTools(
            self.state, self.client.for_caller(self.state.sandbox_id, self.state.person_id), escalate
        )
        model = self.env.get("GEMINI_MODEL") or Config.gemini_model
        self.session = AgentSession(llm=google.LLM(model=model, vertexai=False))
        await self.session.__aenter__()
        await self.session.start(GloveboxAgent(svc, filler_delay_s=60))
        return self

    async def say(self, text: str) -> list[dict]:
        result = await self.session.run(user_input=text)
        events = self.transcript.add(self.state.first_name, text, result.events)
        self.events.extend(events)
        return events

    async def __aexit__(self, *exc) -> None:
        await self.session.__aexit__(*exc)
        await self.client.aclose()


def api_get(env: dict[str, str], state: CallState, path: str) -> dict:
    headers = {
        "authorization": f"Bearer {env['SERVICE_TOKEN']}",
        "x-sandbox-id": state.sandbox_id,
        "x-person-id": state.person_id,
    }
    res = httpx.get(f"{env['API_URL']}{path}", headers=headers, timeout=10)
    res.raise_for_status()
    return res.json()


def local_hhmm(at, tz: str) -> str:
    return at.astimezone(ZoneInfo(tz)).strftime("%-I:%M %p")


async def test_story_a_owner_operator(env):
    sandbox = new_sandbox(env["API_URL"], "owner_operator")
    transcript = Transcript("story-a", {"sandbox_id": sandbox["id"]})
    try:
        async with Call(env, sandbox["demo_code"], None, transcript) as call:
            pickup = next(s for s in call.state.loads["4471"].stops if s.type == "pickup")
            assert pickup.appointment_at is not None
            arrived = local_hhmm(pickup.appointment_at - timedelta(minutes=10), call.state.timezone)
            departed = local_hhmm(pickup.appointment_at + timedelta(minutes=185), call.state.timezone)

            first = await call.say(
                "Fueled up at Love's in Joplin, Missouri, 140 gallons, 5 12 40. "
                "Paid a lumper 85 bucks cash. And they held me at the shipper, "
                f"got there at {arrived}, didn't leave till {departed}."
            )
            assert len(calls(first, "log_expense")) == 2
            assert calls(first, "log_stop_times")

            await call.say("Actually the fuel was 5 21 40, not 5 12.")
            await call.say("Yep, that's all right.")
            await call.say("Is that wait at the shipper billable?")
            await call.say("Yes, go ahead and draft the claim.")
            await call.say("How am I doing on this load?")

            assert calls(call.events, "correct_expense"), "the fuel correction should update E1"
            assert calls(call.events, "confirm_records")
            assert calls(call.events, "create_detention_claim")
            assert calls(call.events, "get_load_profitability")
            assert call.escalations == []

            # The ledger: corrected fuel confirmed, cash lumper and the $50 claim pending as revenue.
            load = api_get(env, call.state, f"/loads/{call.state.loads['4471'].id}/profitability")
            assert load["costs_cents"] == 3175 + 52_140
            assert load["pending_revenue_cents"] == 8500 + 5000
            assert len([r for r in call.state.records.values() if r.kind == "expense"]) == 2
    finally:
        transcript.save()


async def test_story_b_small_fleet(env):
    sandbox = new_sandbox(env["API_URL"], "small_fleet")
    transcript = Transcript("story-b", {"sandbox_id": sandbox["id"]})
    try:
        async with Call(env, sandbox["demo_code"], "tommy", transcript) as tommy:
            first = await tommy.say(
                "Scale ticket on 7712 says 52,800 net. Fueled at Paducah, 47 gallons, 180 bucks, "
                "and a 45 dollar washout."
            )
            assert calls(first, "log_scale_ticket") and len(calls(first, "log_expense")) == 2
            await tommy.say("Wait, the ticket was 52,080, not 52,800.")
            await tommy.say("Yeah, that's right.")
            await tommy.say("How much did we make this week?")
            await tommy.say("What about the whole fleet, how are all the trucks doing?")

            assert calls(tommy.events, "correct_scale_ticket")
            assert calls(tommy.events, "confirm_records")
            assert not calls(tommy.events, "transfer_to_human"), (
                "owner questions are declined, not transferred"
            )
            assert tommy.escalations == []
            tickets = [r for r in tommy.state.records.values() if r.kind == "ticket"]
            assert len(tickets) == 1 and tickets[0].status == "confirmed"

        async with Call(env, sandbox["demo_code"], "ray", transcript) as ray:
            await ray.say("How did truck 2 do this week?")
            await ray.say("Anything we haven't been paid for?")
            assert calls(ray.events, "get_truck_summary")
            assert calls(ray.events, "list_unpaid_loads")

            # The punchline: Ray's numbers include Tommy's ticket, and truck 2 is now positive.
            summary = api_get(env, ray.state, f"/trucks/{ray.state.trucks['2']}/summary")
            assert summary["net_cents"] > 0
    finally:
        transcript.save()
