"""Tool logic, independent of LiveKit so it can be unit tested.

Each method maps to one SPEC section 10 tool and returns a small dict for the LLM. Text the
caller should hear is in `readback`, `summary` or `say`, written by the API, never composed here.

Errors: a 4xx is a normal answer; its message is spoken and the call goes on. Only 5xx,
timeouts and network errors count toward the two-strikes escalation to a human.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Literal, TypeVar

from . import api_models as m
from .api_client import ApiError, ApiUnavailable, CallerApi
from .session import CallState, LoadRef, Record, SpeechHandleLike, StopRef

T = TypeVar("T")
Result = dict[str, Any]

RETRY_MESSAGE = "I couldn't reach the books just now. Want me to try that again?"
TRANSFER_MESSAGE = (
    "I'm having trouble with the books right now, so I'll have someone from the team call you back. "
    "Sorry about that."
)
OWNER_ONLY = "That's one for the owner to check."
FAILURES_BEFORE_TRANSFER = 2

Range = Literal["week", "last_7_days"]


@dataclass
class Invocation:
    """What LiveKit tells us about one tool call."""

    tool_call_id: str | None = None
    speech: SpeechHandleLike | None = None


class _Spoken(Exception):
    """Stop a tool and return this result to the LLM."""

    def __init__(self, result: Result):
        super().__init__(result.get("say", ""))
        self.result = result


def _drop_none(**kw: Any) -> dict[str, Any]:
    return {k: v for k, v in kw.items() if v is not None}


class GloveboxTools:
    def __init__(
        self,
        state: CallState,
        api: CallerApi,
        escalate: Callable[[str], Awaitable[None]],
    ):
        self.state = state
        self.api = api
        self._escalate = escalate

    # ---------- Plumbing ----------

    async def _api(
        self,
        tool: str,
        call: Callable[[], Awaitable[T]],
        on_4xx: Callable[[ApiError], Result | None] | None = None,
    ) -> T:
        try:
            value = await call()
        except ApiError as err:
            custom = on_4xx(err) if on_4xx else None
            raise _Spoken(custom or {"ok": False, "error": err.code, "say": err.message}) from err
        except ApiUnavailable as err:
            count = self.state.failures.get(tool, 0) + 1
            self.state.failures[tool] = count
            if count >= FAILURES_BEFORE_TRANSFER:
                await self._escalate("error")
                raise _Spoken(
                    {"ok": False, "error": "unavailable", "say": TRANSFER_MESSAGE, "call_ending": True}
                ) from err
            raise _Spoken({"ok": False, "error": "unavailable", "say": RETRY_MESSAGE}) from err
        self.state.failures[tool] = 0
        return value

    def _meta(self, tool: str, inv: Invocation) -> dict[str, str]:
        return {
            "call_id": self.state.call_id,
            "idempotency_key": self.state.idempotency_key(tool, inv.tool_call_id),
        }

    async def _load(self, tool: str, number: str) -> LoadRef:
        known = self.state.load(number)
        if known:
            return known
        found = await self._api(tool, lambda: self.api.find_load(number.strip()))
        return self.state.remember_load(found)

    async def _stop(self, tool: str, load_number: str, stop: str) -> tuple[LoadRef, StopRef]:
        load = await self._load(tool, load_number)
        found = self.state.find_stop(load, stop)
        if not found:
            names = ", ".join(f"{s.type} at {s.facility_name}" for s in load.stops)
            raise _Spoken(
                {"ok": False, "error": "unknown_stop", "say": f"Which stop on load {load.number}? {names}."}
            )
        return load, found

    def _own_record(self, ref: str, kind: str) -> Record:
        record = self.state.record(ref)
        if not record or record.kind != kind:
            what = "expense" if kind == "expense" else "scale ticket"
            raise _Spoken(
                {"ok": False, "error": "unknown_ref", "say": f"I don't have that {what} from this call."}
            )
        return record

    @staticmethod
    def _flags(r: m.ExpenseResponse | m.TicketResponse) -> Result:
        out: Result = {"needs_confirmation": r.needs_confirmation}
        if r.confirmation_prompt:
            out["confirmation_prompt"] = r.confirmation_prompt
        return out

    async def _run(self, body: Callable[[], Awaitable[Result]]) -> Result:
        try:
            return await body()
        except _Spoken as spoken:
            return spoken.result

    # ---------- Expenses ----------

    async def log_expense(
        self,
        inv: Invocation,
        *,
        category: str,
        amount: str,
        vendor: str | None = None,
        city: str | None = None,
        state: str | None = None,
        gallons: str | None = None,
        payment_method: str | None = None,
        load_number: str | None = None,
        reimbursable: bool | None = None,
    ) -> Result:
        async def body() -> Result:
            repeat = self.state.pending_duplicate(category, amount)
            if repeat:
                return {
                    "ok": True,
                    "ref": repeat.ref,
                    "status": repeat.status,
                    "readback": repeat.readback,
                    "already_logged": True,
                }
            load = await self._load("log_expense", load_number) if load_number else None
            req = m.CreateExpenseBody(
                **_drop_none(
                    category=category,
                    amount=amount,
                    vendor=vendor,
                    city=city,
                    state=state,
                    gallons=gallons,
                    payment_method=payment_method,
                    reimbursable=reimbursable,
                    load_id=load.id if load else None,
                ),
                **self._meta("log_expense", inv),
            )
            res = await self._api("log_expense", lambda: self.api.create_expense(req))
            # Saved before anything is spoken, so a cut-off readback can still be found by ref.
            rec = self.state.add_record(
                "expense",
                str(res.id),
                res.status.value,
                res.readback,
                category=res.category.value,
                amount=amount,
                speech=inv.speech,
            )
            return {
                "ok": True,
                "ref": rec.ref,
                "status": rec.status,
                "readback": res.readback,
                **self._flags(res),
            }

        return await self._run(body)

    async def correct_expense(
        self,
        inv: Invocation,
        *,
        ref: str,
        category: str | None = None,
        amount: str | None = None,
        vendor: str | None = None,
        city: str | None = None,
        state: str | None = None,
        gallons: str | None = None,
        payment_method: str | None = None,
        load_number: str | None = None,
        reimbursable: bool | None = None,
    ) -> Result:
        async def body() -> Result:
            rec = self._own_record(ref, "expense")
            load = await self._load("correct_expense", load_number) if load_number else None
            req = m.PatchExpenseBody(
                **_drop_none(
                    category=category,
                    amount=amount,
                    vendor=vendor,
                    city=city,
                    state=state,
                    gallons=gallons,
                    payment_method=payment_method,
                    reimbursable=reimbursable,
                    load_id=load.id if load else None,
                ),
                **self._meta("correct_expense", inv),
            )
            res = await self._api("correct_expense", lambda: self.api.correct_expense(rec.id, req))
            self.state.add_record(
                "expense",
                rec.id,
                res.status.value,
                res.readback,
                category=res.category.value,
                amount=amount,
                speech=inv.speech,
            )
            return {
                "ok": True,
                "ref": rec.ref,
                "status": res.status.value,
                "readback": res.readback,
                **self._flags(res),
            }

        return await self._run(body)

    async def discard_expense(self, inv: Invocation, *, ref: str, reason: str | None = None) -> Result:
        async def body() -> Result:
            rec = self._own_record(ref, "expense")
            req = m.DiscardBody(**_drop_none(reason=reason), **self._meta("discard_expense", inv))
            res = await self._api("discard_expense", lambda: self.api.discard_expense(rec.id, req))
            rec.status = "discarded"
            return {"ok": True, "ref": rec.ref, "status": "discarded", "say": res.message}

        return await self._run(body)

    # ---------- Scale tickets ----------

    async def log_scale_ticket(
        self,
        inv: Invocation,
        *,
        load_number: str,
        net_weight_lbs: str,
        ticket_number: str | None = None,
        location: str | None = None,
    ) -> Result:
        async def body() -> Result:
            load = await self._load("log_scale_ticket", load_number)
            req = m.CreateTicketBody(
                net_weight_lbs=net_weight_lbs,
                **_drop_none(ticket_number=ticket_number, location=location),
                **self._meta("log_scale_ticket", inv),
            )

            def existing(err: ApiError) -> Result | None:
                found = err.details.get("existing")
                if err.code != "ticket_exists" or not isinstance(found, dict):
                    return None
                rec = self.state.add_record(
                    "ticket",
                    str(found["id"]),
                    str(found["status"]),
                    str(found["readback"]),
                    speech=inv.speech,
                )
                return {
                    "ok": False,
                    "error": "ticket_exists",
                    "ref": rec.ref,
                    "status": rec.status,
                    "say": err.message,
                }

            res = await self._api("log_scale_ticket", lambda: self.api.create_ticket(load.id, req), existing)
            rec = self.state.add_record(
                "ticket", str(res.id), res.status.value, res.readback, speech=inv.speech
            )
            return {
                "ok": True,
                "ref": rec.ref,
                "status": rec.status,
                "readback": res.readback,
                **self._flags(res),
            }

        return await self._run(body)

    async def correct_scale_ticket(
        self,
        inv: Invocation,
        *,
        ref: str,
        net_weight_lbs: str | None = None,
        ticket_number: str | None = None,
        location: str | None = None,
    ) -> Result:
        async def body() -> Result:
            rec = self._own_record(ref, "ticket")
            req = m.PatchTicketBody(
                **_drop_none(net_weight_lbs=net_weight_lbs, ticket_number=ticket_number, location=location),
                **self._meta("correct_scale_ticket", inv),
            )
            res = await self._api("correct_scale_ticket", lambda: self.api.correct_ticket(rec.id, req))
            self.state.add_record("ticket", rec.id, res.status.value, res.readback, speech=inv.speech)
            return {
                "ok": True,
                "ref": rec.ref,
                "status": res.status.value,
                "readback": res.readback,
                **self._flags(res),
            }

        return await self._run(body)

    # ---------- Confirmation ----------

    async def confirm_records(self, inv: Invocation, *, refs: list[str]) -> Result:
        """Confirm pending records from this call whose readback the caller heard in full."""

        async def body() -> Result:
            ready: list[Record] = []
            not_confirmed: list[Result] = []
            read_again: list[Result] = []
            for ref in refs:
                rec = self.state.record(ref)
                if not rec:
                    not_confirmed.append({"ref": ref, "reason": "not_from_this_call"})
                elif rec.status != "pending":
                    not_confirmed.append({"ref": rec.ref, "reason": f"already_{rec.status}"})
                elif rec.readback_speech is not None and (
                    rec.readback_speech.interrupted or not rec.readback_speech.done()
                ):
                    # The caller didn't hear it all. Say it again now, then wait for a yes.
                    rec.readback_speech = inv.speech
                    read_again.append({"ref": rec.ref, "readback": rec.readback})
                else:
                    ready.append(rec)

            confirmed: list[str] = []
            for kind in ("expense", "ticket"):
                batch = [r for r in ready if r.kind == kind]
                if not batch:
                    continue
                req = m.ConfirmBody(ids=[r.id for r in batch], **self._meta(f"confirm_{kind}s", inv))
                send = self.api.confirm_expenses if kind == "expense" else self.api.confirm_tickets
                res = await self._api("confirm_records", lambda send=send, req=req: send(req))
                by_id = {r.id: r for r in batch}
                for item in res.results:
                    rec = by_id.get(str(item.id))
                    if not rec:
                        continue
                    if item.result.value in ("confirmed", "already_confirmed"):
                        rec.status = "confirmed"
                        confirmed.append(rec.ref)
                    else:
                        not_confirmed.append({"ref": rec.ref, "reason": item.result.value})

            out: Result = {"ok": True, "confirmed": confirmed}
            if not_confirmed:
                out["not_confirmed"] = not_confirmed
            if read_again:
                out["read_back_first"] = read_again
                out["say"] = "Read these back again, word for word, and wait for a yes before confirming."
            return out

        return await self._run(body)

    # ---------- Stops and detention ----------

    async def log_stop_times(
        self,
        inv: Invocation,
        *,
        load_number: str,
        stop: str,
        arrived_at: str | None = None,
        departed_at: str | None = None,
    ) -> Result:
        async def body() -> Result:
            _, found = await self._stop("log_stop_times", load_number, stop)
            req = m.StopTimesBody(
                **_drop_none(arrived_at=arrived_at, departed_at=departed_at),
                **self._meta("log_stop_times", inv),
            )
            res = await self._api("log_stop_times", lambda: self.api.record_stop_times(found.id, req))
            return {
                "ok": True,
                "readback": res.readback,
                "load_status": res.load_status.value,
                "load_delivered": res.load_delivered,
            }

        return await self._run(body)

    async def check_detention(self, inv: Invocation, *, load_number: str, stop: str) -> Result:
        async def body() -> Result:
            _, found = await self._stop("check_detention", load_number, stop)
            res = await self._api("check_detention", lambda: self.api.check_detention(found.id))
            return {
                "ok": True,
                "eligible": res.eligible,
                "late_arrival": res.late_arrival,
                "claim_exists": res.claim is not None,
                "summary": res.summary,
            }

        return await self._run(body)

    async def create_detention_claim(
        self, inv: Invocation, *, load_number: str, stop: str, notes: str | None = None
    ) -> Result:
        async def body() -> Result:
            _, found = await self._stop("create_detention_claim", load_number, stop)
            req = m.CreateClaimBody(**_drop_none(notes=notes), **self._meta("create_detention_claim", inv))
            res = await self._api("create_detention_claim", lambda: self.api.create_claim(found.id, req))
            return {"ok": True, "status": res.status.value, "readback": res.readback}

        return await self._run(body)

    # ---------- Money questions ----------

    async def get_load_profitability(self, inv: Invocation, *, load_number: str) -> Result:
        async def body() -> Result:
            load = await self._load("get_load_profitability", load_number)
            res = await self._api("get_load_profitability", lambda: self.api.load_profitability(load.id))
            return {"ok": True, "summary": res.summary}

        return await self._run(body)

    def _owner(self) -> None:
        # The agent never offers these tools to drivers; the API rejects them regardless.
        if not self.state.is_owner:
            raise _Spoken({"ok": False, "error": "owner_only", "say": OWNER_ONLY})

    async def get_truck_summary(self, inv: Invocation, *, truck_number: str, range: Range = "week") -> Result:
        async def body() -> Result:
            self._owner()
            truck_id = self.state.trucks.get(truck_number.strip())
            if not truck_id:
                units = ", ".join(sorted(self.state.trucks))
                return {"ok": False, "error": "unknown_truck", "say": f"Which truck? I have {units}."}
            res = await self._api("get_truck_summary", lambda: self.api.truck_summary(truck_id, range))
            return {"ok": True, "summary": res.summary}

        return await self._run(body)

    async def get_business_summary(self, inv: Invocation, *, range: Range = "week") -> Result:
        async def body() -> Result:
            self._owner()
            res = await self._api(
                "get_business_summary", lambda: self.api.business_summary(self.state.business_id, range)
            )
            return {"ok": True, "summary": res.summary}

        return await self._run(body)

    async def list_unpaid_loads(self, inv: Invocation) -> Result:
        async def body() -> Result:
            self._owner()
            res = await self._api("list_unpaid_loads", lambda: self.api.unpaid_loads(self.state.business_id))
            return {"ok": True, "summary": res.summary}

        return await self._run(body)

    async def transfer_to_human(self, inv: Invocation) -> Result:
        await self._escalate("transferred")
        return {
            "ok": True,
            "say": "Okay, I'll have someone from the team call you back. Thanks for calling.",
            "call_ending": True,
        }
