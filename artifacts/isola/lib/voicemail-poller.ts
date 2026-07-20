/**
 * lib/voicemail-poller.ts — per-tenant AI missed-call catcher poller
 *
 * PORT of Isola Lite's app/lib/lite-voicemail-poller.ts (deepseek
 * /opt/bff-v2, PROVEN in production). Driven there by an Inngest 5-min
 * cron; here the owner chose a Replit Scheduled Deployment instead (see
 * app/api/internal/voicemail-poll/route.ts) — pollTenantVoicemails() is a
 * plain exported async function with no scheduler dependency baked in, so
 * it is trivially callable from either.
 *
 * For each Tenant with a provisioned Magnus SIP line:
 *   1. SSH voice00 (read-only): list /var/spool/asterisk/voicemail/billing/<magnus_sip_username>/INBOX/msg*.txt
 *   2. For each msgId not already in TenantVoicemailCatch: read .txt + .wav (base64), run pipeline
 *   3. SPAM skip: durationSec < 2 OR callerId in SPAM_BLOCKLIST -> isSpam=true
 *   4. Run parseVoicemailMeta -> transcribeVoicemail -> summarizeVoicemail (lib/voicemail-catcher.ts)
 *   5. Create TenantVoicemailCatch row
 *   6. Delivery gate: VOICEMAIL_CATCH_DELIVER=true -> WhatsApp template to Tenant.owner_phone
 *      (flag OFF by default — see header of this file for why)
 *
 * VOICE00 ACCESS: SSH to VOICE00_SSH_HOST (default matches Lite's
 * registrar, see env below), read-only. This poller does NOT write to
 * voice00 and does NOT touch Asterisk/Magnus config.
 *
 * FIXTURE MODE: set VOICEMAIL_CATCH_FIXTURE_DIR to override the voicemail
 * dir base path — same mechanism as source, for local/CI testing without a
 * live voice00 SSH path.
 *
 * See the PR description / commit message for the full list of
 * adaptations from the Lite source (LiteAccount -> Tenant field mapping,
 * dropped quota counters, delivery-gate rename, etc).
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { prisma } from '@/lib/prisma';
import { sendWhatsApp } from '@/lib/notify-whatsapp';
import { enqueueNotification } from '@/lib/notify';
import {
  parseVoicemailMeta,
  transcribeVoicemail,
  summarizeVoicemail,
} from '@/lib/voicemail-catcher';

// ── Constants ────────────────────────────────────────────────────────────────

const SPAM_MIN_DURATION = 2; // seconds — calls shorter than this are spam

// Callers to always mark as spam (robocaller patterns) — same list as source
const SPAM_BLOCKLIST = new Set([
  '100', // internal test / echo / ringback
  '1000',
]);

// Voice00 SSH details (read-only access). Renamed from source's
// MAGNUS_SSH_HOST — Foundation has no existing env var for this host.
const VOICE00_SSH_HOST = process.env.VOICE00_SSH_HOST ?? 'voice00';
const VOICE00_SSH_USER = process.env.VOICE00_SSH_USER ?? 'epicdm';
const VOICE00_VOICEMAIL_BASE = '/var/spool/asterisk/voicemail/billing';
const VOICE00_SSH_KEY = process.env.VOICE00_SSH_KEY ?? '';

// Fixture override (testing without real voice00 calls)
const FIXTURE_DIR = process.env.VOICEMAIL_CATCH_FIXTURE_DIR ?? '';

// Delivery gate — fail-closed default, same posture as source's
// getRuntimeFlag("LITE_CATCH_DELIVER"), implemented here as a plain env
// var since Foundation has no DB-backed runtime-flag system yet.
const DELIVER_ENABLED = process.env.VOICEMAIL_CATCH_DELIVER === 'true';

// S6 Phase 2: route the owner alert through the durable NotificationOutbox
// (lib/notify.ts + lib/notify-drain.ts) instead of the direct send below.
// Default OFF — existing DELIVER_ENABLED direct-send path is unchanged.
const NOTIFY_OUTBOX_ENABLED = process.env.NOTIFY_OUTBOX_ENABLED === 'true';

const TEMPLATE_NAME = process.env.VOICEMAIL_CATCH_TEMPLATE || 'isola_missed_call_alert';

// ── Types ────────────────────────────────────────────────────────────────────

export interface PollTenantVoicemailsResult {
  tenantsScanned: number;
  newCatches: number;
  spamSkipped: number;
  alreadyProcessed: number;
  errors: string[];
}

// ── SSH helpers (voice00 read-only) — same shape as source ────────────────────

let _v00KeyPath: string | null = null;
function voice00KeyOpts(): string {
  if (!VOICE00_SSH_KEY) return '';
  if (!_v00KeyPath) {
    let k = VOICE00_SSH_KEY.replace(/\\n/g, '\n').replace(/\r/g, '');
    if (k.trim().split('\n').length < 3) {
      const B = '-----BEGIN OPENSSH PRIVATE KEY-----', E = '-----END OPENSSH PRIVATE KEY-----';
      const body = k.replace(B, '').replace(E, '').replace(/\s+/g, '');
      k = B + '\n' + (body.match(/.{1,70}/g) ?? []).join('\n') + '\n' + E + '\n';
    } else if (!k.endsWith('\n')) { k += '\n'; }
    _v00KeyPath = '/tmp/voice00_ssh_key';
    fs.writeFileSync(_v00KeyPath, k, { mode: 0o600 });
    fs.chmodSync(_v00KeyPath, 0o600);
  }
  return '-i ' + _v00KeyPath + ' -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null';
}

function sshVoice00(cmd: string): string {
  const sshCmd = `ssh ${voice00KeyOpts()} -o ConnectTimeout=10 ${VOICE00_SSH_USER}@${VOICE00_SSH_HOST} "${cmd.replace(/"/g, '\\"')}"`;
  return execSync(sshCmd, { timeout: 30_000, encoding: 'utf8' }).trim();
}

function sshReadFile(remotePath: string): string {
  return sshVoice00(`cat '${remotePath}'`);
}

function sshBase64File(remotePath: string): string {
  return sshVoice00(`base64 -w 0 '${remotePath}'`);
}

function sshListFiles(dirPath: string, pattern: string): string[] {
  try {
    const out = sshVoice00(`ls '${dirPath}'/${pattern} 2>/dev/null || true`);
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

// ── Local file helpers (fixture mode) — unchanged from source ────────────────

function localReadFile(p: string): string {
  return fs.readFileSync(p, 'utf8');
}

function localBase64File(p: string): string {
  return fs.readFileSync(p).toString('base64');
}

function localListFiles(dir: string, pattern: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const re = pattern.replace('*', '.*').replace('?', '.');
  return fs
    .readdirSync(dir)
    .filter((f) => new RegExp(`^${re}$`).test(f))
    .map((f) => path.join(dir, f));
}

// ── Core per-message processing — unchanged from source ──────────────────────

export async function processVoicemailFile(opts: {
  txtContent: string;
  wavPath: string; // local path to a (possibly temp-copied) wav file
  msgId: string;
  tenantId: string;
}): Promise<{
  meta: ReturnType<typeof parseVoicemailMeta>;
  transcript: string;
  summary: Awaited<ReturnType<typeof summarizeVoicemail>>;
  isSpam: boolean;
}> {
  const { txtContent, wavPath } = opts;

  const meta = parseVoicemailMeta(txtContent);

  const isSpam = meta.durationSec < SPAM_MIN_DURATION || SPAM_BLOCKLIST.has(meta.callerId);

  const transcript = isSpam ? '' : await transcribeVoicemail(wavPath);
  const summary = isSpam
    ? {
        summary: 'Spam or too-short call — skipped',
        intent: 'spam',
        urgency: 'low' as const,
        callbackNumber: null,
        confident: false,
      }
    : await summarizeVoicemail({ transcript, callerId: meta.callerId, durationSec: meta.durationSec });

  return { meta, transcript, summary, isSpam };
}

// ── WA delivery ────────────────────────────────────────────────────────────

// Template body param: single line, no newlines/tabs/4+ spaces (Meta rejects them) — same rule as source.
function buildMissedCallSummaryLine(opts: { callerId: string; summary: string; urgency: string }): string {
  const urgencyTag = opts.urgency === 'urgent' ? ' [urgent]' : '';
  return `From +${opts.callerId}${urgencyTag}: ${opts.summary}`
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

/**
 * deliverCatch: send a WhatsApp template notification to the tenant owner
 * directly (non-durable — a failed send is lost). GATE: only runs when
 * VOICEMAIL_CATCH_DELIVER=true. Used when NOTIFY_OUTBOX_ENABLED is OFF; when
 * ON, deliverOrEnqueueCatch below enqueues into NotificationOutbox instead
 * and this function is not called.
 */
