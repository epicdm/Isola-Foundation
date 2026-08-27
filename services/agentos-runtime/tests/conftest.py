"""Shared pytest fixtures.

`main.py` reads its configuration and mounts AgentOS at IMPORT TIME (see that
module's docstring) — that is the actual "startup refusal" mechanism under
test, so tests that need a working app import it FRESH, after setting the
required environment, rather than relying on a module cached from a previous
test's environment.
"""

from __future__ import annotations

import importlib
import sys

import pytest

from agentos_runtime.allowlist import AGENTOS_ALLOWED_TENANT


def write_secret(tmp_path, name: str, value: str):
    path = tmp_path / name
    path.write_text(value, encoding="utf-8")
    return str(path)


@pytest.fixture
def base_env(tmp_path, monkeypatch):
    """The minimum environment `load_settings()` accepts. Individual tests
    mutate/delete keys via `monkeypatch` to exercise the fail-closed paths.
    """
    shared_secret_path = write_secret(tmp_path, "shared_secret", "test-shared-secret-value")
    jwt_key_path = write_secret(tmp_path, "jwt_key", "a" * 32)

    monkeypatch.setenv("AGENTOS_SHARED_SECRET_FILE", shared_secret_path)
    monkeypatch.setenv("AGENTOS_JWT_VERIFICATION_KEY_FILE", jwt_key_path)
    # The SERVER-SIDE tenant authority (see settings.py / allowlist.py). Set to
    # the expected constant, which is what a real deployment sets it to.
    monkeypatch.setenv("AGENTOS_TENANT_ID", AGENTOS_ALLOWED_TENANT)
    monkeypatch.delenv("AGENTOS_MODEL_API_KEY", raising=False)
    monkeypatch.delenv("AGENTOS_MODEL_API_KEY_FILE", raising=False)
    monkeypatch.setenv("AGENTOS_HOST", "127.0.0.1")
    monkeypatch.setenv("AGENTOS_PORT", "8700")
    return {
        "shared_secret": "test-shared-secret-value",
        "jwt_key": "a" * 32,
        "tenant_id": AGENTOS_ALLOWED_TENANT,
    }


def fresh_import(module_name: str):
    """Import `module_name` with no cached module from a prior test's
    environment. Also drops `agentos_runtime.settings`'s import isn't
    necessary to drop since it holds no module-level state — only
    `agentos_runtime.main` reads env at import time.
    """
    sys.modules.pop(module_name, None)
    return importlib.import_module(module_name)


@pytest.fixture
def app_module(base_env):
    """Imports `agentos_runtime.main` fresh, against `base_env`. Tests that
    need a DIFFERENT environment (missing secret, etc.) should not use this
    fixture — they call `fresh_import` themselves after adjusting env.
    """
    return fresh_import("agentos_runtime.main")


@pytest.fixture
def client(app_module):
    from fastapi.testclient import TestClient

    with TestClient(app_module.app) as c:
        yield c
