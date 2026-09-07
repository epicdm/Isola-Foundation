/**
 * Engine config factories — wire Replit Secrets → config objects for the
 * five proven engine clients in /engines/.
 *
 * None of these modules read process.env themselves; config is always
 * passed as a parameter. These factories are the ONLY place that touches env.
 *
 * Required secrets (see SETUP_CHECKLIST in /api/setup-status/route.ts):
 *   MAGNUS_BASE_URL, MAGNUS_API_KEY, MAGNUS_API_SECRET
 *   FISERV_API_KEY, FISERV_BASE_URL (optional)
 *   ODOO_URL, ODOO_API_KEY, ODOO_DB
 *   META_WA_VERIFY_TOKEN, META_WA_APP_SECRET
 *   ANTHROPIC_API_KEY
 */

import type { MagnusConfig } from '@/engines/magnus';
import type { FiservConfig } from '@/engines/fiserv';
import type { WhatsAppConfig } from '@/engines/whatsapp';
import type { OdooConfig } from '@/engines/odoo';
import type { ChatwootConfig } from '@/engines/chatwoot';
import type { BffConfig } from '@/engines/bff';
import { serviceTokensFrom } from '@/lib/customer-360/service-auth';

// ── Magnus ───────────────────────────────────────────────────────────────────

export function getMagnusConfig(): MagnusConfig {
  // Accept MAGNUS_URL (the name actually set in this env/.env.local) with
  // MAGNUS_BASE_URL as a legacy fallback.
  const baseUrl = process.env.MAGNUS_URL || process.env.MAGNUS_BASE_URL;
  const apiKey = process.env.MAGNUS_API_KEY;
  const apiSecret = process.env.MAGNUS_API_SECRET;
  if (!baseUrl || !apiKey || !apiSecret) {
    throw new Error(
      'Magnus not configured — set MAGNUS_URL, MAGNUS_API_KEY, MAGNUS_API_SECRET',
    );
  }
  return { baseUrl, apiKey, apiSecret };
}

export function isMagnusConfigured(): boolean {
  return !!(
    (process.env.MAGNUS_URL || process.env.MAGNUS_BASE_URL) &&
    process.env.MAGNUS_API_KEY &&
    process.env.MAGNUS_API_SECRET
  );
}

/** Deployment-configured ring timeout (seconds, as a raw string) for the S5
 *  voice-routing app/app_then_cell modes. Raw plumbing only — validating that
 *  the value is a sane bounded positive integer is lib/voice-routing.ts's job
 *  (isValidRingTimeoutSeconds), not this factory's. Returns null when unset —
 *  callers must not invent a hardcoded fallback for a missing/invalid value. */
export function getVoiceRoutingRingTimeoutSeconds(): string | null {
  const raw = process.env.VOICE_ROUTING_RING_TIMEOUT_SECONDS;
  return raw && raw.trim() !== '' ? raw.trim() : null;
}

// ── Fiserv ───────────────────────────────────────────────────────────────────

export function getFiservConfig(overrides?: Partial<FiservConfig>): FiservConfig {
  const apiKey = overrides?.apiKey ?? process.env.FISERV_API_KEY;
  if (!apiKey) {
    throw new Error('Fiserv not configured — set FISERV_API_KEY (or provide a tenant FiservBinding)');
  }
  return { apiKey, baseUrl: overrides?.baseUrl ?? process.env.FISERV_BASE_URL };
}

export function isFiservConfigured(): boolean {
  return !!process.env.FISERV_API_KEY;
}

// ── BFF Lite (payment rails: mirror-account, top-up options/start) ──────────

export function getBffConfig(overrides?: Partial<BffConfig>): BffConfig {
  const baseUrl = overrides?.baseUrl ?? process.env.BFF_BASE_URL;
  const internalSecret = overrides?.internalSecret ?? process.env.BFF_INTERNAL_SECRET;
  if (!baseUrl || !internalSecret) {
    throw new Error('BFF not configured — set BFF_BASE_URL, BFF_INTERNAL_SECRET (or provide a tenant BffBinding)');
  }
  return { baseUrl, internalSecret };
}

export function isBffConfigured(): boolean {
  return !!(process.env.BFF_BASE_URL && process.env.BFF_INTERNAL_SECRET);
}

