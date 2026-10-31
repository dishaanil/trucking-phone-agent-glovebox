"""Spoken amounts through Deepgram Nova-3 with number formatting: what does the LLM actually receive?

Audio is synthesized with Deepgram TTS, then transcribed. Results are saved under /evals.
"""

from __future__ import annotations

import re

import aiohttp
import pytest
from livekit.plugins import deepgram

from .live import Transcript, require_env

pytestmark = pytest.mark.live

PHRASES = [
    ("fuel was five twelve forty", r"5\s?12[.\s]?40|512\.?40"),
    ("it came to five hundred twelve dollars and forty cents", r"\$?512(\.40)?"),
    ("the ticket says fifty two thousand eight hundred net", r"52,?800"),
    ("fifty two eight net", r"52[,\s]?8(00)?"),
    ("got there at seven fifty, didn't leave till eleven oh five", r"7:?50.*11:?0?5"),
]


async def test_spoken_amounts_come_back_as_digits():
    require_env("DEEPGRAM_API_KEY")
    transcript = Transcript("stt-amounts", {"model": "nova-3", "smart_format": True, "numerals": True})
    misses = []
    async with aiohttp.ClientSession() as http:
        tts = deepgram.TTS(model="aura-2-andromeda-en", http_session=http)
        stt = deepgram.STT(model="nova-3", smart_format=True, numerals=True, http_session=http)
        for spoken, expected in PHRASES:
            frames = [ev.frame async for ev in tts.synthesize(spoken)]
            heard = (await stt.recognize(frames)).alternatives[0].text
            transcript.turns.append({"spoken": spoken, "heard": heard, "expected": expected})
            if not re.search(expected, heard):
                misses.append((spoken, heard))
    path = transcript.save()
    assert not misses, f"see {path}: {misses}"
