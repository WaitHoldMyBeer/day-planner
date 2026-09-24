import { route } from '../../lib/http.js';
import { destroySession } from '../../lib/auth.js';

export default route({
  POST: async (req, res) => {
    await destroySession(req, res);
    res.status(200).json({ ok: true });
  },
});
