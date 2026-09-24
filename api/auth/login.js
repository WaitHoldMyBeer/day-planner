import { route, body, bad } from '../../lib/http.js';
import { one } from '../../lib/db.js';
import { verifyPassword, hashPassword, normalizeEmail, createSession, publicUser } from '../../lib/auth.js';

// Used when the email is unknown so both paths cost the same.
const DUMMY = hashPassword('dummy-password-for-timing');

export default route({
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
});
