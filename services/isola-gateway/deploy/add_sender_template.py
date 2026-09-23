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


def _no_duplicate_keys(pairs):
    keys = [k for k, _ in pairs]
    if len(keys) != len(set(keys)):
        # A duplicate key parses to its LAST value here and in JSON.parse, and
        # re-emitting would silently collapse it. Refuse rather than decide.
        raise Refused("the store contains a duplicate key inside an object; refusing to re-emit it")
    return dict(pairs)


def _no_nonfinite(token):
    raise Refused(f"the store contains a non-finite number ({token}); refusing to re-emit it")


def strict_loads(raw: bytes):
    return json.loads(raw, object_pairs_hook=_no_duplicate_keys, parse_constant=_no_nonfinite)


def element_spans(text: str) -> list[tuple[int, int]]:
    """Character spans of each top-level array element, found by the JSON
    decoder itself (raw_decode), so a string containing ']' or ',' cannot
    confuse it. Raises Refused if the text is not exactly one array."""
    dec = json.JSONDecoder(object_pairs_hook=_no_duplicate_keys, parse_constant=_no_nonfinite)
    ws = " \t\r\n"
    i = 0
    while i < len(text) and text[i] in ws:
        i += 1
    if i >= len(text) or text[i] != "[":
        raise Refused("store is not a JSON array")
    i += 1
    spans = []
    while True:
        while i < len(text) and text[i] in ws:
            i += 1
        if i < len(text) and text[i] == "]" and not spans:
            i += 1
            break
        _, end = dec.raw_decode(text, i)
        spans.append((i, end))
        i = end
        while i < len(text) and text[i] in ws:
            i += 1
        if i < len(text) and text[i] == ",":
            i += 1
            continue
        if i < len(text) and text[i] == "]":
            i += 1
            break
        raise Refused("store array is malformed")
    if text[i:].strip(ws):
        raise Refused("trailing content after the store array")
    return spans


def transform(raw: bytes, account: int, inbox: int, last4: str, template: str) -> tuple[bytes, dict]:
    """Pure: returns (new store bytes, a value-free report). Raises Refused.

    SERIALIZATION: only the TARGET binding's text is replaced (re-emitted with
    the one added key); every other byte of the store, including every other
    binding, is kept verbatim and proven byte-equal. The target's untouched
    fields are proven equal on the re-parse. Duplicate keys and non-finite
    numbers are refused anywhere in the store."""
    data = strict_loads(raw)
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

    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        raise Refused("store is not UTF-8")
    spans = element_spans(text)
    if len(spans) != len(data):
        raise Refused("element spans disagree with the parse")
    patched = strict_loads(text[spans[t][0]:spans[t][1]].encode())
    patched["senderTemplates"] = {key: template}
    new_text = text[:spans[t][0]] + json.dumps(patched, ensure_ascii=False) + text[spans[t][1]:]
    new_raw = new_text.encode("utf-8")
    # Prove against a RE-PARSE of the emitted bytes: that is what the gateway reads.
    new = strict_loads(new_raw)
    if len(new) != len(data):
        raise Refused("the re-parsed store has a different binding count")
    new_spans = element_spans(new_text)
    prefix_equal = text[:spans[t][0]] == new_text[:new_spans[t][0]]
    suffix_equal = text[spans[t][1]:] == new_text[new_spans[t][1]:]

    # Equality proofs, value-free: other bindings byte-equal AND parse-equal.
    others_equal = prefix_equal and suffix_equal and all(
        canonical(data[i]) == canonical(new[i]) for i in range(len(data)) if i != t)
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
        "other_bindings_byte_equal": prefix_equal and suffix_equal,
        "serialization": "only the target binding's text is replaced; all other bytes verbatim",
    }
    if report["keys_added"] != ["senderTemplates"] or report["keys_removed"] or not report["target_fields_unchanged"] or not others_equal:
        raise Refused("structural check failed: " + canonical({k: report[k] for k in ("keys_added", "keys_removed", "target_fields_unchanged", "other_bindings_unchanged")}))
    return new_raw, report


# Only counts and booleans leave the container: never the parser's error TEXT
# (it could quote a value), and never a senderTemplates key or value. Whether
# the target carries exactly the expected template is computed INSIDE, against
# T_IDX / T_TPL passed in the environment (an index and a template id, neither
# of them secret).
VALIDATOR_JS = (
    "import {parseBindings} from '/app/dist/bindings.js';"
    "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=parseBindings(s);"
    "const errs=r.ok?[]:r.errors.map(e=>String(e));const i=Number(process.env.T_IDX);"
    "const tv=r.ok&&r.bindings[i]?Object.values(r.bindings[i].senderTemplates??{}):[];"
    "console.log(JSON.stringify({ok:r.ok,count:r.ok?r.bindings.length:0,"
    "errorCount:errs.length,senderTemplatesErrors:errs.filter(e=>e.includes('\"senderTemplates\"')).length,"
    "senderTemplateCounts:r.ok?r.bindings.map(b=>Object.keys(b.senderTemplates??{}).length):[],"
    "targetCarriesTemplate:tv.length===1&&tv[0]===process.env.T_TPL}))});"
)