// Default top-up currency by the consumer's own number's country code:
// Dominica (+1767) → EC$ (Fiserv's XCD rail); any other number (e.g. US
// +1) → US$. The consumer can always switch via the currency toggle — this
// only picks the initial selection.
export function defaultTopupCurrency(phoneNumber: string): 'EC$' | 'US$' {
  const digits = (phoneNumber || '').replace(/[^\d+]/g, '');
  if (digits.startsWith('+1767')) return 'EC$';
  if (digits.startsWith('+1')) return 'US$';
  return 'EC$';
}

// ── NBD manual bank-transfer details (for the "Pay manually" top-up option) ──
// EPIC's own NBD account that consumers wire/transfer to directly. Account
// NUMBER reuses the BFF's existing LITE_NBD_ACCOUNT (already provisioned).
// Account NAME defaults to EPIC's public legal business name — this is
// public, non-sensitive information (not a secret), so it's safe to bake in
// as a default. NBD_ACCOUNT_NAME, if set, overrides the default.

const DEFAULT_NBD_ACCOUNT_NAME = 'EPIC Communications Inc';

export interface NbdManualAccount {
  configured: boolean;
  bank: string;
  accountName: string | null;
  accountNumber: string | null;
}

export function getNbdManualAccount(): NbdManualAccount {
  const accountNumber = process.env.NBD_ACCOUNT_NUMBER || process.env.LITE_NBD_ACCOUNT || null;
  const accountName = process.env.NBD_ACCOUNT_NAME || DEFAULT_NBD_ACCOUNT_NAME;
  return {
    configured: !!(accountNumber && accountName),
    bank: 'NBD',
    accountName,
    accountNumber,
  };
}

// ── WhatsApp ──────────────────────────────────────────────────────────────────
// No global secrets — per-send: phoneId and token come from the WhatsAppNumber DB record.

export function getWhatsAppConfig(): WhatsAppConfig {
  return { graphVersion: process.env.META_GRAPH_VERSION }; // defaults to v25.0 in the engine
}

// ── Chatwoot ──────────────────────────────────────────────────────────────────
// Per-tenant: config comes from the ChatwootBinding DB record.
//
// ChatwootBinding.token holds either a literal secret (legacy rows, still
// supported) or a CREDENTIAL REFERENCE of the form `env:VAR_NAME` — the row
// names which env var to read at use time instead of carrying the value
// itself. This is deliberately per-row, not a mode-wide rule: a platform-wide
// "mode === 'mirror' means use CHATWOOT_SERVICE_TOKEN" would hand EPIC's own
// service token to any OTHER tenant's blank mirror binding (a real one
// already exists for a different Chatwoot account entirely). Each row
// choosing its own reference keeps resolution tenant-sourced, the same
// property connector.ts's callEngine('chatwoot', ...) already documents as
// load-bearing for this engine.

const CREDENTIAL_REF_PREFIX = 'env:';

/** Thrown by resolveChatwootToken — message carries only the env var NAME,
 *  never a value (set or unset). Callers that touch Chatwoot as a side
 *  effect (never the primary customer-facing action) must catch this next
 *  to their existing Chatwoot-call try/catch, not let it propagate. */
export class ChatwootCredentialRefError extends Error {
  constructor(public readonly varName: string) {
    super(`Chatwoot credential reference "${CREDENTIAL_REF_PREFIX}${varName}" is not set in the environment`);
    this.name = 'ChatwootCredentialRefError';
  }
}

/**
 * Resolves a ChatwootBinding.token value. A literal value passes through
 * unchanged (today's behaviour, untouched). A `env:VAR_NAME` reference reads
 * that env var and returns it — and if the var is unset or empty, THROWS
 * rather than falling back to the literal string or to an empty token: a
 * silently-empty credential would let a caller "succeed" in making an
 * unauthenticated Chatwoot call, which is a worse failure than a loud one.
 */
export function resolveChatwootToken(stored: string): string {
  if (!stored.startsWith(CREDENTIAL_REF_PREFIX)) return stored;
  const varName = stored.slice(CREDENTIAL_REF_PREFIX.length);
  const value = process.env[varName];
  if (!value) {
    throw new ChatwootCredentialRefError(varName);
  }
  return value;
}

export function getChatwootConfig(binding: {
  base_url: string;
  account_id: string;
  token: string;
}): ChatwootConfig {
  return {
    baseUrl: binding.base_url,
    accountId: binding.account_id,
    token: resolveChatwootToken(binding.token),
  };
}

