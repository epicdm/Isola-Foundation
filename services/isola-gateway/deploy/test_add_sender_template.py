"""Tests for add_sender_template.py. Run: python3 -m unittest -v test_add_sender_template.py
No Docker, no network: a fake runner stands in for the docker CLI.
Fixture credentials are obviously fake literals, never real values."""
import copy
import io
import json
import unittest
from contextlib import redirect_stdout

import add_sender_template as T

OWNER = "+1 767 555 1274"
STAFF = ["+1 767 555 0001", OWNER, "+1 767 555 0340"]
INTERNAL = {
    "tenantId": "epic-internal-manager", "chatwootAccountId": 2, "chatwootInboxId": 10,
    "chatwootAgentBotId": 4, "exposure": "INTERNAL", "templateId": "isola-internal-manager@v1",
    "status": "active", "agentBotSecret": "FAKE-SECRET-A", "agentBotAccessToken": "FAKE-TOKEN-A",
    "allowedSenders": STAFF, "labels": ["x"],
    "paperclipCompanyId": "00000000-0000-0000-0000-00000000000c",
    "paperclipAgentId": "00000000-0000-0000-0000-00000000000a",
}
PUBLIC = {
    "tenantId": "pub", "chatwootAccountId": 2, "chatwootInboxId": 7, "chatwootAgentBotId": 3,
    "exposure": "PUBLIC", "templateId": "isola-ai-sales-front-desk-agent@v1", "status": "active",
    "agentBotSecret": "FAKE-SECRET-B", "agentBotAccessToken": "FAKE-TOKEN-B",
    "paperclipCompanyId": "00000000-0000-0000-0000-00000000000c",
    "paperclipAgentId": "00000000-0000-0000-0000-00000000000b",
}


def store(*bindings):
    return json.dumps(list(bindings)).encode()


class TransformTests(unittest.TestCase):
    def test_adds_exactly_one_entry_on_the_target_and_changes_nothing_else(self):
        raw = store(PUBLIC, INTERNAL)
        new_raw, rep = T.transform(raw, 2, 10, "1274", "isola-owner-manager@v1")
        new = json.loads(new_raw)
        self.assertEqual(new[1]["senderTemplates"], {OWNER: "isola-owner-manager@v1"})
        self.assertEqual(new[0], PUBLIC)
        without = {k: v for k, v in new[1].items() if k != "senderTemplates"}
        self.assertEqual(without, INTERNAL)
        self.assertEqual(rep["keys_added"], ["senderTemplates"])
        self.assertEqual(rep["keys_removed"], [])
        self.assertTrue(rep["target_fields_unchanged"] and rep["other_bindings_unchanged"])
        self.assertEqual(rep["credential_fields_unchanged"], {"agentBotSecret": True, "agentBotAccessToken": True})

    def test_report_carries_no_credential_or_full_number(self):
        _, rep = T.transform(store(PUBLIC, INTERNAL), 2, 10, "1274", "isola-owner-manager@v1")
        text = json.dumps(rep)
        for needle in ("FAKE-SECRET", "FAKE-TOKEN", "555 1274", "5551274", "0340"):
            self.assertNotIn(needle, text)

    def test_refuses_no_match_and_a_non_internal_target(self):
        with self.assertRaises(T.Refused):
            T.transform(store(PUBLIC, INTERNAL), 2, 99, "1274", "isola-owner-manager@v1")
        with self.assertRaises(T.Refused):
            T.transform(store(PUBLIC, INTERNAL), 2, 7, "1274", "isola-owner-manager@v1")

    def test_refuses_duplicate_target_bindings(self):
        with self.assertRaises(T.Refused):
            T.transform(store(INTERNAL, INTERNAL), 2, 10, "1274", "isola-owner-manager@v1")

    def test_sender_must_match_exactly_one_allowlisted_entry(self):
        with self.assertRaises(T.Refused):  # not on the allowlist: routes, never admits
            T.transform(store(INTERNAL), 2, 10, "9999", "isola-owner-manager@v1")
        two = dict(INTERNAL, allowedSenders=[OWNER, "+44 20 7946 1274"])
        with self.assertRaises(T.Refused):  # ambiguous last four
            T.transform(store(two), 2, 10, "1274", "isola-owner-manager@v1")
        T.transform(store(INTERNAL), 2, 10, "1274", "isola-owner-manager@v1")  # control

    def test_refuses_an_existing_different_value_and_reports_an_identical_one(self):
        other = dict(INTERNAL, senderTemplates={STAFF[0]: "isola-owner-manager@v1"})
        with self.assertRaises(T.Refused):
            T.transform(store(other), 2, 10, "1274", "isola-owner-manager@v1")
        same = dict(INTERNAL, senderTemplates={OWNER: "isola-owner-manager@v1"})
        with self.assertRaisesRegex(T.Refused, "no change needed"):
            T.transform(store(same), 2, 10, "1274", "isola-owner-manager@v1")

    def test_refuses_duplicate_keys_and_non_finite_numbers(self):
        dup = b'[{"chatwootAccountId": 2, "chatwootInboxId": 10, "exposure": "INTERNAL", "exposure": "PUBLIC"}]'
        with self.assertRaisesRegex(T.Refused, "duplicate key"):
            T.transform(dup, 2, 10, "1274", "isola-owner-manager@v1")
        nan = store(INTERNAL)[:-2] + b', "x": NaN}]'
        with self.assertRaisesRegex(T.Refused, "non-finite"):
            T.transform(nan, 2, 10, "1274", "isola-owner-manager@v1")

    def test_equality_is_proven_on_the_reparse_of_the_emitted_bytes(self):
        pretty = json.dumps([PUBLIC, INTERNAL], indent=4).encode()  # formatting differs, meaning does not
        new_raw, rep = T.transform(pretty, 2, 10, "1274", "isola-owner-manager@v1")
        self.assertTrue(rep["other_bindings_unchanged"] and rep["target_fields_unchanged"])
        self.assertTrue(rep["other_bindings_byte_equal"])
        self.assertIn("verbatim", rep["serialization"])
        self.assertEqual(json.loads(new_raw)[0], PUBLIC)

    def test_every_other_binding_is_kept_byte_for_byte(self):
        a = json.dumps(PUBLIC, indent=2, ensure_ascii=True)
        head = "[\n  " + a + " ,\n  "
        raw = (head + json.dumps(INTERNAL) + "\n]\n").encode()
        new_raw, rep = T.transform(raw, 2, 10, "1274", "isola-owner-manager@v1")
        self.assertTrue(rep["other_bindings_byte_equal"])
        self.assertTrue(new_raw.startswith(head.encode()))  # the other binding, spacing and all
        self.assertTrue(new_raw.endswith(b"\n]\n"))

    def test_refuses_a_store_that_is_not_an_array_of_objects(self):
        with self.assertRaises(T.Refused):
            T.transform(b'{"a":1}', 2, 10, "1274", "isola-owner-manager@v1")


