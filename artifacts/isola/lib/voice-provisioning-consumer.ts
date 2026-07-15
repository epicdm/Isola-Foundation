/**
 * lib/voice-provisioning-consumer.ts — EMA consumer variant of
 * lib/voice-provisioning.ts. Same idempotent step-machine discipline
 * (Magnus user → prefix_local reconciliation → SIP account → DID
 * draw/claim/route → extension-first reconciliation → caller-ID), persisted
 * to `ConsumerAccount` instead of `Tenant`.
 *
 * Deliberately does NOT touch: Tenant, the agent/webhook/agent-tools
 * adapter, brain-provider switching, act-as/session, or any admin/owner UI.
 * Reuses lib/magnus-voice.ts primitives as-is (createMagnusUser already
 * hardcodes id_group='3', id_plan='34' "EMA_Basic" — no change needed there
 * for the consumer path since that's the exact plan requested).
 */

import { prisma } from './prisma';
import { getMagnusConfig, isMagnusConfigured, getBffConfig, isBffConfigured } from './engines';
import { addCredit } from '@/engines/magnus';
import { mirrorAccount } from '@/engines/bff';
import {
  genMagnusUsername,
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
  MAGNUS_REGISTRATION_SERVER,
  enforceSipSecret,
} from './magnus-voice';
import crypto from 'node:crypto';

// ── Launch hook: "15 free minutes" starter grant ──────────────────────────
// One config constant, trivially adjustable. EC$2.05 = 15 min × EC$0.135/min
// (the live Dominica rate — see `rate` module, id_plan 34 EMA_Basic, prefix
// 1767), rounded up to the nearest cent (2.025 → 2.05) so the grant always
// covers at least a full 15 minutes rather than slightly under.
export const STARTER_FREE_EC = 2.05;
// Distinct WalletTxn.type used ONLY as the one-time idempotency marker for
// this grant — its mere existence for a consumer_account_id means "already
// granted," so re-provisioning (or any other retry of this function) never
// re-grants. Not a request_id/dispatch-key pattern like the admin credit
// route: this fires at most once per account's entire lifetime, not once
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

function toResult(c: {
  voice_provisioning_state: string;
  voice_provisioning_error: string | null;
  magnus_user_id: string | null;
  magnus_sip_id: string | null;
  magnus_sip_username: string | null;
  magnus_sip_password: string | null;
  magnus_did_id: string | null;
  magnus_did_number: string | null;
  magnus_diddestination_id: string | null;
  magnus_callerid_id: string | null;
}): ConsumerVoiceProvisioningResult {
  return {
    state: c.voice_provisioning_state,
    error: c.voice_provisioning_error,
    magnus_user_id: c.magnus_user_id,
    magnus_sip_id: c.magnus_sip_id,
    magnus_sip_username: c.magnus_sip_username,
    magnus_sip_password: c.magnus_sip_password,
    magnus_did_id: c.magnus_did_id,
    magnus_did_number: c.magnus_did_number,
    magnus_diddestination_id: c.magnus_diddestination_id,
    magnus_callerid_id: c.magnus_callerid_id,
    registration_server: MAGNUS_REGISTRATION_SERVER,
  };
}

/** Same naming convention as genMagnusUsername, but for consumer ids — kept
 *  as a distinct helper (rather than reusing genMagnusUsername's `ep_`
 *  prefix, which is reserved for business-tenant PBX accounts) so a live
 *  Magnus grid listing can tell tenants and EMA consumers apart at a glance. */
function genConsumerMagnusUsername(consumerAccountId: string): string {
  return `ema_${consumerAccountId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 16).toLowerCase()}`;
}