// ── Odoo ──────────────────────────────────────────────────────────────────────

export function getOdooConfig(overrides?: Partial<OdooConfig>): OdooConfig {
  const url = overrides?.url ?? process.env.ODOO_URL;
  const apiKey = overrides?.apiKey ?? process.env.ODOO_API_KEY;
  const db = overrides?.db ?? process.env.ODOO_DB;
  if (!url || !apiKey || !db) {
    throw new Error('Odoo not configured — set ODOO_URL, ODOO_API_KEY, ODOO_DB (or provide a tenant OdooBinding)');
  }
  return { url, apiKey, db };
}

export function isOdooConfigured(): boolean {
  return !!(process.env.ODOO_URL && process.env.ODOO_API_KEY && process.env.ODOO_DB);
}

// ── Agent tools (governed catalog endpoint) ───────────────────────────────────
// POST /api/agent-tools/invoke — flag-gated, default OFF. Service-token auth,
// NOT a session/Odoo/Meta key.

export function isAgentToolsEnabled(): boolean {
  return process.env.FLOWISE_AGENT_TOOLS_ENABLED === 'true';
}

export function getAgentToolsToken(): string | undefined {
  return process.env.ISOLA_AGENT_TOOLS_TOKEN;
}

// ── Setup checklist ───────────────────────────────────────────────────────────

export interface SecretStatus {
  key: string;
  label: string;
  configured: boolean;
  required: boolean;
}

