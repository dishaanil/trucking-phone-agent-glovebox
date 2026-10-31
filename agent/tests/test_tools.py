import json

import httpx
import pytest

from glovebox_agent.tools import OWNER_ONLY, RETRY_MESSAGE, TRANSFER_MESSAGE, GloveboxTools, Invocation

from .conftest import LOAD_7712, PERSON, SANDBOX, STOP_DELIVERY, TRUCK_2, FakeSpeech, make_state

EXPENSE_ID = "88888888-8888-4888-8888-888888888888"
TICKET_ID = "99999999-9999-4999-8999-999999999999"


def expense(**over):
    body = {
        "id": EXPENSE_ID,
        "status": "pending",
        "category": "fuel",
        "amount_cents": 51240,
        "amount_display": "512 dollars and 40 cents",
        "gallons": "140",
        "vendor": "Love's",
        "city": "Joplin",
        "state": "MO",
        "payment_method": "unknown",
        "reimbursable": False,
        "occurred_at": "2026-10-31T12:00:00.000Z",
        "load_id": LOAD_7712,
        "load_number": "7712",
        "truck_id": TRUCK_2,
        "truck_unit": "2",
        "receipt_status": "missing",
        "readback": "Fuel, 512 dollars and 40 cents, 140 gallons at Love's in Joplin, Missouri.",
        "needs_confirmation": False,
        "confirmation_reasons": [],
        "confirmation_prompt": None,
    }
    return {**body, **over}


def ticket(**over):
    body = {
        "id": TICKET_ID,
        "status": "pending",
        "load_id": LOAD_7712,
        "load_number": "7712",
        "net_weight_lbs": 52800,
        "weight_display": "52,800 pounds",
        "ticket_number": None,
        "location": None,
        "readback": "Scale ticket for load 7712, 52,800 pounds net.",
        "needs_confirmation": False,
        "confirmation_reasons": [],
        "confirmation_prompt": None,
    }
    return {**body, **over}


class Escalations:
    def __init__(self):
        self.reasons: list[str] = []

    async def __call__(self, reason: str) -> None:
        self.reasons.append(reason)


@pytest.fixture
def escalations():
    return Escalations()


@pytest.fixture
def tools(client, escalations):
    return GloveboxTools(make_state(), client.for_caller(SANDBOX, PERSON), escalations)


def owner_tools(client, escalations):
    return GloveboxTools(make_state(is_owner=True), client.for_caller(SANDBOX, PERSON), escalations)


async def log_fuel(tools, speech=None, call_id="fc_1"):
    return await tools.log_expense(
        Invocation(call_id, speech),
        category="fuel",
        amount="512.40",
        gallons="140",
        vendor="Love's",
        city="Joplin",
        state="MO",
        load_number="7712",
    )


async def test_log_expense_maps_the_load_and_returns_a_ref_and_the_api_readback(tools, api):
    route = api.post("/expenses").respond(201, json=expense())
    result = await log_fuel(tools)
    assert result == {
        "ok": True,
        "ref": "E1",
        "status": "pending",
        "readback": "Fuel, 512 dollars and 40 cents, 140 gallons at Love's in Joplin, Missouri.",
        "needs_confirmation": False,
    }
    sent = json.loads(route.calls.last.request.content)
    assert sent["load_id"] == LOAD_7712 and sent["amount"] == "512.40"
    assert sent["idempotency_key"] == "call_test:fc_1:log_expense" and sent["call_id"] == "call_test"
    # The ref is saved before anything is spoken.
    assert tools.state.records["E1"].id == EXPENSE_ID


async def test_a_repeated_log_returns_the_existing_ref_without_writing(tools, api):
    route = api.post("/expenses").respond(201, json=expense())
    first = await log_fuel(tools, call_id="fc_1")
    again = await tools.log_expense(Invocation("fc_2"), category="fuel", amount="$512.4", load_number="7712")
    assert route.call_count == 1
    assert again["ref"] == first["ref"] == "E1"
    assert again["already_logged"] is True


async def test_an_interrupted_readback_must_be_heard_again_before_confirming(tools, api):
    api.post("/expenses").respond(201, json=expense())
    confirm = api.post("/expenses/confirm").respond(
        200, json={"results": [{"id": EXPENSE_ID, "result": "confirmed"}], "confirmed_count": 1}
    )
    cut_off = FakeSpeech(interrupted=True)
    await log_fuel(tools, speech=cut_off)

    reread = FakeSpeech(done=False)
    first = await tools.confirm_records(Invocation("fc_c1", reread), refs=["E1"])
    assert first["confirmed"] == []
    assert first["read_back_first"] == [{"ref": "E1", "readback": tools.state.records["E1"].readback}]
    assert confirm.call_count == 0

    # The re-read played to the end; the caller says yes.
    reread._done = True
    second = await tools.confirm_records(Invocation("fc_c2", FakeSpeech(done=False)), refs=["E1"])
    assert second == {"ok": True, "confirmed": ["E1"]}
    assert tools.state.records["E1"].status == "confirmed"
    assert json.loads(confirm.calls.last.request.content)["ids"] == [EXPENSE_ID]


