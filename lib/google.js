// Google Calendar: OAuth 2.0 (web server flow) and the events API on the user's primary calendar.
import { q, one } from './db.js';
import { encrypt, decrypt } from './auth.js';
import { HttpError } from './http.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const CAL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
export const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/calendar.events'];

export function configured() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

export function requireConfig() {
  if (!configured()) {
    throw new HttpError(503, 'Google Calendar is not set up on this server yet. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.', { code: 'not_configured' });
  }
}

export function authUrl(redirectUri, state) {
  const p = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `${AUTH_URL}?${p}`;
}

async function tokenRequest(params) {
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, ...params }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(`Google token error: ${data.error || r.status} ${data.error_description || ''}`.trim());
    err.google = data.error || 'token_error';
    throw err;
  }
  return data;
}

export async function exchangeCode(code, redirectUri) {
  return tokenRequest({ code, redirect_uri: redirectUri, grant_type: 'authorization_code' });
}

function emailFromIdToken(idToken) {
  try {
    const payload = JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8'));
    return payload.email || null;
  } catch (e) { return null; }
}

export async function saveAccount(userId, tokens) {
  const email = emailFromIdToken(tokens.id_token);
  const expires = new Date(Date.now() + (Number(tokens.expires_in) || 3600) * 1000 - 30000).toISOString();
  if (tokens.refresh_token) {
    await q(
      `INSERT INTO google_accounts (user_id, email, refresh_token, access_token, expires_at, enabled)
       VALUES ($1, $2, $3, $4, $5, true)
       ON CONFLICT (user_id) DO UPDATE SET email = EXCLUDED.email, refresh_token = EXCLUDED.refresh_token,
         access_token = EXCLUDED.access_token, expires_at = EXCLUDED.expires_at, enabled = true`,
      [userId, email, encrypt(tokens.refresh_token), encrypt(tokens.access_token), expires]
    );
  } else {
    // Google omits the refresh token when the user already granted access once; keep the stored one.
    const r = await q(
      `UPDATE google_accounts SET email = COALESCE($2, email), access_token = $3, expires_at = $4, enabled = true WHERE user_id = $1`,
      [userId, email, encrypt(tokens.access_token), expires]
    );
    if (r.rowCount === 0) throw new HttpError(400, 'Google did not return a refresh token. Remove the app at myaccount.google.com/permissions and connect again.');
  }
  return email;
}

export async function getAccount(userId) {
  const row = await one('SELECT user_id, email, refresh_token, access_token, expires_at, enabled FROM google_accounts WHERE user_id = $1', [userId]);
  return row;
}

export async function status(userId) {
  const row = await getAccount(userId);
  return { configured: configured(), connected: !!row, enabled: !!(row && row.enabled), email: row ? row.email : null };
}

export async function setEnabled(userId, enabled) {
  await q('UPDATE google_accounts SET enabled = $2 WHERE user_id = $1', [userId, !!enabled]);
}

export async function disconnect(userId) {
  const row = await getAccount(userId);
  if (row) {
    try {
      const token = decrypt(row.refresh_token);
      await fetch(`${REVOKE_URL}?token=${encodeURIComponent(token)}`, { method: 'POST' });
    } catch (e) { /* revocation is best effort */ }
    await q('DELETE FROM google_accounts WHERE user_id = $1', [userId]);
  }
}

/** A valid access token for the user, refreshing when it is close to expiry. */
async function accessToken(userId) {
  requireConfig();
  const row = await getAccount(userId);
  if (!row) throw new HttpError(409, 'Google Calendar is not connected.', { code: 'not_connected' });
  if (row.access_token && row.expires_at && new Date(row.expires_at).getTime() > Date.now()) {
    return decrypt(row.access_token);
  }
  let data;
  try {
    data = await tokenRequest({ refresh_token: decrypt(row.refresh_token), grant_type: 'refresh_token' });
  } catch (e) {
    if (e.google === 'invalid_grant') {
      await q('DELETE FROM google_accounts WHERE user_id = $1', [userId]);
      throw new HttpError(409, 'Google access expired. Connect Google Calendar again.', { code: 'reconnect' });
    }
    throw e;
  }
  const expires = new Date(Date.now() + (Number(data.expires_in) || 3600) * 1000 - 30000).toISOString();
  await q('UPDATE google_accounts SET access_token = $2, expires_at = $3 WHERE user_id = $1', [userId, encrypt(data.access_token), expires]);
  return data.access_token;
}

async function call(userId, method, url, bodyObj) {
  const token = await accessToken(userId);
  const r = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(bodyObj ? { 'Content-Type': 'application/json' } : {}) },
    body: bodyObj ? JSON.stringify(bodyObj) : undefined,
  });
  if (r.status === 204) return null;
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = (data.error && data.error.message) || `Google Calendar error ${r.status}`;
    if (r.status === 401) throw new HttpError(409, 'Google access expired. Connect Google Calendar again.', { code: 'reconnect' });
    if (r.status === 403) throw new HttpError(403, `Google refused the request: ${msg}`, { code: 'google_forbidden' });
    if (r.status === 404 || r.status === 410) throw new HttpError(404, 'That event no longer exists in Google Calendar.', { code: 'gone' });
    throw new HttpError(502, msg, { code: 'google_error' });
  }
  return data;
}

function simplify(item) {
  const allDay = !!(item.start && item.start.date && !item.start.dateTime);
  return {
    id: item.id,
    summary: item.summary || '(No title)',
    description: item.description || '',
    start: allDay ? item.start.date : item.start.dateTime,
    end: allDay ? item.end.date : item.end.dateTime,
    allDay,
    htmlLink: item.htmlLink || null,
    location: item.location || '',
    status: item.status || 'confirmed',
    fromApp: !!(item.extendedProperties && item.extendedProperties.private && item.extendedProperties.private.dayPlanner),
  };
}

export async function listEvents(userId, timeMin, timeMax) {
  const p = new URLSearchParams({ singleEvents: 'true', orderBy: 'startTime', timeMin, timeMax, maxResults: '250', showDeleted: 'false' });
  const data = await call(userId, 'GET', `${CAL}?${p}`);
  return (data.items || []).filter((i) => i.status !== 'cancelled').map(simplify);
}

export async function createEvent(userId, { summary, description, start, end }) {
  const data = await call(userId, 'POST', CAL, {
    summary,
    description: description || undefined,
    start: { dateTime: start },
    end: { dateTime: end },
    extendedProperties: { private: { dayPlanner: '1' } },
  });
  return simplify(data);
}

export async function deleteEvent(userId, eventId) {
  try {
    await call(userId, 'DELETE', `${CAL}/${encodeURIComponent(eventId)}`);
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) return; // already gone
    throw e;
  }
}
