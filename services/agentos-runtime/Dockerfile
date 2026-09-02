# syntax=docker/dockerfile:1
#
# Build context MUST be services/agentos-runtime/ — this image never reaches
# into the monorepo and depends on no workspace package, same convention as
# services/isola-runtime/Dockerfile.
#
#   docker build -t agentos-runtime:0.1.0 services/agentos-runtime
#
# ZERO PUBLIC PORTS BY POLICY: this image is built to join only the private
# runtime network declared in Phase B's Compose/stack file — nothing in this
# Dockerfile publishes a host port (no `-p`/`ports:` here; that decision lives
# entirely in the stack file, deliberately not in this repo per the task
# scope). The app itself also never assumes it is reachable externally: no
# CORS middleware, no 0.0.0.0 default (see settings.py's DEFAULT_HOST).
#
# Non-root, minimal base, no shell tooling beyond what the base image already
# carries, healthcheck via the unauthenticated /healthz route — same hardening
# spirit as services/isola-runtime/Dockerfile.

# ---------- build ----------
FROM python:3.13-slim AS build
WORKDIR /app

# No compiler toolchain needed for these pins (no C-extension builds beyond
# manylinux wheels already available for this platform), so no build-essential
# is installed here — keeping the build stage itself minimal too.
COPY requirements.txt ./
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

COPY pyproject.toml ./
COPY src ./src

# ---------- runtime ----------
FROM python:3.13-slim AS runtime
# PYTHONPATH=/app/src is LOAD-BEARING, not tidiness. The package lives at
# /app/src/agentos_runtime and is never `pip install`ed into site-packages —
# only its dependencies are (via --prefix=/install above). Without this the
# container builds cleanly and then dies on boot with
# `ModuleNotFoundError: No module named 'agentos_runtime'`.
#
# It was missing until 2026-08-27 and the test suite did not catch it:
# pyproject.toml sets `pythonpath = ["src"]` under [tool.pytest.ini_options],
# so PYTEST put the package on the path and 47/47 passed against a path the
# real runtime never has. The green suite proved the code, not the deliverable.
# Measured on host03: image built, service created, task exited 1 in a restart
# loop. Do not remove this line without making `docker run` part of the proof.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app/src \
    PATH="/usr/local/bin:$PATH" \
    AGENTOS_HOST=0.0.0.0 \
    AGENTOS_PORT=8700

WORKDIR /app

COPY --from=build /install /usr/local
COPY --from=build /app/src ./src

# Non-root, dedicated user — never the base image's default.
RUN groupadd --system agentos && \
    useradd --system --gid agentos --home-dir /app --no-create-home agentos && \
    chown -R root:root /app && chmod -R a-w /app

USER agentos

# No EXPOSE of a host-facing default beyond documenting the container-internal
# port; EXPOSE does not publish anything by itself, and Phase B's stack file
# is the ONLY place that may attach this to the private network. This line
# documents the image's DEFAULT container-internal port; the actual bind
# follows AGENTOS_PORT through settings.resolve_port, below.
EXPOSE 8700

# Probes the SAME parser uvicorn binds with, so the two can never disagree.
#
# It used to read `os.environ.get('AGENTOS_PORT','8700')` — a third copy of
# the default, next to settings.py's DEFAULT_PORT and the hardcoded `--port`
# in the old CMD. With AGENTOS_PORT=9000 the probe watched 9000 while uvicorn
# bound 8700, and the container reported itself unhealthy while serving
# perfectly well (def-agentos-dockerfile-hardcodes-host-port-ignoring-
# settings-2026-08-27).
#
# `resolve_port` deliberately needs no credential, so this probe answers
# "which port" without being able to read the shared secret.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request,sys; \
    from agentos_runtime.settings import resolve_port; \
    sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:%d/healthz' % resolve_port(), timeout=3).status==200 else 1)" \
  || exit 1

# NO `--host`/`--port` HERE, AND NO CMD AT ALL.
#
# The bind is not an image literal: `agentos_runtime.__main__` reads
# AGENTOS_HOST/AGENTOS_PORT through settings.resolve_host/resolve_port, the
# same parser load_settings() and the healthcheck above use. AGENTOS_HOST is
# set to 0.0.0.0 in the ENV block above because another container on the
# private overlay must be able to reach this one; the isolation comes from
# publishing nothing to a host interface, never from the bind address
# (CLAUDE.md Law 6 — a filter rule is not containment; structure is).
ENTRYPOINT ["python", "-m", "agentos_runtime"]
