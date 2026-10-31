"""System prompt and greeting, rendered from the caller's context at call start."""

from __future__ import annotations

from datetime import datetime
from importlib.resources import files
from string import Template
from zoneinfo import ZoneInfo

from .session import CallState, LoadRef

_TEMPLATE = Template(files("glovebox_agent").joinpath("prompts/system.md").read_text(encoding="utf-8"))

OWNER_RULES = (
    "- Owner questions: get_truck_summary, get_business_summary and list_unpaid_loads, then say "
    'their `summary`. "This week" means range "week"; "last 7 days" or "past week" means range '
    '"last_7_days".'
)
DRIVER_RULES = (
    "- Fleet totals, other trucks, other drivers' loads and unpaid loads are for the owner. Decline in one "
    'friendly sentence ("That\'s one for the owner to check.") and offer what you can do instead, like the '
    "numbers on their own load."
)


def _local(dt: datetime, tz: str) -> str:
    return dt.astimezone(ZoneInfo(tz)).strftime("%A %B %-d, %-I:%M %p")


def _load_line(load: LoadRef, tz: str) -> str:
    stops = "; ".join(
        f"{s.type} at {s.facility_name}, {s.city} {s.state}".strip()
        + (f", appointment {_local(s.appointment_at, tz)}" if s.appointment_at else "")
        for s in load.stops
    )
    return f"- Load {load.number} ({load.status.replace('_', ' ')}, truck {load.truck_unit}): {stops}"


def role_label(state: CallState) -> str:
    if state.is_owner and state.is_driver:
        return "owner and driver"
    return "owner" if state.is_owner else "driver"


def render_system_prompt(state: CallState, now: datetime) -> str:
    loads = [_load_line(load, state.timezone) for load in state.loads.values()]
    trucks = ", ".join(sorted(state.trucks))
    return _TEMPLATE.substitute(
        full_name=state.full_name,
        role=role_label(state),
        business_name=state.business_name,
        local_now=_local(now, state.timezone),
        timezone=state.timezone,
        trucks_line=f"Trucks this caller can ask about: {trucks}." if trucks else "No truck assigned.",
        loads_block="Active loads:\n" + "\n".join(loads) if loads else "No active loads.",
        owner_rules=OWNER_RULES if state.is_owner else DRIVER_RULES,
    )


def _route(load: LoadRef) -> str:
    cities = [s.city for s in load.stops if s.city]
    return f", {cities[0]} to {cities[-1]}" if len(cities) >= 2 else ""


def greeting(state: CallState) -> str:
    """Says it's an automated assistant, then states the current load."""
    hello = f"Hi {state.first_name}, this is Glovebox, an automated bookkeeping assistant."
    loads = list(state.loads.values())
    moving = [load for load in loads if load.status == "in_transit"]
    waiting = [load for load in loads if load.status == "delivered"]
    if moving:
        return f"{hello} You're on load {moving[0].number}{_route(moving[0])}. What've you got?"
    if waiting:
        return (
            f"{hello} Load {waiting[0].number} is delivered and still needs a scale ticket. What've you got?"
        )
    return f"{hello} What can I help with?"
