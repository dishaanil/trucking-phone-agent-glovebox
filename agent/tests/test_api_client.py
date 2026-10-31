import httpx
import pytest

from glovebox_agent import api_models as m
from glovebox_agent.api_client import ApiError, ApiUnavailable

from .conftest import PERSON, SANDBOX


async def test_caller_requests_carry_token_and_caller_headers(client, api):
    route = api.get("/loads").respond(
        404, json={"error": "load_not_found", "message": "I can't find that load."}
    )
    with pytest.raises(ApiError) as err:
        await client.for_caller(SANDBOX, PERSON).find_load("9999")
    req = route.calls.last.request
    assert req.headers["authorization"] == "Bearer token-0123456789abcdef"
    assert req.headers["x-sandbox-id"] == SANDBOX and req.headers["x-person-id"] == PERSON
    assert req.url.params["number"] == "9999"
    assert (err.value.status, err.value.code, err.value.message) == (
        404,
        "load_not_found",
        "I can't find that load.",
    )


async def test_retries_5xx_and_network_errors_with_the_same_body(client, api):
    route = api.post("/calls/call_1/end")
    route.side_effect = [
        httpx.ConnectError("down"),
        httpx.Response(503),
        httpx.Response(
            200,
            json={
                "call_id": "call_1",
                "ended_at": "2026-10-31T12:00:00.000Z",
                "end_reason": "completed",
                "duration_seconds": 42,
            },
        ),
    ]
    res = await client.for_caller(SANDBOX, PERSON).end_call("call_1", "completed")
    assert res.duration_seconds == 42
    assert route.call_count == 3
    assert {c.request.content for c in route.calls} == {b'{"reason":"completed"}'}


async def test_gives_up_after_retries(client, api):
    api.get("/loads").mock(side_effect=httpx.ReadTimeout("slow"))
    with pytest.raises(ApiUnavailable):
        await client.for_caller(SANDBOX, PERSON).find_load("7712")


async def test_4xx_is_not_retried(client, api):
    route = api.get("/loads").respond(403, json={"error": "forbidden", "message": "Not yours."})
    with pytest.raises(ApiError):
        await client.for_caller(SANDBOX, PERSON).find_load("7705")
    assert route.call_count == 1


async def test_resolve_parses_each_status(client, api):
    api.post("/callers/resolve").respond(200, json={"status": "not_found"})
    assert isinstance(await client.resolve(call_id="c", demo_code="1234"), m.ResolveCallerResponse3)
    body = api.calls.last.request.content
    assert body == b'{"call_id":"c","demo_code":"1234"}'
