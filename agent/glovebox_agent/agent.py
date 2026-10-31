"""LiveKit agents. Thin wrappers: every tool hands off to GloveboxTools, which holds the logic.

Tools take human terms (load and truck numbers, stop names, refs like E1). Drivers never get
the owner tools; the API rejects them regardless.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any, Literal

from livekit.agents import Agent, ChatContext, ChatMessage, RunContext, function_tool
from livekit.agents.llm import Tool

from .api_client import ApiClient, ApiError, ApiUnavailable
from .prompt import greeting, render_system_prompt
from .session import CallState
from .tools import GloveboxTools, Invocation

Category = Literal[
    "fuel", "def", "toll", "scale_fee", "parking", "lumper", "repair", "washout", "food", "other"
]
PaymentMethod = Literal["card", "cash", "fuel_card", "unknown"]
Range = Literal["week", "last_7_days"]
FILLER = "One sec."


def _inv(ctx: RunContext) -> Invocation:
    return Invocation(tool_call_id=ctx.function_call.call_id, speech=ctx.speech_handle)


def build_tools(svc: GloveboxTools, filler_delay_s: float) -> list[Tool]:
    """One tool per SPEC section 10 row the caller may use."""
    state = svc.state

    def filler(ctx: RunContext):  # at most one filler line per turn, only if the call is slow
        return ctx.with_filler(lambda _step: FILLER if state.take_filler() else None, delay=filler_delay_s)

    @function_tool
    async def log_expense(
        ctx: RunContext,
        category: Category,
        amount: str,
        vendor: str | None = None,
        city: str | None = None,
        state_code: str | None = None,
        gallons: str | None = None,
        payment_method: PaymentMethod | None = None,
        load_number: str | None = None,
        reimbursable: bool | None = None,
    ) -> dict[str, Any]:
        """Log one expense as pending. Call once per expense.

        Args:
            category: Expense category. A fee for using a truck scale is scale_fee.
            amount: The amount exactly as said, like "512.40" or "85".
            vendor: Where, like "Love's".
            city: City name.
            state_code: State, like "MO" or "Missouri".
            gallons: Gallons for fuel or DEF, as said.
            payment_method: How it was paid, if said.
            load_number: The load it belongs to, if any.
            reimbursable: Only if the caller says whether it's billed back.
        """
        async with filler(ctx):
            return await svc.log_expense(
                _inv(ctx),
                category=category,
                amount=amount,
                vendor=vendor,
                city=city,
                state=state_code,
                gallons=gallons,
                payment_method=payment_method,
                load_number=load_number,
                reimbursable=reimbursable,
            )

    @function_tool
    async def correct_expense(
        ctx: RunContext,
        ref: str,
        category: Category | None = None,
        amount: str | None = None,
        vendor: str | None = None,
        city: str | None = None,
        state_code: str | None = None,
        gallons: str | None = None,
        payment_method: PaymentMethod | None = None,
        load_number: str | None = None,
        reimbursable: bool | None = None,
    ) -> dict[str, Any]:
        """Correct an expense from this call. Pass only the fields that change.

        Args:
            ref: The expense ref from log_expense, like "E1".
        """
        async with filler(ctx):
            return await svc.correct_expense(
                _inv(ctx),
                ref=ref,
                category=category,
                amount=amount,
                vendor=vendor,
                city=city,
                state=state_code,
                gallons=gallons,
                payment_method=payment_method,
                load_number=load_number,
                reimbursable=reimbursable,
            )

    @function_tool
    async def discard_expense(ctx: RunContext, ref: str, reason: str | None = None) -> dict[str, Any]:
        """Remove an expense from this call when the caller says it shouldn't be there.

        Args:
            ref: The expense ref, like "E1".
            reason: Why, in a few words.
        """
        async with filler(ctx):
            return await svc.discard_expense(_inv(ctx), ref=ref, reason=reason)

    @function_tool
    async def log_scale_ticket(
        ctx: RunContext,
        load_number: str,
        net_weight_lbs: str,
        ticket_number: str | None = None,
        location: str | None = None,
    ) -> dict[str, Any]:
        """Log the scale ticket (net weight) for a load as pending.

        Args:
            load_number: The load, like "7712".
            net_weight_lbs: Net pounds exactly as said, like "52,800".
            ticket_number: The ticket number, if said.
            location: Where it was weighed, if said.
        """
        async with filler(ctx):
            return await svc.log_scale_ticket(
                _inv(ctx),
                load_number=load_number,
                net_weight_lbs=net_weight_lbs,
                ticket_number=ticket_number,
                location=location,
            )

    @function_tool
    async def correct_scale_ticket(
        ctx: RunContext,
        ref: str,
        net_weight_lbs: str | None = None,
        ticket_number: str | None = None,
        location: str | None = None,
    ) -> dict[str, Any]:
        """Correct a scale ticket from this call. Pass only the fields that change.

        Args:
            ref: The ticket ref, like "T1".
        """
        async with filler(ctx):
            return await svc.correct_scale_ticket(
                _inv(ctx),
                ref=ref,
                net_weight_lbs=net_weight_lbs,
                ticket_number=ticket_number,
                location=location,
            )

    @function_tool
    async def confirm_records(ctx: RunContext, refs: list[str]) -> dict[str, Any]:
        """Confirm records after reading them back and hearing a clear yes.

        Args:
            refs: Refs of the records the caller just confirmed, like ["E1", "T1"].
        """
        async with filler(ctx):
            return await svc.confirm_records(_inv(ctx), refs=refs)

    @function_tool
    async def log_stop_times(
        ctx: RunContext,
        load_number: str,
        stop: str,
        arrived_at: str | None = None,
        departed_at: str | None = None,
    ) -> dict[str, Any]:
        """Record when the caller arrived at and/or left a stop.

        Args:
            load_number: The load, like "4471".
            stop: "pickup", "delivery", or the facility name.
            arrived_at: Arrival time as said, like "7:50" or "7:50 PM".
            departed_at: Departure time as said, like "11:05".
        """
        async with filler(ctx):
            return await svc.log_stop_times(
                _inv(ctx), load_number=load_number, stop=stop, arrived_at=arrived_at, departed_at=departed_at
            )

    @function_tool
    async def check_detention(ctx: RunContext, load_number: str, stop: str) -> dict[str, Any]:
        """Check whether waiting time at a stop is billable detention.

        Args:
            load_number: The load.
            stop: "pickup", "delivery", or the facility name.
        """
        async with filler(ctx):
            return await svc.check_detention(_inv(ctx), load_number=load_number, stop=stop)

    @function_tool
    async def create_detention_claim(
        ctx: RunContext, load_number: str, stop: str, notes: str | None = None
    ) -> dict[str, Any]:
        """Draft a detention claim for a stop, only after the caller agrees.

        Args:
            load_number: The load.
            stop: "pickup", "delivery", or the facility name.
            notes: Anything the caller wants noted.
        """
        async with filler(ctx):
            return await svc.create_detention_claim(
                _inv(ctx), load_number=load_number, stop=stop, notes=notes
            )

    @function_tool
    async def get_load_profitability(ctx: RunContext, load_number: str) -> dict[str, Any]:
        """How a load is doing: pay, costs and net.

        Args:
            load_number: The load.
        """
        async with filler(ctx):
            return await svc.get_load_profitability(_inv(ctx), load_number=load_number)

    @function_tool
    async def get_truck_summary(ctx: RunContext, truck_number: str, range: Range = "week") -> dict[str, Any]:
        """Owner only. A truck's revenue, costs and net for a period.

        Args:
            truck_number: The truck, like "2".
            range: "week" for this week, "last_7_days" for the last 7 days.
        """
        async with filler(ctx):
            return await svc.get_truck_summary(_inv(ctx), truck_number=truck_number, range=range)

    @function_tool
    async def get_business_summary(ctx: RunContext, range: Range = "week") -> dict[str, Any]:
        """Owner only. The whole business: revenue, costs, net, best and worst truck.

        Args:
            range: "week" for this week, "last_7_days" for the last 7 days.
        """
        async with filler(ctx):
            return await svc.get_business_summary(_inv(ctx), range=range)

    @function_tool
    async def list_unpaid_loads(ctx: RunContext) -> dict[str, Any]:
        """Owner only. Delivered or invoiced loads that haven't been paid."""
        async with filler(ctx):
            return await svc.list_unpaid_loads(_inv(ctx))

    @function_tool
    async def transfer_to_human(ctx: RunContext) -> dict[str, Any]:
        """The caller asked for a person. Ends the call with a callback promise."""
        return await svc.transfer_to_human(_inv(ctx))

    common: list[Tool] = [
        log_expense,
        correct_expense,
        discard_expense,
        log_scale_ticket,
        correct_scale_ticket,
        confirm_records,
        log_stop_times,
        check_detention,
        create_detention_claim,
        get_load_profitability,
        transfer_to_human,
    ]
    owner: list[Tool] = [get_truck_summary, get_business_summary, list_unpaid_loads]
    return common + owner if state.is_owner else common


