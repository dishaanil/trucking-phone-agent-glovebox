"""The tool layer against a running API with a fresh sandbox: no LLM, no provider keys.

Checks that the generated models parse real responses and that both demo stories work at the
tool level. Skipped unless the API is reachable:
    uv run --env-file ../api/.env --env-file .env pytest tests/test_api_integration.py
"""

from __future__ import annotations

import os
from datetime import timedelta
from zoneinfo import ZoneInfo

import pytest

from glovebox_agent.api_client import ApiClient
from glovebox_agent.session import CallState
from glovebox_agent.tools import GloveboxTools, Invocation

from .conftest import FakeSpeech
from .live import new_sandbox, require_api


@pytest.fixture
async def api_env():
    url = os.environ.get("API_URL", f"http://localhost:{os.environ.get('PORT', '3001')}")
    token = os.environ.get("SERVICE_TOKEN")
    if not token:
        pytest.skip("needs SERVICE_TOKEN (the API's)")
    require_api(url)
    client = ApiClient(url, token)
    yield url, client
    await client.aclose()


async def start(
    api_env, scenario: str, seed_key: str | None, sandbox: dict | None = None
) -> tuple[GloveboxTools, list[str], dict]:
    url, client = api_env
    sandbox = sandbox or new_sandbox(url, scenario)
    call_id = f"call_it_{sandbox['demo_code']}_{seed_key or 'default'}"
    resolved = await client.resolve(call_id=call_id, demo_code=sandbox["demo_code"], seed_key=seed_key)
    assert resolved.status == "resolved"
    state = CallState.from_resolved(call_id, resolved)
    escalations: list[str] = []

    async def escalate(reason: str) -> None:
        escalations.append(reason)

    tools = GloveboxTools(state, client.for_caller(state.sandbox_id, state.person_id), escalate)
    return tools, escalations, sandbox


async def test_story_a_at_the_tool_level(api_env):
    tools, escalations, _ = await start(api_env, "owner_operator", None)
    heard = FakeSpeech()
    fuel = await tools.log_expense(
        Invocation("fc_1", heard),
        category="fuel",
        amount="512.40",
        gallons="140",
        vendor="Love's",
        city="Joplin",
        state="MO",
        load_number="4471",
    )
    assert fuel["readback"] == "Fuel, 512 dollars and 40 cents, 140 gallons at Love's in Joplin, Missouri."
    lumper = await tools.log_expense(
        Invocation("fc_2", heard), category="lumper", amount="85", payment_method="cash", load_number="4471"
    )
    assert lumper["ref"] == "E2"
    fixed = await tools.correct_expense(Invocation("fc_3", heard), ref="E1", amount="521.40")
    assert fixed["ref"] == "E1" and "521 dollars and 40 cents" in fixed["readback"]
    assert (await tools.confirm_records(Invocation("fc_4"), refs=["E1", "E2"]))["confirmed"] == ["E1", "E2"]

    pickup = next(s for s in tools.state.loads["4471"].stops if s.type == "pickup")
    tz = ZoneInfo(tools.state.timezone)
    arrived = (pickup.appointment_at - timedelta(minutes=10)).astimezone(tz).strftime("%-I:%M %p")
    departed = (pickup.appointment_at + timedelta(minutes=185)).astimezone(tz).strftime("%-I:%M %p")
    times = await tools.log_stop_times(
        Invocation("fc_5"), load_number="4471", stop="shipper", arrived_at=arrived, departed_at=departed
    )
    assert times["readback"].startswith("Harlan Point Cold Storage: arrived")
    detention = await tools.check_detention(Invocation(), load_number="4471", stop="pickup")
    assert detention["summary"] == "Detention is billable: 1 hour, 50 dollars. Want me to draft the claim?"
    claim = await tools.create_detention_claim(Invocation("fc_6"), load_number="4471", stop="pickup")
    assert claim["readback"].startswith("Drafted a detention claim for load 4471")

    profit = await tools.get_load_profitability(Invocation(), load_number="4471")
    assert profit["summary"].startswith("Load 4471 pays 2,400 dollars")
    assert escalations == []


async def test_story_b_at_the_tool_level(api_env):
    tools, escalations, sandbox = await start(api_env, "small_fleet", "tommy")
    heard = FakeSpeech()
    ticket = await tools.log_scale_ticket(
        Invocation("fc_1", heard), load_number="7712", net_weight_lbs="52,800"
    )
    assert ticket["readback"] == "Scale ticket for load 7712, 52,800 pounds net."
    again = await tools.log_scale_ticket(
        Invocation("fc_2", heard), load_number="7712", net_weight_lbs="52,080"
    )
    assert again["error"] == "ticket_exists" and again["ref"] == "T1"
    fixed = await tools.correct_scale_ticket(Invocation("fc_3", heard), ref="T1", net_weight_lbs="52,080")
    assert fixed["readback"] == "Scale ticket for load 7712, 52,080 pounds net."
    await tools.log_expense(
        Invocation("fc_4", heard), category="fuel", amount="180", gallons="47", load_number="7712"
    )
    await tools.log_expense(Invocation("fc_5", heard), category="washout", amount="45", load_number="7712")
    confirmed = await tools.confirm_records(Invocation("fc_6"), refs=["T1", "E1", "E2"])
    assert sorted(confirmed["confirmed"]) == ["E1", "E2", "T1"]

    # Tommy asks owner questions twice: declined, not transferred.
    for _ in range(2):
        assert (await tools.get_business_summary(Invocation()))["error"] == "owner_only"
    assert escalations == []

    # Ray calls into the same sandbox: his answer includes what Tommy just logged.
    ray, _, _ = await start(api_env, "small_fleet", "ray", sandbox)
    truck2 = await ray.get_truck_summary(Invocation(), truck_number="2")
    assert truck2["summary"].startswith("Truck 2 grossed 1,111 this week, spent 1,012, so it netted 99.")
    unpaid = await ray.list_unpaid_loads(Invocation())
    assert unpaid["summary"].startswith("3 loads haven't been paid: 7705")