export function getSetupChecklist(): SecretStatus[] {
  return [
    {
      key: 'ANTHROPIC_API_KEY',
      label: 'Anthropic API key — all AI tiers (Haiku / Sonnet / Opus)',
      configured: !!process.env.ANTHROPIC_API_KEY,
      required: true,
    },
    {
      key: 'META_WA_VERIFY_TOKEN',
      label: 'Meta WhatsApp verify token (webhook)',
      configured: !!process.env.META_WA_VERIFY_TOKEN,
      required: true,
    },
    {
      key: 'META_APP_SECRET',
      label: 'Meta WhatsApp app secret (signature verification)',
      configured: !!(process.env.META_APP_SECRET ?? process.env.META_WA_APP_SECRET),
      required: false,
    },
    {
      key: 'META_SYSTEM_TOKEN',
      label: 'Meta system user token (default WhatsApp send token)',
      configured: !!process.env.META_SYSTEM_TOKEN,
      required: false,
    },
    {
      key: 'MAGNUS_URL',
      label: 'Magnus base URL (voice/wallet)',
      configured: !!(process.env.MAGNUS_URL || process.env.MAGNUS_BASE_URL),
      required: true,
    },
    {
      key: 'MAGNUS_API_KEY',
      label: 'Magnus API key',
      configured: !!process.env.MAGNUS_API_KEY,
      required: true,
    },
    {
      key: 'MAGNUS_API_SECRET',
      label: 'Magnus API secret',
      configured: !!process.env.MAGNUS_API_SECRET,
      required: true,
    },
    {
      key: 'FISERV_API_KEY',
      label: 'Fiserv API key (card top-up)',
      configured: !!process.env.FISERV_API_KEY,
      required: true,
    },
    {
      key: 'FISERV_BASE_URL',
      label: 'Fiserv base URL (optional, defaults to api01.epic.dm)',
      configured: !!process.env.FISERV_BASE_URL,
      required: false,
    },
    {
      key: 'ODOO_URL',
      label: 'Odoo URL (CRM)',
      configured: !!process.env.ODOO_URL,
      required: false,
    },
    {
      key: 'ODOO_API_KEY',
      label: 'Odoo API key',
      configured: !!process.env.ODOO_API_KEY,
      required: false,
    },
    {
      key: 'ODOO_DB',
      label: 'Odoo database name',
      configured: !!process.env.ODOO_DB,
      required: false,
    },
    {
      key: 'ADMIN_REPLIT_IDS',
      label: 'Admin Replit user IDs (comma-separated, for EPIC operators)',
      configured: !!process.env.ADMIN_REPLIT_IDS,
      required: true,
    },
    {
      key: 'FISERV_CHARGE_ENABLED',
      label: 'Set to "true" to enable live card charges via Fiserv (kill-switch)',
      configured: process.env.FISERV_CHARGE_ENABLED === 'true',
      required: false,
    },
    {
      key: 'BFF_BASE_URL',
      label: 'BFF Lite base URL (payment rails: mirror-account, top-up)',
      configured: !!process.env.BFF_BASE_URL,
      required: false,
    },
    {
      key: 'BFF_INTERNAL_SECRET',
      label: 'BFF Lite internal secret (server-to-server auth)',
      configured: !!process.env.BFF_INTERNAL_SECRET,
      required: false,
    },
    {
      key: 'TENANT_MASTER_KEY',
      label: 'Master key for encrypting per-tenant secrets at rest',
      configured: !!process.env.TENANT_MASTER_KEY,
      required: false,
    },
    {
      key: 'CHATWOOT_SUPER_ADMIN_TOKEN',
      label: 'Chatwoot super-admin token (for provisioning inboxes)',
      configured: !!process.env.CHATWOOT_SUPER_ADMIN_TOKEN,
      required: false,
    },
    {
      key: 'CHATWOOT_AGENT_ACCESS_TOKEN',
      label: 'Chatwoot agent access token (for per-tenant conversation mirroring)',
      configured: !!process.env.CHATWOOT_AGENT_ACCESS_TOKEN,
      required: false,
    },
    {
      key: 'CHATWOOT_AGENTBOT_TOKEN',
      label: 'Chatwoot agent-bot token (A2 mode — bot id 4 "Isola Brain (A2)")',
      configured: !!process.env.CHATWOOT_AGENTBOT_TOKEN,
      required: false,
    },
    {
      key: 'CHATWOOT_BOT_SECRET',
      label: 'Chatwoot agent-bot webhook secret (A2 inbound auth)',
      configured: !!process.env.CHATWOOT_BOT_SECRET,
      required: false,
    },
    {
      key: 'META_SYSTEM_TOKEN',
      label: 'Meta system user token (default WhatsApp access token)',
      configured: !!process.env.META_SYSTEM_TOKEN,
      required: false,
    },
    {
      key: 'ISOLA_AGENT_TOOLS_TOKEN',
      label: 'Service token for POST /api/agent-tools/invoke (Flowise tool-catalog gate)',
      configured: !!process.env.ISOLA_AGENT_TOOLS_TOKEN,
      required: false,
    },
    {
      key: 'FLOWISE_AGENT_TOOLS_ENABLED',
      label: 'Set to "true" to enable the agent-tools invoke endpoint (kill-switch, default off)',
      configured: process.env.FLOWISE_AGENT_TOOLS_ENABLED === 'true',
      required: false,
    },
    // ── Customer 360 server-to-server read surface ───────────────────────────
    // Registered here so an operator can see WHETHER each is configured without
    // anyone reading a value. All three are needed together: a token with no
    // tenant binding fails closed rather than defaulting to some tenant, which
    // is how "one key over all tenants" would otherwise arrive by omission.
    {
      key: 'ISOLA_360_SERVICE_TOKEN',
      label:
        'Service token(s) for the Customer 360 read surface (portal → Foundation). Several callers legitimately read the SAME tenant — production and staging both do — so this accepts a set: ISOLA_360_SERVICE_TOKEN plus any ISOLA_360_SERVICE_TOKEN_<LABEL>, each its own secret so each can be revoked alone. Distinct from ISOLA_AGENT_TOOLS_TOKEN on purpose — that one gates a Flowise tool catalogue and must never reach customer data. Rotation program: yes.',
      // Answered from the SAME enumeration the door uses, never from a second
      // reading of one variable. A readout that consults a different rule than
      // the check can report "not configured" about a credential that in fact
      // authenticates — which is precisely how production spent this cycle
      // looking unconfigured while holding a perfectly good token.
      configured: serviceTokensFrom(process.env).length > 0,
      required: false,
    },
    {
      key: 'ISOLA_360_SERVICE_TENANT_ID',
      label:
        'The ONE tenant the Customer 360 service token may read. The tenant is configuration, never a request parameter — a service caller cannot name a tenant.',
      configured: !!process.env.ISOLA_360_SERVICE_TENANT_ID,
      required: false,
    },
    {
      key: 'ISOLA_360_SERVICE_ENABLED',
      label:
        'Set to "true" to enable the Customer 360 server-to-server read surface (kill-switch, default off)',
      configured: process.env.ISOLA_360_SERVICE_ENABLED === 'true',
      required: false,
    },
  ];
}
