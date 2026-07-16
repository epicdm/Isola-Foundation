/**
 * lib/voice-provisioning.ts — idempotent state machine that provisions a
 * Magnus voice/PBX stack: user → SIP account → DID (draw + claim + route) →
 * caller-ID. Each step only runs if its Magnus id isn't already persisted on
 * the VoiceLine row, so re-running on an already-provisioned (or
 * partially-provisioned) line is always a safe no-op / resume.
 *
 * Phase C: converged onto ONE path — `provisionVoiceLine()` — shared by both
 * the business/Tenant realm (this file's `provisionTenantVoice()` wrapper)
 * and the consumer/EMA realm (voice-provisioning-consumer.ts's
 * `provisionConsumerVoice()` wrapper). State now persists on the `VoiceLine`
 * table (found/created by tenant_id for business, identity_id for consumer)
 * instead of directly on Tenant/ConsumerAccount — Phase D cleanup folded in:
 * neither model's duplicated `magnus_*`/`voice_*` columns are written by
 * provisioning anymore.
 *
 * NOTE on step order vs. the original brief: the brief lists "create SIP →
 * create caller-ID → draw DID" — but a caller-ID is only meaningful once a
 * real DID number exists (Magnus's `callerid.cid` is the number itself), so
 * caller-ID creation runs AFTER the DID is drawn and claimed, using that DID
 * as its `cid`. The SIP account is still created before the DID, and its
 * caller-ID fields are patched in once the DID exists. Every other primitive
 * matches the brief exactly.
 */

import { prisma } from './prisma';
import { getMagnusConfig, isMagnusConfigured } from './engines';
import {
  genMagnusUsername,
  genConsumerMagnusUsername,
  createMagnusUser,
  createSipAccount,
  patchSipCallerId,
  createCallerId,
  drawAvailableDid,
  claimDid,
  createDidDestinationToSip,
  readSipAccount,
  findDidByNumber,
  findDidDestinationForSip,
  findCallerIdByCid,
  readUserPrefixLocal,
  patchUserPrefixLocal,
  readDidDestination,
  setDidDestinationRoute,
  DOMINICA_LOCAL_PREFIX_RULES,
  enforceSipSecret,
} from './magnus-voice';
import type { MagnusConfig } from '@/engines/magnus';
import type { VoiceLine } from '@prisma/client';
import crypto from 'node:crypto';

export interface VoiceProvisioningResult {
  state: string;
  error: string | null;
  magnus_user_id: string | null;
  magnus_sip_id: string | null;
  magnus_sip_username: string | null;
  magnus_did_id: string | null;
  magnus_did_number: string | null;
  magnus_diddestination_id: string | null;
  magnus_callerid_id: string | null;
}

export function toVoiceProvisioningResult(line: VoiceLine): VoiceProvisioningResult {
  return {
    state: line.provisioning_state,
    error: line.provisioning_error,
    magnus_user_id: line.magnus_user_id,
    magnus_sip_id: line.magnus_sip_id,
    magnus_sip_username: line.magnus_sip_username,
    magnus_did_id: line.magnus_did_id,
    magnus_did_number: line.magnus_did_number,
    magnus_diddestination_id: line.magnus_diddestination_id,
    magnus_callerid_id: line.magnus_callerid_id,
  };
}

export interface ProvisionVoiceLineParams {
  /** Magnus `user.description` — free text, used for at-a-glance ownership on the Magnus grid. */
  description: string;
  /** Seed for genMagnusUsername-style naming (tenantId for business, identityId for consumer). */
  usernameSeed: string;
  usernamePrefix: 'ep_' | 'ema_';
  /**
   * Consumer-only hook: fired once, right after Step 1 resolves/creates the
   * Magnus user id (persisted onto the VoiceLine row already), before Step 2
   * (SIP account) runs. Lets the consumer wrapper mirror the id onto the
   * Wallet and apply the one-time starter grant at the exact point in the
   * step order the pre-convergence code did.
   */
  onMagnusUserResolved?: (magnusUserId: string) => Promise<void>;
}