class FakeDocker:
    """Dispatches docker CLI argv; records what was created and swapped."""

    def __init__(self, raw, validator_ok=True, secrets=("isola_gwint_bindings_v5",),
                 fail_update=False, corrupt_new_mount=False, swarm_rolls_back=False,
                 fail_after_apply=False, rollback_failures=0, redeploy_during_validation=False):
        self.swarm_rolls_back = swarm_rolls_back
        self.fail_update = fail_update
        self.fail_after_apply = fail_after_apply        # the swap applies, then exits non-zero
        self.rollback_failures = rollback_failures      # rollback commands that fail before one works
        self.redeploy_during_validation = redeploy_during_validation
        self.version = 10
        self.corrupt_new_mount = corrupt_new_mount
        self.image = "isola-gateway:vsp-da9a8df"
        self.validated_images = []
        self.stores = {"isola_gwint_bindings_v5": raw}
        self.mounted = "isola_gwint_bindings_v5"
        self.container = "0000000000c1"
        self.task_secret_override = None  # a running task mounting something other than the spec
        self.retag_on_swap = False  # the tag resolves to a DIFFERENT image once swapped
        self.tags = {}
        self.secrets = list(secrets)
        self.validator_ok = validator_ok
        self.calls = []

    def __call__(self, argv, stdin):
        self.calls.append(list(argv))
        a = list(argv)
        if a[:3] == ["docker", "service", "inspect"]:
            return json.dumps([{"Version": {"Index": self.version},
                                "Spec": {"TaskTemplate": {"ContainerSpec": {"Image": self.image, "Secrets": [
                {"SecretName": self.mounted, "File": {"Name": "gateway_bindings"}}]}}}}]).encode()
        if a[:3] == ["docker", "service", "ps"]:
            return ("task-" + self.container).encode()
        if a[:2] == ["docker", "tag"]:
            self.tags[a[3]] = a[2]
            return b""
        if a[:3] == ["docker", "image", "inspect"]:
            if a[-1] in self.tags:
                return self.tags[a[-1]].encode()
            return ("sha256:" + "a" * 64).encode()  # what the tag resolves to at validation
        if a[:4] == ["docker", "inspect", "--type", "container"]:
            moved = self.retag_on_swap and self.mounted != "isola_gwint_bindings_v5"
            return ("sha256:" + ("b" if moved else "a") * 64).encode()
        if a[:4] == ["docker", "inspect", "--type", "task"]:
            cid = a[4][len("task-"):]
            secret = self.task_secret_override or self.mounted
            return json.dumps([{"Status": {"State": "running", "ContainerStatus": {"ContainerID": cid}},
                                "Spec": {"ContainerSpec": {"Secrets": [
                                    {"SecretName": secret, "File": {"Name": "gateway_bindings"}}]}}}]).encode()
        if a[:2] == ["docker", "exec"]:
            if self.corrupt_new_mount and self.mounted != "isola_gwint_bindings_v5":
                return self.stores[self.mounted] + b" "
            return self.stores[self.mounted]
        if a[:3] == ["docker", "run", "--rm"]:
            self.validated_images.append(a[a.index("node") + 1])
            data = json.loads(stdin)
            if not self.validator_ok:
                return json.dumps({"ok": False, "count": 0, "errorCount": 1, "senderTemplatesErrors": 0}).encode()
            env = dict(x.split("=", 1) for x in a if x.startswith(("T_IDX=", "T_TPL=")))
            tv = list(data[int(env["T_IDX"])].get("senderTemplates", {}).values())
            return json.dumps({"ok": True, "count": len(data), "errorCount": 0, "senderTemplatesErrors": 0,
                               "senderTemplateCounts": [len(b.get("senderTemplates", {})) for b in data],
                               "targetCarriesTemplate": len(tv) == 1 and tv[0] == env["T_TPL"]}).encode()
        if a[:3] == ["docker", "secret", "ls"]:
            if self.redeploy_during_validation:  # another deploy lands between validate and write
                self.image, self.version = "isola-gateway:someone-elses-build", self.version + 1
            return "\n".join(self.secrets).encode()
        if a[:3] == ["docker", "secret", "create"]:
            self.stores[a[3]] = stdin
            self.secrets.append(a[3])
            return b"id\n"
        if a[:3] == ["docker", "secret", "rm"]:
            if a[3] == self.mounted:  # Swarm refuses to remove a referenced secret
                raise T.Refused("command failed (docker secret, exit 1)")
            self.stores.pop(a[3], None)
            self.secrets.remove(a[3])
            return b"ok\n"
        if a[:3] == ["docker", "service", "update"]:
            src = [x for x in a if x.startswith("source=")][0].split(",")[0][len("source="):]
            rollback = src == "isola_gwint_bindings_v5"
            if "--image" in a:
                self.image = a[a.index("--image") + 1]
            if self.fail_update:
                raise T.Refused("command failed (docker service, exit 1)")
            if rollback and self.rollback_failures > 0:
                self.rollback_failures -= 1
                raise T.Refused("command failed (docker service, exit 1)")
            self.version += 1
            self.mounted = src
            if self.fail_after_apply and not rollback:
                self.container = "%012x" % (int(self.container, 16) + 1)
                raise T.Refused("command failed (docker service, exit 1)")
            self.container = "%012x" % (int(self.container, 16) + 1)  # a new task per update
            if self.swarm_rolls_back and src != "isola_gwint_bindings_v5":
                self.mounted = "isola_gwint_bindings_v5"  # Swarm reverted before the tool looked
                self.container = "%012x" % (int(self.container, 16) + 1)
            return b"svc\n"
        raise AssertionError("unexpected docker call: " + " ".join(a[:3]))


