/**
 * lib/consumer-otp.ts — phone-OTP code lifecycle for the P2 consumer auth
 * realm (separate from Replit Auth / lib/session.ts entirely).
 *
 * Security properties:
 *   - 6-digit numeric code, generated with crypto.randomInt (uniform).
 *   - Only an HMAC-SHA256 hash of the code is ever stored (peppered with
 *     SESSION_SECRET) — the plaintext code exists only in memory/response.
 *   - Single-use: verifyOtp() marks the row consumed_at on success; a
 *     consumed or expired row can never be verified again.
 *   - ~5 minute expiry.
 *   - Rate-limited per phone number (max 3 requests / 15 min).
 *   - Verify attempts are capped per code (max 5) to slow brute force.
 */

import crypto from 'node:crypto';
import { prisma } from './prisma';

const OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_VERIFY_ATTEMPTS = 5;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_MAX_REQUESTS = 3;

export class OtpRateLimitError extends Error {
  constructor() {
    super('Too many OTP requests for this phone number — try again later.');
  }
}
export class OtpInvalidError extends Error {}
export class OtpLockedError extends Error {
  constructor() {
    super('Too many incorrect attempts — request a new code.');
  }
}

function getPepper(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET not configured — required to hash OTP codes');
  return secret;
}

function hashCode(phoneNumber: string, code: string): string {
  return crypto.createHmac('sha256', getPepper()).update(`${phoneNumber}:${code}`).digest('hex');
}

function generateCode(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}

/** Throws if not a plausible E.164 number. Returns the normalized form. */
export function normalizePhone(raw: string): string {
  const trimmed = raw.trim();
  if (!/^\+[1-9]\d{7,14}$/.test(trimmed)) {
    throw new Error('Phone number must be in E.164 format, e.g. +17671234567');
  }
  return trimmed;
}

export async function requestOtp(phoneNumber: string): Promise<{ code: string; expiresAt: Date }> {
  const since = new Date(Date.now() - RATE_LIMIT_WINDOW_MS);
  const recentCount = await prisma.consumerOtpRequest.count({
    where: { phone_number: phoneNumber, created_at: { gt: since } },
  });
  if (recentCount >= RATE_LIMIT_MAX_REQUESTS) {
    throw new OtpRateLimitError();
  }

  const code = generateCode();
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);
  await prisma.consumerOtpRequest.create({
    data: {
      phone_number: phoneNumber,
      code_hash: hashCode(phoneNumber, code),
      expires_at: expiresAt,
    },
  });
  return { code, expiresAt };
}

/** Throws OtpInvalidError / OtpLockedError on failure. Resolves silently on success. */
export async function verifyOtp(phoneNumber: string, code: string): Promise<void> {
  const record = await prisma.consumerOtpRequest.findFirst({
    where: { phone_number: phoneNumber, consumed_at: null },
    orderBy: { created_at: 'desc' },
  });
  if (!record) throw new OtpInvalidError('No pending code for this phone number — request a new one.');
  if (record.attempt_count >= MAX_VERIFY_ATTEMPTS) throw new OtpLockedError();
  if (record.expires_at.getTime() < Date.now()) {
    throw new OtpInvalidError('Code expired — request a new one.');
  }

  const candidateHash = hashCode(phoneNumber, code);
  const candidateBuf = Buffer.from(candidateHash);
  const storedBuf = Buffer.from(record.code_hash);
  const matches =
    candidateBuf.length === storedBuf.length && crypto.timingSafeEqual(candidateBuf, storedBuf);

  // Increment attempt count regardless of outcome so repeated guesses lock out.
  await prisma.consumerOtpRequest.update({
    where: { id: record.id },
    data: {
      attempt_count: { increment: 1 },
      ...(matches ? { consumed_at: new Date() } : {}),
    },
  });

  if (!matches) throw new OtpInvalidError('Incorrect code.');
}
