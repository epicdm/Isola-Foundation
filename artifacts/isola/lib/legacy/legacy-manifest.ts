/**
 * LEGACY COMMUNICATIONS MANIFEST — FROZEN, NOT EXPANDED, AWAITING PROVEN REPLACEMENT.
 *
 * These modules predate the Foundation/Lane-2 boundary. They are the ONLY working
 * internal staff path today, so deleting them to make an architecture token read
 * green would trade a working product for a green square. They stay until Lane 2
 * proves parity and supplies cutover evidence.
 *
 * What this file buys, and it is the whole point: the freeze is MACHINE-ENFORCED.
 * `legacy-manifest.test.ts` fails the build if any permanent Foundation module
 * imports one of these, or if a listed path silently disappears. A freeze that is
 * only written in a document is a freeze that thaws the first time someone is in a
 * hurry.
 *
 * `disposition` is the agreed end state, not a wish:
 *   remove   — deleted once the replacement contract is live and proven
 *   disable  — kept in tree, switched off behind a flag, deleted later
 *   contract — the transport goes, the type/contract definition stays
 */

export type LegacyDisposition = 'remove' | 'disable' | 'contract'

export interface LegacyModule {
  /** Path relative to artifacts/isola. */
  path: string
  purpose: string
  /** Is this on a live code path today? */
  active: boolean
  /** The Lane-2 contract that must exist and be proven before removal. */
  replacedBy: string
  /** The specific evidence required before this file may be touched. */
  removalPrerequisite: string
  disposition: LegacyDisposition
}

