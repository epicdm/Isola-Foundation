#!/bin/bash
# host03 STAGING: plstg_web is shared with another lane (acctsum deploy + manual rollback observed 18:10-18:12Z). Take the rc16
# footprint OFF it: back to its pre-rc16 spec (image rc6-cbf1d10c, original env/mounts, no host mapping). The rc16 proof moves to
# a dedicated clone. Prints no secret.
D="sudo -n docker"; S=plstg_web
CUR=$($D service inspect $S --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}')
# only put the image back if it is still OUR rc16; if the other lane has deployed since, leave their image and remove only our additions
IMGARG=""; [ "${CUR%@*}" = "plsvc-staging-synthetic:rc16-9c5d8439" ] && IMGARG="--image plsvc-staging-synthetic:rc6-cbf1d10c"
echo "current spec image: $CUR -> image change: ${IMGARG:-none}"
$D service update --detach --no-resolve-image $IMGARG \
  --env-rm ISOLA_RUNTIME_ENV --env-rm STAGING_WA_ALLOWLIST_FILE --env-rm PL_FLOW_SENDER_PHONE_ID --env-rm WHATSAPP_TOKEN \
  --env-rm NODE_EXTRA_CA_CERTS --env-rm FLOW_PRIVATE_KEY_B64 --mount-rm /zzrc16 --host-rm graph.facebook.com:10.77.0.16 $S >/dev/null
for i in $(seq 1 60); do s=$($D service ps $S --filter desired-state=running --format '{{.CurrentState}} {{.Image}}' | head -1); case "$s" in Running*) break;; esac; sleep 3; done
echo "plstg_web now: $s"
echo "env names: $($D service inspect $S --format '{{range .Spec.TaskTemplate.ContainerSpec.Env}}{{println .}}{{end}}' | cut -d= -f1 | tr '\n' ' ')"
echo "mounts: $($D service inspect $S --format '{{range .Spec.TaskTemplate.ContainerSpec.Mounts}}{{.Target}} {{end}}') hosts: $($D service inspect $S --format '{{json .Spec.TaskTemplate.ContainerSpec.Hosts}}')"
