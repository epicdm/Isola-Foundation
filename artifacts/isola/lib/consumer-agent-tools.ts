/**
 * Governed tool catalog for the P4 consumer companion agent.
 *
 * Mirrors the trust-boundary shape of lib/agent-tools.ts (the Flowise-facing
 * gate): every function here takes a TRUSTED `consumerAccountId` argument
 * supplied by the caller (the chat route, which derives it from
 * getConsumerSession() — never from the model's tool-call input). The model
 * can never name or influence which account a tool acts on; there is no
 * "account_id" field in any tool's input schema.
 *
 * Read tools (get_balance, get_line_status, get_recent_calls) hit the same
 * engine clients the consumer REST routes already use. The two action tools
 * are deliberately narrow:
 *   - initiate_topup: NEVER moves money. It validates an amount, records an
 *     audit row, and returns a client-side navigation action so the human
 *     still enters card details on the existing governed /wallet/topup path
 *     (which has its own Fiserv gate). The agent never sees or handles card
 *     data.
 *   - set_call_forwarding: a real, reversible settings write — reuses the
 *     exact same Magnus call + ConsumerAccount update + audit trail as
 *     POST /api/consumer/voice/forward.
 * No destructive or money-moving action is ever dispatched directly by the
 * agent.
 */

import { prisma } from './prisma';
import { audit } from './audit';
import { getMagnusConfig, isMagnusConfigured } from './engines';
import { getBalance, getCalls } from '@/engines/magnus';
import { setDidDestinationRoute, MAGNUS_REGISTRATION_SERVER } from './magnus-voice';
import type { ConsumerAccount } from '@prisma/client';
import type { ConsumerSessionAccount } from './consumer-session';

export class ConsumerToolError extends Error {}

// ── get_balance ──────────────────────────────────────────────────────────────

export async function toolGetBalance(account: ConsumerAccount) {
  const wallet = await prisma.wallet.findUnique({ where: { consumer_account_id: account.id } });
  if (!wallet) return { configured: false, balance: null, currency: 'EC$' };

  if (isMagnusConfigured() && wallet.magnus_user_id) {
    try {
      const live = await getBalance(getMagnusConfig(), wallet.magnus_user_id);
      if (live) {
        await prisma.wallet.update({
          where: { id: wallet.id },
          data: { balance_cache: live.balance, balance_minor: Math.round(live.balance * 100) },
        });
        return { configured: true, balance: live.balance, currency: live.currency, live: true };
      }
    } catch (e: any) {
      console.error('[consumer-agent-tools] get_balance Magnus error:', e.message);
    }
  }
  // ledger-phase-b read cutover — see app/api/wallet/balance/route.ts.
  const cachedBalance = wallet.balance_minor != null ? wallet.balance_minor / 100 : wallet.balance_cache;
  return { configured: isMagnusConfigured(), balance: cachedBalance, currency: wallet.currency, live: false };
}

// ── get_line_status ──────────────────────────────────────────────────────────

export async function toolGetLineStatus(account: ConsumerSessionAccount) {
  const voiceLine = await prisma.voiceLine.findFirst({
    where: { identity_id: account.identityId, owner_kind: 'consumer' },
  });
  if (!voiceLine) {
    return {
      state: 'not_provisioned',
      error: null,
      did_number: null,
      registration_server: MAGNUS_REGISTRATION_SERVER,
      forward_to_cell: false,
      cell_number: null,
    };
  }
  return {
    state: voiceLine.provisioning_state,
    error: voiceLine.provisioning_error,
    did_number: voiceLine.magnus_did_number,
    registration_server: MAGNUS_REGISTRATION_SERVER,
    forward_to_cell: voiceLine.voice_forward_to_cell,
    cell_number: voiceLine.voice_cell_number,
  };
}

// ── get_recent_calls ─────────────────────────────────────────────────────────

export async function toolGetRecentCalls(account: ConsumerSessionAccount, limit: number) {
  const cappedLimit = Math.max(1, Math.min(limit || 5, 20));
  const voiceLine = await prisma.voiceLine.findFirst({
    where: { identity_id: account.identityId, owner_kind: 'consumer' },
  });
  if (!isMagnusConfigured() || !voiceLine?.magnus_user_id) {
    return { configured: false, calls: [] };
  }
  try {
    const calls = await getCalls(getMagnusConfig(), voiceLine.magnus_user_id, cappedLimit);
    return { configured: true, calls };
  } catch (e: any) {
    console.error('[consumer-agent-tools] get_recent_calls error:', e.message);
    return { configured: true, calls: [], error: 'failed_to_fetch' };
  }
}

// ── initiate_topup — proposes an amount, never charges ──────────────────────

const MIN_TOPUP_EC = 10;
const MAX_TOPUP_EC = 500;

export async function toolInitiateTopup(account: ConsumerAccount, amount: number) {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    throw new ConsumerToolError('amount must be a positive number');
  }
  const clamped = Math.min(Math.max(amount, MIN_TOPUP_EC), MAX_TOPUP_EC);

  await audit({
    consumerAccountId: account.id,
    actorId: 'consumer_assistant',
    action: 'consumer_assistant.initiate_topup',
    entity: 'consumer_account',
    entityId: account.id,
    meta: { requested_amount: amount, clamped_amount: clamped },
  });

  return {
    // Interpreted client-side only — no charge happens here. The human still
    // must enter card details on /consumer/wallet, which runs the real,
    // separately-governed Fiserv charge path.
    client_action: 'navigate_topup' as const,
    amount: clamped,
    note:
      clamped !== amount
        ? `Amount adjusted to the allowed range (EC$${MIN_TOPUP_EC}–EC$${MAX_TOPUP_EC}).`
        : undefined,
  };
}

// ── set_call_forwarding — real, reversible settings write ──────────────────

export async function toolSetCallForwarding(
  account: ConsumerSessionAccount,
  enabled: boolean,
  cellNumber: string | undefined,
) {
  if (!isMagnusConfigured()) {
    throw new ConsumerToolError('Magnus is not configured — cannot change call routing');
  }
  const voiceLine = await prisma.voiceLine.findFirst({
    where: { identity_id: account.identityId, owner_kind: 'consumer' },
  });

  if (!voiceLine?.magnus_diddestination_id || voiceLine.provisioning_state !== 'completed') {
    throw new ConsumerToolError('This account\u2019s voice line is not provisioned yet');
  }

  const nextCellNumber = cellNumber !== undefined ? cellNumber : voiceLine.voice_cell_number;
  if (enabled && !nextCellNumber) {
    throw new ConsumerToolError('A cell number is required to enable forward-to-cell');
  }

  await setDidDestinationRoute(
    getMagnusConfig(),
    voiceLine.magnus_diddestination_id,
    enabled ? { mode: 'cell', cellNumber: nextCellNumber! } : { mode: 'sip' },
  );

  const updated = await prisma.voiceLine.update({
    where: { id: voiceLine.id },
    data: {
      voice_forward_to_cell: !!enabled,
      ...(cellNumber !== undefined && { voice_cell_number: cellNumber }),
    },
  });

  await audit({
    consumerAccountId: account.id,
    actorId: 'consumer_assistant',
    action: 'consumer.voice.forward_toggle',
    entity: 'consumer_account',
    entityId: account.id,
    meta: { forward_to_cell: updated.voice_forward_to_cell, via: 'assistant' },
  });

  return { forward_to_cell: updated.voice_forward_to_cell, cell_number: updated.voice_cell_number };
}
