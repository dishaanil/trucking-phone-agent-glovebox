import re
from datetime import UTC, datetime
from types import SimpleNamespace

from livekit import rtc

from glovebox_agent.agent import GloveboxAgent, build_tools, tool_names
from glovebox_agent.main import call_id_for, caller_input
from glovebox_agent.prompt import greeting, render_system_prompt
from glovebox_agent.session import StopRef
from glovebox_agent.tools import GloveboxTools

from .conftest import PERSON, SANDBOX, make_state

OWNER_TOOLS = {"get_truck_summary", "get_business_summary", "list_unpaid_loads"}
NOW = datetime(2026, 10, 31, 15, 5, tzinfo=UTC)  # 10:05 AM in Chicago


def service(client, *, is_owner=False):
    async def escalate(_reason: str) -> None:
        return None

    return GloveboxTools(make_state(is_owner=is_owner), client.for_caller(SANDBOX, PERSON), escalate)


def test_drivers_never_get_owner_tools(client):
    names = set(tool_names(build_tools(service(client), 0.7)))
    assert names.isdisjoint(OWNER_TOOLS)
    assert {"log_expense", "confirm_records", "log_stop_times", "transfer_to_human"} <= names


def test_owners_get_every_tool(client):
    names = set(tool_names(build_tools(service(client, is_owner=True), 0.7)))
    assert names >= OWNER_TOOLS
    assert len(names) == 14


def test_agent_builds_with_the_rendered_prompt(client):
    agent = GloveboxAgent(service(client), now=NOW)
    assert "Tommy Reece" in agent.instructions


def test_prompt_has_local_time_context_and_role_rules():
    driver = render_system_prompt(make_state(), NOW)
    assert "Saturday October 31, 10:05 AM (America/Chicago)" in driver
    assert "Load 7712 (delivered, truck 2)" in driver
    assert "That's one for the owner to check." in driver
    # Rules added after the first live Story A transcripts (evals/transcripts/*story-a.json).
    assert "always pass load_number" in driver
    assert 'ask "Is that right?" and nothing else' in driver
    assert "Ask one question at a time" in driver
    assert "get_business_summary" not in driver
    assert "$" not in driver.replace("$full_name", "")  # every placeholder was filled

    owner = render_system_prompt(make_state(is_owner=True), NOW)
    assert "get_truck_summary, get_business_summary and list_unpaid_loads" in owner
    assert "owner and driver" in owner


def test_prompt_shows_appointments_in_local_time():
    state = make_state()
    state.loads["7712"].stops[0] = StopRef(
        id="x",
        type="pickup",
        facility_name="Sutter Ridge Farm",
        city="Marion",
        state="KY",
        appointment_at=datetime(2026, 10, 31, 13, 0, tzinfo=UTC),
    )
    assert "pickup at Sutter Ridge Farm, Marion KY, appointment Saturday October 31, 8:00 AM" in (
        render_system_prompt(state, NOW)
    )


def test_greeting_says_it_is_automated_and_names_the_load():
    state = make_state()
    assert greeting(state) == (
        "Hi Tommy, this is Glovebox, an automated bookkeeping assistant. "
        "Load 7712 is delivered and still needs a scale ticket. What've you got?"
    )
    load = state.loads["7712"]
    load.status = "in_transit"
    load.stops[0].city, load.stops[1].city = "Chicago", "Atlanta"
    assert "You're on load 7712, Chicago to Atlanta." in greeting(state)
    state.loads.clear()
    assert greeting(state).endswith("What can I help with?")


def participant(kind, *, attributes=None, metadata=""):
    return SimpleNamespace(kind=kind, attributes=attributes or {}, metadata=metadata)


def test_caller_input_uses_caller_id_for_phone_calls_and_metadata_for_browser_calls():
    sip = rtc.ParticipantKind.PARTICIPANT_KIND_SIP
    std = rtc.ParticipantKind.PARTICIPANT_KIND_STANDARD
    assert caller_input(participant(sip, attributes={"sip.phoneNumber": "+12705550112"})) == {
        "phone": "+12705550112"
    }
    assert caller_input(participant(std, metadata='{"demo_code": "4821", "seed_key": "tommy"}')) == {
        "demo_code": "4821",
        "seed_key": "tommy",
    }
    assert caller_input(participant(std, metadata="not json")) == {}
    assert caller_input(participant(std, metadata='{"demo_code": "abcd"}')) == {}


def test_call_ids_match_the_api_format():
    call_id = call_id_for("room with spaces/and slashes")
    assert re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", call_id)
    assert call_id != call_id_for("room with spaces/and slashes")