ARGS = ["--service", "isolagwint_gateway", "--expect-current-secret", "isola_gwint_bindings_v5",
        "--new-secret", "isola_gwint_bindings_v6", "--account", "2", "--inbox", "10",
        "--sender-last4", "1274", "--template", "isola-owner-manager@v1"]


def run_main(fake, extra=()):
    buf = io.StringIO()
    with redirect_stdout(buf):
        code = T.main(ARGS + list(extra), runner=fake, sleep=lambda s: None)
    return code, json.loads(buf.getvalue()), buf.getvalue()


class MainTests(unittest.TestCase):
    def test_dry_run_creates_and_swaps_nothing(self):
        fake = FakeDocker(store(PUBLIC, INTERNAL))
        code, rep, _ = run_main(fake)
        self.assertEqual(code, 0)
        self.assertIn("DRY RUN OK", rep["result"])
        self.assertFalse(any(c[:3] in (["docker", "secret", "create"], ["docker", "service", "update"]) for c in fake.calls))
        self.assertTrue(rep["validator_original"]["ok"] and rep["validator_new"]["ok"])
        # validated with the immutable id of the image the SERVICE runs
        self.assertEqual(set(fake.validated_images), {"sha256:" + "a" * 64})
        self.assertTrue(any(c[:3] == ["docker", "image", "inspect"] and c[-1] == "isola-gateway:vsp-da9a8df"
                            for c in fake.calls))

    def test_apply_creates_a_new_version_swaps_and_proves_the_mount(self):
        fake = FakeDocker(store(PUBLIC, INTERNAL))
        code, rep, text = run_main(fake, ["--apply"])
        self.assertEqual(code, 0, rep)
        self.assertEqual(fake.mounted, "isola_gwint_bindings_v6")
        self.assertIn("isola_gwint_bindings_v5", fake.stores)  # old version kept for rollback
        self.assertTrue(rep["mounted_equals_validated"])
        self.assertIn("source=isola_gwint_bindings_v5", rep["rollback_command"])
        for needle in ("FAKE-SECRET", "FAKE-TOKEN", "555 1274"):
            self.assertNotIn(needle, text)

    def test_a_parser_rejection_of_the_new_store_refuses_before_any_write(self):
        fake = FakeDocker(store(PUBLIC, INTERNAL), validator_ok=False)
        code, rep, _ = run_main(fake, ["--apply"])
        self.assertEqual(code, 2)
        self.assertIn("CONTROL FAILED", rep["refused"])  # the original fails too: instrument broken
        self.assertNotIn("isola_gwint_bindings_v6", fake.stores)

    def test_refuses_when_the_service_mounts_a_different_secret_than_expected(self):
        fake = FakeDocker(store(PUBLIC, INTERNAL))
        fake.mounted = "isola_gwint_bindings_v4"
        fake.stores["isola_gwint_bindings_v4"] = fake.stores["isola_gwint_bindings_v5"]
        code, rep, _ = run_main(fake, ["--apply"])
        self.assertEqual(code, 2)
        self.assertNotIn("isola_gwint_bindings_v6", fake.stores)

    def test_refuses_an_existing_new_secret_name(self):
        fake = FakeDocker(store(PUBLIC, INTERNAL), secrets=("isola_gwint_bindings_v5", "isola_gwint_bindings_v6"))
        code, rep, _ = run_main(fake, ["--apply"])
        self.assertEqual(code, 2)
        self.assertEqual(fake.mounted, "isola_gwint_bindings_v5")

    def test_a_failed_swap_removes_the_new_secret_and_leaves_the_original_mounted(self):
        fake = FakeDocker(store(PUBLIC, INTERNAL), fail_update=True)
        code, rep, _ = run_main(fake, ["--apply"])
        self.assertEqual(code, 2)
        self.assertNotIn("isola_gwint_bindings_v6", fake.stores)
        self.assertNotIn("isola_gwint_bindings_v6", fake.secrets)
        self.assertEqual(rep["mounted_after_swap"], "original")
        self.assertTrue(rep["original_bytes_still_mounted"])

    def test_a_rolling_update_in_flight_refuses_before_reading(self):
        fake = FakeDocker(store(PUBLIC, INTERNAL))
        fake.task_secret_override = "isola_gwint_bindings_v4"  # spec says v5, the running task still mounts v4
        code, rep, _ = run_main(fake, ["--apply"])
        self.assertEqual(code, 2)
        self.assertIn("rolling update", rep["refused"])
        self.assertFalse(any(c[:2] == ["docker", "exec"] for c in fake.calls))

    def test_a_redeploy_between_validation_and_write_refuses_before_any_write(self):
        fake = FakeDocker(store(PUBLIC, INTERNAL), redeploy_during_validation=True)
        code, rep, _ = run_main(fake, ["--apply"])
        self.assertEqual(code, 2)
        self.assertIn("changed", rep["refused"])
        self.assertNotIn("isola_gwint_bindings_v6", fake.stores)
        self.assertFalse(any(c[:3] == ["docker", "secret", "create"] for c in fake.calls))

    def test_a_digest_qualified_service_image_pins_cleanly_and_nothing_is_orphaned_on_pin_failure(self):
        fake = FakeDocker(store(PUBLIC, INTERNAL))
        fake.image = "registry.local:5000/isola-gateway:vsp-da9a8df@sha256:" + "c" * 64
        code, rep, _ = run_main(fake, ["--apply"])
        self.assertEqual(code, 0, rep)
        self.assertEqual(rep["pinned_image"], "registry.local:5000/isola-gateway:bt-" + "a" * 12)
        # pin failure: the tag resolves elsewhere -> refused BEFORE any secret is created
        fake2 = FakeDocker(store(PUBLIC, INTERNAL))
        real_call = fake2.__call__
        def lying(argv, stdin):
            if argv[:3] == ["docker", "image", "inspect"] and argv[-1].endswith(":bt-" + "a" * 12):
                return ("sha256:" + "f" * 64).encode()
            return real_call(argv, stdin)
        buf = io.StringIO()
        with redirect_stdout(buf):
            code2 = T.main(ARGS + ["--apply"], runner=lying, sleep=lambda s: None)
        self.assertEqual(code2, 2)
        self.assertFalse(any(c[:3] == ["docker", "secret", "create"] for c in fake2.calls))

    def _flaky(self, fake, after, skip):
        """Fail the first `service inspect` issued after the first `after`
        call, `skip` inspects later (a transient manager error mid-flight)."""
        state = {"armed": False, "seen": 0, "fired": False}
        def runner(argv, stdin):
            if argv[:3] == after:
                state["armed"] = True
            if state["armed"] and not state["fired"] and argv[:3] == ["docker", "service", "inspect"]:
                if state["seen"] == skip:
                    state["fired"] = True
                    raise T.Refused("command failed (docker service, exit 1)")
                state["seen"] += 1
            return fake(argv, stdin)
        return runner

    def test_a_transient_failure_right_after_create_leaves_no_orphan(self):
        fake = FakeDocker(store(PUBLIC, INTERNAL))
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = T.main(ARGS + ["--apply"], runner=self._flaky(fake, ["docker", "secret", "create"], 0), sleep=lambda s: None)
        rep = json.loads(buf.getvalue())
        self.assertEqual(code, 2)
        self.assertIn("original secret mounted", rep["safety_net"])
        self.assertNotIn("isola_gwint_bindings_v6", fake.secrets)
        self.assertEqual(fake.mounted, "isola_gwint_bindings_v5")

    def test_a_transient_failure_right_after_the_swap_rolls_back_and_cleans_up(self):
        fake = FakeDocker(store(PUBLIC, INTERNAL))
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = T.main(ARGS + ["--apply"], runner=self._flaky(fake, ["docker", "service", "update"], 0), sleep=lambda s: None)
        rep = json.loads(buf.getvalue())
        self.assertEqual(code, 2)
        self.assertIn("original secret mounted", rep["safety_net"])
        self.assertEqual(fake.mounted, "isola_gwint_bindings_v5")
        self.assertNotIn("isola_gwint_bindings_v6", fake.secrets)
        self.assertNotIn("_raw", rep)

    def test_the_swap_pins_the_validated_image(self):
        fake = FakeDocker(store(PUBLIC, INTERNAL))
        code, rep, _ = run_main(fake, ["--apply"])
        self.assertEqual(code, 0, rep)
        swaps = [c for c in fake.calls if c[:3] == ["docker", "service", "update"]]
        self.assertEqual(len(swaps), 1)
        pinned = swaps[0][swaps[0].index("--image") + 1]
        self.assertEqual(pinned, "isola-gateway:bt-" + "a" * 12)  # a tag this tool made from the validated id
        self.assertEqual(fake.tags[pinned], "sha256:" + "a" * 64)
        self.assertTrue(rep["image_unchanged"])

    def test_a_tag_that_moves_to_another_image_is_caught_and_rolled_back(self):
        fake = FakeDocker(store(PUBLIC, INTERNAL))
        fake.retag_on_swap = True
        code, rep, _ = run_main(fake, ["--apply"])
        self.assertEqual(code, 2)
        self.assertFalse(rep["image_unchanged"])
        self.assertTrue(rep["rollback_restores_original"])
        self.assertEqual(fake.mounted, "isola_gwint_bindings_v5")

    def test_validation_runs_on_the_immutable_image_id_not_the_tag(self):
        fake = FakeDocker(store(PUBLIC, INTERNAL))
        run_main(fake)
        self.assertEqual(set(fake.validated_images), {"sha256:" + "a" * 64})

    def test_a_swap_that_applies_but_exits_nonzero_is_judged_by_observed_state(self):
        fake = FakeDocker(store(PUBLIC, INTERNAL), fail_after_apply=True)
        code, rep, _ = run_main(fake, ["--apply"])
        self.assertEqual(code, 0, rep)
        self.assertEqual(rep["swap_command"], "failed; acting on observed state")
        self.assertTrue(rep["mounted_equals_validated"])

    def test_a_failing_rollback_command_is_retried_and_the_result_proven(self):
        fake = FakeDocker(store(PUBLIC, INTERNAL), corrupt_new_mount=True, rollback_failures=1)
        code, rep, _ = run_main(fake, ["--apply"])
        self.assertEqual(code, 2)
        self.assertTrue(rep["rollback_restores_original"])
        self.assertEqual(fake.mounted, "isola_gwint_bindings_v5")
        self.assertIn("proven back on the original", rep["refused"])

    def test_an_unrecoverable_rollback_is_reported_as_live_unverified(self):
        fake = FakeDocker(store(PUBLIC, INTERNAL), corrupt_new_mount=True, rollback_failures=9)
        code, rep, _ = run_main(fake, ["--apply"])
        self.assertEqual(code, 2)
        self.assertIn("LIVE UNVERIFIED", rep["refused"])
        self.assertIn("rollback_command", rep)
        self.assertEqual(rep["created"], "isola_gwint_bindings_v6")  # never claims a cleanup it did not do

    def test_an_unverified_mount_is_rolled_back_automatically_and_the_rollback_is_proven(self):
        fake = FakeDocker(store(PUBLIC, INTERNAL), corrupt_new_mount=True)
        code, rep, _ = run_main(fake, ["--apply"])
        self.assertEqual(code, 2)
        self.assertFalse(rep["mounted_equals_validated"])
        self.assertEqual(rep["auto_rollback"], "issued by this tool (attempt 1)")
        self.assertNotIn("isola_gwint_bindings_v6", fake.secrets)  # the unverified version is removed
        self.assertTrue(rep["rollback_restores_original"])
        self.assertEqual(fake.mounted, "isola_gwint_bindings_v5")

    def test_swarm_auto_rollback_is_recognised_proven_and_cleaned_up(self):
        fake = FakeDocker(store(PUBLIC, INTERNAL), swarm_rolls_back=True)
        code, rep, _ = run_main(fake, ["--apply"])
        self.assertEqual(code, 2)
        self.assertEqual(rep["mounted_after_swap"], "original")  # observed, not assumed
        self.assertTrue(rep["original_bytes_still_mounted"])
        self.assertNotIn("isola_gwint_bindings_v6", fake.secrets)
        self.assertEqual(fake.mounted, "isola_gwint_bindings_v5")

    def test_existing_routing_on_another_binding_is_kept_and_never_printed(self):
        other = dict(PUBLIC, exposure="INTERNAL", chatwootInboxId=11,
                     allowedSenders=["+1 767 555 2222"], senderTemplates={"+1 767 555 2222": "private-routing-token@v1"})
        fake = FakeDocker(store(other, INTERNAL))
        code, rep, text = run_main(fake, ["--apply"])
        self.assertEqual(code, 0, rep)
        self.assertEqual(rep["validator_new"]["senderTemplateCounts"], [1, 1])
        self.assertNotIn("private-routing-token", text)
        self.assertNotIn("555 2222", text)

    def test_refuses_bad_argument_shapes(self):
        for bad in (["--sender-last4", "12a4"], ["--template", "x y"], ["--new-secret", "a;b"],
                    ["--new-secret", "--help"], ["--service", "-x"]):
            args = list(ARGS)
            i = args.index(bad[0])
            args[i + 1] = bad[1]
            buf = io.StringIO()
            with redirect_stdout(buf):
                fake = FakeDocker(store(INTERNAL))
                try:
                    code = T.main(args, runner=fake, sleep=lambda s: None)
                except SystemExit as e:  # argparse refuses an option-shaped value itself
                    code = e.code
                self.assertFalse(any(c[:3] == ["docker", "secret", "create"] for c in fake.calls), bad)
            self.assertEqual(code, 2, bad)


if __name__ == "__main__":
    unittest.main()