async function deliverCatch(opts: {
  tenantId: string;
  magnusSipUsername: string;
  ownerPhone: string;
  summaryLine: string;
}): Promise<boolean> {
  const { tenantId, magnusSipUsername, ownerPhone, summaryLine } = opts;

  if (!DELIVER_ENABLED) {
    console.info(`[voicemail-poller] delivery gate OFF — storing only (tenantId=${tenantId})`);
    return false;
  }

  try {
    const result = await sendWhatsApp({
      tenantId,
      contact: ownerPhone,
      template: TEMPLATE_NAME,
      payload: { summaryLine },
    });
    console.info(
      `[voicemail-poller] WA catch send ok=${result.ok} status=${result.status}${result.error ? ` error=${result.error}` : ''} to ${ownerPhone} (${magnusSipUsername}) via template ${TEMPLATE_NAME}`,
    );
    return result.ok;
  } catch (err: any) {
    console.error(`[voicemail-poller] WA template delivery failed for ${magnusSipUsername}: ${err.message}`);
    return false;
  }
}

/**
 * deliverOrEnqueueCatch: resolve the tenant owner's phone once, then either
 * enqueue into NotificationOutbox (NOTIFY_OUTBOX_ENABLED=true — durable,
 * retries on failure via lib/notify-drain.ts) or send directly via
 * deliverCatch (flag OFF — the original non-durable behavior, unchanged).
 * Returns true when no further delivery attempt is needed for this catch
 * (sent, enqueued, or already enqueued as a duplicate).
 */
