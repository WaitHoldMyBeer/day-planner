import { route } from '../../lib/http.js';
import { q } from '../../lib/db.js';
import { requireUser } from '../../lib/auth.js';

export default route({
  GET: async (req, res) => {
    const user = await requireUser(req);
    const r = await q('SELECT id, data, rev FROM todos WHERE user_id = $1', [user.id]);
    res.status(200).json({ todos: r.rows.map((x) => ({ id: x.id, ...x.data, rev: x.rev })) });
  },
});
