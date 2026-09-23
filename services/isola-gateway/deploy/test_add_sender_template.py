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

    def test_refuses_a_store_that_is_not_an_array_of_objects(self):
        with self.assertRaises(T.Refused):
            T.transform(b'{"a":1}', 2, 10, "1274", "isola-owner-manager@v1")


class FakeDocker:
    """Dispatches docker CLI argv; records what was created and swapped."""

    def __init__(self, raw, validator_ok=True, secrets=("isola_gwint_bindings_v5",)):
        self.stores = {"isola_gwint_bindings_v5": raw}
        self.mounted = "isola_gwint_bindings_v5"
        self.container = "c1"
        self.secrets = list(secrets)
        self.validator_ok = validator_ok
        self.calls = []

    def __call__(self, argv, stdin):
        self.calls.append(list(argv))
        a = list(argv)
        if a[:3] == ["docker", "service", "inspect"]:
            return json.dumps([{"Spec": {"TaskTemplate": {"ContainerSpec": {"Secrets": [
                {"SecretName": self.mounted, "File": {"Name": "gateway_bindings"}}]}}}}]).encode()
        if a[:3] == ["docker", "ps", "-q"]:
            return (self.container + "\n").encode()
        if a[:2] == ["docker", "exec"]:
            return self.stores[self.mounted]
        if a[:3] == ["docker", "run", "--rm"]:
            data = json.loads(stdin)
            if not self.validator_ok:
                return json.dumps({"ok": False, "count": 0, "errors": ["binding[0]: bad"]}).encode()
            return json.dumps({"ok": True, "count": len(data),
                               "senderTemplateCounts": [len(b.get("senderTemplates", {})) for b in data],
                               "templates": [list(b.get("senderTemplates", {}).values()) for b in data]}).encode()
        if a[:3] == ["docker", "secret", "ls"]:
            return "\n".join(self.secrets).encode()
        if a[:3] == ["docker", "secret", "create"]:
            self.stores[a[3]] = stdin
            self.secrets.append(a[3])
            return b"id\n"
        if a[:3] == ["docker", "service", "update"]:
            src = [x for x in a if x.startswith("source=")][0].split(",")[0][len("source="):]
            self.mounted = src
            self.container = "c2"
            return b"svc\n"
        raise AssertionError("unexpected docker call: " + " ".join(a[:3]))


ARGS = ["--service", "isolagwint_gateway", "--expect-current-secret", "isola_gwint_bindings_v5",
        "--new-secret", "isola_gwint_bindings_v6", "--account", "2", "--inbox", "10",
        "--sender-last4", "1274", "--template", "isola-owner-manager@v1",
        "--validator-image", "isola-gateway:vsp-da9a8df"]


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

    def test_refuses_bad_argument_shapes(self):
        for bad in (["--sender-last4", "12a4"], ["--template", "x y"], ["--new-secret", "a;b"]):
            args = list(ARGS)
            i = args.index(bad[0])
            args[i + 1] = bad[1]
            buf = io.StringIO()
            with redirect_stdout(buf):
                code = T.main(args, runner=FakeDocker(store(INTERNAL)), sleep=lambda s: None)
            self.assertEqual(code, 2, bad)


if __name__ == "__main__":
    unittest.main()