def service_state(runner: Runner, service: str) -> tuple:
    """(Swarm spec version index, image, mounted bindings secret): the triple a
    compare-and-swap check re-reads immediately before writing."""
    spec = json.loads(runner(["docker", "service", "inspect", service], None))[0]
    return (spec.get("Version", {}).get("Index"), service_image(runner, service), mounted_secret(runner, service))


def service_image(runner: Runner, service: str) -> str:
    """The image the service RUNS, so validation uses the parser that will read the store."""
    spec = json.loads(runner(["docker", "service", "inspect", service], None))
    image = spec[0]["Spec"]["TaskTemplate"]["ContainerSpec"]["Image"]
    if not re.fullmatch(r"[A-Za-z0-9_.:/@-]+", image):
        raise Refused("the service image reference has an unexpected shape")
    return image


def validate(runner: Runner, image: str, raw: bytes, target_index: int, template: str) -> dict:
    out = runner(["docker", "run", "--rm", "-i", "--network", "none",
                  "-e", f"T_IDX={int(target_index)}", "-e", f"T_TPL={template}",
                  "--entrypoint", "node", image, "--input-type=module", "-e", VALIDATOR_JS], raw)
    return json.loads(out)


def wait_and_compare(runner: Runner, service: str, secret: str, old_container: str | None,
                     expected: bytes, sleep: Callable[[float], None]):
    """Wait until the service mounts `secret` in a task other than
    `old_container` (any task if None), then compare its store to `expected`.
    True/False, or None on timeout."""
    for _ in range(30):
        try:
            if mounted_secret(runner, service) == secret:
                c = service_container(runner, service)
                if old_container is None or c != old_container:
                    return read_store(runner, c) == expected
        except Refused:
            pass
        sleep(5)
    return None


def _remove_new_secret(runner: Runner, name: str, report: dict) -> None:
    """Remove an unreferenced new version. Swarm refuses to remove a secret a
    service still references, so a failure here is reported, never hidden."""
    try:
        runner(["docker", "secret", "rm", name], None)
        report["created"] = None
        report["cleanup"] = "the unused new secret was removed"
    except Refused:
        report["cleanup"] = "the new secret could NOT be removed (still referenced?); remove it by hand"


