import { route, body, bad, isId } from '../../lib/http.js';
import { q } from '../../lib/db.js';
import { requireUser } from '../../lib/auth.js';
import { cleanTodo, rev } from '../../lib/validate.js';

export default route({
  PUT: async (req, res) => {
    const user = await requireUser(req);
    const id = req.query.id;
    if (!isId(id)) throw bad('Bad task id.');
    const b = body(req);
    const data = cleanTodo(b);
    const r = rev(b.rev);
    await q(
      `INSERT INTO todos (user_id, id, data, rev, updated_at) VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (user_id, id) DO UPDATE SET data = EXCLUDED.data, rev = EXCLUDED.rev, updated_at = now()`,
      [user.id, id, JSON.stringify(data), r]
    );
    res.status(200).json({ ok: true, rev: r });
  },
  DELETE: async (req, res) => {
    const user = await requireUser(req);
    const id = req.query.id;
    if (!isId(id)) throw bad('Bad task id.');
    await q('DELETE FROM todos WHERE user_id = $1 AND id = $2', [user.id, id]);
    res.status(200).json({ ok: true });
  },
});
