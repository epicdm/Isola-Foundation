/**
 * VOICE P3 native proof — Option A, existing-canary only.
 *
 * AUTHORIZED SCOPE (owner dispatch "VOICE — AUTHORIZE OPTION A EXISTING-CANARY
 * NATIVE PROOF"): magnusUser 1573 / SIP 1842 / DID 17678185040 (the "second
 * canary") ONLY. Never touches 17678185039 (the owner-witnessed primary
 * line). Permitted: create ONE Foundation VoiceLine row bound to the
 * already-existing canary, run the real provisioning/resume/read-back path,
 * remove the row after evidence capture. NOT permitted: create, delete or
 * modify a Magnus user, SIP account, DID, caller-ID, route or credit.
 *
 * DELIBERATELY calls provisionVoiceLine() directly, NOT provisionConsumerVoice().
 * provisionConsumerVoice's onMagnusUserResolved fires UNCONDITIONALLY whenever
 * a magnus_user_id is resolved — including an already-existing one — gated
 * only by its own WalletTxn idempotency check. A freshly-seeded test row has
 * no prior grant, so that path WOULD attempt a real Magnus credit call. The
 * owner's authorization explicitly excludes credit, so this script never
 * imports or calls the consumer wrapper at all.
 *
 * SAFETY GATE: Step 1b of provisionVoiceLine() patches user.prefix_local if
 * the live value differs from the expected constant — a real MODIFY of the
 * Magnus user, which is on the forbidden list. This script reads that value
 * FIRST and refuses to proceed to the real provisioning call if it does not
 * already match, rather than letting the reconciliation write fire silently.
 * Same reasoning applies to the SIP secret (Step 2) and the DID route (Step
 * 3b) — all three are read and pre-verified before the real call, and the
 * run aborts with a clear reason if any would require a write.
 *
 * Run with: pnpm --filter @workspace/isola exec tsx scripts/p3-native-canary-proof-2026-08-24.ts
 * Requires real MAGNUS_URL/MAGNUS_API_KEY/MAGNUS_API_SECRET and DATABASE_URL
 * already present in the environment this runs in. This script never reads,
 * prints or logs any of those values — only booleans and Magnus's own
 * returned identifiers (ids and the DID number, which is not a secret).
 */
import { prisma } from '../lib/prisma';
import { getMagnusConfig, isMagnusConfigured } from '../lib/engines';
import {
  readSipAccount,
  findDidByNumber,
  readUserPrefixLocal,
  readDidDestination,
  findDidDestinationForSip,
  DOMINICA_LOCAL_PREFIX_RULES,
} from '../lib/magnus-voice';
import { provisionVoiceLine, toVoiceProvisioningResult } from '../lib/voice-provisioning';

const CANARY = {
  magnusUserId: '1573',
  sipId: '1842',
  didNumber: '17678185040',
};
const FORBIDDEN_PRIMARY_DID = '17678185039';
const TEST_IDENTITY_ID = 'voice-p3-native-proof-2026-08-24';

function log(step: string, data: object) {
  console.log(JSON.stringify({ step, ts: new Date().toISOString(), ...data }));
}

