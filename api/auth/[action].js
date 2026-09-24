// One function serves /api/auth/register, /login, /logout and /me (Vercel's Hobby plan caps
// functions per deployment, so related routes share a file). `action` comes from the path.
import { route, body, bad, unauthorized } from '../../lib/http.js';
import { one } from '../../lib/db.js';
import {
  hashPassword, verifyPassword, normalizeEmail, validEmail, validatePassword,
  createSession, destroySession, currentUser, publicUser,
} from '../../lib/auth.js';

// Used when the email is unknown so both login paths cost the same.
const DUMMY = hashPassword('dummy-password-for-timing');

const handlers = {
  register: route({
    POST: async (req, res) => {
      const b = body(req);
      const email = normalizeEmail(b.email);
      if (!validEmail(email)) throw bad('Enter a valid email address.', { field: 'email' });
      validatePassword(b.password);
      const name = String(b.name || '').trim().slice(0, 80);
      const invite = process.env.INVITE_CODE;
      if (invite && String(b.invite || '').trim() !== invite) throw bad('That invite code is not right.', { field: 'invite' });
      const existing = await one('SELECT id FROM users WHERE email = $1', [email]);
      if (existing) throw bad('An account with that email already exists. Sign in instead.', { field: 'email' });
      const row = await one(
        'INSERT INTO users (email, name, pass_hash) VALUES ($1, $2, $3) RETURNING id, email, name',
        [email, name, hashPassword(b.password)]
      );
      await createSession(res, req, row.id);
      res.status(200).json({ user: publicUser(row) });
    },
  }),

  login: route({
    POST: async (req, res) => {
      const b = body(req);
      const email = normalizeEmail(b.email);
      const password = typeof b.password === 'string' ? b.password : '';
      const row = await one('SELECT id, email, name, pass_hash FROM users WHERE email = $1', [email]);
      const ok = row ? verifyPassword(password, row.pass_hash) : (verifyPassword(password, DUMMY), false);
      if (!ok) throw bad('Email or password is wrong.');
      await createSession(res, req, row.id);
      res.status(200).json({ user: publicUser(row) });
    },
  }),

  logout: route({
    POST: async (req, res) => {
      await destroySession(req, res);
      res.status(200).json({ ok: true });
    },
  }),

  me: route({
    GET: async (req, res) => {
      const u = await currentUser(req);
      if (!u) throw unauthorized();
      res.status(200).json({ user: { id: u.id, email: u.email, name: u.name } });
    },
  }),
};

export default async function handler(req, res) {
  const h = handlers[req.query.action];
  if (!h) { res.status(404).json({ error: 'No such route.' }); return; }
  return h(req, res);
}
