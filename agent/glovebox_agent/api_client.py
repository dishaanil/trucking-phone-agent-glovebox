"""The only HTTP code in the agent: a typed client for the Glovebox API.

Every request carries the service token; caller-scoped requests add x-sandbox-id and
x-person-id. Writes carry call_id and an idempotency key, and a retry resends the same body,
so a network retry never writes twice.
"""

from __future__ import annotations

import asyncio
from typing import Any, TypeVar
from uuid import UUID

import httpx
from pydantic import BaseModel, TypeAdapter, ValidationError

from . import api_models as m

T = TypeVar("T", bound=BaseModel)

ResolveResult = m.ResolveCallerResponse1 | m.ResolveCallerResponse2 | m.ResolveCallerResponse3
_resolve_adapter: TypeAdapter[ResolveResult] = TypeAdapter(ResolveResult)


class ApiError(Exception):
    """The API answered with a 4xx: a normal answer the caller should hear, not a failure."""

    def __init__(self, status: int, code: str, message: str, details: dict[str, Any]):
        super().__init__(f"{status} {code}: {message}")
        self.status = status
        self.code = code
        self.message = message
        self.details = details


class ApiUnavailable(Exception):
    """5xx, timeout or network error. Counts toward the two-strikes escalation."""


class ApiClient:
    def __init__(
        self,
        base_url: str,
        service_token: str,
        *,
        timeout_s: float = 5.0,
        retries: int = 2,
        retry_backoff_s: float = 0.2,
        transport: httpx.AsyncBaseTransport | None = None,
    ):
        self._http = httpx.AsyncClient(
            base_url=base_url,
            timeout=timeout_s,
            headers={"authorization": f"Bearer {service_token}"},
            transport=transport,
        )
        self._retries = retries
        self._backoff = retry_backoff_s

    async def aclose(self) -> None:
        await self._http.aclose()

    async def request(
        self,
        method: str,
        path: str,
        *,
        json: dict[str, Any] | None = None,
        params: dict[str, str] | None = None,
        headers: dict[str, str] | None = None,
    ) -> Any:
        """Send a request, retrying 5xx, timeouts and network errors with the same body."""
        last: Exception | None = None
        for attempt in range(self._retries + 1):
            if attempt:
                await asyncio.sleep(self._backoff * attempt)
            try:
                res = await self._http.request(method, path, json=json, params=params, headers=headers)
            except httpx.TransportError as err:  # includes timeouts
                last = err
                continue
            if res.status_code >= 500:
                last = ApiUnavailable(f"{res.status_code} from {method} {path}")
                continue
            body = res.json() if res.content else None
            if res.status_code >= 400:
                detail = body if isinstance(body, dict) else {}
                raise ApiError(
                    res.status_code,
                    str(detail.get("error", "error")),
                    str(detail.get("message", "Something went wrong.")),
                    detail,
                )
            return body
        raise ApiUnavailable(str(last)) from last

    async def resolve(
        self,
        *,
        call_id: str,
        phone: str | None = None,
        demo_code: str | None = None,
        seed_key: str | None = None,
    ) -> ResolveResult:
        body: dict[str, Any] = {"call_id": call_id}
        if phone is not None:
            body["phone"] = phone
        else:
            body["demo_code"] = demo_code
            if seed_key:
                body["seed_key"] = seed_key
        return _parse_union(await self.request("POST", "/callers/resolve", json=body))

    def for_caller(self, sandbox_id: UUID | str, person_id: UUID | str) -> CallerApi:
        return CallerApi(self, str(sandbox_id), str(person_id))


def _parse_union(data: Any) -> ResolveResult:
    try:
        return _resolve_adapter.validate_python(data)
    except ValidationError as err:
        raise ApiUnavailable(f"unexpected resolve response: {err}") from err


def _parse(model: type[T], data: Any) -> T:
    try:
        return model.model_validate(data)
    except ValidationError as err:
        raise ApiUnavailable(f"unexpected {model.__name__}: {err}") from err


