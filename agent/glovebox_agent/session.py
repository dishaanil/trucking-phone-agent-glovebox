"""Per-call state: who is calling, what they can see, and the records made during this call.

The LLM never sees UUIDs. Records get short refs (E1, E2 for expenses, T1 for tickets), loads
are named by number, trucks by unit, and stops by type or facility name.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal, InvalidOperation
from typing import Literal, Protocol

from . import api_models as m

RecordKind = Literal["expense", "ticket"]


class SpeechHandleLike(Protocol):
    """The parts of a LiveKit SpeechHandle the readback check uses."""

    @property
    def interrupted(self) -> bool: ...

    def done(self) -> bool: ...


@dataclass
class Record:
    ref: str
    kind: RecordKind
    id: str
    status: str
    readback: str
    category: str | None = None
    amount_key: Decimal | None = None
    # The speech that carries this record's readback. Confirmation needs it finished, uninterrupted.
    readback_speech: SpeechHandleLike | None = None


@dataclass
class StopRef:
    id: str
    type: str
    facility_name: str
    city: str = ""
    state: str = ""
    appointment_at: datetime | None = None


@dataclass
class LoadRef:
    id: str
    number: str
    status: str
    truck_unit: str
    stops: list[StopRef]


@dataclass
class CallState:
    call_id: str
    sandbox_id: str
    person_id: str
    business_id: str
    business_name: str
    first_name: str
    full_name: str
    is_owner: bool
    is_driver: bool
    timezone: str
    trucks: dict[str, str]  # unit number -> truck id
    loads: dict[str, LoadRef]  # load number -> load
    records: dict[str, Record] = field(default_factory=dict)
    # Consecutive 5xx/timeout/network failures per tool, for the two-strikes rule.
    failures: dict[str, int] = field(default_factory=dict)
    turn: int = 0
    filler_turn: int | None = None
    end_reason: str = "caller_hung_up"
    _counters: dict[RecordKind, int] = field(default_factory=lambda: {"expense": 0, "ticket": 0})

    @classmethod
    def from_resolved(cls, call_id: str, r: m.ResolveCallerResponse1) -> CallState:
        return cls(
            call_id=call_id,
            sandbox_id=str(r.sandbox.id),
            person_id=str(r.person.id),
            business_id=str(r.business.id),
            business_name=r.business.name,
            first_name=r.person.first_name,
            full_name=r.person.full_name,
            is_owner=r.person.is_owner,
            is_driver=r.person.is_driver,
            timezone=r.person.timezone,
            trucks={t.unit_number: str(t.id) for t in r.trucks},
            loads={
                load.load_number: LoadRef(
                    id=str(load.id),
                    number=load.load_number,
                    status=load.status.value,
                    truck_unit=load.truck_unit,
                    stops=[_stop(s) for s in load.stops],
                )
                for load in r.active_loads
            },
        )

    # ---------- Idempotency ----------

    def idempotency_key(self, tool_name: str, tool_call_id: str | None) -> str:
        """One key per tool invocation: the LLM's tool-call id when available, else a fresh UUID."""
        return f"{self.call_id}:{tool_call_id or uuid.uuid4().hex}:{tool_name}"

    # ---------- Records ----------

    def add_record(
        self,
        kind: RecordKind,
        id: str,
        status: str,
        readback: str,
        *,
        category: str | None = None,
        amount: str | None = None,
        speech: SpeechHandleLike | None = None,
    ) -> Record:
        """Save a record (or refresh one already known by id) and return it with its ref."""
        for existing in self.records.values():
            if existing.id == id:
                existing.status, existing.readback = status, readback
                if category is not None:
                    existing.category = category
                if amount is not None:
                    existing.amount_key = amount_key(amount)
                if speech is not None:
                    existing.readback_speech = speech
                return existing
        self._counters[kind] += 1
        ref = f"{'E' if kind == 'expense' else 'T'}{self._counters[kind]}"
        record = Record(
            ref, kind, id, status, readback, category, amount_key(amount) if amount else None, speech
        )
        self.records[ref] = record
        return record

    def record(self, ref: str) -> Record | None:
        return self.records.get(ref.strip().upper())

    def pending_duplicate(self, category: str, amount: str) -> Record | None:
        """A pending expense from this call with the same category and amount (a repeated log)."""
        key = amount_key(amount)
        if key is None:
            return None
        for r in self.records.values():
            if (
                r.kind == "expense"
                and r.status == "pending"
                and r.category == category
                and r.amount_key == key
            ):
                return r
        return None

    # ---------- Loads, trucks and stops ----------

    def load(self, number: str) -> LoadRef | None:
        return self.loads.get(number.strip())

    def remember_load(self, load: m.LoadResponse) -> LoadRef:
        ref = LoadRef(
            id=str(load.id),
            number=load.load_number,
            status=load.status.value,
            truck_unit=load.truck_unit,
            stops=[_stop(s) for s in load.stops],
        )
        self.loads[ref.number] = ref
        return ref

    @staticmethod
    def find_stop(load: LoadRef, stop: str) -> StopRef | None:
        """'pickup', 'delivery', 'shipper', 'receiver', or part of the facility name."""
        wanted = stop.strip().lower()
        aliases = {"shipper": "pickup", "receiver": "delivery", "consignee": "delivery"}
        wanted_type = aliases.get(wanted, wanted)
        by_type = [s for s in load.stops if s.type == wanted_type]
        if len(by_type) == 1:
            return by_type[0]
        by_name = [s for s in load.stops if wanted and wanted in s.facility_name.lower()]
        return by_name[0] if len(by_name) == 1 else None

    # ---------- Turns and fillers ----------

    def next_turn(self) -> None:
        self.turn += 1

    def take_filler(self) -> bool:
        """At most one filler line per turn."""
        if self.filler_turn == self.turn:
            return False
        self.filler_turn = self.turn
        return True


def _stop(s: m.Stop | m.Stop1) -> StopRef:
    return StopRef(
        id=str(s.id),
        type=s.type.value,
        facility_name=s.facility_name,
        city=s.city,
        state=s.state,
        appointment_at=s.appointment_at,
    )


def amount_key(amount: str) -> Decimal | None:
    """Normalize an amount string only to compare two of them; the API does all parsing and math."""
    try:
        return Decimal(amount.strip().replace("$", "").replace(",", "")).normalize()
    except (InvalidOperation, ValueError):
        return None
