#!/bin/bash
# zz-acct2: scale ONE of OUR services. usage: zz-acct2-h03-scale.sh <service> <replicas>. Refuses anything outside our prefixes.
SVC=$1; N=$2
case "$SVC" in plstg_zzacct2_mock|plstg_zzacct2_web|uplinkstg_zzacct2_app|uplinkstg_zzacct2_sink) ;; *) echo "ABORT: $SVC is not a zzacct2 service"; exit 1;; esac
case "$N" in 0|1) ;; *) echo "ABORT: replicas $N"; exit 1;; esac
sudo -n docker service scale "$SVC=$N" 2>&1 | tail -2
sleep ${3:-0}
sudo -n docker service ls --format '{{.Name}} {{.Replicas}}' | grep zzacct2
