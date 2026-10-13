import unittest, plw_handoff as H
NOW = 1_800_000_000
def row(**o):
    r = {"display_id": 901, "status": 0, "inbox_id": 11, "handoff_at": NOW - 120, "handoff_note": "Relay handoff: agent unavailable (request_too_large)", "staff_reply_after": False, "customer_tail": "0000"}; r.update(o); return r
class T(unittest.TestCase):
    def test_positive_control_open_unattended_handoff_fires_new(self):
        a, st = H.decide([row()], {}, NOW); self.assertEqual([x[1] for x in a], ["new"]); self.assertIn("NEEDS A PERSON", a[0][2]); self.assertIn("conversations/901", a[0][2])
    def test_not_repeated_within_the_window(self):
        a, st = H.decide([row()], {}, NOW); b, st2 = H.decide([row()], st, NOW + 240); self.assertEqual(b, [])
    def test_reminder_after_N_minutes_then_every_30_min_max_6(self):
        a, st = H.decide([row()], {}, NOW); b, st = H.decide([row()], st, NOW + 11 * 60); self.assertEqual([x[1] for x in b], ["wait"])
        t = NOW + 11 * 60; n = 0
        for i in range(10):
            t += 1801; c, st = H.decide([row()], st, t); n += len(c)
        self.assertEqual(n, 6)
    def test_control_staff_reply_silences(self):
        a, _ = H.decide([row(staff_reply_after=True)], {}, NOW); self.assertEqual(a, [])
    def test_control_pending_or_resolved_is_silent(self):
        for s in (1, 2, 3): self.assertEqual(H.decide([row(status=s)], {}, NOW)[0], [])
    def test_control_other_inbox_is_silent(self):
        self.assertEqual(H.decide([row(inbox_id=7)], {}, NOW)[0], [])
    def test_state_forgets_attended_conversations(self):
        a, st = H.decide([row()], {}, NOW); self.assertEqual(len(st), 1); b, st2 = H.decide([row(staff_reply_after=True)], st, NOW + 60); self.assertEqual(st2, {})
    def test_a_new_handoff_on_the_same_conversation_alerts_again(self):
        a, st = H.decide([row()], {}, NOW); b, st2 = H.decide([row(handoff_at=NOW + 600)], st, NOW + 700); self.assertEqual([x[1] for x in b], ["new"])
    def test_parse_rows_roundtrip_and_garbage(self):
        txt = "901|0|11|%d|Relay handoff: x|f|0000\nnot a row\n902|0|11|%d|Relay handoff: y|t|1111" % (NOW - 60, NOW - 30)
        rs = H.parse_rows(txt); self.assertEqual(len(rs), 2); self.assertTrue(rs[1]["staff_reply_after"]); self.assertFalse(rs[0]["staff_reply_after"])
    def test_two_conversations_two_alerts(self):
        a, _ = H.decide([row(display_id=1), row(display_id=2)], {}, NOW); self.assertEqual(len(a), 2)
if __name__ == "__main__": unittest.main(verbosity=1)
