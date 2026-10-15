#!/bin/bash
# READ-ONLY: env NAMES (never values) of the relay service that relate to Chatwoot / Uplink, to find the in-process way to call the Chatwoot API.
docker service inspect uplink_sf-relay-pl-prod --format '{{range .Spec.TaskTemplate.ContainerSpec.Env}}{{println .}}{{end}}' | cut -d= -f1 | sort | tr '\n' ' '
echo
docker service inspect uplink_sf-relay-pl-prod --format '{{range .Spec.TaskTemplate.ContainerSpec.Secrets}}{{.SecretName}} -> {{.File.Name}}{{println}}{{end}}' | sed -E 's/_v[0-9]+//' | head -12
