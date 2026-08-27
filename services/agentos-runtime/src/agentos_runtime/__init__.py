"""The private AgentOS sidecar for Isola AI Operating Company (AI-1A).

This package is NOT a public service. It has no published host port, no
Traefik ingress and no browser/Paperclip direct path (see
dec-agentos-private-python-service-behind-node-isola-runtime-2026-08-22). The
only caller in production is services/isola-runtime's Node process, over the
private runtime network, authenticated with a file-backed shared secret.
"""

__all__: list[str] = []
