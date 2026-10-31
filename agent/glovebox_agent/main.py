"""LiveKit worker entry point.

    uv run --env-file .env python -m glovebox_agent.main dev       # connect to LiveKit Cloud
    uv run --env-file .env python -m glovebox_agent.main console   # talk in the terminal

Caller resolution: a SIP caller is resolved by caller ID. A browser participant can pass
`{"demo_code": "1234", "seed_key": "tommy"}` as participant metadata. Otherwise the agent asks
for the demo code out loud.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import uuid
from typing import Any

from livekit import rtc
from livekit.agents import AgentServer, AgentSession, JobContext, JobProcess, cli, inference
from livekit.plugins import cartesia, deepgram, google, silero

from .agent import DemoCodeAgent, GloveboxAgent
from .api_client import ApiClient, ApiError, ApiUnavailable
from .config import Config, load_config
from .session import CallState
from .tools import GloveboxTools

log = logging.getLogger("glovebox.agent")

# Deepgram Nova-3 keyterms: truck stop chains, seeded (fictional) facilities, commodities, categories.
KEYTERMS = [
    "Love's",
    "Pilot",
    "Flying J",
    "TA",
    "Petro",
    "Kwik Trip",
    "Casey's",
    "Harlan Point Cold Storage",
    "Southmere Distribution",
    "Corliss Packaging",
    "Tamsin Foods",
    "Millbrook",
    "Sutter Ridge",
    "Dellacourt",
    "Ostrander",
    "Halvern",
    "Bluegate",
    "Prairie Run",
    "corn",
    "soybeans",
    "hopper",
    "lumper",
    "washout",
    "DEF",
    "scale ticket",
    "detention",
    "reefer",
]
SILENCE_CHECK_IN = "Still there?"
SILENCE_GOODBYE = "I'll let you go. Call back anytime."


def prewarm(proc: JobProcess) -> None:
    proc.userdata["vad"] = silero.VAD.load()


server = AgentServer(setup_fnc=prewarm)


def make_session(config: Config, vad: Any) -> AgentSession:
    tts: Any = (
        cartesia.TTS() if config.tts_provider == "cartesia" else deepgram.TTS(model="aura-2-andromeda-en")
    )
    return AgentSession(
        stt=deepgram.STT(model="nova-3", smart_format=True, numerals=True, keyterm=KEYTERMS),
        llm=google.LLM(model=config.gemini_model, vertexai=False),
        tts=tts,
        vad=vad,
        # Drivers pause mid-thought: wait a little longer than the default before answering.
        # LiveKit's turn detector (cloud inference, local fallback; the old plugin is deprecated).
        turn_handling={
            "turn_detection": inference.TurnDetector(),
            "endpointing": {"min_delay": 0.8, "max_delay": 4.0},
        },
        user_away_timeout=config.user_away_timeout_s,
    )


def call_id_for(room_name: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9_.:-]", "-", room_name)[:80]
    return f"call_{safe}_{uuid.uuid4().hex[:8]}"


def caller_input(participant: rtc.RemoteParticipant) -> dict[str, str]:
    """Caller ID for phone calls; demo code and role from participant metadata for browser calls."""
    if participant.kind == rtc.ParticipantKind.PARTICIPANT_KIND_SIP:
        phone = participant.attributes.get("sip.phoneNumber")
        if phone:
            return {"phone": phone}
    try:
        meta = json.loads(participant.metadata or "{}")
    except json.JSONDecodeError:
        meta = {}
    out: dict[str, str] = {}
    if isinstance(meta, dict):
        if str(meta.get("demo_code", "")).isdigit():
            out["demo_code"] = str(meta["demo_code"])
        if meta.get("seed_key"):
            out["seed_key"] = str(meta["seed_key"])
    return out


@server.rtc_session()
async def entrypoint(ctx: JobContext) -> None:
    config = load_config()
    client = ApiClient(config.api_url, config.service_token, timeout_s=config.api_timeout_s)
    await ctx.connect()
    participant = await ctx.wait_for_participant()
    call_id = call_id_for(ctx.room.name)
    session = make_session(config, ctx.proc.userdata["vad"])
    current: dict[str, CallState | None] = {"state": None}

    async def end_call(reason: str) -> None:
        """Hang up once the agent finishes what it is saying."""
        state = current["state"]
        if state:
            state.end_reason = reason

        async def hang_up() -> None:
            await asyncio.sleep(0.5)  # let the final reply start
            while session.current_speech is not None:
                await session.current_speech.wait_for_playout()
            ctx.delete_room()

        asyncio.create_task(hang_up())

    async def start_bookkeeper(state: CallState) -> GloveboxAgent:
        current["state"] = state
        svc = GloveboxTools(state, client.for_caller(state.sandbox_id, state.person_id), end_call)
        return GloveboxAgent(svc, filler_delay_s=config.filler_delay_s)

    async def record_end() -> None:
        state = current["state"]
        if state:
            try:
                await client.for_caller(state.sandbox_id, state.person_id).end_call(call_id, state.end_reason)
            except (ApiError, ApiUnavailable):
                log.warning("could not record call end; the API timeout will close it")
        await client.aclose()

    ctx.add_shutdown_callback(record_end)

    # Silence: one check-in, then wrap up after a second long silence.
    away = {"count": 0}

    @session.on("user_state_changed")
    def on_user_state(ev: Any) -> None:
        if ev.new_state != "away":
            if ev.new_state == "speaking":
                away["count"] = 0
            return
        away["count"] += 1
        if away["count"] == 1:
            session.say(SILENCE_CHECK_IN)
        else:
            session.say(SILENCE_GOODBYE)
            asyncio.create_task(end_call("silence"))

    agent: Any
    found = caller_input(participant)
    resolved = None
    if found:
        try:
            resolved = await client.resolve(call_id=call_id, **found)
        except (ApiError, ApiUnavailable) as err:
            log.warning("caller resolution failed: %s", err)
    if resolved is not None and resolved.status == "resolved":
        agent = await start_bookkeeper(CallState.from_resolved(call_id, resolved))
    else:
        agent = DemoCodeAgent(
            client, call_id, start_bookkeeper, lambda: end_call("completed"), config.demo_site
        )

    await session.start(agent=agent, room=ctx.room)


if __name__ == "__main__":
    cli.run_app(server)
