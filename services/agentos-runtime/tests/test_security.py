"""Shared-secret authentication for the /v1/agent-run dependency.

Test category mapping:
  1. Valid service authentication
  2. Invalid/missing service authentication

Exercised against a minimal, standalone FastAPI app (not `main.app`) so this
suite never needs `agno` importable — `security.py` has no such dependency,
and keeping this test isolated proves that boundary.
"""

from __future__ import annotations

from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from agentos_runtime.security import constant_time_equals, make_verify_shared_secret
from agentos_runtime.settings import Settings


def _fake_settings(secret: str) -> Settings:
    return Settings(
        shared_secret=secret,
        jwt_verification_key="k" * 32,
        model_api_key=None,
        model_base_url="https://api.deepseek.com",
        model_id="deepseek-chat",
        request_timeout_s=10.0,
        host="127.0.0.1",
        port=8700,
    )


def _make_test_app(secret: str) -> FastAPI:
    app = FastAPI()
    verify = make_verify_shared_secret(_fake_settings(secret))

    @app.get("/protected")
    async def protected(_auth: None = Depends(verify)) -> dict[str, bool]:
        return {"ok": True}

    return app


def test_valid_shared_secret_is_accepted():
    secret = "-".join(["not", "a", "real", "credential", "valid"]) + "-" + "0" * 16
    client = TestClient(_make_test_app(secret))
    res = client.get("/protected", headers={"Authorization": f"Bearer {secret}"})
    assert res.status_code == 200
    assert res.json() == {"ok": True}


def test_missing_authorization_header_is_rejected():
    secret = "-".join(["not", "a", "real", "credential", "missing"]) + "-" + "0" * 16
    client = TestClient(_make_test_app(secret))
    res = client.get("/protected")
    assert res.status_code == 401


def test_wrong_shared_secret_is_rejected():
    secret = "-".join(["not", "a", "real", "credential", "wrong"]) + "-" + "0" * 16
    client = TestClient(_make_test_app(secret))
    res = client.get("/protected", headers={"Authorization": "Bearer totally-different-value"})
    assert res.status_code == 401


def test_malformed_scheme_is_rejected():
    secret = "-".join(["not", "a", "real", "credential", "scheme"]) + "-" + "0" * 16
    client = TestClient(_make_test_app(secret))
    res = client.get("/protected", headers={"Authorization": f"Basic {secret}"})
    assert res.status_code == 401


def test_empty_bearer_value_is_rejected():
    secret = "-".join(["not", "a", "real", "credential", "empty"]) + "-" + "0" * 16
    client = TestClient(_make_test_app(secret))
    res = client.get("/protected", headers={"Authorization": "Bearer "})
    assert res.status_code == 401


def test_constant_time_equals_is_correct():
    assert constant_time_equals("abc", "abc") is True
    assert constant_time_equals("abc", "abd") is False
    assert constant_time_equals("abc", "abcd") is False