export const LEGACY_COMMUNICATIONS: readonly LegacyModule[] = [
  // ── Meta / WhatsApp transport ──────────────────────────────────────────────
  {
    path: 'app/api/webhooks/whatsapp/route.ts',
    purpose: 'Meta webhook: inbound WhatsApp, staff taps, Flow replies, verification',
    active: true,
    replacedBy: 'lane2.events.ingest@1 + lane2.provisioning.channel.connect@1',
    removalPrerequisite: 'Lane 2 receives Meta webhooks AND emits normalized events for one full staff loop',
    disposition: 'remove',
  },
  {
    path: 'engines/whatsapp.ts',
    purpose: 'Graph API sender: templates, interactive messages, Flows',
    active: true,
    replacedBy: 'lane2.messaging.send.request@1',
    removalPrerequisite: 'Lane 2 delivers a template, a button message and a Flow with receipts',
    disposition: 'remove',
  },
  {
    path: 'lib/notify-whatsapp.ts',
    purpose: 'Outbound staff notification: template selection, quick-reply payloads',
    active: true,
    replacedBy: 'lane2.messaging.send.request@1',
    removalPrerequisite: 'parity on template params and quick-reply payload round-trip',
    disposition: 'remove',
  },
  {
    path: 'lib/consumer-whatsapp-otp.ts',
    purpose: 'Consumer OTP delivery over WhatsApp',
    active: false,
    replacedBy: 'lane2.messaging.send.request@1',
    removalPrerequisite: 'confirm no live consumer OTP flow depends on it',
    disposition: 'remove',
  },
  {
    path: 'app/api/onboard/whatsapp/route.ts',
    purpose: 'WABA / phone-number registration',
    active: false,
    replacedBy: 'lane2.provisioning.channel.connect@1',
    removalPrerequisite: 'Lane 2 provisions one number end to end and returns safe identifiers',
    disposition: 'remove',
  },

  // ── Chatwoot ──────────────────────────────────────────────────────────────
  {
    path: 'app/api/chatwoot/webhook/route.ts',
    purpose: 'Chatwoot webhook receiver',
    active: true,
    replacedBy: 'lane2.events.ingest@1',
    removalPrerequisite: 'Lane 2 owns the Chatwoot webhook and forwards normalized events',
    disposition: 'remove',
  },
  {
    path: 'app/api/chatwoot/agent-bot/route.ts',
    purpose: 'AgentBot processing — explicitly outside the Foundation boundary',
    active: true,
    replacedBy: 'Lane 2 AgentBot runtime',
    removalPrerequisite: 'Lane 2 AgentBot answers one live conversation with zero duplicate processing',
    disposition: 'remove',
  },
  {
    path: 'engines/chatwoot.ts',
    purpose: 'Chatwoot REST client: conversations, messages, assignment',
    active: true,
    replacedBy: 'lane2.messaging.send.request@1 + lane2.links.native@1',
    removalPrerequisite: 'Foundation reads Chatwoot state only via normalized events and deep links',
    disposition: 'remove',
  },
  {
    path: 'lib/chatwoot-webhook-signature.ts',
    purpose: 'HMAC verification of Chatwoot webhooks',
    active: true,
    replacedBy: 'Lane 2 webhook authentication',
    removalPrerequisite: 'removed together with the Chatwoot webhook route',
    disposition: 'remove',
  },

  // ── Takeover / handback engine ────────────────────────────────────────────
  {
    path: 'app/api/conversations/[id]/handback/route.ts',
    purpose: 'Human handback endpoint',
    active: true,
    replacedBy: 'lane2.events.ingest@1 (handback reported, not commanded)',
    removalPrerequisite: 'Lane 2 owns handback and reports it as an event',
    disposition: 'remove',
  },
  {
    path: 'lib/chatwoot-handoff.ts',
    purpose: 'Human handoff orchestration',
    active: true,
    replacedBy: 'Lane 2 handoff runtime',
    removalPrerequisite: 'one live takeover and handback driven entirely by Lane 2',
    disposition: 'remove',
  },
  {
    path: 'lib/ownership/authority.ts',
    purpose: 'Who owns a conversation right now',
    active: true,
    replacedBy: 'lane2.events.ingest@1 ownership events → Foundation read model',
    removalPrerequisite: 'ownership projection proven from events alone',
    disposition: 'remove',
  },
  {
    path: 'lib/ownership/state.ts',
    purpose: 'Ownership state storage',
    active: true,
    replacedBy: 'Foundation activity read model (projection, not authority)',
    removalPrerequisite: 'projection replaces stateful ownership without behaviour change',
    disposition: 'remove',
  },
  {
    path: 'lib/ownership/transitions.ts',
    purpose: 'Legal ownership transitions',
    active: true,
    replacedBy: 'Lane 2 owns transitions; Foundation records them',
    removalPrerequisite: 'Lane 2 enforces transitions and emits each one',
    disposition: 'remove',
  },
  {
    path: 'lib/ownership/handback.ts',
    purpose: 'Handback execution',
    active: true,
    replacedBy: 'Lane 2 handoff runtime',
    removalPrerequisite: 'same evidence as chatwoot-handoff.ts',
    disposition: 'remove',
  },
  {
    path: 'lib/ownership/authorize.ts',
    purpose: 'Permission decisions — Foundation-owned logic living in a legacy folder',
    active: true,
    replacedBy: 'nothing; this is Foundation authority',
    removalPrerequisite: 'not removed — relocate to the permanent permission module',
    disposition: 'contract',
  },

  // ── Delivery mechanics ────────────────────────────────────────────────────
  {
    path: 'lib/inbound-dedup.ts',
    purpose: 'Duplicate inbound message suppression',
    active: true,
    replacedBy: 'Lane 2 transport dedup; Foundation dedups its own read model only',
    removalPrerequisite: 'Lane 2 guarantees at-most-once delivery of normalized events',
    disposition: 'remove',
  },
  {
    path: 'lib/escalation-intent.ts',
    purpose: 'AI suppression / escalation trigger detection',
    active: true,
    replacedBy: 'Lane 2 AI suppression',
    removalPrerequisite: 'Lane 2 suppresses AI and reports it as an ownership event',
    disposition: 'remove',
  },
  {
    path: 'lib/staff-ops/staff-channel.ts',
    purpose: 'Which channel a staff message goes out on',
    active: true,
    replacedBy: 'ChannelBinding read model + lane2.messaging.send.request@1',
    removalPrerequisite: 'channel selection resolved from ChannelBinding, not from transport code',
    disposition: 'remove',
  },

  // ── Clawith session runtime ───────────────────────────────────────────────
  {
    path: 'lib/staff-ops/staff-runtime-bridge.ts',
    purpose: 'Runs an internal staff Clawith turn over HTTP',
    active: true,
    replacedBy: 'lane2.agent.turn.request@1',
    removalPrerequisite: 'Lane 2 runs one internal staff turn with the Foundation governed envelope',
    disposition: 'remove',
  },
  {
    path: 'lib/clawith/client.ts',
    purpose: 'Structured Clawith transport',
    active: true,
    replacedBy: 'lane2.agent.turn.request@1',
    removalPrerequisite: 'same evidence as staff-runtime-bridge.ts',
    disposition: 'remove',
  },
  {
    path: 'lib/clawith/request.ts',
    purpose: 'Clawith request construction',
    active: true,
    replacedBy: 'lane2.agent.turn.request@1 request schema',
    removalPrerequisite: 'contract pack schema supersedes it',
    disposition: 'contract',
  },
  {
    path: 'lib/clawith/gate.ts',
    purpose: 'Per-number gate on Clawith routing',
    active: true,
    replacedBy: 'agent_exposure_policy + ChannelBinding classification',
    removalPrerequisite: 'exposure policy enforcing, not shadow',
    disposition: 'remove',
  },
  {
    path: 'lib/brain-provider.ts',
    purpose: 'Agent runtime selection and streaming reply',
    active: true,
    replacedBy: 'lane2.agent.turn.request@1',
    removalPrerequisite: 'Lane 2 answers one customer conversation end to end',
    disposition: 'remove',
  },
  {
    path: 'lib/connector.ts',
    purpose: 'Provider dispatch layer',
    active: true,
    replacedBy: 'lane2.messaging.send.request@1',
    removalPrerequisite: 'no permanent module resolves a provider through it',
    disposition: 'remove',
  },
  {
    path: 'lib/engines.ts',
    purpose: 'Engine registry binding provider implementations',
    active: true,
    replacedBy: 'lane2.messaging.send.request@1',
    removalPrerequisite: 'removed with connector.ts',
    disposition: 'remove',
  },
] as const

/**
 * Directories that are PERMANENT Foundation product code. Nothing here may import
 * a legacy module — that is the whole freeze, expressed as something a test can
 * fail on. Add new permanent modules here as they are built.
 */
export const PERMANENT_MODULE_ROOTS: readonly string[] = [
  'lib/channels',
  'lib/context',
  'lib/governed',
  'lib/events',
  'lib/legacy',
]

/** Hostnames and credential shapes that must never appear in a permanent module. */
export const FORBIDDEN_IN_PERMANENT_MODULES: readonly RegExp[] = [
  /graph\.facebook\.com/,
  /agents\.epic\.dm/,
  /bff\.epic\.dm/,
  /inbox\.epic\.dm\/api/,
  /process\.env\.[A-Z_]*(TOKEN|SECRET|API_KEY|ACCESS_KEY)/,
]

export const LEGACY_PATHS: readonly string[] = LEGACY_COMMUNICATIONS.map((m) => m.path)
