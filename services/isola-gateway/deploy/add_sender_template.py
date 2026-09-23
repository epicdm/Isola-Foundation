#!/usr/bin/env python3
"""
add_sender_template.py: the sanctioned, narrow re-mint of a gateway bindings
secret that adds ONE `senderTemplates` entry to ONE INTERNAL binding.

WHY THIS EXISTS (2026-09-23)
----------------------------
Per-sender routing (Isola-Foundation #151) needs `senderTemplates` on the
internal Manager binding. Bindings live in a Swarm secret that also carries
each binding's agentBotSecret / agentBotAccessToken, and the boot overlay can
only ADD bindings, never change one. So the change is a re-mint of a
credential-bearing store. Before this tool the only prior art was an
operator-interactive rotation script (.checkpoint-out/.../rotate-gateway-
agentbot-secrets-2026-09-17.sh) that pipes the raw store through ad-hoc
Python; an agent cannot use that shape, and the isola-guard rule 1a correctly
refuses it, because a transform is indistinguishable from a read at the shell.
The owner authorized building this narrowly scoped, reviewed mechanism.

WHAT IT GUARANTEES
------------------
- The store is read INSIDE this process (docker exec cat of the service's own
  mount) and is never written to disk, argv, or stdout. It prints structure
  only: counts, identities, key names, equality booleans, validator verdicts.
  It never prints a value, and never a hash of a credential.
- It targets exactly one binding, (chatwootAccountId, chatwootInboxId), which
  must be INTERNAL. Zero or several matches refuse.
- The sender is chosen by LAST FOUR DIGITS against that binding's existing
  `allowedSenders`: exactly one entry must match, and its exact string becomes
  the key. The tool can route an admitted sender, never admit one, and the
  full number never appears on a command line.
- Everything else is proven unchanged: every other binding is equal by
  canonical JSON, and every key of the target except `senderTemplates` is
  equal (the credentials included, compared by equality only).
- The result is validated by the gateway's OWN parser (parseBindings in the
  image that will run it), and so is the original, as a control.
- --apply creates a NEW versioned secret (the old one is kept for rollback),
  swaps the service with --update-failure-action rollback, waits for the new
  task, re-reads the mounted file and checks it byte-equals what was
  validated. It prints the exact rollback command.
Without --apply it is a dry run: everything above except the create and swap.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from typing import Callable, Sequence

SECRET_MOUNT_DIR = "/run/secrets/"
MOUNT_TARGET = "gateway_bindings"
NAME_RE = re.compile(r"^[A-Za-z0-9_.-]+$")
TEMPLATE_RE = re.compile(r"^[a-z0-9-]+@v[0-9]+$")

Runner = Callable[[Sequence[str], bytes | None], bytes]


class Refused(Exception):
    """A precondition failed. Nothing was created or changed."""


def run(argv: Sequence[str], stdin: bytes | None = None) -> bytes:
    p = subprocess.run(list(argv), input=stdin, capture_output=True)
    if p.returncode != 0:
        # Never echo stderr: a failed `cat` or parse could carry content.
        raise Refused(f"command failed ({argv[0]} {argv[1] if len(argv) > 1 else ''}, exit {p.returncode})")
    return p.stdout


def digits(s: str) -> str:
    return re.sub(r"\D", "", s)


def canonical(obj: object) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def service_container(runner: Runner, service: str) -> str:
    out = runner(["docker", "ps", "-q", "-f", f"name={service}"], None).decode().split()
    if len(out) != 1:
        raise Refused(f"expected exactly 1 running container for {service}, found {len(out)}")
    return out[0]


def mounted_secret(runner: Runner, service: str) -> str:
    spec = json.loads(runner(["docker", "service", "inspect", service], None))
    secrets = spec[0]["Spec"]["TaskTemplate"]["ContainerSpec"].get("Secrets") or []
    names = [s["SecretName"] for s in secrets if s.get("File", {}).get("Name") == MOUNT_TARGET]
    if len(names) != 1:
        raise Refused(f"{service} mounts {len(names)} secrets at {MOUNT_TARGET}, expected 1")
    return names[0]


def read_store(runner: Runner, container: str) -> bytes:
    return runner(["docker", "exec", container, "cat", SECRET_MOUNT_DIR + MOUNT_TARGET], None)


def transform(raw: bytes, account: int, inbox: int, last4: str, template: str) -> tuple[bytes, dict]:
    """Pure: returns (new store bytes, a value-free report). Raises Refused."""
    data = json.loads(raw)
    if not isinstance(data, list) or not all(isinstance(b, dict) for b in data):
        raise Refused("store is not a JSON array of binding objects")
    idx = [i for i, b in enumerate(data)
           if b.get("chatwootAccountId") == account and b.get("chatwootInboxId") == inbox]
    if len(idx) != 1:
        raise Refused(f"{len(idx)} bindings match account {account} inbox {inbox}, expected exactly 1")
    t = idx[0]
    target = data[t]
    if target.get("exposure") != "INTERNAL":
        raise Refused("the target binding is not INTERNAL")
    senders = target.get("allowedSenders")
    if not isinstance(senders, list):
        raise Refused("the target binding has no allowedSenders list")
    hits = [s for s in senders if isinstance(s, str) and digits(s).endswith(last4)]
    if len(hits) != 1:
        raise Refused(f"{len(hits)} allowedSenders end in the given last four digits, expected exactly 1")
    key = hits[0]
    existing = target.get("senderTemplates")
    if existing not in (None, {}):
        if existing == {key: template}:
            raise Refused("the binding already carries exactly this senderTemplates entry (no change needed)")
        raise Refused("the binding already carries a different senderTemplates value; this tool only adds to an empty one")

    new = json.loads(raw)  # an independent deep copy
    new[t]["senderTemplates"] = {key: template}
    new_raw = json.dumps(new, ensure_ascii=False).encode()

    # Equality proofs, against the ORIGINAL bytes' parse, value-free.
    others_equal = all(canonical(data[i]) == canonical(new[i]) for i in range(len(data)) if i != t)
    before_keys, after_keys = set(target), set(new[t])
    unchanged = {k: (target[k] == new[t][k]) for k in sorted(before_keys & after_keys)}
    report = {
        "bindings": len(data),
        "target_index": t,
        "target": {k: target.get(k) for k in ("tenantId", "chatwootAccountId", "chatwootInboxId",
                                              "chatwootAgentBotId", "exposure", "templateId", "status")},
        "allowedSenders_count": len(senders),
        "sender_matched": "exactly 1 allowedSenders entry by last four digits",
        "keys_added": sorted(after_keys - before_keys),
        "keys_removed": sorted(before_keys - after_keys),
        "target_fields_unchanged": all(unchanged.values()),
        "target_fields_checked": sorted(unchanged),
        "credential_fields_unchanged": {k: unchanged[k] for k in ("agentBotSecret", "agentBotAccessToken") if k in unchanged},
        "other_bindings_unchanged": others_equal,
        "senderTemplates_entries": 1,
        "senderTemplates_template": template,
    }
    if report["keys_added"] != ["senderTemplates"] or report["keys_removed"] or not report["target_fields_unchanged"] or not others_equal:
        raise Refused("structural check failed: " + canonical({k: report[k] for k in ("keys_added", "keys_removed", "target_fields_unchanged", "other_bindings_unchanged")}))
    return new_raw, report


VALIDATOR_JS = (
    "import {parseBindings} from '/app/dist/bindings.js';"
    "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=parseBindings(s);"
    "console.log(JSON.stringify({ok:r.ok,count:r.ok?r.bindings.length:0,"
    "errors:r.ok?[]:r.errors.map(e=>String(e).slice(0,200)),"
    "senderTemplateCounts:r.ok?r.bindings.map(b=>Object.keys(b.senderTemplates??{}).length):[],"
    "templates:r.ok?r.bindings.map(b=>Object.values(b.senderTemplates??{})):[]}))});"
)


def validate(runner: Runner, image: str, raw: bytes) -> dict:
    out = runner(["docker", "run", "--rm", "-i", "--network", "none", "--entrypoint", "node", image,
                  "--input-type=module", "-e", VALIDATOR_JS], raw)
    return json.loads(out)


def main(argv: Sequence[str] | None = None, runner: Runner = run, sleep: Callable[[float], None] = time.sleep) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--service", required=True)
    ap.add_argument("--expect-current-secret", required=True)
    ap.add_argument("--new-secret", required=True)
    ap.add_argument("--account", type=int, required=True)
    ap.add_argument("--inbox", type=int, required=True)
    ap.add_argument("--sender-last4", required=True)
    ap.add_argument("--template", required=True)
    ap.add_argument("--validator-image", required=True)
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args(argv)
    report: dict = {"mode": "apply" if a.apply else "dry-run"}
    try:
        for n in (a.service, a.expect_current_secret, a.new_secret, a.validator_image.replace(":", "").replace("/", "")):
            if not NAME_RE.match(n):
                raise Refused("a name argument contains characters outside [A-Za-z0-9_.-]")
        if not re.fullmatch(r"[0-9]{4}", a.sender_last4):
            raise Refused("--sender-last4 must be exactly four digits")
        if not TEMPLATE_RE.match(a.template):
            raise Refused("--template must look like name@vN")
        current = mounted_secret(runner, a.service)
        if current != a.expect_current_secret:
            raise Refused("the service does not mount the expected current secret")
        if a.new_secret == current:
            raise Refused("--new-secret must differ from the current secret")
        report["current_secret"] = current
        container = service_container(runner, a.service)
        raw = read_store(runner, container)
        new_raw, structure = transform(raw, a.account, a.inbox, a.sender_last4, a.template)
        report["structure"] = structure
        before = validate(runner, a.validator_image, raw)
        after = validate(runner, a.validator_image, new_raw)
        report["validator_original"] = {k: before.get(k) for k in ("ok", "count", "errors", "senderTemplateCounts")}
        report["validator_new"] = {k: after.get(k) for k in ("ok", "count", "errors", "senderTemplateCounts", "templates")}
        if not before.get("ok"):
            raise Refused("CONTROL FAILED: the gateway parser rejects the ORIGINAL store, so its verdict on the new one means nothing")
        if not after.get("ok") or after.get("count") != before.get("count"):
            raise Refused("the gateway parser rejects the new store, or it changed the binding count")
        expected_counts = [0] * before["count"]
        expected_counts[structure["target_index"]] = 1
        if after.get("senderTemplateCounts") != expected_counts:
            raise Refused("the parsed senderTemplates do not land on exactly the target binding")
        if not a.apply:
            report["result"] = "DRY RUN OK: nothing created or changed"
            return 0
        existing = runner(["docker", "secret", "ls", "--format", "{{.Name}}"], None).decode().split()
        if a.new_secret in existing:
            raise Refused("--new-secret already exists; choose the next version")
        runner(["docker", "secret", "create", a.new_secret, "-"], new_raw)
        runner(["docker", "service", "update", "--quiet", "--secret-rm", current,
                "--secret-add", f"source={a.new_secret},target={MOUNT_TARGET}",
                "--update-failure-action", "rollback", "--update-monitor", "30s", a.service], None)
        report["created"] = a.new_secret
        report["rollback_command"] = (f"sudo docker service update --secret-rm {a.new_secret} "
                                      f"--secret-add source={current},target={MOUNT_TARGET} {a.service}")
        for _ in range(30):
            if mounted_secret(runner, a.service) == a.new_secret:
                try:
                    c2 = service_container(runner, a.service)
                    if c2 != container:
                        mounted = read_store(runner, c2)
                        report["mounted_equals_validated"] = (mounted == new_raw)
                        break
                except Refused:
                    pass
            sleep(5)
        else:
            raise Refused("the new task did not come up within 150s; check the service, and roll back if needed")
        if not report["mounted_equals_validated"]:
            raise Refused("the mounted store differs from the validated bytes; roll back")
        report["result"] = "APPLIED: new secret mounted and byte-equal to the validated store"
        return 0
    except Refused as e:
        report["refused"] = str(e)
        return 2
    finally:
        print(json.dumps(report, indent=1, ensure_ascii=False))


if __name__ == "__main__":
    sys.exit(main())