def main(argv: Sequence[str] | None = None, runner: Runner = run, sleep: Callable[[float], None] = time.sleep) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--service", required=True)
    ap.add_argument("--expect-current-secret", required=True)
    ap.add_argument("--new-secret", required=True)
    ap.add_argument("--account", type=int, required=True)
    ap.add_argument("--inbox", type=int, required=True)
    ap.add_argument("--sender-last4", required=True)
    ap.add_argument("--template", required=True)
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args(argv)
    report: dict = {"mode": "apply" if a.apply else "dry-run"}
    try:
        for n in (a.service, a.expect_current_secret, a.new_secret):
            if not NAME_RE.match(n):
                raise Refused("a name argument contains characters outside [A-Za-z0-9_.-]")
        if not re.fullmatch(r"[0-9]{4}", a.sender_last4):
            raise Refused("--sender-last4 must be exactly four digits")
        if not TEMPLATE_RE.match(a.template):
            raise Refused("--template must look like name@vN")
        initial_state = service_state(runner, a.service)
        current = initial_state[2]
        if current != a.expect_current_secret:
            raise Refused("the service does not mount the expected current secret")
        if a.new_secret == current:
            raise Refused("--new-secret must differ from the current secret")
        report["current_secret"] = current
        container = service_container(runner, a.service)
        raw = read_store(runner, container)
        new_raw, structure = transform(raw, a.account, a.inbox, a.sender_last4, a.template)
        report["structure"] = structure
        image = initial_state[1]
        report["validator_image"] = image + " (the image the service runs)"
        t = structure["target_index"]
        before = validate(runner, image, raw, t, a.template)
        after = validate(runner, image, new_raw, t, a.template)
        keep = ("ok", "count", "errorCount", "senderTemplatesErrors", "senderTemplateCounts")
        report["validator_original"] = {k: before.get(k) for k in keep}
        report["validator_new"] = {k: after.get(k) for k in keep + ("targetCarriesTemplate",)}
        if not before.get("ok"):
            raise Refused("CONTROL FAILED: the gateway parser rejects the ORIGINAL store, so its verdict on the new one means nothing")
        if not after.get("ok") or after.get("count") != before.get("count"):
            raise Refused("the gateway parser rejects the new store, or it changed the binding count")
        # Relative to the ORIGINAL counts: other bindings may already route by sender.
        expected_counts = list(before.get("senderTemplateCounts") or [])
        if len(expected_counts) != before["count"]:
            raise Refused("the parser did not report per-binding senderTemplates counts")
        expected_counts[t] += 1
        if after.get("senderTemplateCounts") != expected_counts or after.get("targetCarriesTemplate") is not True:
            raise Refused("the parsed senderTemplates do not land on exactly the target binding with the requested template")
        if not a.apply:
            report["result"] = "DRY RUN OK: nothing created or changed"
            return 0
        existing = runner(["docker", "secret", "ls", "--format", "{{.Name}}"], None).decode().split()
        if a.new_secret in existing:
            raise Refused("--new-secret already exists; choose the next version")
        # COMPARE-AND-SWAP: everything validated above is only valid for the
        # service as it was. Re-read spec version, image and mounted secret
        # immediately before the first write, and refuse if any moved.
        if service_state(runner, a.service) != initial_state:
            raise Refused("the service changed (spec version, image or mounted secret) since validation; re-run")
        runner(["docker", "secret", "create", a.new_secret, "-"], new_raw)
        report["created"] = a.new_secret
        report["rollback_command"] = (f"sudo docker service update --secret-rm {a.new_secret} "
                                      f"--secret-add source={current},target={MOUNT_TARGET} {a.service}")
        swap = ["docker", "service", "update", "--quiet", "--secret-rm", current,
                "--secret-add", f"source={a.new_secret},target={MOUNT_TARGET}",
                "--update-failure-action", "rollback", "--update-monitor", "30s", a.service]
        try:
            runner(swap, None)
            report["swap_command"] = "succeeded"
        except Refused:
            # An error exit does not prove the swap did not (partly) happen.
            # Act on the OBSERVED state below, never on the exit code.
            report["swap_command"] = "failed; acting on observed state"

        mounted_now = mounted_secret(runner, a.service)
        if mounted_now == current:
            # The swap did not take (or Swarm already reverted it). Only now,
            # with the new version provably unreferenced, remove it.
            report["mounted_after_swap"] = "original"
            report["original_bytes_still_mounted"] = wait_and_compare(runner, a.service, current, None, raw, sleep)
            _remove_new_secret(runner, a.new_secret, report)
            raise Refused("the swap did not take effect; the service is on the original secret")
        if mounted_now != a.new_secret:
            raise Refused("the service mounts an UNEXPECTED secret after the swap; inspect it now")

        verified = wait_and_compare(runner, a.service, a.new_secret, container, new_raw, sleep)
        report["mounted_equals_validated"] = verified
        image_after = service_image(runner, a.service)
        report["image_unchanged"] = image_after == image
        if verified is True and image_after == image:
            report["result"] = "APPLIED: new secret mounted, byte-equal to the validated store, same image"
            return 0

        # Unverified content must not stay live: roll back, retrying the
        # command, and judge success ONLY by what is observed mounted.
        for attempt in range(3):
            if mounted_secret(runner, a.service) != a.new_secret:
                break
            try:
                runner(["docker", "service", "update", "--quiet", "--secret-rm", a.new_secret,
                        "--secret-add", f"source={current},target={MOUNT_TARGET}", a.service], None)
                report["auto_rollback"] = f"issued by this tool (attempt {attempt + 1})"
            except Refused:
                report["auto_rollback"] = f"rollback command failed (attempt {attempt + 1})"
                sleep(5)
        else:
            report.setdefault("auto_rollback", "not issued")
        if "auto_rollback" not in report:
            report["auto_rollback"] = "Swarm had already rolled back"
        restored = wait_and_compare(runner, a.service, current, None, raw, sleep)
        report["rollback_restores_original"] = restored
        if restored is True:
            _remove_new_secret(runner, a.new_secret, report)
            raise Refused("the new mount was not verified; the service is proven back on the original secret")
        raise Refused("LIVE UNVERIFIED: the new mount was not verified and the rollback is NOT proven; "
                      "run the rollback_command and inspect the service now")
    except Refused as e:
        report["refused"] = str(e)
        return 2
    finally:
        print(json.dumps(report, indent=1, ensure_ascii=False))


if __name__ == "__main__":
    sys.exit(main())