async def test_confirm_in_the_same_breath_as_the_readback_is_refused(tools, api):
    api.post("/expenses").respond(201, json=expense())
    speaking = FakeSpeech(done=False)
    await log_fuel(tools, speech=speaking)
    result = await tools.confirm_records(Invocation("fc_c", speaking), refs=["E1"])
    assert result["confirmed"] == [] and result["read_back_first"][0]["ref"] == "E1"


async def test_confirm_only_accepts_pending_refs_from_this_call(tools, api):
    api.post("/expenses").respond(201, json=expense())
    api.post("/expenses/confirm").respond(
        200, json={"results": [{"id": EXPENSE_ID, "result": "confirmed"}], "confirmed_count": 1}
    )
    await log_fuel(tools, speech=FakeSpeech())
    await tools.confirm_records(Invocation("fc_c1"), refs=["E1"])
    result = await tools.confirm_records(Invocation("fc_c2"), refs=["E1", "E7"])
    assert result["confirmed"] == []
    assert result["not_confirmed"] == [
        {"ref": "E1", "reason": "already_confirmed"},
        {"ref": "E7", "reason": "not_from_this_call"},
    ]


async def test_confirm_sends_expenses_and_tickets_to_their_endpoints(tools, api):
    api.post("/expenses").respond(201, json=expense())
    api.post(f"/loads/{LOAD_7712}/scale-tickets").respond(201, json=ticket())
    exp = api.post("/expenses/confirm").respond(
        200, json={"results": [{"id": EXPENSE_ID, "result": "confirmed"}], "confirmed_count": 1}
    )
    tix = api.post("/scale-tickets/confirm").respond(
        200, json={"results": [{"id": TICKET_ID, "result": "confirmed"}], "confirmed_count": 1}
    )
    await log_fuel(tools, speech=FakeSpeech())
    await tools.log_scale_ticket(
        Invocation("fc_t", FakeSpeech()), load_number="7712", net_weight_lbs="52,800"
    )
    result = await tools.confirm_records(Invocation("fc_c"), refs=["E1", "T1"])
    assert result == {"ok": True, "confirmed": ["E1", "T1"]}
    assert json.loads(exp.calls.last.request.content)["idempotency_key"] == "call_test:fc_c:confirm_expenses"
    assert json.loads(tix.calls.last.request.content)["idempotency_key"] == "call_test:fc_c:confirm_tickets"


async def test_a_second_ticket_returns_the_existing_one_as_a_ref(tools, api):
    api.post(f"/loads/{LOAD_7712}/scale-tickets").respond(
        409,
        json={
            "error": "ticket_exists",
            "message": "Load 7712 already has a scale ticket: Scale ticket for load 7712, 52,800 pounds net. "
            "Want to correct it?",
            "existing": {
                "id": TICKET_ID,
                "status": "pending",
                "readback": "Scale ticket for load 7712, 52,800 pounds net.",
            },
        },
    )
    result = await tools.log_scale_ticket(Invocation("fc_t"), load_number="7712", net_weight_lbs="52080")
    assert result["error"] == "ticket_exists" and result["ref"] == "T1"
    assert result["say"].startswith("Load 7712 already has a scale ticket")


async def test_4xx_messages_are_spoken_and_never_escalate(tools, api, escalations):
    # A driver asking about another driver's load twice: two 403s, no transfer.
    api.get("/loads").respond(403, json={"error": "forbidden", "message": "That load isn't on your truck."})
    for i in range(2):
        result = await tools.get_load_profitability(Invocation(f"fc_{i}"), load_number="7705")
        assert result == {"ok": False, "error": "forbidden", "say": "That load isn't on your truck."}
    assert escalations.reasons == []
    assert tools.state.failures.get("get_load_profitability", 0) == 0


async def test_a_driver_asking_two_owner_questions_is_not_transferred(tools, api, escalations):
    for _ in range(2):
        result = await tools.get_business_summary(Invocation())
        assert result == {"ok": False, "error": "owner_only", "say": OWNER_ONLY}
    assert escalations.reasons == []
    assert not api.calls


async def test_two_5xx_failures_on_the_same_tool_transfer_to_a_human(tools, api, escalations):
    api.post(f"/stops/{STOP_DELIVERY}/times").mock(side_effect=httpx.ConnectError("down"))
    first = await tools.log_stop_times(
        Invocation("fc_1"), load_number="7712", stop="delivery", arrived_at="7:50"
    )
    assert first == {"ok": False, "error": "unavailable", "say": RETRY_MESSAGE}
    assert escalations.reasons == []
    second = await tools.log_stop_times(
        Invocation("fc_2"), load_number="7712", stop="delivery", arrived_at="7:50"
    )
    assert second["say"] == TRANSFER_MESSAGE and second["call_ending"] is True
    assert escalations.reasons == ["error"]


