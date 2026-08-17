/**
 * Authentication primitives.
 *
 * Everything here uses WebCrypto rather than a native module, so the identical
 * code runs on Node and on Cloudflare Workers. That rules out bcrypt/argon2,
 * so passwords use PBKDF2-SHA256 with a high iteration count — the strongest
 * option available in the standard WebCrypto surface.
 */

const PBKDF2_ITERATIONS = 210_000;
const SALT_BYTES = 16;
const KEY_BITS = 256;

const encoder = new TextEncoder();

/* -------------------------------------------------------------------------- */
/* Passwords                                                                  */
/* -------------------------------------------------------------------------- */

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64(salt)}$${b64(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;

  const iterations = Number(parts[1]);
  const salt = unb64(parts[2]!);
  const expected = unb64(parts[3]!);
  if (!Number.isFinite(iterations) || iterations <= 0) return false;

  const actual = await pbkdf2(password, salt, iterations);
  return timingSafeEqual(actual, expected);
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    // The cast keeps this compiling against both the DOM and Workers lib
    // definitions, which disagree on whether a Uint8Array is a BufferSource.
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    key,
    KEY_BITS,
  );
  return new Uint8Array(bits);
}

/** Constant-time comparison so a wrong password cannot be found byte by byte. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/* -------------------------------------------------------------------------- */
/* Single-use tokens (magic links, invites)                                   */
/* -------------------------------------------------------------------------- */

/** A URL-safe random token. Only its hash is ever stored. */
export function generateToken(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(token));
  return b64(new Uint8Array(digest));
}

/* -------------------------------------------------------------------------- */
/* JWT (HS256)                                                                */
/* -------------------------------------------------------------------------- */

export interface JwtPayload {
  sub: string;
  email: string;
  exp: number;
  iat: number;
}

export async function signJwt(
  payload: Omit<JwtPayload, 'exp' | 'iat'>,
  secret: string,
  ttlSeconds = 60 * 60 * 24 * 30,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const body: JwtPayload = { ...payload, iat: now, exp: now + ttlSeconds };

  const header = b64url(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const claims = b64url(encoder.encode(JSON.stringify(body)));
  const signature = await sign(`${header}.${claims}`, secret);
  return `${header}.${claims}.${signature}`;
}

export async function verifyJwt(token: string, secret: string): Promise<JwtPayload | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [header, claims, signature] = parts as [string, string, string];
  const expected = await sign(`${header}.${claims}`, secret);
  if (!timingSafeEqual(encoder.encode(signature), encoder.encode(expected))) return null;

  try {
    const payload = JSON.parse(new TextDecoder().decode(unb64url(claims))) as JwtPayload;
    if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

async function sign(data: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  return b64url(new Uint8Array(signature));
}

/* -------------------------------------------------------------------------- */
/* Base64 helpers                                                             */
/* -------------------------------------------------------------------------- */

function b64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function unb64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function b64url(bytes: Uint8Array): string {
  return b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  return unb64(padded + '='.repeat((4 - (padded.length % 4)) % 4));
}
