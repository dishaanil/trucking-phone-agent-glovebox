import subprocess
from pathlib import Path

AGENT = Path(__file__).resolve().parent.parent


def test_generated_models_match_the_api_schema():
    """Run scripts/generate_models.sh if this fails (after `pnpm schemas:export` in /api)."""
    # Generate inside the package so the formatter uses this project's settings.
    out = AGENT / "glovebox_agent" / ".api_models_check.py"
    try:
        subprocess.run(
            ["sh", str(AGENT / "scripts/generate_models.sh"), str(out)], check=True, capture_output=True
        )
        assert out.read_text() == (AGENT / "glovebox_agent/api_models.py").read_text()
    finally:
        out.unlink(missing_ok=True)
