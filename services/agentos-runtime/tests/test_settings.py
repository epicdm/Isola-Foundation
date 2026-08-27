"""Fail-closed boot validation.

Test category mapping:
  This is the "startup refusal" mechanism itself — see main.py's docstring.
  Exercised directly here (fast, no ASGI app needed); test_main_boot.py
  exercises the same failure through a real module import.
"""

from __future__ import annotations

import pytest

from agentos_runtime.settings import ConfigError, load_settings

# Built at runtime, not written as string literals, so no scanner ever has to
# decide whether one is real — same convention (and same reasoning) as
# services/isola-runtime/test/harness.ts's `placeholder()`.
def _placeholder(label: str) -> str:
    return "-".join(["not", "a", "real", "credential", label]) + "-" + "0" * 16


_FAKE_SHARED_SECRET = _placeholder("shared")
_FAKE_JWT_KEY = _placeholder("jwt")


def _env(tmp_path, **overrides) -> dict[str, str]:
    shared = tmp_path / "shared"
    shared.write_text(_FAKE_SHARED_SECRET, encoding="utf-8")
    jwt = tmp_path / "jwt"
    jwt.write_text(_FAKE_JWT_KEY, encoding="utf-8")
    env = {
        "AGENTOS_SHARED_SECRET_FILE": str(shared),
        "AGENTOS_JWT_VERIFICATION_KEY_FILE": str(jwt),
    }
    env.update(overrides)
    return env


def test_loads_with_minimum_required_config(tmp_path):
    settings = load_settings(_env(tmp_path))
    assert settings.shared_secret == _FAKE_SHARED_SECRET
    assert settings.jwt_verification_key == _FAKE_JWT_KEY
    assert settings.model_api_key is None  # accepted absence — see settings.py docstring
    assert settings.model_base_url == "https://api.deepseek.com"
    assert settings.model_id == "deepseek-chat"


def test_missing_shared_secret_refuses_to_load(tmp_path):
    env = _env(tmp_path)
    del env["AGENTOS_SHARED_SECRET_FILE"]
    with pytest.raises(ConfigError, match="AGENTOS_SHARED_SECRET"):
        load_settings(env)


def test_missing_jwt_key_refuses_to_load(tmp_path):
    env = _env(tmp_path)
    del env["AGENTOS_JWT_VERIFICATION_KEY_FILE"]
    with pytest.raises(ConfigError, match="AGENTOS_JWT_VERIFICATION_KEY"):
        load_settings(env)


def test_unreadable_secret_file_refuses_to_load(tmp_path):
    env = _env(tmp_path, AGENTOS_SHARED_SECRET_FILE=str(tmp_path / "does-not-exist"))
    with pytest.raises(ConfigError, match="not readable"):
        load_settings(env)


def test_empty_secret_file_refuses_to_load(tmp_path):
    empty = tmp_path / "empty"
    empty.write_text("", encoding="utf-8")
    env = _env(tmp_path, AGENTOS_SHARED_SECRET_FILE=str(empty))
    with pytest.raises(ConfigError, match="empty"):
        load_settings(env)


def test_trailing_newline_in_secret_file_is_stripped(tmp_path):
    path = tmp_path / "with-newline"
    path.write_text(_FAKE_SHARED_SECRET + "\n", encoding="utf-8")
    env = _env(tmp_path, AGENTOS_SHARED_SECRET_FILE=str(path))
    settings = load_settings(env)
    assert settings.shared_secret == _FAKE_SHARED_SECRET


def test_direct_env_value_wins_over_file_when_both_set(tmp_path):
    direct_value = "not-a-real-credential-direct-" + "0" * 16
    env = _env(tmp_path, AGENTOS_SHARED_SECRET=direct_value)
    settings = load_settings(env)
    assert settings.shared_secret == direct_value


def test_invalid_timeout_refuses_to_load(tmp_path):
    env = _env(tmp_path, AGENTOS_REQUEST_TIMEOUT_S="not-a-number")
    with pytest.raises(ConfigError, match="AGENTOS_REQUEST_TIMEOUT_S"):
        load_settings(env)


def test_zero_timeout_refuses_to_load(tmp_path):
    env = _env(tmp_path, AGENTOS_REQUEST_TIMEOUT_S="0")
    with pytest.raises(ConfigError, match="positive"):
        load_settings(env)


def test_model_credential_absent_is_accepted_not_fatal(tmp_path):
    # Phase A explicitly allows no live model credential in this sandbox — see
    # settings.py's module docstring. This is the POSITIVE control proving
    # that absence is a deliberate, accepted state and not an oversight: it
    # loads cleanly, and agent.py's own fail-closed-per-request behaviour is
    # covered separately in test_agent_run_route.py.
    settings = load_settings(_env(tmp_path))
    assert settings.model_api_key is None