async function deliverOrEnqueueCatch(opts: {
  tenantId: string;
  magnusSipUsername: string;
  msgId: string;
  callerId: string;
  summary: string;
  urgency: string;
}): Promise<boolean> {
  const { tenantId, magnusSipUsername, msgId, callerId, summary, urgency } = opts;

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { owner_phone: true },
  });
  const ownerPhone = tenant?.owner_phone;
  if (!ownerPhone) {
    console.warn(`[voicemail-poller] no owner_phone on tenant ${tenantId} (${magnusSipUsername}) — delivery skipped`);
    return false;
  }

  const summaryLine = buildMissedCallSummaryLine({ callerId, summary, urgency });

  if (NOTIFY_OUTBOX_ENABLED) {
    const enqueueResult = await enqueueNotification({
      tenantId,
      contact: ownerPhone,
      channel: 'whatsapp',
      consentBasis: 'owner_self_notification',
      template: TEMPLATE_NAME,
      payload: { summaryLine, callerId, urgency },
      dedupeKey: `voicemail:${tenantId}:${msgId}`,
    });
    return enqueueResult.enqueued || enqueueResult.reason === 'duplicate';
  }

  return deliverCatch({ tenantId, magnusSipUsername, ownerPhone, summaryLine });
}

// ── Main poller ───────────────────────────────────────────────────────────────