function genUsername(seed: string, prefix: 'ep_' | 'ema_'): string {
  return prefix === 'ep_' ? genMagnusUsername(seed) : genConsumerMagnusUsername(seed);
}

/**
 * The ONE Magnus voice-line provisioning path. Operates entirely on a
 * `VoiceLine` row (identified by `voiceLineId`) — callers are responsible for
 * finding-or-creating that row (by tenant_id or identity_id) before calling
 * this, and for running any owner-kind-specific steps around it (starter
 * grant, BFF mirror) via `onMagnusUserResolved` or after this returns.
 */
export async function provisionVoiceLine(
  voiceLineId: string,
  config: MagnusConfig,
  params: ProvisionVoiceLineParams,
): Promise<VoiceLine> {
  let line = await prisma.voiceLine.findUniqueOrThrow({ where: { id: voiceLineId } });

  line = await prisma.voiceLine.update({
    where: { id: voiceLineId },
    data: { provisioning_state: 'pending', provisioning_error: null },
  });

  try {
    // Step 1: Magnus user (reuse if already linked, e.g. from wallet setup).
    let magnusUserId = line.magnus_user_id;
    if (!magnusUserId) {
      const username = genUsername(params.usernameSeed, params.usernamePrefix);
      const password = crypto.randomBytes(9).toString('base64url').slice(0, 12);
      magnusUserId = await createMagnusUser(config, {
        username,
        password,
        description: params.description,
      });
      line = await prisma.voiceLine.update({
        where: { id: voiceLineId },
        data: { magnus_user_id: magnusUserId },
      });
    }
    if (params.onMagnusUserResolved) {
      await params.onMagnusUserResolved(magnusUserId!);
    }

    // Step 1b: local-dialing prefix rules — verified live: every correctly
    // configured Magnus account carries the SAME two static rules on
    // `user.prefix_local` ("*/1767/7,767/1767/10"), which normalize local
    // 7-digit and 767-prefixed dialing to full E.164 (1767xxxxxxx). Without
    // them, outbound calls to local Dominica numbers have no route. This
    // isn't tracked in our own DB — Magnus's live `user.prefix_local` is the
    // only source of truth — so always reconcile against it, only issuing a
    // write when the live value doesn't already match (idempotent: re-running
    // provisioning on an already-correct account is a pure no-op read).
    const livePrefixLocal = await readUserPrefixLocal(config, magnusUserId!);
    if (livePrefixLocal !== null && livePrefixLocal !== DOMINICA_LOCAL_PREFIX_RULES) {
      await patchUserPrefixLocal(config, magnusUserId!, DOMINICA_LOCAL_PREFIX_RULES);
    }

    // Step 2: SIP account — create if missing; if it already exists, always
    // resync the owner-facing username/password from the LIVE Magnus record
    // rather than trusting whatever is cached on the VoiceLine row. Magnus's
    // `sip.secret` is the actual credential the softphone must authenticate
    // with — a locally-cached password that no longer matches it would
    // silently render a QR code the owner's phone can never register with.
    let sipId = line.magnus_sip_id;
    let sipUsername = line.magnus_sip_username;
    let sipPassword = line.magnus_sip_password;
    let liveSip: Awaited<ReturnType<typeof readSipAccount>> = null;
    if (!sipId) {
      sipUsername = genUsername(params.usernameSeed, params.usernamePrefix);
      sipPassword = crypto.randomBytes(9).toString('base64url').slice(0, 12);
      sipId = await createSipAccount(config, { id_user: magnusUserId!, name: sipUsername, secret: sipPassword });
      line = await prisma.voiceLine.update({
        where: { id: voiceLineId },
        data: { magnus_sip_id: sipId, magnus_sip_username: sipUsername, magnus_sip_password: sipPassword },
      });
    } else {
      liveSip = await readSipAccount(config, sipId);
      if (liveSip) {
        // Username: adopt Magnus's live value only if we don't already have
        // one locally (legacy backfill case) — otherwise the locally-stored
        // value is authoritative, same as the password below.
        const nextUsername = line.magnus_sip_username || liveSip.name || sipUsername;
        if (nextUsername !== line.magnus_sip_username) {
          sipUsername = nextUsername;
          line = await prisma.voiceLine.update({
            where: { id: voiceLineId },
            data: { magnus_sip_username: sipUsername },
          });
        }

        // Password: the Acrobits CSC link already handed to the owner
        // carries whatever is in line.magnus_sip_password — THAT is the
        // single source of truth. If Magnus's live secret has drifted from
        // it, force Magnus back into line rather than adopting Magnus's
        // value, which would silently orphan the credential already in use.
        if (sipPassword && liveSip.secret !== sipPassword) {
          await enforceSipSecret(config, sipId, sipPassword);
        } else if (!sipPassword && liveSip.secret) {
          // No locally-stored password at all (legacy row) — adopt Magnus's
          // as a one-time backfill; there's nothing else to be authoritative.
          sipPassword = liveSip.secret;
          line = await prisma.voiceLine.update({
            where: { id: voiceLineId },
            data: { magnus_sip_password: sipPassword },
          });
        }
      }
    }

    // Step 3: DID — draw/claim/route only if this SIP extension has NOTHING
    // wired up yet. If it already has a DID stamped as its caller-ID (the
    // canonical "currently active" number for that extension, per
    // `patchSipCallerId`'s convention), reconcile the VoiceLine row to match
    // that instead of trusting a possibly-stale/duplicate id — this repairs
    // drift left over from any earlier partial or double-run without ever
    // drawing/claiming a brand-new DID or creating a second diddestination.
    let didId = line.magnus_did_id;
    let didNumber = line.magnus_did_number;
    let diddestinationId = line.magnus_diddestination_id;

    if (!liveSip) liveSip = await readSipAccount(config, sipId!);
    const canonicalDidNumber = liveSip?.cid_number || liveSip?.callerid || null;

    if (canonicalDidNumber) {
      if (didNumber !== canonicalDidNumber || !didId || !diddestinationId) {
        const didRow = await findDidByNumber(config, canonicalDidNumber);
        const destRow = await findDidDestinationForSip(config, sipId!, didRow?.id ?? null);
        didId = didRow?.id ?? didId;
        didNumber = didRow?.did ?? canonicalDidNumber;
        diddestinationId = destRow?.id ?? diddestinationId;
        line = await prisma.voiceLine.update({
          where: { id: voiceLineId },
          data: {
            magnus_did_id: didId,
            magnus_did_number: didNumber,
            magnus_diddestination_id: diddestinationId,
          },
        });
      }
    } else if (!didId || !diddestinationId) {
      // Nothing wired to this extension at all yet — first-time draw/claim/route.
      const drawn = await drawAvailableDid(config);
      didNumber = await claimDid(config, drawn.id, magnusUserId!);
      didId = drawn.id;
      diddestinationId = await createDidDestinationToSip(config, {
        id_did: didId,
        id_user: magnusUserId!,
        id_sip: sipId!,
        sipUsername: sipUsername!,
      });
      line = await prisma.voiceLine.update({
        where: { id: voiceLineId },
        data: {
          magnus_did_id: didId,
          magnus_did_number: didNumber,
          magnus_diddestination_id: diddestinationId,
          voice_forward_to_cell: false,
        },
      });
      // Now that the DID is known, stamp it onto the SIP account's caller-ID.
      await patchSipCallerId(config, sipId!, didNumber!);
    }

    // Step 3b: EXTENSION-FIRST reconciliation. Ringing the SIP extension is
    // the default; forwarding to the owner's cell is only an opt-in override
    // (`VoiceLine.voice_forward_to_cell`), never the default. Magnus's live
    // `diddestination.destination` is the actual routing source of truth and
    // can drift from that flag (e.g. a row created before this fix shipped,
    // or an interrupted forward-toggle write) — always reconcile it here,
    // not just at creation time, so re-running provisioning on an
    // already-provisioned line repairs a wrongly-PSTN-routed DID too.
    if (diddestinationId) {
      const liveDest = await readDidDestination(config, diddestinationId);
      if (liveDest) {
        // Live-verified 2026-07-12: `destination === ''` alone is NOT
        // sufficient to confirm extension-first routing — a row can have an
        // empty destination yet still have `voip_call !== '1'` (the actual
        // bug this file shipped with for several rounds; see diddestination
        // 2592 for a live wrong-form example: voip_call='0' + non-empty
        // destination). Both fields must be correct.
        const isCurrentlySip = liveDest.destination === '' && liveDest.voip_call === '1';
        const wantsCellForward = !!line.voice_forward_to_cell && !!line.voice_cell_number;
        if (!wantsCellForward && !isCurrentlySip) {
          // Default path: not opted into cell-forward, but Magnus isn't
          // routing to the SIP extension — fix it.
          await setDidDestinationRoute(config, diddestinationId, { mode: 'sip' });
        } else if (wantsCellForward && isCurrentlySip) {
          // Owner has cell-forward enabled but Magnus still rings the SIP
          // extension — bring it in line with their preference.
          await setDidDestinationRoute(config, diddestinationId, { mode: 'cell', cellNumber: line.voice_cell_number! });
        }
      }
    }

    // Step 4: caller-ID entry, using the DID as the caller-ID number. Always
    // resolve against whichever `callerid` row Magnus already has for the
    // *current* canonical DID (reusing it if found — never creating a
    // duplicate) rather than trusting the previously-cached id, since step 3
    // may have just switched `didNumber` to a different (correct) DID.
    let calleridId = line.magnus_callerid_id;
    const existingCallerId = didNumber ? await findCallerIdByCid(config, didNumber) : null;
    const resolvedCallerId = existingCallerId?.id ?? null;
    if (resolvedCallerId ? resolvedCallerId !== calleridId : !calleridId) {
      calleridId = resolvedCallerId ?? (await createCallerId(config, { id_user: magnusUserId!, cid: didNumber! }));
      line = await prisma.voiceLine.update({
        where: { id: voiceLineId },
        data: { magnus_callerid_id: calleridId },
      });
    }

    line = await prisma.voiceLine.update({
      where: { id: voiceLineId },
      data: { provisioning_state: 'completed', provisioning_error: null },
    });

    return line;
  } catch (e: any) {
    const message = e?.message ?? String(e);
    line = await prisma.voiceLine.update({
      where: { id: voiceLineId },
      data: { provisioning_state: 'failed', provisioning_error: message },
    });
    return line;
  }
}

