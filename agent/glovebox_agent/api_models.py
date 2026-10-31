# Generated from api/schemas/api.schema.json by agent/scripts/generate_models.sh. Do not edit.

from __future__ import annotations

from enum import StrEnum
from uuid import UUID
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, RootModel
from typing import Any, Dict, Literal


class Range(StrEnum):
    week = "week"
    last_7_days = "last_7_days"


class RevenueStatus(StrEnum):
    final = "final"
    pending_scale_ticket = "pending_scale_ticket"


class DeliveredLoad(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    load_id: UUID
    load_number: str
    truck_unit: str
    revenue_status: RevenueStatus
    revenue_cents: int | None
    projected_revenue_cents: int | None


class Status(StrEnum):
    booked = "booked"
    in_transit = "in_transit"
    delivered = "delivered"
    invoiced = "invoiced"
    paid = "paid"


class OpenLoadsWithCost(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    load_id: UUID
    load_number: str
    truck_unit: str
    status: Status
    costs_cents: int


class Truck(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    truck_id: UUID
    truck_unit: str
    revenue_cents: int
    costs_cents: int
    net_cents: int


class BestTruck(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    truck_id: UUID
    truck_unit: str
    revenue_cents: int
    costs_cents: int
    net_cents: int


class WorstTruck(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    truck_id: UUID
    truck_unit: str
    revenue_cents: int
    costs_cents: int
    net_cents: int


class BusinessSummaryResponse(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    business_id: UUID
    business_name: str
    range: Range
    start: AwareDatetime
    end: AwareDatetime
    revenue_cents: int
    revenue_display: str
    costs_cents: int
    costs_display: str
    net_cents: int
    net_display: str
    pending_revenue_cents: int
    delivered_loads: list[DeliveredLoad]
    open_loads_with_costs: list[OpenLoadsWithCost]
    summary: str
    overhead_costs_cents: int
    trucks: list[Truck]
    best_truck: BestTruck | None
    worst_truck: WorstTruck | None


class Status1(StrEnum):
    draft = "draft"
    sent = "sent"
    approved = "approved"
    rejected = "rejected"
    paid = "paid"


class ClaimResponse(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    id: UUID
    stop_id: UUID
    load_id: UUID
    load_number: str
    facility_name: str
    status: Status1
    billable_minutes: int
    amount_cents: int
    amount_display: str
    notes: str | None
    readback: str


class ConfirmBody(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    ids: list[UUID] = Field(..., max_length=50, min_length=1)
    call_id: str = Field(..., max_length=128, min_length=1)
    idempotency_key: str = Field(..., max_length=256, min_length=1)


class Result1(StrEnum):
    confirmed = "confirmed"
    already_confirmed = "already_confirmed"
    discarded = "discarded"
    not_found = "not_found"
    forbidden = "forbidden"


class Result(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    id: UUID
    result: Result1


class ConfirmResponse(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    results: list[Result]
    confirmed_count: int


class CreateClaimBody(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    notes: str | None = Field(None, max_length=500, min_length=1)
    call_id: str = Field(..., max_length=128, min_length=1)
    idempotency_key: str = Field(..., max_length=256, min_length=1)


class Category(StrEnum):
    fuel = "fuel"
    def_ = "def"
    toll = "toll"
    scale_fee = "scale_fee"
    parking = "parking"
    lumper = "lumper"
    repair = "repair"
    washout = "washout"
    food = "food"
    other = "other"


class PaymentMethod(StrEnum):
    card = "card"
    cash = "cash"
    fuel_card = "fuel_card"
    unknown = "unknown"


class CreateExpenseBody(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    category: Category
    amount: str = Field(..., max_length=32, min_length=1)
    vendor: str | None = Field(None, max_length=100, min_length=1)
    city: str | None = Field(None, max_length=100, min_length=1)
    state: str | None = Field(None, max_length=40, min_length=1)
    gallons: str | None = Field(None, max_length=16, min_length=1)
    payment_method: PaymentMethod | None = None
    load_id: UUID | None = None
    truck_id: UUID | None = None
    reimbursable: bool | None = None
    occurred_at: AwareDatetime | None = None
    call_id: str = Field(..., max_length=128, min_length=1)
    idempotency_key: str = Field(..., max_length=256, min_length=1)


class NetWeightLbs(RootModel[str]):
    root: str = Field(..., max_length=16, min_length=1)


class CreateTicketBody(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    net_weight_lbs: NetWeightLbs | int
    ticket_number: str | None = Field(None, max_length=40, min_length=1)
    location: str | None = Field(None, max_length=100, min_length=1)
    call_id: str = Field(..., max_length=128, min_length=1)
    idempotency_key: str = Field(..., max_length=256, min_length=1)


class Reason(StrEnum):
    payer_no_detention = "payer_no_detention"
    missing_times = "missing_times"
    under_free_time = "under_free_time"


class Claim(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    id: UUID
    stop_id: UUID
    load_id: UUID
    load_number: str
    facility_name: str
    status: Status1
    billable_minutes: int
    amount_cents: int
    amount_display: str
    notes: str | None
    readback: str


class DetentionResponse(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    stop_id: UUID
    load_id: UUID
    load_number: str
    facility_name: str
    payer_name: str
    eligible: bool
    reason: Reason | None
    on_time: bool | None
    late_arrival: bool
    clock_start: AwareDatetime | None
    waited_minutes: int
    free_minutes: int
    billable_minutes: int
    billable_display: str
    amount_cents: int
    amount_display: str
    notes: str | None
    claim: Claim | None
    summary: str


class DiscardBody(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    reason: str | None = Field(None, max_length=200, min_length=1)
    call_id: str = Field(..., max_length=128, min_length=1)
    idempotency_key: str = Field(..., max_length=256, min_length=1)


class PreviousStatus(StrEnum):
    pending = "pending"
    confirmed = "confirmed"
    discarded = "discarded"


class DiscardResponse(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    id: UUID
    status: Literal["discarded"]
    previous_status: PreviousStatus
    message: str


class Reason1(StrEnum):
    completed = "completed"
    caller_hung_up = "caller_hung_up"
    transferred = "transferred"
    silence = "silence"
    error = "error"


class EndCallBody(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    reason: Reason1


class EndReason(StrEnum):
    completed = "completed"
    caller_hung_up = "caller_hung_up"
    transferred = "transferred"
    silence = "silence"
    error = "error"
    timeout = "timeout"


class EndCallResponse(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    call_id: str
    ended_at: AwareDatetime
    end_reason: EndReason
    duration_seconds: int


class ErrorResponse(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    __annotations__ = {
        "__pydantic_extra__": Dict[str, Any],
    }
    error: str
    message: str


class Status3(StrEnum):
    pending = "pending"
    confirmed = "confirmed"
    discarded = "discarded"


class ConfirmationReason(StrEnum):
    amount_over_ceiling = "amount_over_ceiling"
    price_per_gallon_out_of_range = "price_per_gallon_out_of_range"
    weight_out_of_range = "weight_out_of_range"
    occurred_long_ago = "occurred_long_ago"


class ExpenseResponse(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    id: UUID
    status: Status3
    category: Category
    amount_cents: int = Field(..., gt=0)
    amount_display: str
    gallons: str | None
    vendor: str | None
    city: str | None
    state: str | None
    payment_method: PaymentMethod
    reimbursable: bool
    occurred_at: AwareDatetime
    load_id: UUID | None
    load_number: str | None
    truck_id: UUID | None
    truck_unit: str | None
    receipt_status: str
    readback: str
    needs_confirmation: bool
    confirmation_reasons: list[ConfirmationReason]
    confirmation_prompt: str | None


class Status4(StrEnum):
    booked = "booked"
    in_transit = "in_transit"
    delivered = "delivered"
    invoiced = "invoiced"
    paid = "paid"


class RateType(StrEnum):
    flat = "flat"
    per_ton = "per_ton"
    per_mile = "per_mile"


class Type(StrEnum):
    pickup = "pickup"
    delivery = "delivery"


class Stop(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    id: UUID
    type: Type
    sequence: int
    facility_name: str
    city: str
    state: str
    timezone: str
    appointment_at: AwareDatetime | None
    arrived_at: AwareDatetime | None
    departed_at: AwareDatetime | None


class LoadResponse(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    id: UUID
    load_number: str
    status: Status4
    commodity: str | None
    rate_type: RateType
    rate_cents: int
    loaded_miles: int
    truck_id: UUID
    truck_unit: str
    driver_id: UUID
    driver_name: str
    payer_name: str
    stops: list[Stop]


class Vendor(RootModel[str]):
    root: str = Field(..., max_length=100, min_length=1)


class City(RootModel[str]):
    root: str = Field(..., max_length=100, min_length=1)


class State(RootModel[str]):
    root: str = Field(..., max_length=40, min_length=1)


class Gallons(RootModel[str]):
    root: str = Field(..., max_length=16, min_length=1)


class PatchExpenseBody(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    category: Category | None = None
    amount: str | None = Field(None, max_length=32, min_length=1)
    vendor: Vendor | None = None
    city: City | None = None
    state: State | None = None
    gallons: Gallons | None = None
    payment_method: PaymentMethod | None = None
    load_id: UUID | None = None
    truck_id: UUID | None = None
    reimbursable: bool | None = None
    occurred_at: AwareDatetime | None = None
    call_id: str = Field(..., max_length=128, min_length=1)
    idempotency_key: str = Field(..., max_length=256, min_length=1)


class TicketNumber(RootModel[str]):
    root: str = Field(..., max_length=40, min_length=1)


class Location(RootModel[str]):
    root: str = Field(..., max_length=100, min_length=1)


class PatchTicketBody(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    net_weight_lbs: NetWeightLbs | int | None = None
    ticket_number: TicketNumber | None = None
    location: Location | None = None
    call_id: str = Field(..., max_length=128, min_length=1)
    idempotency_key: str = Field(..., max_length=256, min_length=1)


class ProfitabilityResponse(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    load_id: UUID
    load_number: str
    status: Status4
    rate_type: RateType
    loaded_miles: int
    revenue_status: RevenueStatus
    revenue_cents: int | None
    revenue_display: str | None
    projected_revenue_cents: int | None
    projected_revenue_display: str | None
    detention_revenue_cents: int
    pending_revenue_cents: int
    costs_cents: int
    costs_display: str
    net_cents: int | None
    net_display: str | None
    cost_per_mile_cents: int | None
    summary: str


class ResolveCallerBody1(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    phone: str = Field(..., max_length=32, min_length=1)
    call_id: str | None = Field(None, pattern="^[A-Za-z0-9_.:-]{1,128}$")


class ResolveCallerBody2(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    demo_code: str = Field(..., pattern="^\\d{4}$")
    seed_key: str | None = Field(None, pattern="^[a-z]+$")
    call_id: str | None = Field(None, pattern="^[A-Za-z0-9_.:-]{1,128}$")


class Scenario(StrEnum):
    owner_operator = "owner_operator"
    small_fleet = "small_fleet"


class AccessMode(StrEnum):
    phone = "phone"
    code = "code"


class Sandbox(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    id: UUID
    scenario: Scenario
    access_mode: AccessMode


class Business(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    id: UUID
    name: str


class Person(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    id: UUID
    seed_key: str
    full_name: str
    first_name: str
    is_owner: bool
    is_driver: bool
    timezone: str


class Truck1(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    id: UUID
    unit_number: str
    trailer_type: str
    assigned_seed_key: str | None


class Stop1(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    id: UUID
    type: Type
    sequence: int
    facility_name: str
    city: str
    state: str
    appointment_at: AwareDatetime | None


class ActiveLoad(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    id: UUID
    load_number: str
    status: Status4
    commodity: str | None
    rate_type: RateType
    truck_unit: str
    payer_name: str
    needs_scale_ticket: bool
    stops: list[Stop1]


class ResolveCallerResponse1(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    status: Literal["resolved"]
    sandbox: Sandbox
    business: Business
    person: Person
    trucks: list[Truck1]
    active_loads: list[ActiveLoad]


class Sandbox1(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    id: UUID
    scenario: Scenario
    access_mode: AccessMode


class Person1(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    seed_key: str
    full_name: str
    is_owner: bool
    is_driver: bool
    truck_unit: str | None


class ResolveCallerResponse2(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    status: Literal["choose_person"]
    sandbox: Sandbox1
    people: list[Person1]


class ResolveCallerResponse3(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    status: Literal["not_found"]


class StopTimesBody(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    arrived_at: str | None = Field(None, max_length=40, min_length=1)
    departed_at: str | None = Field(None, max_length=40, min_length=1)
    call_id: str = Field(..., max_length=128, min_length=1)
    idempotency_key: str = Field(..., max_length=256, min_length=1)


class Stop2(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    id: UUID
    type: Type
    sequence: int
    facility_name: str
    city: str
    state: str
    timezone: str
    appointment_at: AwareDatetime | None
    arrived_at: AwareDatetime | None
    departed_at: AwareDatetime | None


class LoadStatus(StrEnum):
    booked = "booked"
    in_transit = "in_transit"
    delivered = "delivered"
    invoiced = "invoiced"
    paid = "paid"


class StopTimesResponse(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    stop: Stop2
    load_id: UUID
    load_number: str
    load_status: LoadStatus
    load_delivered: bool
    claim_recalculated: bool
    readback: str


class Status7(StrEnum):
    pending = "pending"
    confirmed = "confirmed"
    discarded = "discarded"


class TicketResponse(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    id: UUID
    status: Status7
    load_id: UUID
    load_number: str
    net_weight_lbs: int = Field(..., gt=0)
    weight_display: str
    ticket_number: str | None
    location: str | None
    readback: str
    needs_confirmation: bool
    confirmation_reasons: list[ConfirmationReason]
    confirmation_prompt: str | None


class DeliveredLoad1(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    load_id: UUID
    load_number: str
    truck_unit: str
    revenue_status: RevenueStatus
    revenue_cents: int | None
    projected_revenue_cents: int | None


class Status8(StrEnum):
    booked = "booked"
    in_transit = "in_transit"
    delivered = "delivered"
    invoiced = "invoiced"
    paid = "paid"


class OpenLoadsWithCost1(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    load_id: UUID
    load_number: str
    truck_unit: str
    status: Status8
    costs_cents: int


class TruckSummaryResponse(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    truck_id: UUID
    truck_unit: str
    range: Range
    start: AwareDatetime
    end: AwareDatetime
    revenue_cents: int
    revenue_display: str
    costs_cents: int
    costs_display: str
    net_cents: int
    net_display: str
    pending_revenue_cents: int
    delivered_loads: list[DeliveredLoad1]
    open_loads_with_costs: list[OpenLoadsWithCost1]
    summary: str


class Load(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    load_id: UUID
    load_number: str
    truck_unit: str
    payer_name: str
    status: Status8
    revenue_status: RevenueStatus
    amount_cents: int | None
    amount_display: str | None
    projected_amount_cents: int | None
    delivered_at: AwareDatetime | None
    invoiced_at: AwareDatetime | None
    days_since_invoiced: int | None


class UnpaidLoadsResponse(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    loads: list[Load]
    total_cents: int
    total_display: str
    summary: str


class GloveboxApi(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    BusinessSummaryResponse_1: BusinessSummaryResponse | None = Field(None, alias="BusinessSummaryResponse")
    ClaimResponse_1: ClaimResponse | None = Field(None, alias="ClaimResponse")
    ConfirmBody_1: ConfirmBody | None = Field(None, alias="ConfirmBody")
    ConfirmResponse_1: ConfirmResponse | None = Field(None, alias="ConfirmResponse")
    CreateClaimBody_1: CreateClaimBody | None = Field(None, alias="CreateClaimBody")
    CreateExpenseBody_1: CreateExpenseBody | None = Field(None, alias="CreateExpenseBody")
    CreateTicketBody_1: CreateTicketBody | None = Field(None, alias="CreateTicketBody")
    DetentionResponse_1: DetentionResponse | None = Field(None, alias="DetentionResponse")
    DiscardBody_1: DiscardBody | None = Field(None, alias="DiscardBody")
    DiscardResponse_1: DiscardResponse | None = Field(None, alias="DiscardResponse")
    EndCallBody_1: EndCallBody | None = Field(None, alias="EndCallBody")
    EndCallResponse_1: EndCallResponse | None = Field(None, alias="EndCallResponse")
    ErrorResponse_1: ErrorResponse | None = Field(None, alias="ErrorResponse")
    ExpenseResponse_1: ExpenseResponse | None = Field(None, alias="ExpenseResponse")
    LoadResponse_1: LoadResponse | None = Field(None, alias="LoadResponse")
    PatchExpenseBody_1: PatchExpenseBody | None = Field(None, alias="PatchExpenseBody")
    PatchTicketBody_1: PatchTicketBody | None = Field(None, alias="PatchTicketBody")
    ProfitabilityResponse_1: ProfitabilityResponse | None = Field(None, alias="ProfitabilityResponse")
    ResolveCallerBody: ResolveCallerBody1 | ResolveCallerBody2 | None = None
    ResolveCallerResponse: ResolveCallerResponse1 | ResolveCallerResponse2 | ResolveCallerResponse3 | None = (
        None
    )
    StopTimesBody_1: StopTimesBody | None = Field(None, alias="StopTimesBody")
    StopTimesResponse_1: StopTimesResponse | None = Field(None, alias="StopTimesResponse")
    TicketResponse_1: TicketResponse | None = Field(None, alias="TicketResponse")
    TruckSummaryResponse_1: TruckSummaryResponse | None = Field(None, alias="TruckSummaryResponse")
    UnpaidLoadsResponse_1: UnpaidLoadsResponse | None = Field(None, alias="UnpaidLoadsResponse")
