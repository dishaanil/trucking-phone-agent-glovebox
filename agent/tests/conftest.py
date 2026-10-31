from __future__ import annotations

from collections.abc import AsyncIterator

import pytest
import respx

from glovebox_agent.api_client import ApiClient
from glovebox_agent.session import CallState, LoadRef, StopRef

API = "http://api.test"
SANDBOX = "11111111-1111-4111-8111-111111111111"
PERSON = "22222222-2222-4222-8222-222222222222"
BUSINESS = "33333333-3333-4333-8333-333333333333"
LOAD_7712 = "44444444-4444-4444-8444-444444444444"
STOP_PICKUP = "55555555-5555-4555-8555-555555555555"
STOP_DELIVERY = "66666666-6666-4666-8666-666666666666"
TRUCK_2 = "77777777-7777-4777-8777-777777777777"


class FakeSpeech:
    """Stands in for a LiveKit SpeechHandle."""

    def __init__(self, *, interrupted: bool = False, done: bool = True):
        self.interrupted = interrupted
        self._done = done

    def done(self) -> bool:
        return self._done


def make_state(*, is_owner: bool = False) -> CallState:
    return CallState(
        call_id="call_test",
        sandbox_id=SANDBOX,
        person_id=PERSON,
        business_id=BUSINESS,
        business_name="Cedar Fork Hauling LLC",
        first_name="Tommy",
        full_name="Tommy Reece",
        is_owner=is_owner,
        is_driver=True,
        timezone="America/Chicago",
        trucks={"2": TRUCK_2},
        loads={
            "7712": LoadRef(
                id=LOAD_7712,
                number="7712",
                status="delivered",
                truck_unit="2",
                stops=[
                    StopRef(id=STOP_PICKUP, type="pickup", facility_name="Sutter Ridge Farm"),
                    StopRef(
                        id=STOP_DELIVERY, type="delivery", facility_name="Millbrook Grain Co. river terminal"
                    ),
                ],
            )
        },
    )


@pytest.fixture
async def client() -> AsyncIterator[ApiClient]:
    c = ApiClient(API, "token-0123456789abcdef", retry_backoff_s=0)
    yield c
    await c.aclose()


@pytest.fixture
def api() -> respx.MockRouter:
    with respx.mock(base_url=API, assert_all_called=False) as router:
        yield router
