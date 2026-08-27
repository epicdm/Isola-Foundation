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
        "AGENTOS_TENANT_ID": "8D3dp3z",
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


def test_missing_tenant_id_refuses_to_load(tmp_path):
    # The server-side tenant authority is mandatory: without it the only
    # remaining way to pick a tenant is the request envelope, which is the
    # client-side selection this setting exists to remove.
    env = _env(tmp_path)
    del env["AGENTOS_TENANT_ID"]
    with pytest.raises(ConfigError, match="AGENTOS_TENANT_ID"):
        load_settings(env)


def test_tenant_id_is_read_from_config_not_a_constant(tmp_path):
    settings = load_settings(_env(tmp_path, AGENTOS_TENANT_ID="some-other-tenant"))
    assert settings.tenant_id == "some-other-tenant"


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


@pytest.mark.parametrize("raw", ["nan", "NaN", "inf", "-inf", "Infinity"])
def test_non_finite_timeout_refuses_to_load(tmp_path, raw):
    """
    `float("nan")` PARSES, and every comparison against NaN is false — so a
    positivity check (`<= 0`) cannot see it. Left unrefused, the value reaches
    `asyncio.wait_for(..., timeout=...)` and this runtime raises
    `ValueError: cannot convert float NaN to integer` from inside the event
    loop: an unstructured framework crash, which is precisely what the request
    deadline exists to replace with a structured timeout outcome.

    Found by adversarial review of the deadline change itself, and reproduced
    before being fixed. `inf` is refused for the same reason: a deadline that
    never fires is not a deadline.
    """
    env = _env(tmp_path, AGENTOS_REQUEST_TIMEOUT_S=raw)
    with pytest.raises(ConfigError, match="AGENTOS_REQUEST_TIMEOUT_S"):
        load_settings(env)


def test_POSITIVE_CONTROL_finite_timeout_still_loads_and_is_applied(tmp_path):
    """
    Without this, the five refusals above would pass equally against a settings
    loader that had simply learned to reject every timeout value. This proves a
    valid value is still accepted AND carried through to the Settings object,
    so the refusals above are discriminating rather than indiscriminate.
    """
    env = _env(tmp_path, AGENTOS_REQUEST_TIMEOUT_S="42.5")
    settings = load_settings(env)
    assert settings.request_timeout_s == 42.5


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
