"""Configuration from environment variables, loaded once.

LiveKit (LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET) and provider keys (DEEPGRAM_API_KEY,
GOOGLE_API_KEY, CARTESIA_API_KEY) are read by the LiveKit plugins themselves. In development,
run with `uv run --env-file .env ...`.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Literal

TtsProvider = Literal["deepgram", "cartesia"]


class ConfigError(Exception):
    pass


@dataclass(frozen=True)
class Config:
    api_url: str
    service_token: str
    gemini_model: str = "gemini-3.5-flash"
    tts_provider: TtsProvider = "deepgram"
    api_timeout_s: float = 5.0
    filler_delay_s: float = 0.7
    # Silence: one check-in, then wrap up after a second long silence.
    user_away_timeout_s: float = 15.0
    # Website the agent points callers to when a demo code fails twice.
    demo_site: str = "the Glovebox demo website"


def load_config(env: Mapping[str, str] | None = None) -> Config:
    env = os.environ if env is None else env

    def required(name: str) -> str:
        value = env.get(name, "").strip()
        if not value:
            raise ConfigError(f"{name} must be set")
        return value

    tts = env.get("TTS_PROVIDER", "deepgram").strip()
    if tts not in ("deepgram", "cartesia"):
        raise ConfigError("TTS_PROVIDER must be deepgram or cartesia")
    return Config(
        api_url=required("API_URL").rstrip("/"),
        service_token=required("SERVICE_TOKEN"),
        gemini_model=env.get("GEMINI_MODEL", "").strip() or Config.gemini_model,
        tts_provider=tts,  # type: ignore[arg-type]
        api_timeout_s=float(env.get("API_TIMEOUT_S", Config.api_timeout_s)),
        user_away_timeout_s=float(env.get("USER_AWAY_TIMEOUT_S", Config.user_away_timeout_s)),
        demo_site=env.get("DEMO_SITE", "").strip() or Config.demo_site,
    )