export async function provisionConsumerVoice(consumerAccountId: string): Promise<ConsumerVoiceProvisioningResult> {
  if (!isMagnusConfigured()) {
    throw new Error('Magnus not configured — set MAGNUS_URL, MAGNUS_API_KEY, MAGNUS_API_SECRET');
  }
  const config = getMagnusConfig();

  let consumer = await prisma.consumerAccount.findUnique({ where: { id: consumerAccountId }, include: { wallet: true } });
  if (!consumer) throw new Error('ConsumerAccount not found');

  await prisma.consumerAccount.update({
    where: { id: consumerAccountId },
    data: { voice_provisioning_state: 'pending', voice_provisioning_error: null },
  });

  try {
    // Step 0: wallet — every consumer needs one to bill against. Create it
    // up front (before Magnus user id is known) so it exists even if a later
    // step throws; the Magnus link gets mirrored onto it in step 1 like the
    // tenant path does.
    if (!consumer.wallet) {
      await prisma.wallet.create({
        data: { consumer_account_id: consumerAccountId, balance_cache: 0 },
      });
      consumer = await prisma.consumerAccount.findUniqueOrThrow({
        where: { id: consumerAccountId },
        include: { wallet: true },
      });
    }

    // Step 1: Magnus user (reuse if already linked).
    let magnusUserId = consumer.magnus_user_id;
    if (!magnusUserId) {
      const username = genConsumerMagnusUsername(consumer.id);
      const password = crypto.randomBytes(9).toString('base64url').slice(0, 12);
      magnusUserId = await createMagnusUser(config, {
        username,
        password,
        description: `EMA_CONSUMER:${consumer.display_name ?? consumer.phone_number}`,
      });
      consumer = await prisma.consumerAccount.update({
        where: { id: consumerAccountId },
        data: { magnus_user_id: magnusUserId },
        include: { wallet: true },
      });
      if (consumer.wallet && !consumer.wallet.magnus_user_id) {
        await prisma.wallet.update({
          where: { consumer_account_id: consumerAccountId },
          data: { magnus_user_id: magnusUserId },
        });
      }
    }

    // Step 1b: local-dialing prefix rules — same Dominica convention as the
    // tenant path (reconciled against live Magnus, not tracked locally).
    const livePrefixLocal = await readUserPrefixLocal(config, magnusUserId!);
    if (livePrefixLocal !== null && livePrefixLocal !== DOMINICA_LOCAL_PREFIX_RULES) {
      await patchUserPrefixLocal(config, magnusUserId!, DOMINICA_LOCAL_PREFIX_RULES);
    }

    // Step 1c: "15 free minutes" starter grant — launch hook. Exactly once
    // per account, ever. Guarded on a WalletTxn row rather than a retryable
    // request_id: this is a system-fired one-time event, not a user action,
    // so "does a starter_grant WalletTxn already exist for this account" is
    // itself the idempotency check. Magnus-before-ledger, same money-safety
    // contract as the admin credit route: only write the local ledger/balance
    // once the Magnus refill call actually succeeds. A failure here is
    // logged and swallowed (no WalletTxn written) rather than failing the
    // whole provisioning run — the next provisioning attempt will retry it,
    // and a promo credit failing must never block getting the account a
    // working SIP/DID setup.
    if (consumer.wallet) {
      const existingGrant = await prisma.walletTxn.findFirst({
        where: { consumer_account_id: consumerAccountId, type: STARTER_GRANT_TXN_TYPE },
      });
      if (!existingGrant) {
        const grantResult = await addCredit(
          config,
          magnusUserId!,
          STARTER_FREE_EC,
          'EMA starter grant — 15 free minutes',
        );
        if (grantResult.success) {
          const [, updatedWallet] = await prisma.$transaction([
            prisma.walletTxn.create({
              data: {
                consumer_account_id: consumerAccountId,
                wallet_id: consumer.wallet.id,
                type: STARTER_GRANT_TXN_TYPE,
                amount_usd: STARTER_FREE_EC,
                description: 'Starter grant — 15 free minutes (launch promo)',
                ref: 'system:starter_grant',
              },
            }),
            prisma.wallet.update({
              where: { id: consumer.wallet.id },
              data: { balance_cache: { increment: STARTER_FREE_EC } },
            }),
          ]);
          consumer = await prisma.consumerAccount.findUniqueOrThrow({
            where: { id: consumerAccountId },
            include: { wallet: true },
          });
          console.log(
            `[voice-provisioning-consumer] starter grant applied consumer=${consumerAccountId} amount=${STARTER_FREE_EC} new_balance_cache=${updatedWallet.balance_cache}`,
          );
        } else {
          console.error(
            `[voice-provisioning-consumer] starter grant FAILED consumer=${consumerAccountId} magnus_user_id=${magnusUserId}: ${grantResult.error}`,
          );
        }
      }
    }

    // Step 2: SIP account — create if missing; else resync owner-facing
    // credentials from the live Magnus record.
    let sipId = consumer.magnus_sip_id;
    let sipUsername = consumer.magnus_sip_username;
    let sipPassword = consumer.magnus_sip_password;
    let liveSip: Awaited<ReturnType<typeof readSipAccount>> = null;
    if (!sipId) {
      sipUsername = genConsumerMagnusUsername(consumer.id);
      sipPassword = crypto.randomBytes(9).toString('base64url').slice(0, 12);
      sipId = await createSipAccount(config, { id_user: magnusUserId!, name: sipUsername, secret: sipPassword });
      consumer = await prisma.consumerAccount.update({
        where: { id: consumerAccountId },
        data: { magnus_sip_id: sipId, magnus_sip_username: sipUsername, magnus_sip_password: sipPassword },
        include: { wallet: true },
      });
    } else {
      liveSip = await readSipAccount(config, sipId);
      if (liveSip) {
        // Username: adopt Magnus's live value only if we don't already have
        // one locally (legacy backfill case) — otherwise the locally-stored
        // value is authoritative, same as the password below.
        const nextUsername = consumer.magnus_sip_username || liveSip.name || sipUsername;
        if (nextUsername !== consumer.magnus_sip_username) {
          sipUsername = nextUsername;
          consumer = await prisma.consumerAccount.update({
            where: { id: consumerAccountId },
            data: { magnus_sip_username: sipUsername },
            include: { wallet: true },
          });
        }

        // Password: the Acrobits CSC link the user already scanned carries
        // whatever is in consumer.magnus_sip_password — THAT is the single
        // source of truth. If Magnus's live secret has drifted from it
        // (e.g. the create-time quirk handled in enforceSipSecret, or a
        // manual change), force Magnus back into line rather than adopting
        // Magnus's value, which would silently orphan the credential the
        // user's phone already has.
        if (sipPassword && liveSip.secret !== sipPassword) {
          await enforceSipSecret(config, sipId, sipPassword);
        } else if (!sipPassword && liveSip.secret) {
          // No locally-stored password at all (legacy row) — adopt Magnus's
          // as a one-time backfill; there's nothing else to be authoritative.
          sipPassword = liveSip.secret;
          consumer = await prisma.consumerAccount.update({
            where: { id: consumerAccountId },
            data: { magnus_sip_password: sipPassword },
            include: { wallet: true },
          });
        }
      }
    }

    // Step 3: DID — draw/claim/route only if this SIP extension has nothing
    // wired up yet; otherwise reconcile from whatever Magnus already has.
    let didId = consumer.magnus_did_id;
    let didNumber = consumer.magnus_did_number;
    let diddestinationId = consumer.magnus_diddestination_id;

    if (!liveSip) liveSip = await readSipAccount(config, sipId!);
    const canonicalDidNumber = liveSip?.cid_number || liveSip?.callerid || null;

    if (canonicalDidNumber) {
      if (didNumber !== canonicalDidNumber || !didId || !diddestinationId) {
        const didRow = await findDidByNumber(config, canonicalDidNumber);
        const destRow = await findDidDestinationForSip(config, sipId!, didRow?.id ?? null);
        didId = didRow?.id ?? didId;
        didNumber = didRow?.did ?? canonicalDidNumber;
        diddestinationId = destRow?.id ?? diddestinationId;
        consumer = await prisma.consumerAccount.update({
          where: { id: consumerAccountId },
          data: {
            magnus_did_id: didId,
            magnus_did_number: didNumber,
            magnus_diddestination_id: diddestinationId,
          },
          include: { wallet: true },
        });
      }
    } else if (!didId || !diddestinationId) {
      // First-time draw/claim/route from the 1767818XXXX pool.
      const drawn = await drawAvailableDid(config);
      didNumber = await claimDid(config, drawn.id, magnusUserId!);
      didId = drawn.id;
      diddestinationId = await createDidDestinationToSip(config, {
        id_did: didId,
        id_user: magnusUserId!,
        id_sip: sipId!,
        sipUsername: sipUsername!,
      });
      consumer = await prisma.consumerAccount.update({
        where: { id: consumerAccountId },
        data: {
          magnus_did_id: didId,
          magnus_did_number: didNumber,
          magnus_diddestination_id: diddestinationId,
          voice_forward_to_cell: false,
        },
        include: { wallet: true },
      });
      await patchSipCallerId(config, sipId!, didNumber!);
    }

    // Step 3b: EXTENSION-FIRST reconciliation — same discipline as the
    // tenant path (voip_call='1' + empty destination, matching reference
    // diddestination 2565), reconciled every run, not just at creation time.
    if (diddestinationId) {
      const liveDest = await readDidDestination(config, diddestinationId);
      if (liveDest) {
        const isCurrentlySip = liveDest.destination === '' && liveDest.voip_call === '1';
        const wantsCellForward = !!consumer.voice_forward_to_cell && !!consumer.voice_cell_number;
        if (!wantsCellForward && !isCurrentlySip) {
          await setDidDestinationRoute(config, diddestinationId, { mode: 'sip' });
        } else if (wantsCellForward && isCurrentlySip) {
          await setDidDestinationRoute(config, diddestinationId, { mode: 'cell', cellNumber: consumer.voice_cell_number! });
        }
      }
    }

    // Step 4: caller-ID entry, using the DID as the caller-ID number.
    let calleridId = consumer.magnus_callerid_id;
    const existingCallerId = didNumber ? await findCallerIdByCid(config, didNumber) : null;
    const resolvedCallerId = existingCallerId?.id ?? null;
    if (resolvedCallerId ? resolvedCallerId !== calleridId : !calleridId) {
      calleridId = resolvedCallerId ?? (await createCallerId(config, { id_user: magnusUserId!, cid: didNumber! }));
      consumer = await prisma.consumerAccount.update({
        where: { id: consumerAccountId },
        data: { magnus_callerid_id: calleridId },
        include: { wallet: true },
      });
    }

    // Step 5: mirror the finished account (final SIP creds + DID + owner
    // phone) into the BFF Lite payment rails so it can identify who is
    // paying for top-ups without re-deriving Magnus state itself. Idempotent
    // upsert on the BFF side — safe to call on every provisioning run.
    // Non-fatal: a BFF outage must never block getting the account a
    // working SIP/DID setup, same posture as the starter-grant step above.
    if (isBffConfigured() && sipUsername && sipPassword && didNumber) {
      try {
        const mirrorResult = await mirrorAccount(getBffConfig(), {
          magnusUserId: magnusUserId!,
          sipUsername,
          sipPassword,
          did: didNumber,
          ownerPhone: consumer.phone_number,
        });
        if (mirrorResult.ok) {
          console.log(
            `[voice-provisioning-consumer] BFF mirror-account ok consumer=${consumerAccountId} created=${!!mirrorResult.created} updated=${!!mirrorResult.updated}`,
          );
        } else {
          console.error(
            `[voice-provisioning-consumer] BFF mirror-account FAILED consumer=${consumerAccountId}: ${mirrorResult.error}`,
          );
        }
      } catch (e: any) {
        console.error(`[voice-provisioning-consumer] BFF mirror-account error consumer=${consumerAccountId}:`, e?.message ?? e);
      }
    }

    consumer = await prisma.consumerAccount.update({
      where: { id: consumerAccountId },
      data: { voice_provisioning_state: 'completed', voice_provisioning_error: null },
      include: { wallet: true },
    });

    return toResult(consumer);
  } catch (e: any) {
    const message = e?.message ?? String(e);
    consumer = await prisma.consumerAccount.update({
      where: { id: consumerAccountId },
      data: { voice_provisioning_state: 'failed', voice_provisioning_error: message },
      include: { wallet: true },
    });
    return toResult(consumer);
  }
}
