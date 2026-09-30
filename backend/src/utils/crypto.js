import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '../config/env.js';

/**
 * Column-level encryption for PAN, Aadhaar and bank account numbers (AES-256-GCM).
 * Stored as base64(iv | tag | ciphertext) with a version prefix so keys can rotate.
 */
const KEY = Buffer.from(env.PII_ENCRYPTION_KEY, 'base64');
const PREFIX = 'v1:';

export function encryptPII(plain) {
  if (plain === null || plain === undefined || plain === '') return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ct]).toString('base64');
}

export function decryptPII(enc) {
  if (!enc) return null;
  if (!enc.startsWith(PREFIX)) throw new Error('Unknown PII ciphertext version');
  const buf = Buffer.from(enc.slice(PREFIX.length), 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/** XXXX XXXX 1234 — the only form Aadhaar is ever displayed or exported in. */
export function maskAadhaar(aadhaar) {
  if (!aadhaar) return null;
  const digits = aadhaar.replace(/\D/g, '');
  return `XXXX XXXX ${digits.slice(-4)}`;
}

export function maskPan(pan) {
  if (!pan) return null;
  return `${pan.slice(0, 2)}XXX${pan.slice(5)}`;
}

export function maskAccount(last4) {
  return last4 ? `XXXXXX${last4}` : null;
}
