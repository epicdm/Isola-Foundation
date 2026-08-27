"""ONE authoritative source for the host and port this sidecar binds.

Closes def-agentos-dockerfile-hardcodes-host-port-ignoring-settings-2026-08-27.

THE DEFECT. `Dockerfile`'s last line was
`CMD ["--host","0.0.0.0","--port","8700"]` — a hardcoded bind — while
`settings.py` read `AGENTOS_HOST`/`AGENTOS_PORT` and the image HEALTHCHECK
probed `os.environ.get('AGENTOS_PORT','8700')`. Set `AGENTOS_PORT=9000` and
the healthcheck probed 9000 while uvicorn bound 8700: a setting accepted,
echoed by two of three readers, and silently ignored by the one that matters
(CLAUDE.md Law 24's corollary — "pin twice and verify the binding": the config
states intent, the bound socket states fact).

The fix is not "make the Dockerfile read the env too" — that would be a third
copy of the same decision (Law 21: enumerate every place the value lives).
`settings.resolve_host` / `settings.resolve_port` is the ONE parser, and the
uvicorn bind, the healthcheck and `load_settings()` all go through it.

This file asserts the source-level property. The image-level property — that
the built container really does bind 8700 by default and 9000 when told to —
is proved by running the image, because a passing source test plus a build is
not proof that the deliverable starts (the missing PYTHONPATH documented in
the Dockerfile is this repo's own precedent for exactly that).
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from agentos_runtime.settings import (
    DEFAULT_HOST,
    DEFAULT_PORT,
    ConfigError,
    load_settings,
    resolve_host,
    resolve_port,
)

DOCKERFILE = Path(__file__).resolve().parent.parent / "Dockerfile"


def _placeholder(label: str) -> str:
    return "-".join(["not", "a", "real", "credential", label]) + "-" + "0" * 16


def _env(tmp_path, **overrides) -> dict[str, str]:
    shared = tmp_path / "shared"
    shared.write_text(_placeholder("shared"), encoding="utf-8")
    jwt = tmp_path / "jwt"
    jwt.write_text(_placeholder("jwt"), encoding="utf-8")
    env = {
        "AGENTOS_SHARED_SECRET_FILE": str(shared),
        "AGENTOS_JWT_VERIFICATION_KEY_FILE": str(jwt),
        "AGENTOS_TENANT_ID": "8D3dp3z",
    }
    env.update(overrides)
    return env


# ---------------------------------------------------------------------------
# The one parser
# ---------------------------------------------------------------------------


def test_the_default_port_is_8700():
    assert resolve_port({}) == 8700
    assert DEFAULT_PORT == 8700


def test_a_non_default_port_is_read_not_ignored():
    # The exact case that was broken: AGENTOS_PORT=9000.
    assert resolve_port({"AGENTOS_PORT": "9000"}) == 9000


def test_an_empty_port_value_falls_back_to_the_default():
    assert resolve_port({"AGENTOS_PORT": ""}) == 8700


def test_a_non_integer_port_refuses_rather_than_silently_defaulting(tmp_path):
    """Falling back to 8700 here would be the SAME defect in a new place: a
    value supplied, accepted and quietly discarded.
    """
    with pytest.raises(ConfigError, match="AGENTOS_PORT"):
        resolve_port({"AGENTOS_PORT": "not-an-integer"})


def test_the_default_host_is_loopback_and_an_override_is_read():
    assert resolve_host({}) == DEFAULT_HOST == "127.0.0.1"
    # The container image sets 0.0.0.0 because another container on the private
    # overlay must reach it; isolation comes from publishing nothing, never
    # from the bind address (CLAUDE.md Law 6: a filter rule is not containment).
    assert resolve_host({"AGENTOS_HOST": "0.0.0.0"}) == "0.0.0.0"


@pytest.mark.parametrize("raw,expected", [(None, 8700), ("9000", 9000), ("8081", 8081)])
def test_load_settings_and_resolve_port_never_disagree(tmp_path, raw, expected):
    """THE MULTI-READER ASSERTION (Law 20's multi-gate corollary). Two readers
    of the same setting must key on the same field — and this asserts they
    agree on a NON-DEFAULT value too, so it cannot pass trivially by both
    happening to return 8700.
    """
    overrides = {} if raw is None else {"AGENTOS_PORT": raw}
    env = _env(tmp_path, **overrides)
    settings = load_settings(env)
    assert settings.port == resolve_port(env) == expected
    assert settings.host == resolve_host(env)


# ---------------------------------------------------------------------------
# The uvicorn bind
# ---------------------------------------------------------------------------


def test_the_module_entrypoint_binds_what_the_setting_says(monkeypatch):
    """`python -m agentos_runtime` must derive its bind from the same parser.

    `uvicorn.run` is monkeypatched, so no socket is opened and the app module
    is never imported by a worker — this measures the ARGUMENTS, which is the
    property in question.
    """
    import uvicorn

    import agentos_runtime.__main__ as entry

    captured: dict = {}
    monkeypatch.setattr(uvicorn, "run", lambda *args, **kwargs: captured.update(kwargs))

    monkeypatch.setenv("AGENTOS_PORT", "9000")
    monkeypatch.setenv("AGENTOS_HOST", "0.0.0.0")
    entry.main()
    assert captured["port"] == 9000
    assert captured["host"] == "0.0.0.0"

    # POSITIVE CONTROL — without a second, different value this would pass
    # equally against an entrypoint that hardcoded 9000.
    captured.clear()
    monkeypatch.delenv("AGENTOS_PORT", raising=False)
    monkeypatch.delenv("AGENTOS_HOST", raising=False)
    entry.main()
    assert captured["port"] == 8700
    assert captured["host"] == "127.0.0.1"


# ---------------------------------------------------------------------------
# The image
# ---------------------------------------------------------------------------


def _dockerfile_text() -> str:
    return DOCKERFILE.read_text(encoding="utf-8")


def _directive(text: str, keyword: str) -> str:
    """The full logical line for a directive, with backslash continuations joined."""
    joined = re.sub(r"\\\s*\n\s*", " ", text)
    for line in joined.splitlines():
        if line.strip().startswith(keyword):
            return line.strip()
    return ""


def test_CONTROL_the_dockerfile_scan_is_reading_something():
    """If this fails, every assertion below is reading an empty string and
    would pass vacuously — the instrument must be checked before the world
    (CLAUDE.md Law 13).
    """
    text = _dockerfile_text()
    assert len(text) > 500
    assert _directive(text, "ENTRYPOINT")
    assert _directive(text, "HEALTHCHECK")


def test_the_container_bind_is_not_hardcoded_in_the_dockerfile():
    text = _dockerfile_text()
    entrypoint = _directive(text, "ENTRYPOINT")
    cmd = _directive(text, "CMD")
    for directive in (entrypoint, cmd):
        assert "--port" not in directive, f"a hardcoded port bind survives in: {directive}"
        assert "--host" not in directive, f"a hardcoded host bind survives in: {directive}"
    # And it goes through the module entrypoint, which is the one that reads
    # the setting.
    assert "agentos_runtime" in entrypoint


def test_the_healthcheck_probes_the_same_authoritative_port():
    """Not `os.environ.get('AGENTOS_PORT','8700')`: that duplicated the default
    in a third place, so a change to DEFAULT_PORT would have moved the bind
    and left the probe behind.
    """
    healthcheck = _directive(_dockerfile_text(), "HEALTHCHECK")
    assert "resolve_port" in healthcheck
    assert "8700" not in healthcheck, "the healthcheck still embeds a duplicated default port"


def test_the_image_still_publishes_nothing():
    """The sidecar stays private: no host-publishing or reverse-proxy
    DIRECTIVE. EXPOSE documents the container-internal default and publishes
    nothing by itself.

    Comments are stripped first, and that is not cosmetic — the first version
    of this test scanned the raw text and failed on the Dockerfile's own
    comment explaining that it deliberately has no `ports:`. A guard that
    fires on the DESCRIPTION of a thing rather than the thing is theatre
    (CLAUDE.md Law 27c); the instrument was wrong, not the file.
    """
    directives = [
        line.strip().lower()
        for line in _dockerfile_text().splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]
    body = "\n".join(directives)
    assert "traefik" not in body
    assert "ports:" not in body
    assert "--publish" not in body
    # CONTROL: the strip left real directives behind to scan.
    assert any(line.startswith("entrypoint") for line in directives)
