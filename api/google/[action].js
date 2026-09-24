// One function serves every /api/google/* route (Vercel's Hobby plan caps functions per
// deployment). `action` comes from the path:
//   GET  status                      connection state for the signed-in user
//   GET  connect                     starts the OAuth round trip (browser navigation)
//   GET  callback                    OAuth return; stores tokens, redirects to /
//   POST disconnect                  revokes and forgets the Google account
//   POST toggle {enabled}            show/hide Google events
//   GET  events?timeMin&timeMax      events on the primary calendar in that window
//   POST events {summary,start,end}  create an event
//   DELETE events?id=...             delete an event
import { route, body, bad, origin, requestOrigin, HttpError } from '../../lib/http.js';
import { requireUser, userBySession, sealState, openState } from '../../lib/auth.js';
import {
  requireConfig, authUrl, exchangeCode, saveAccount, status, getAccount, setEnabled, disconnect,
  listEvents, createEvent, deleteEvent,
} from '../../lib/google.js';

const isIso = (s) => typeof s === 'string' && !Number.isNaN(Date.parse(s));

const handlers = {
  status: route({
    GET: async (req, res) => {
      const user = await requireUser(req);
      res.status(200).json(await status(user.id));
    },
  }),

  // The redirect URI registered with Google is fixed (APP_URL). The user may be on another
  // alias of the app, where the session cookie lives, so the state carries the session and
  // the origin to return to; the callback trusts the state, not the cookie.
  connect: route({
    GET: async (req, res) => {
      const user = await requireUser(req);
      requireConfig();
      const redirectUri = `${origin(req)}/api/google/callback`;
      const state = sealState({ uid: user.id, sid: user.sid, o: requestOrigin(req) });
      res.redirect(302, authUrl(redirectUri, state));
    },
  }),

  callback: route({
    GET: async (req, res) => {
      const st = openState(req.query.state);
      const home = st && typeof st.o === 'string' && /^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(st.o) ? st.o : '';
      const back = (s) => res.redirect(302, `${home}/?google=${s}`);
      if (req.query.error) return back('denied');
      if (!st) return back('badstate');
      const user = await userBySession(st.sid);
      if (!user || String(user.id) !== String(st.uid)) return back('signedout');
      try { requireConfig(); } catch (e) { return back('notconfigured'); }
      const code = req.query.code;
      if (!code) return back('error');
      try {
        const tokens = await exchangeCode(code, `${origin(req)}/api/google/callback`);
        await saveAccount(user.id, tokens);
      } catch (e) {
        console.error('[google callback]', e && e.message ? e.message : e);
        return back(e && e.status === 400 ? 'norefresh' : 'error');
      }
      return back('connected');
    },
  }),

  disconnect: route({
    POST: async (req, res) => {
      const user = await requireUser(req);
      await disconnect(user.id);
      res.status(200).json({ ok: true });
    },
  }),

  toggle: route({
    POST: async (req, res) => {
      const user = await requireUser(req);
      const acct = await getAccount(user.id);
      if (!acct) throw new HttpError(409, 'Connect Google Calendar first.', { code: 'not_connected' });
      await setEnabled(user.id, !!body(req).enabled);
      res.status(200).json(await status(user.id));
    },
  }),

  events: route({
    GET: async (req, res) => {
      const user = await requireUser(req);
      const { timeMin, timeMax } = req.query;
      if (!isIso(timeMin) || !isIso(timeMax)) throw bad('timeMin and timeMax must be ISO timestamps.');
      if (Date.parse(timeMax) - Date.parse(timeMin) > 8 * 86400000) throw bad('Window too large.');
      const events = await listEvents(user.id, new Date(timeMin).toISOString(), new Date(timeMax).toISOString());
      res.status(200).json({ events });
    },
    POST: async (req, res) => {
      const user = await requireUser(req);
      const b = body(req);
      const summary = String(b.summary || '').trim().slice(0, 300) || 'Untitled';
      if (!isIso(b.start) || !isIso(b.end)) throw bad('start and end must be ISO timestamps.');
      if (Date.parse(b.end) <= Date.parse(b.start)) throw bad('end must be after start.');
      const event = await createEvent(user.id, {
        summary,
        description: String(b.description || '').slice(0, 2000),
        start: new Date(b.start).toISOString(),
        end: new Date(b.end).toISOString(),
      });
      res.status(200).json({ event });
    },
    DELETE: async (req, res) => {
      const user = await requireUser(req);
      const id = req.query.id;
      if (typeof id !== 'string' || !id || id.length > 300) throw bad('Bad event id.');
      await deleteEvent(user.id, id);
      res.status(200).json({ ok: true });
    },
  }),
};

export default async function handler(req, res) {
  const h = handlers[req.query.action];
  if (!h) { res.status(404).json({ error: 'No such route.' }); return; }
  return h(req, res);
}
