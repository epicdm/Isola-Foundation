/**
 * tenant-secrets.ts — envelope encryption for per-tenant binding secrets.
 *
 * Every secret field on OdooBinding / FiservBinding / BffBinding (the *_enc
 * columns) is AES-256-GCM ciphertext produced by encryptSecret() below,
 * never plaintext. The key is derived from TENANT_MASTER_KEY (declared in
 * lib/engines.ts's getSetupChecklist(), previously unused anywhere in the
 * codebase — this module is its first real consumer).
 *
 * Encoding: base64(iv[12] || authTag[16] || ciphertext).
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
// Fixed, non-secret salt: TENANT_MASTER_KEY itself is the secret input to the
// KDF, so the salt only needs to make the derived key algorithm-specific, not
// per-secret-random (every secret using the same derived key is fine — GCM's
// per-encryption randomness comes from the random IV below).
const KDF_SALT = 'isola-tenant-secrets-v1';

function deriveKey(): Buffer {
  const masterKey = process.env.TENANT_MASTER_KEY;
  if (!masterKey) {
    throw new Error('TENANT_MASTER_KEY is not set — cannot encrypt/decrypt tenant binding secrets');
  }
  return scryptSync(masterKey, KDF_SALT, 32);
}

export function encryptSecret(plaintext: string): string {
  const key = deriveKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

export function decryptSecret(encoded: string): string {
  const key = deriveKey();
  const raw = Buffer.from(encoded, 'base64');
  const iv = raw.subarray(0, IV_LENGTH);
  const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = raw.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

export function isTenantMasterKeyConfigured(): boolean {
  return !!process.env.TENANT_MASTER_KEY;
}
