import { route, body } from '../lib/http.js';
import { q, one } from '../lib/db.js';
import { requireUser } from '../lib/auth.js';
import { cleanSettings, rev } from '../lib/validate.js';

export default route({
  GET: async (req, res) => {
    const user = await requireUser(req);
    const row = await one('SELECT data, rev FROM settings WHERE user_id = $1', [user.id]);
    res.status(200).json({ settings: row ? { ...row.data, rev: row.rev } : null });
  },
  PUT: async (req, res) => {
    const user = await requireUser(req);
    const b = body(req);
    const data = cleanSettings(b);
    const r = rev(b.rev);
    await q(
      `INSERT INTO settings (user_id, data, rev, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, rev = EXCLUDED.rev, updated_at = now()`,
      [user.id, JSON.stringify(data), r]
    );
    res.status(200).json({ ok: true, rev: r });
  },
});
