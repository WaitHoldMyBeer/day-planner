import { route, body, bad, isDate } from '../../lib/http.js';
import { q, one } from '../../lib/db.js';
import { requireUser } from '../../lib/auth.js';
import { cleanBlocks, rev } from '../../lib/validate.js';

export default route({
  GET: async (req, res) => {
    const user = await requireUser(req);
    const date = req.query.date;
    if (!isDate(date)) throw bad('date must be YYYY-MM-DD.');
    const row = await one('SELECT date, data, rev, updated_at FROM days WHERE user_id = $1 AND date = $2', [user.id, date]);
    res.status(200).json({ day: row ? { date: row.date, blocks: row.data.blocks || [], rev: row.rev, updatedAt: row.updated_at } : null });
  },
  PUT: async (req, res) => {
    const user = await requireUser(req);
    const date = req.query.date;
    if (!isDate(date)) throw bad('date must be YYYY-MM-DD.');
    const b = body(req);
    const blocks = cleanBlocks(b.blocks);
    const r = rev(b.rev);
    await q(
      `INSERT INTO days (user_id, date, data, rev, updated_at) VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (user_id, date) DO UPDATE SET data = EXCLUDED.data, rev = EXCLUDED.rev, updated_at = now()`,
      [user.id, date, JSON.stringify({ blocks }), r]
    );
    res.status(200).json({ ok: true, rev: r });
  },
});
