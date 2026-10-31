"""Helpers for live tests: a running API, real provider keys, and transcripts saved under /evals.

Run with: uv run --env-file .env pytest -m live
"""

from __future__ import annotations

import json
import os
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
import pytest

TRANSCRIPTS = Path(__file__).resolve().parents[2] / "evals" / "transcripts"


def require_env(*names: str) -> dict[str, str]:
    missing = [n for n in names if not os.environ.get(n)]
    if missing:
        pytest.skip(f"live test needs {', '.join(missing)} (run with uv run --env-file .env)")
    return {n: os.environ[n] for n in names}


def require_api(api_url: str) -> None:
    try:
        httpx.get(f"{api_url}/health", timeout=2).raise_for_status()
    except httpx.HTTPError:
        pytest.skip(f"live test needs the API running at {api_url} (cd api && pnpm dev)")


def new_sandbox(api_url: str, scenario: str) -> dict[str, Any]:
    res = httpx.post(f"{api_url}/sandboxes", json={"scenario": scenario, "access_mode": "code"}, timeout=10)
    res.raise_for_status()
    return res.json()


def event_json(ev: Any) -> dict[str, Any]:
    item = ev.item
    if ev.type == "message":
        return {"type": "message", "role": item.role, "text": item.text_content}
    if ev.type == "function_call":
        return {"type": "function_call", "name": item.name, "arguments": json.loads(item.arguments or "{}")}
    if ev.type == "function_call_output":
        return {
            "type": "function_call_output",
            "name": item.name,
            "output": item.output,
            "is_error": item.is_error,
        }
    return {"type": ev.type}


class Transcript:
    """Collects turns and writes them to evals/transcripts/<timestamp>-<name>.json."""

    def __init__(self, name: str, meta: dict[str, Any]):
        self.name = name
        self.meta = meta
        self.turns: list[dict[str, Any]] = []

    def add(self, speaker: str, user_input: str, events: list[Any]) -> list[dict[str, Any]]:
        out = [event_json(e) for e in events]
        self.turns.append({"speaker": speaker, "user": user_input, "events": out})
        return out

    def save(self) -> Path:
        TRANSCRIPTS.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
        path = TRANSCRIPTS / f"{stamp}-{self.name}.json"
        path.write_text(json.dumps({"name": self.name, **self.meta, "turns": self.turns}, indent=2) + "\n")
        return path


def calls(events: list[dict[str, Any]], name: str) -> list[dict[str, Any]]:
    return [e for e in events if e["type"] == "function_call" and e["name"] == name]
