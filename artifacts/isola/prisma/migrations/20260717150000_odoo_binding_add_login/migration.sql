-- Migration: add nullable login column to OdooBinding
-- Stores the Odoo cloud login email used with the API key (api_key_enc).
-- Passed to Clawith dispatch so each tenant uses its own Odoo connection
-- instead of Clawith's hardcoded sandbox credentials.
-- Additive and backward-compatible: existing rows will have login = NULL.

ALTER TABLE "OdooBinding" ADD COLUMN IF NOT EXISTS "login" TEXT;