/** Finds the business VoiceLine for a tenant, creating it if missing. */
export async function getOrCreateBusinessVoiceLine(tenantId: string): Promise<VoiceLine> {
  const existing = await prisma.voiceLine.findFirst({ where: { tenant_id: tenantId, owner_kind: 'business' } });
  if (existing) return existing;
  return prisma.voiceLine.create({ data: { owner_kind: 'business', tenant_id: tenantId } });
}

/** Business/Tenant wrapper around provisionVoiceLine() — stable name/signature/result shape for existing call sites. */
export async function provisionTenantVoice(tenantId: string): Promise<VoiceProvisioningResult> {
  if (!isMagnusConfigured()) {
    throw new Error('Magnus not configured — set MAGNUS_URL, MAGNUS_API_KEY, MAGNUS_API_SECRET');
  }
  const config = getMagnusConfig();

  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, include: { wallet: true } });
  if (!tenant) throw new Error('Tenant not found');

  const voiceLine = await getOrCreateBusinessVoiceLine(tenantId);

  const result = await provisionVoiceLine(voiceLine.id, config, {
    description: `ISOLA_TENANT_PBX:${tenant.business_name}`,
    usernameSeed: tenantId,
    usernamePrefix: 'ep_',
    onMagnusUserResolved: async (magnusUserId) => {
      // Mirror onto the wallet too if it doesn't have its own Magnus link yet —
      // they're the same Magnus billing entity, and wallet balance/CDR reads
      // key off wallet.magnus_user_id.
      if (tenant.wallet && !tenant.wallet.magnus_user_id) {
        await prisma.wallet.update({ where: { tenant_id: tenantId }, data: { magnus_user_id: magnusUserId } });
      }
    },
  });

  return toVoiceProvisioningResult(result);
}
