#!/bin/bash
# host03 STAGING (rc16g) phase F: make MY OWN adapter service genuinely unreachable (0 replicas), run the F1 tap, always scale it back.
# Touches only plstg_zzrc16g_adapter (asserted by name + image + mounted file before the mutation). No other service is changed.
set -u
D="sudo -n docker"; Z=/home/epicadmin/zz-lanea-rc16-20261011; S=plstg_zzrc16g_adapter
IMG=${1:?web image tag}
MNT=$($D service inspect $S --format '{{range .Spec.TaskTemplate.ContainerSpec.Mounts}}{{.Source}}{{end}}')
[ "$MNT" = "/home/epicadmin/zz-lanea-rc16-20261011/h/adapter-rc13h" ] || { echo "REFUSING: $S mount is not the rc13h dir ($MNT)"; exit 2; }
$D service scale --detach $S=0 >/dev/null
for i in $(seq 1 30); do n=$($D ps -q -f name=$S | wc -l); [ "$n" = 0 ] && break; sleep 2; done
echo "adapter containers running: $($D ps -q -f name=$S | wc -l) (must be 0)"
ADAPTER_DOWN=1 USE_WA=17675550159 bash $Z/h5_oneshot.sh rc16g_drive.mjs $IMG
$D service scale --detach $S=1 >/dev/null
for i in $(seq 1 60); do s=$($D service ps $S --filter desired-state=running --format '{{.CurrentState}}' | head -1); case "$s" in Running*) break;; esac; sleep 3; done
echo "adapter restored: $s"
