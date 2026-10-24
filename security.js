import { HttpError, onlyDigits } from './http.js';

const encoder = new TextEncoder();

export function bytesToB64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function b64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function bytesToB64Url(bytes) {
  return bytesToB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomToken(bytes = 32) {
  return bytesToB64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(String(value)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(String(secret)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(String(message)));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function timingSafeEqual(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    diff |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  }
  return diff === 0;
}

const PBKDF2_ITERATIONS = 210000;

export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
    throw new HttpError(400, 'A senha deve ter entre 8 e 200 caracteres', 'WEAK_PASSWORD');
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return `pbkdf2$${PBKDF2_ITERATIONS}$${bytesToB64(salt)}$${bytesToB64(new Uint8Array(bits))}`;
}

export async function verifyPassword(password, stored) {
  const value = String(stored || '');
  if (!value.startsWith('pbkdf2$')) {
    return { ok: timingSafeEqual(value, String(password || '')), legacy: true, needsRehash: true };
  }
  const [, iterationsRaw, saltRaw, hashRaw] = value.split('$');
  const iterations = Number(iterationsRaw);
  if (!iterations || !saltRaw || !hashRaw) return { ok: false, legacy: false, needsRehash: false };
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: b64ToBytes(saltRaw), iterations, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return {
    ok: timingSafeEqual(bytesToB64(new Uint8Array(bits)), hashRaw),
    legacy: false,
    needsRehash: iterations < PBKDF2_ITERATIONS,
  };
}

export function validCpfCnpj(value) {
  const digits = onlyDigits(value);
  return digits.length === 11 || digits.length === 14;
}

export function validUpiVpa(value) {
  return /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z]{2,64}$/.test(String(value || ''));
}

export async function encryptSensitive(value, env) {
  const rawKey = env.PALM_KEY || env.DATA_ENCRYPTION_KEY;
  if (!rawKey || !value) return value;
  try {
    const keyBytes = b64ToBytes(rawKey);
    if (keyBytes.length !== 32) return value;
    const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      encoder.encode(String(value))
    );
    return `enc:v1:${bytesToB64(iv)}:${bytesToB64(new Uint8Array(ciphertext))}`;
  } catch (error) {
    console.error('Falha ao criptografar dado sensível:', error?.message || error);
    return value;
  }
}