class CallerApi:
    """Requests made on behalf of one resolved caller."""

    def __init__(self, client: ApiClient, sandbox_id: str, person_id: str):
        self._client = client
        self._headers = {"x-sandbox-id": sandbox_id, "x-person-id": person_id}

    async def _send(self, method: str, path: str, model: type[T], **kw: Any) -> T:
        return _parse(model, await self._client.request(method, path, headers=self._headers, **kw))

    async def _write(self, method: str, path: str, model: type[T], body: BaseModel) -> T:
        return await self._send(method, path, model, json=body.model_dump(mode="json", exclude_unset=True))

    # Expenses
    async def create_expense(self, body: m.CreateExpenseBody) -> m.ExpenseResponse:
        return await self._write("POST", "/expenses", m.ExpenseResponse, body)

    async def correct_expense(self, expense_id: str, body: m.PatchExpenseBody) -> m.ExpenseResponse:
        return await self._write("PATCH", f"/expenses/{expense_id}", m.ExpenseResponse, body)

    async def confirm_expenses(self, body: m.ConfirmBody) -> m.ConfirmResponse:
        return await self._write("POST", "/expenses/confirm", m.ConfirmResponse, body)

    async def discard_expense(self, expense_id: str, body: m.DiscardBody) -> m.DiscardResponse:
        return await self._write("POST", f"/expenses/{expense_id}/discard", m.DiscardResponse, body)

    # Scale tickets
    async def create_ticket(self, load_id: str, body: m.CreateTicketBody) -> m.TicketResponse:
        return await self._write("POST", f"/loads/{load_id}/scale-tickets", m.TicketResponse, body)

    async def correct_ticket(self, ticket_id: str, body: m.PatchTicketBody) -> m.TicketResponse:
        return await self._write("PATCH", f"/scale-tickets/{ticket_id}", m.TicketResponse, body)

    async def confirm_tickets(self, body: m.ConfirmBody) -> m.ConfirmResponse:
        return await self._write("POST", "/scale-tickets/confirm", m.ConfirmResponse, body)

    # Stops and detention
    async def record_stop_times(self, stop_id: str, body: m.StopTimesBody) -> m.StopTimesResponse:
        return await self._write("POST", f"/stops/{stop_id}/times", m.StopTimesResponse, body)

    async def check_detention(self, stop_id: str) -> m.DetentionResponse:
        return await self._send("GET", f"/stops/{stop_id}/detention", m.DetentionResponse)

    async def create_claim(self, stop_id: str, body: m.CreateClaimBody) -> m.ClaimResponse:
        return await self._write("POST", f"/stops/{stop_id}/detention-claims", m.ClaimResponse, body)

    # Loads
    async def find_load(self, number: str) -> m.LoadResponse:
        return await self._send("GET", "/loads", m.LoadResponse, params={"number": number})

    async def load_profitability(self, load_id: str) -> m.ProfitabilityResponse:
        return await self._send("GET", f"/loads/{load_id}/profitability", m.ProfitabilityResponse)

    # Owner only
    async def truck_summary(self, truck_id: str, range_: str) -> m.TruckSummaryResponse:
        return await self._send(
            "GET", f"/trucks/{truck_id}/summary", m.TruckSummaryResponse, params={"range": range_}
        )

    async def business_summary(self, business_id: str, range_: str) -> m.BusinessSummaryResponse:
        return await self._send(
            "GET", f"/businesses/{business_id}/summary", m.BusinessSummaryResponse, params={"range": range_}
        )

    async def unpaid_loads(self, business_id: str) -> m.UnpaidLoadsResponse:
        return await self._send("GET", f"/businesses/{business_id}/unpaid-loads", m.UnpaidLoadsResponse)

    # Calls
    async def end_call(self, call_id: str, reason: str) -> m.EndCallResponse:
        return await self._write(
            "POST", f"/calls/{call_id}/end", m.EndCallResponse, m.EndCallBody(reason=reason)
        )