async def test_a_success_resets_the_failure_count(tools, api, escalations):
    route = api.get(f"/stops/{STOP_DELIVERY}/detention")
    route.side_effect = [
        httpx.ConnectError("down"),
        httpx.ConnectError("down"),
        httpx.ConnectError("down"),
        httpx.Response(
            200,
            json={
                "stop_id": STOP_DELIVERY,
                "load_id": LOAD_7712,
                "load_number": "7712",
                "facility_name": "Millbrook Grain Co. river terminal",
                "payer_name": "Millbrook Grain Co.",
                "eligible": False,
                "reason": "payer_no_detention",
                "on_time": None,
                "late_arrival": False,
                "clock_start": None,
                "waited_minutes": 0,
                "free_minutes": 0,
                "billable_minutes": 0,
                "billable_display": "0 minutes",
                "amount_cents": 0,
                "amount_display": "0 cents",
                "notes": None,
                "claim": None,
                "summary": "Millbrook Grain Co. doesn't pay detention, so there's nothing to claim.",
            },
        ),
    ]
    assert (await tools.check_detention(Invocation(), load_number="7712", stop="delivery"))[
        "say"
    ] == RETRY_MESSAGE
    ok = await tools.check_detention(Invocation(), load_number="7712", stop="delivery")
    assert ok["summary"].startswith("Millbrook Grain Co. doesn't pay detention")
    assert tools.state.failures["check_detention"] == 0 and escalations.reasons == []


async def test_unknown_loads_are_looked_up_by_number(tools, api):
    load_7705 = "abababab-abab-4bab-8bab-abababababab"
    api.get("/loads").respond(
        200,
        json={
            "id": load_7705,
            "load_number": "7705",
            "status": "delivered",
            "commodity": "soybeans",
            "rate_type": "per_ton",
            "rate_cents": 1500,
            "loaded_miles": 92,
            "truck_id": TRUCK_2,
            "truck_unit": "2",
            "driver_id": PERSON,
            "driver_name": "Tommy Reece",
            "payer_name": "Millbrook Grain Co.",
            "stops": [],
        },
    )
    api.get(f"/loads/{load_7705}/profitability").respond(
        200,
        json={
            "load_id": load_7705,
            "load_number": "7705",
            "status": "delivered",
            "rate_type": "per_ton",
            "loaded_miles": 92,
            "revenue_status": "final",
            "revenue_cents": 38430,
            "revenue_display": "384 dollars and 30 cents",
            "projected_revenue_cents": None,
            "projected_revenue_display": None,
            "detention_revenue_cents": 0,
            "pending_revenue_cents": 0,
            "costs_cents": 44840,
            "costs_display": "448 dollars and 40 cents",
            "net_cents": -6410,
            "net_display": "minus 64 dollars and 10 cents",
            "cost_per_mile_cents": 487,
            "summary": "Load 7705 pays 384 dollars, costs so far are 448, so it's down 64.",
        },
    )
    result = await tools.get_load_profitability(Invocation(), load_number="7705")
    assert result == {
        "ok": True,
        "summary": "Load 7705 pays 384 dollars, costs so far are 448, so it's down 64.",
    }
    assert "7705" in tools.state.loads


async def test_unknown_stop_asks_which_one(tools, api):
    result = await tools.check_detention(Invocation(), load_number="7712", stop="the gas station")
    assert result["error"] == "unknown_stop"
    assert "pickup at Sutter Ridge Farm" in result["say"]
    assert not api.calls


async def test_owner_truck_summary_maps_the_unit(client, api, escalations):
    tools = owner_tools(client, escalations)
    route = api.get(f"/trucks/{TRUCK_2}/summary").respond(
        200,
        json={
            "truck_id": TRUCK_2,
            "truck_unit": "2",
            "range": "week",
            "start": "2026-10-26T05:00:00.000Z",
            "end": "2026-10-31T12:00:00.000Z",
            "revenue_cents": 74690,
            "revenue_display": "x",
            "costs_cents": 78720,
            "costs_display": "x",
            "net_cents": -4030,
            "net_display": "x",
            "pending_revenue_cents": 0,
            "delivered_loads": [],
            "open_loads_with_costs": [],
            "summary": "Truck 2 grossed 747 this week, spent 787, so it lost 40.",
        },
    )
    result = await tools.get_truck_summary(Invocation(), truck_number="2")
    assert result["summary"].startswith("Truck 2 grossed 747")
    assert route.calls.last.request.url.params["range"] == "week"
    assert (await tools.get_truck_summary(Invocation(), truck_number="9"))["error"] == "unknown_truck"


async def test_transfer_to_human_escalates(tools, escalations):
    result = await tools.transfer_to_human(Invocation())
    assert result["call_ending"] is True and escalations.reasons == ["transferred"]
