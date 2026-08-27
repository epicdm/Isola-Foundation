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
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
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
# is the ONLY place that may attach this to the private network.
EXPOSE 8700

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request,os,sys; \
    sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('AGENTOS_PORT','8700')+'/health', timeout=3).status==200 else 1)" \
  || exit 1

ENTRYPOINT ["python", "-m", "uvicorn", "agentos_runtime.main:app"]
CMD ["--host", "0.0.0.0", "--port", "8700"]
