-- Lane 1 Task 3 — one-time, idempotent creation of the 5 conversation custom
-- attribute definitions the founding-pilot lead pipeline needs on Chatwoot
-- account 5 (the EMA/Isola sales account). Additive only — never touches the
-- 17 pre-existing definitions (9 conversation-attribute rows already on
-- account 5: isola_agent, customer_account_id, customer_did, plan,
-- minutes_or_balance, provisioning_status, ai_mode, human_owner,
-- handoff_reason; 8 farm-advisory rows on unrelated account 39). Safe to
-- re-run: guarded by the table's own (attribute_key, attribute_model,
-- account_id) unique index (attribute_key_model_index).
--
-- attribute_display_type: 0 = text, 6 = list (Chatwoot's Rails enum,
-- confirmed live against this instance's existing rows — e.g. "Urgency" is
-- display_type=6 with a populated attribute_values array).
-- attribute_model: 0 = conversation_attribute (confirmed: all 9 existing
-- account-5 rows use 0; the only attribute_model=1 rows on this instance are
-- account 39's contact-level farmer attributes, an unrelated tenant).
--
-- Run: cat this file | docker exec -i chatwoot-chatwoot-postgres-1 psql -U chatwoot -d chatwoot

INSERT INTO custom_attribute_definitions
  (attribute_display_name, attribute_key, attribute_display_type, attribute_model, account_id, attribute_values, created_at, updated_at)
VALUES
  ('Pilot Stage', 'pilot_stage', 6, 0, 5,
   '["New","Qualified","Demo","Proposal","Commitment pending","Won","Lost"]'::jsonb,
   now(), now()),
  ('Source', 'source', 0, 0, 5, '[]'::jsonb, now(), now()),
  ('Campaign', 'campaign', 0, 0, 5, '[]'::jsonb, now(), now()),
  ('Offer', 'offer', 0, 0, 5, '[]'::jsonb, now(), now()),
  ('Requested Assistant', 'requested_assistant', 0, 0, 5, '[]'::jsonb, now(), now())
ON CONFLICT (attribute_key, attribute_model, account_id) DO NOTHING;
