"""`python -m agentos_runtime` — the ONE way this service is started.

Exists to close def-agentos-dockerfile-hardcodes-host-port-ignoring-settings-
2026-08-27. The image previously ran
`python -m uvicorn agentos_runtime.main:app` with
`CMD ["--host","0.0.0.0","--port","8700"]` appended, so the bind was a literal
in the Dockerfile while settings.py read AGENTOS_HOST/AGENTOS_PORT and the
HEALTHCHECK read AGENTOS_PORT again with its own duplicated default. Three
readers, two of which could be overruled without noticing — set
AGENTOS_PORT=9000 and the probe watched 9000 while uvicorn bound 8700.

Now there is one parser (`settings.resolve_host` / `settings.resolve_port`)
and every reader goes through it: this entrypoint, the HEALTHCHECK, and
`load_settings()`.

Deliberately uses `resolve_host`/`resolve_port` rather than `load_settings()`:
the bind decision must not depend on the shared secret being readable, and
the FULL fail-closed configuration check still happens — in the uvicorn
worker, at the moment it imports `agentos_runtime.main`, which is where the
startup refusal belongs (see main.py's docstring). A config error there still
exits the process non-zero; nothing is loosened by not repeating it here.

The app is passed as an IMPORT STRING, not an object, so the refusal above
happens inside uvicorn's own startup rather than in this module — the
container then reports the failure through the normal server lifecycle
instead of a bare traceback at PID 1.
"""

from __future__ import annotations

import uvicorn

from agentos_runtime.settings import resolve_host, resolve_port


def main() -> None:
    uvicorn.run(
        "agentos_runtime.main:app",
        host=resolve_host(),
        port=resolve_port(),
        # No reloader, no extra workers: one process per container, the
        # orchestrator owns replication. Access logging stays off because this
        # service does its own redacted, structured run logging
        # (logging_utils.py) and uvicorn's default access line would write the
        # request path of every call beside it with no redaction discipline.
        access_log=False,
    )


if __name__ == "__main__":
    main()