export async function pollTenantVoicemails(): Promise<PollTenantVoicemailsResult> {
  const result: PollTenantVoicemailsResult = {
    tenantsScanned: 0,
    newCatches: 0,
    spamSkipped: 0,
    alreadyProcessed: 0,
    errors: [],
  };

  // Only business VoiceLines with a provisioned Magnus SIP line have a
  // voicemail spool to poll. Mirrors source's prisma.liteAccount.findMany()
  // scan-everything pattern, scoped by the equivalent Foundation column —
  // now living on VoiceLine (Phase C) instead of directly on Tenant.
  const voiceLines = await prisma.voiceLine.findMany({
    where: { owner_kind: 'business', magnus_sip_username: { not: null } },
    select: {
      magnus_sip_username: true,
      tenant: {
        select: {
          id: true,
          voicemail_catches: { select: { msgId: true } },
        },
      },
    },
  });

  for (const voiceLine of voiceLines) {
    const tenant = voiceLine.tenant;
    if (!tenant) continue;
    result.tenantsScanned++;
    const sipUsername = voiceLine.magnus_sip_username as string; // non-null per where clause
    const processedMsgIds = new Set(tenant.voicemail_catches.map((c) => c.msgId));

    const useFixture = Boolean(FIXTURE_DIR);
    const voicemailDir = useFixture
      ? path.join(FIXTURE_DIR, sipUsername, 'INBOX')
      : `${VOICE00_VOICEMAIL_BASE}/${sipUsername}/INBOX`;

    let txtFiles: string[];
    try {
      txtFiles = useFixture ? localListFiles(voicemailDir, 'msg*.txt') : sshListFiles(voicemailDir, 'msg*.txt');
    } catch (err: any) {
      console.debug(`[voicemail-poller] no voicemail dir for ${sipUsername}: ${err.message}`);
      continue;
    }

    for (const txtFile of txtFiles) {
      const basename = path.basename(txtFile, '.txt'); // e.g. "msg0000"
      const msgId = basename;

      if (processedMsgIds.has(msgId)) {
        result.alreadyProcessed++;
        continue;
      }

      const wavFile = txtFile.replace(/\.txt$/, '.wav');
      let tmpWavPath: string | null = null;

      try {
        const txtContent = useFixture ? localReadFile(txtFile) : sshReadFile(txtFile);

        if (useFixture) {
          tmpWavPath = wavFile;
        } else {
          const b64 = sshBase64File(wavFile);
          tmpWavPath = `/tmp/voicemail_catch_${sipUsername}_${msgId}.wav`;
          fs.writeFileSync(tmpWavPath, Buffer.from(b64, 'base64'));
        }

        const { meta, transcript, summary, isSpam } = await processVoicemailFile({
          txtContent,
          wavPath: tmpWavPath,
          msgId,
          tenantId: tenant.id,
        });

        const catch_ = await prisma.tenantVoicemailCatch.create({
          data: {
            tenant_id: tenant.id,
            msgId,
            callerId: meta.callerId,
            calledExten: meta.calledExten,
            origtime: meta.origtime,
            durationSec: meta.durationSec,
            transcript,
            summary: summary.summary,
            intent: summary.intent,
            urgency: summary.urgency,
            callbackNumber: summary.callbackNumber,
            confident: summary.confident,
            isSpam,
            delivered: false,
          },
        });

        if (isSpam) {
          result.spamSkipped++;
          console.info(`[voicemail-poller] spam/short skipped: ${sipUsername}/${msgId}`);
        } else {
          result.newCatches++;

          const delivered = await deliverOrEnqueueCatch({
            tenantId: tenant.id,
            magnusSipUsername: sipUsername,
            msgId,
            callerId: meta.callerId,
            summary: summary.summary,
            urgency: summary.urgency,
          });

          if (delivered) {
            await prisma.tenantVoicemailCatch.update({
              where: { id: catch_.id },
              data: { delivered: true },
            });
          }

          console.info(`[voicemail-poller] processed ${sipUsername}/${msgId}: intent=${summary.intent} urgency=${summary.urgency} confident=${summary.confident}`);
        }
      } catch (err: any) {
        const msg = `${sipUsername}/${msgId}: ${err.message}`;
        console.error(`[voicemail-poller] error processing ${msg}`);
        result.errors.push(msg);
      } finally {
        if (tmpWavPath && !useFixture && fs.existsSync(tmpWavPath)) {
          try {
            fs.unlinkSync(tmpWavPath);
          } catch {}
        }
      }
    }
  }

  return result;
}
