// Accounts and sessions. Passwords are hashed with scrypt (node:crypto, no dependency);
// sessions are random ids stored server-side and carried in an httpOnly cookie.
import crypto from 'node:crypto';
import { q, one } from './db.js';
import { unauthorized, bad, isSecure } from './http.js';

export const COOKIE = 'dp_session';
const SESSION_DAYS = 90;
const SCRYPT = { N: 16384, r: 8, p: 1 };

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, SCRYPT);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [algo, saltHex, hashHex] = String(stored || '').split('$');
  if (algo !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length, SCRYPT);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

export const normalizeEmail = (e) => String(e || '').trim().toLowerCase();
export const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 200;

export function validatePassword(p) {
  if (typeof p !== 'string' || p.length < 8) throw bad('Use a password of at least 8 characters.');
  if (p.length > 200) throw bad('That password is too long.');
}

export function publicUser(row) {
  return { id: String(row.id), email: row.email, name: row.name || '' };
}

export async function createSession(res, req, userId) {
  const id = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000);
  await q('INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, $3)', [id, userId, expires.toISOString()]);
  setCookie(res, req, id, SESSION_DAYS * 86400);
  return id;
}

export function setCookie(res, req, value, maxAge) {
  const parts = [`${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
  if (isSecure(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function readCookie(req) {
  if (req.cookies && typeof req.cookies === 'object') return req.cookies[COOKIE] || null;
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return v.join('=');
  }
  return null;
}

/** The user a session id belongs to, or null when the session is missing or expired. */
export async function userBySession(sid) {
  if (!sid || typeof sid !== 'string') return null;
  const row = await one(
    `SELECT u.id, u.email, u.name, s.id AS sid FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = $1 AND s.expires_at > now()`,
    [sid]
  );
  if (!row) return null;
  return { ...publicUser(row), sid: row.sid };
}

/** The signed-in user for this request, or null. */
export async function currentUser(req) {
  return userBySession(readCookie(req));
}

// Opaque, tamper-proof state for the OAuth round trip. It carries the session so the
// callback can identify the user even when it lands on a different host than the one
// the user signed in on (cookies are per host; the callback URL is fixed per client).
export function sealState(payload) {
  return encrypt(JSON.stringify({ ...payload, ts: Date.now() }));
}
export function openState(state, maxAgeMs = 10 * 60 * 1000) {
  try {
    const p = JSON.parse(decrypt(state));
    if (!p || !p.ts || Date.now() - p.ts > maxAgeMs) return null;
    return p;
  } catch (e) { return null; }
}

export async function requireUser(req) {
  const u = await currentUser(req);
  if (!u) throw unauthorized();
  return u;
}

export async function destroySession(req, res) {
  const sid = readCookie(req);
  if (sid) await q('DELETE FROM sessions WHERE id = $1', [sid]);
  setCookie(res, req, '', 0);
}

export function secret() {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 16) throw new Error('AUTH_SECRET must be set to a long random string.');
  return s;
}

// AES-256-GCM for tokens at rest; key derived from AUTH_SECRET.
function key() {
  return crypto.createHash('sha256').update(secret()).digest();
}
export function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return [iv.toString('base64url'), c.getAuthTag().toString('base64url'), enc.toString('base64url')].join('.');
}
export function decrypt(blob) {
  const [ivB, tagB, encB] = String(blob || '').split('.');
  if (!ivB || !tagB || !encB) throw new Error('Bad ciphertext');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB, 'base64url'));
  d.setAuthTag(Buffer.from(tagB, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(encB, 'base64url')), d.final()]).toString('utf8');
}

// Signed, short-lived state for the OAuth round trip.
export function signState(payload) {
  const data = Buffer.from(JSON.stringify({ ...payload, ts: Date.now() })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret()).update(data).digest('base64url');
  return `${data}.${sig}`;
}
export function verifyState(state, maxAgeMs = 10 * 60 * 1000) {
  const [data, sig] = String(state || '').split('.');
  if (!data || !sig) return null;
  const expected = crypto.createHmac('sha256', secret()).update(data).digest('base64url');
  const a = Buffer.from(sig); const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')); } catch (e) { return null; }
  if (!payload.ts || Date.now() - payload.ts > maxAgeMs) return null;
  return payload;
}
