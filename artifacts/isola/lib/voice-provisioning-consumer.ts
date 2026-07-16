/**
 * lib/voice-provisioning-consumer.ts — EMA consumer wrapper around the
 * shared `provisionVoiceLine()` core in lib/voice-provisioning.ts. Phase C:
 * the consumer voice line is identity-anchored (VoiceLine.identity_id, not
 * ConsumerAccount.id) — the phone-anchored Identity is resolved/created via
 * getOrCreateIdentityByPhone() same as every other consumer-realm lookup.
 *
 * Deliberately does NOT touch: Tenant, the agent/webhook/agent-tools
 * adapter, brain-provider switching, act-as/session, or any admin/owner UI.
 */

import { prisma } from './prisma';
import { getMagnusConfig, isMagnusConfigured, getBffConfig, isBffConfigured } from './engines';
import { addCredit } from '@/engines/magnus';
import { mirrorAccount } from '@/engines/bff';
import { getOrCreateIdentityByPhone } from './identity';
import { MAGNUS_REGISTRATION_SERVER } from './magnus-voice';
import { provisionVoiceLine, toVoiceProvisioningResult } from './voice-provisioning';
import type { VoiceLine } from '@prisma/client';

// ── Launch hook: "15 free minutes" starter grant ──────────────────────────
// One config constant, trivially adjustable. EC$2.05 = 15 min × EC$0.135/min
// (the live Dominica rate — see `rate` module, id_plan 34 EMA_Basic, prefix
// 1767), rounded up to the nearest cent (2.025 → 2.05) so the grant always
// covers at least a full 15 minutes rather than slightly under.
export const STARTER_FREE_EC = 2.05;
// Distinct WalletTxn.type used ONLY as the one-time idempotency marker for
// this grant — its mere existence for an identity_id means "already
// granted," so re-provisioning (or any other retry of this function) never
// re-grants. Not a request_id/dispatch-key pattern like the admin credit
// route: this fires at most once per identity's entire lifetime, not once
// per user-initiated request.
const STARTER_GRANT_TXN_TYPE = 'starter_grant';

export interface ConsumerVoiceProvisioningResult {
  state: string;
  error: string | null;
  magnus_user_id: string | null;
  magnus_sip_id: string | null;
  magnus_sip_username: string | null;
  magnus_sip_password: string | null;
  magnus_did_id: string | null;
  magnus_did_number: string | null;
  magnus_diddestination_id: string | null;
  magnus_callerid_id: string | null;
  registration_server: string;
}

function toConsumerResult(line: VoiceLine): ConsumerVoiceProvisioningResult {
  return {
    ...toVoiceProvisioningResult(line),
    magnus_sip_password: line.magnus_sip_password,
    registration_server: MAGNUS_REGISTRATION_SERVER,
  };
}

/** Finds the consumer VoiceLine for an identity, creating it if missing. */
async function getOrCreateConsumerVoiceLine(identityId: string): Promise<VoiceLine> {
  const existing = await prisma.voiceLine.findFirst({ where: { identity_id: identityId, owner_kind: 'consumer' } });
  if (existing) return existing;
  return prisma.voiceLine.create({ data: { owner_kind: 'consumer', identity_id: identityId } });
}