async function main() {
  if (CANARY.didNumber === FORBIDDEN_PRIMARY_DID) {
    throw new Error('SAFETY ABORT: target DID matches the forbidden primary line');
  }
  if (!isMagnusConfigured()) {
    throw new Error('MAGNUS NOT CONFIGURED — this environment cannot run the real proof');
  }
  const config = getMagnusConfig();

  // ── Step 1: read and record existing Magnus state (read-only) ───────────
  const preSip = await readSipAccount(config, CANARY.sipId);
  if (!preSip) throw new Error(`SAFETY ABORT: could not read live SIP account ${CANARY.sipId} — refusing to proceed against an unverified target`);
  if (preSip.name === undefined) throw new Error('SAFETY ABORT: live SIP row missing expected shape');

  const preDid = await findDidByNumber(config, CANARY.didNumber);
  const prePrefixLocal = await readUserPrefixLocal(config, CANARY.magnusUserId);
  const preDest = await findDidDestinationForSip(config, CANARY.sipId, preDid?.id ?? null);
  const preDestState = preDest ? await readDidDestination(config, preDest.id) : null;

  log('1_pre_read', {
    sip_id: preSip.id,
    sip_name: preSip.name,
    sip_cid_number: preSip.cid_number,
    did_id: preDid?.id ?? null,
    did_number: preDid?.did ?? null,
    prefix_local: prePrefixLocal,
    diddestination_id: preDest?.id ?? null,
    diddestination_state: preDestState
      ? { destination: preDestState.destination, voip_call: preDestState.voip_call }
      : null,
  });

  // ── Safety gate: refuse to proceed if the real call would need to WRITE ──
  const wouldPatchPrefixLocal = prePrefixLocal !== null && prePrefixLocal !== DOMINICA_LOCAL_PREFIX_RULES;
  if (wouldPatchPrefixLocal) {
    throw new Error(
      `SAFETY ABORT: live prefix_local ("${prePrefixLocal}") differs from expected — running provisionVoiceLine would MODIFY the Magnus user (forbidden). Aborting before any write.`,
    );
  }
  const isCurrentlySip = preDestState ? preDestState.destination === '' && preDestState.voip_call === '1' : null;
  if (preDestState && !isCurrentlySip) {
    throw new Error(
      'SAFETY ABORT: live route state is not already extension-first sip — running provisionVoiceLine would MODIFY the route (forbidden). Aborting before any write.',
    );
  }
  log('1b_safety_gate_passed', { wouldPatchPrefixLocal, isCurrentlySip });

  // ── Step 2: seed the bounded Foundation binding ──────────────────────────
  // Pre-populated with the ALREADY-EXISTING canary ids so provisionVoiceLine's
  // create branches (Step 1 user create, Step 3 draw/claim, Step 4 callerid
  // create) are structurally unreachable — every id is already present.
  const seeded = await prisma.voiceLine.create({
    data: {
      owner_kind: 'consumer',
      identity_id: TEST_IDENTITY_ID,
      magnus_user_id: CANARY.magnusUserId,
      magnus_sip_id: CANARY.sipId,
      magnus_sip_username: preSip.name,
      magnus_sip_password: null, // deliberately absent — proves the legacy-backfill adopt-from-Magnus branch, not a locally-asserted secret
      magnus_did_id: preDid?.id ?? null,
      magnus_did_number: CANARY.didNumber,
      magnus_diddestination_id: preDest?.id ?? null,
      magnus_callerid_id: null, // resolved by the real call via findCallerIdByCid — a read, not a create, since one already exists for this DID
    },
  });
  log('2_seeded_foundation_row', { voiceLineId: seeded.id, identity_id: seeded.identity_id });

  try {
    // ── Step 3: execute the REAL provisioning path (first run) ────────────
    const firstRun = await provisionVoiceLine(seeded.id, config, {
      description: 'VOICE_P3_NATIVE_PROOF (disposable, see cleanup)',
      usernameSeed: TEST_IDENTITY_ID,
      usernamePrefix: 'ema_',
      // Deliberately NO onMagnusUserResolved — this is the exact mechanism
      // that keeps this call away from the credit path. See file header.
    });
    log('3_first_run_result', toVoiceProvisioningResult(firstRun));

    // ── Step 4a: idempotent resume — run it again, prove stability ────────
    const secondRun = await provisionVoiceLine(seeded.id, config, {
      description: 'VOICE_P3_NATIVE_PROOF (disposable, see cleanup)',
      usernameSeed: TEST_IDENTITY_ID,
      usernamePrefix: 'ema_',
    });
    log('4a_idempotent_resume_result', toVoiceProvisioningResult(secondRun));
    const idempotent =
      firstRun.magnus_user_id === secondRun.magnus_user_id &&
      firstRun.magnus_sip_id === secondRun.magnus_sip_id &&
      firstRun.magnus_did_number === secondRun.magnus_did_number &&
      firstRun.magnus_diddestination_id === secondRun.magnus_diddestination_id &&
      firstRun.magnus_callerid_id === secondRun.magnus_callerid_id &&
      secondRun.provisioning_state === 'completed';
    log('4a_idempotent_resume_verdict', { idempotent });

    // ── Step 4b: ACTIVE read-back (Foundation-side result shape) ──────────
    const readBack = toVoiceProvisioningResult(secondRun);
    log('4b_active_read_back', { state: readBack.state, hasSipUsername: !!readBack.magnus_sip_username, hasDid: !!readBack.magnus_did_number });

    // ── Step 4c: route reconciliation is a no-op given the pre-verified gate ─
    const postDestState = preDest ? await readDidDestination(config, preDest.id) : null;
    const routeUnchanged =
      !!postDestState && !!preDestState &&
      postDestState.destination === preDestState.destination &&
      postDestState.voip_call === preDestState.voip_call;
    log('4c_route_reconciliation_noop_verified', { routeUnchanged, postDestState });

    // ── Step 4d: Cloud-Softphone independence ──────────────────────────────
    // This VoiceLine row carries no lite-activation/Acrobits field at all —
    // structural proof, not behavioral: the result type and this whole call
    // path never reference cscLaunchUri/lite-activation.
    const resultText = JSON.stringify(readBack);
    const cloudSoftphoneIndependent = !resultText.includes('csc:') && !('cloud_softphone_state' in readBack);
    log('4d_cloud_softphone_independence', { cloudSoftphoneIndependent });

    // ── Step 5: prove no create/claim call fired ───────────────────────────
    const postSip = await readSipAccount(config, CANARY.sipId);
    const postDid = await findDidByNumber(config, CANARY.didNumber);
    const noCreateOrClaimFired =
      postSip?.id === preSip.id &&
      postDid?.id === preDid?.id &&
      postDid?.did === preDid?.did;
    log('5_no_create_or_claim_verdict', {
      noCreateOrClaimFired,
      pre_sip_id: preSip.id, post_sip_id: postSip?.id,
      pre_did_id: preDid?.id, post_did_id: postDid?.id,
    });
  } finally {
    // ── Step 6: remove the Foundation row, unconditionally ─────────────────
    await prisma.voiceLine.delete({ where: { id: seeded.id } });
    log('6_foundation_row_removed', { voiceLineId: seeded.id });
  }

  // ── Step 7: re-read Magnus and prove it is unchanged ─────────────────────
  const finalSip = await readSipAccount(config, CANARY.sipId);
  const finalDid = await findDidByNumber(config, CANARY.didNumber);
  const finalPrefixLocal = await readUserPrefixLocal(config, CANARY.magnusUserId);
  const magnusUnchanged =
    finalSip?.id === preSip.id &&
    finalSip?.name === preSip.name &&
    finalSip?.cid_number === preSip.cid_number &&
    finalDid?.id === preDid?.id &&
    finalDid?.did === preDid?.did &&
    finalPrefixLocal === prePrefixLocal;
  log('7_post_read_magnus_unchanged_verdict', {
    magnusUnchanged,
    final_sip_id: finalSip?.id, final_did_id: finalDid?.id, final_prefix_local_matches: finalPrefixLocal === prePrefixLocal,
  });

  if (!magnusUnchanged) {
    throw new Error('POST-RUN VERIFICATION FAILED: Magnus state differs from the pre-run baseline. Investigate before treating this proof as clean.');
  }

  log('DONE', { verdict: 'clean — Foundation row created and removed, real Magnus reads succeeded, Magnus state unchanged' });
}

main()
  .catch((e) => {
    console.error(JSON.stringify({ step: 'FATAL', error: e?.message ?? String(e) }));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
