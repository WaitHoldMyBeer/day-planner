// One round trip returns everything the client needs for a date: the day, every task,
// settings, Google Calendar connection state, and Claude's suggestions. The client polls this.
import { route, bad, isDate } from '../lib/http.js';
import { q, one } from '../lib/db.js';
import { requireUser } from '../lib/auth.js';
import { status as googleStatus } from '../lib/google.js';
import { buildSyncMember } from '../lib/routine.js';

export default route({
  GET: async (req, res) => {
    const user = await requireUser(req);
    const date = req.query.date;
    if (!isDate(date)) throw bad('date must be YYYY-MM-DD.');
    const [day, todos, settings, google, routine] = await Promise.all([
      one('SELECT date, data, rev, updated_at FROM days WHERE user_id = $1 AND date = $2', [user.id, date]),
      q('SELECT id, data, rev FROM todos WHERE user_id = $1', [user.id]),
      one('SELECT data, rev FROM settings WHERE user_id = $1', [user.id]),
      googleStatus(user.id),
      buildSyncMember(user.id),
    ]);
    res.status(200).json({
      user: { id: user.id, email: user.email, name: user.name },
      day: day ? { date: day.date, blocks: day.data.blocks || [], rev: day.rev, updatedAt: day.updated_at } : null,
      todos: todos.rows.map((r) => ({ id: r.id, ...r.data, rev: r.rev })),
      settings: settings ? { ...settings.data, rev: settings.rev } : null,
      google,
      routine,
      serverTime: new Date().toISOString(),
    });
  },
});
