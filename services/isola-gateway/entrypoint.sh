#!/bin/sh
# Swarm-secret shim. Runs once, then gets out of the way.
#
# WHY THIS EXISTS
# ---------------
# Gate C requires credentials to live in Docker Swarm secrets — not baked into
# the image, not written into a stack file, not checked into a tree. Swarm
# delivers a secret as a FILE under /run/secrets (tmpfs, never on disk), but
# this service reads its configuration from environment variables.
#
# The obvious fix — teach src/config.ts to read a file — is the wrong one here.
# The security argument for this service, which is the only publicly exposed
# Isola component, rests partly on `node:fs` appearing NOWHERE in src/, and
# `test/no-direct-network.test.ts` asserts exactly that by source scan. Adding a
# filesystem read to the application to satisfy a deployment concern would
# trade a standing structural guarantee for a packaging convenience. Moving the
# read to a non-src/ module would be worse: it would keep the scan green while
# making it untrue.
#
# So the read happens OUT HERE, outside the application's module graph, and the
# final `exec` replaces this shell with node. No shell survives in the process
# tree, and the app still contains no filesystem access.
#
# CONVENTION
#   FOO_FILE=/run/secrets/foo   ->   FOO=<contents of /run/secrets/foo>
#
# A `_FILE` variable pointing at something unreadable is a FATAL boot error, not
# a warning. The alternative is starting with a silently absent credential and
# failing every delivery closed at runtime, which is the same outage discovered
# later and with less context.
set -eu

for name in $(env | sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)_FILE=.*/\1/p'); do
  eval "secret_path=\${${name}_FILE}"

  if [ ! -r "$secret_path" ]; then
    echo "entrypoint: ${name}_FILE points at ${secret_path}, which is not readable; refusing to start" >&2
    exit 1
  fi

  # Command substitution strips trailing newlines, which is what is wanted:
  # `docker secret create` from a file commonly leaves one, and a bearer token
  # with a trailing newline fails authentication in a way that is very hard to
  # see in a log.
  eval "export ${name}=\"\$(cat \"\$secret_path\")\""

  # The path is no longer needed and its presence in the environment invites a
  # later reader to think the value is still on disk somewhere it can be found.
  unset "${name}_FILE"
done

# exec, not a plain call: node becomes PID 1, signals reach it directly (the
# service drains in-flight deliveries on SIGTERM), and this shell ceases to
# exist rather than lingering as a parent.
exec "$@"
