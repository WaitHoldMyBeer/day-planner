import { route, body, bad } from '../../lib/http.js';
import { one } from '../../lib/db.js';
import { hashPassword, normalizeEmail, validEmail, validatePassword, createSession, publicUser } from '../../lib/auth.js';

export default route({
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
});