export async function provisionConsumerVoice(consumerAccountId: string): Promise<ConsumerVoiceProvisioningResult> {
  if (!isMagnusConfigured()) {
    throw new Error('Magnus not configured — set MAGNUS_URL, MAGNUS_API_KEY, MAGNUS_API_SECRET');
  }
  const config = getMagnusConfig();

  const consumer = await prisma.consumerAccount.findUnique({ where: { id: consumerAccountId } });
  if (!consumer) throw new Error('ConsumerAccount not found');

  const identity = await getOrCreateIdentityByPhone(consumer.phone_number, consumer.display_name);

  // Step 0: wallet — every consumer needs one to bill against. Create it
  // up front (before Magnus user id is known) so it exists even if a later
  // step throws. Still keyed by consumer_account_id (ConsumerAccount remains
  // the billing-owner record) but also linked by identity_id, per the same
  // dual-link convention the Phase B backfill established.
  let wallet = await prisma.wallet.findUnique({ where: { consumer_account_id: consumerAccountId } });
  if (!wallet) {
    wallet = await prisma.wallet.create({
      data: { consumer_account_id: consumerAccountId, identity_id: identity.id, balance_cache: 0, balance_minor: 0 },
    });
  } else if (!wallet.identity_id) {
    wallet = await prisma.wallet.update({ where: { id: wallet.id }, data: { identity_id: identity.id } });
  }

  const voiceLine = await getOrCreateConsumerVoiceLine(identity.id);

  const result = await provisionVoiceLine(voiceLine.id, config, {
    description: `EMA_CONSUMER:${consumer.display_name ?? consumer.phone_number}`,
    usernameSeed: identity.id,
    usernamePrefix: 'ema_',
    onMagnusUserResolved: async (magnusUserId) => {
      if (wallet && !wallet.magnus_user_id) {
        wallet = await prisma.wallet.update({ where: { id: wallet!.id }, data: { magnus_user_id: magnusUserId } });
      }

      // Step 1c: "15 free minutes" starter grant — launch hook. Exactly once
      // per identity, ever. Guarded on a WalletTxn row rather than a
      // retryable request_id: this is a system-fired one-time event, not a
      // user action, so "does a starter_grant WalletTxn already exist for
      // this identity" is itself the idempotency check. Magnus-before-ledger,
      // same money-safety contract as the admin credit route: only write the
      // local ledger/balance once the Magnus refill call actually succeeds.
      // A failure here is logged and swallowed (no WalletTxn written) rather
      // than failing the whole provisioning run — the next provisioning
      // attempt will retry it, and a promo credit failing must never block
      // getting the account a working SIP/DID setup.
      const existingGrant = await prisma.walletTxn.findFirst({
        where: { identity_id: identity.id, type: STARTER_GRANT_TXN_TYPE },
      });
      if (existingGrant) return;

      const grantResult = await addCredit(config, magnusUserId, STARTER_FREE_EC, 'EMA starter grant — 15 free minutes');
      if (!grantResult.success) {
        console.error(
          `[voice-provisioning-consumer] starter grant FAILED identity=${identity.id} magnus_user_id=${magnusUserId}: ${grantResult.error}`,
        );
        return;
      }

      const grantAmountMinor = Math.round(STARTER_FREE_EC * 100);
      const [, updatedWallet] = await prisma.$transaction([
        prisma.walletTxn.create({
          data: {
            consumer_account_id: consumerAccountId,
            identity_id: identity.id,
            wallet_id: wallet!.id,
            type: STARTER_GRANT_TXN_TYPE,
            amount_usd: STARTER_FREE_EC,
            amount_minor: grantAmountMinor,
            currency: 'EC$',
            // Once-per-identity-ever key — mirrors the existingGrant guard
            // above as an additional DB-level (unique constraint) backstop.
            idempotency_key: `starter_grant:${identity.id}`,
            description: 'Starter grant — 15 free minutes (launch promo)',
            ref: 'system:starter_grant',
          },
        }),
        prisma.wallet.update({
          where: { id: wallet!.id },
          data: { balance_cache: { increment: STARTER_FREE_EC }, balance_minor: { increment: grantAmountMinor } },
        }),
      ]);
      console.log(
        `[voice-provisioning-consumer] starter grant applied identity=${identity.id} amount=${STARTER_FREE_EC} new_balance_cache=${updatedWallet.balance_cache}`,
      );
    },
  });

  // Step 5: mirror the finished account (final SIP creds + DID + owner
  // phone) into the BFF Lite payment rails so it can identify who is paying
  // for top-ups without re-deriving Magnus state itself. Idempotent upsert
  // on the BFF side — safe to call on every provisioning run. Non-fatal: a
  // BFF outage must never block getting the account a working SIP/DID setup.
  if (
    result.provisioning_state === 'completed' &&
    isBffConfigured() &&
    result.magnus_user_id &&
    result.magnus_sip_username &&
    result.magnus_sip_password &&
    result.magnus_did_number
  ) {
    try {
      const mirrorResult = await mirrorAccount(getBffConfig(), {
        magnusUserId: result.magnus_user_id,
        sipUsername: result.magnus_sip_username,
        sipPassword: result.magnus_sip_password,
        did: result.magnus_did_number,
        ownerPhone: consumer.phone_number,
      });
      if (mirrorResult.ok) {
        console.log(
          `[voice-provisioning-consumer] BFF mirror-account ok identity=${identity.id} created=${!!mirrorResult.created} updated=${!!mirrorResult.updated}`,
        );
      } else {
        console.error(`[voice-provisioning-consumer] BFF mirror-account FAILED identity=${identity.id}: ${mirrorResult.error}`);
      }
    } catch (e: any) {
      console.error(`[voice-provisioning-consumer] BFF mirror-account error identity=${identity.id}:`, e?.message ?? e);
    }
  }

  return toConsumerResult(result);
}