def tool_names(tools: list[Tool]) -> list[str]:
    return [t.info.name for t in tools]  # type: ignore[attr-defined]


class GloveboxAgent(Agent):
    """The bookkeeper, once we know who is calling."""

    def __init__(self, svc: GloveboxTools, *, filler_delay_s: float = 0.7, now: datetime | None = None):
        self.state: CallState = svc.state
        super().__init__(
            instructions=render_system_prompt(self.state, now or datetime.now(UTC)),
            tools=build_tools(svc, filler_delay_s),
        )

    async def on_enter(self) -> None:
        self.session.say(greeting(self.state))

    async def on_user_turn_completed(self, turn_ctx: ChatContext, new_message: ChatMessage) -> None:
        self.state.next_turn()


Resolved = Callable[[CallState], Awaitable[GloveboxAgent]]


class DemoCodeAgent(Agent):
    """No caller ID match: ask for the 4-digit demo code, then (small fleet) who is calling."""

    def __init__(
        self,
        client: ApiClient,
        call_id: str,
        on_resolved: Resolved,
        on_give_up: Callable[[], Awaitable[None]],
        demo_site: str,
    ):
        self._client = client
        self._call_id = call_id
        self._on_resolved = on_resolved
        self._on_give_up = on_give_up
        self._demo_site = demo_site
        self._code: str | None = None
        self._misses = 0
        super().__init__(
            instructions=(
                "You are Glovebox, an automated bookkeeping assistant for a trucking demo, on a phone "
                "call. Keep replies to one short sentence. Get the caller's 4-digit demo code and call "
                "submit_demo_code with just the digits. If a tool returns `say`, say it. If it lists "
                "people, ask whether they are calling as the owner or as a driver, and which person, "
                "then call choose_person."
            ),
        )

    async def on_enter(self) -> None:
        self.session.say(
            "Welcome to the Glovebox demo. I'm an automated assistant. What's your 4-digit demo code?"
        )

    async def _resolve(self, seed_key: str | None) -> Any:
        try:
            return await self._client.resolve(call_id=self._call_id, demo_code=self._code, seed_key=seed_key)
        except ApiError as err:
            return {"ok": False, "say": err.message}
        except ApiUnavailable:
            return {"ok": False, "say": "I couldn't reach the demo just now. Let's try that again."}

    async def _finish(self, result: Any) -> Any:
        status = getattr(result, "status", None)
        if status == "resolved":
            # A bare agent hands off without a reply here; the new agent greets the caller.
            return await self._on_resolved(CallState.from_resolved(self._call_id, result))
        if status == "choose_person":
            people = [
                {
                    "seed_key": p.seed_key,
                    "name": p.full_name,
                    "role": "owner" if p.is_owner else "driver",
                    "truck": p.truck_unit,
                }
                for p in result.people
            ]
            return {"ok": True, "people": people, "say": "Are you calling as the owner or as a driver?"}
        if status == "not_found":
            self._misses += 1
            self._code = None
            if self._misses >= 2:
                await self._on_give_up()
                return {
                    "ok": False,
                    "call_ending": True,
                    "say": (
                        f"I can't find that code. You can get one at {self._demo_site}. Thanks for calling."
                    ),
                }
            return {"ok": False, "say": "I can't find that code. Could you say the four digits again?"}
        return result

    @function_tool
    async def submit_demo_code(self, ctx: RunContext, code: str) -> Any:
        """Look up the caller's demo code.

        Args:
            code: The 4 digits, like "4821".
        """
        digits = "".join(ch for ch in code if ch.isdigit())
        if len(digits) != 4:
            return {"ok": False, "say": "The demo code is four digits. What is it?"}
        self._code = digits
        return await self._finish(await self._resolve(None))

    @function_tool
    async def choose_person(self, ctx: RunContext, seed_key: str) -> Any:
        """Who the caller is, after submit_demo_code listed people.

        Args:
            seed_key: The chosen person's seed_key.
        """
        if not self._code:
            return {"ok": False, "say": "What's your 4-digit demo code first?"}
        return await self._finish(await self._resolve(seed_key.strip().lower()))
