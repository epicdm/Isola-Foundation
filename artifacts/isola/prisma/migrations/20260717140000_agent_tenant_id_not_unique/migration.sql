-- Migration: drop unique constraint on Agent.tenant_id
-- Allow one Tenant to own multiple Agents (S4 multi-agent support).
-- Replaces the implicit unique index with an explicit non-unique index
-- so per-tenant queries remain fast.
-- Safe for existing data: all current rows satisfy the new (relaxed) constraint.

-- Drop the unique index created by Prisma from the @unique attribute.
-- Index name matches Prisma's convention: "<Model>_<field>_key".
DROP INDEX IF EXISTS "Agent_tenant_id_key";

-- Create a normal (non-unique) index in its place.
CREATE INDEX IF NOT EXISTS "Agent_tenant_id_idx" ON "Agent"("tenant_id");
