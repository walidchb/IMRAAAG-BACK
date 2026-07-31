import * as crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

export function encryptValue(value: string, key: string): string {
  if (!key) return value;
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(key, 'hex'), iv);
  let encrypted = cipher.update(value, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${tag}:${encrypted}`;
}

export function decryptValue(encrypted: string, key: string): string {
  if (!key) return encrypted;
  if (!encrypted.includes(':')) return encrypted;
  const parts = encrypted.split(':');
  if (parts.length !== 3) return encrypted;
  const [ivHex, tagHex, ciphertext] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, Buffer.from(key, 'hex'), iv);
  decipher.setAuthTag(tag);
  let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

export function encryptRecord(
  obj: Record<string, string>,
  key: string,
): Record<string, string> {
  if (!key || !obj) return obj;
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    result[k] = encryptValue(v, key);
  }
  return result;
}

export function decryptRecord(
  obj: Record<string, string>,
  key: string,
): Record<string, string> {
  if (!key || !obj) return obj;
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    result[k] = decryptValue(v, key);
  }
  return result;
}
