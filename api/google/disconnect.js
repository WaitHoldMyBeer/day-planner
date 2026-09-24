import { route } from '../../lib/http.js';
import { requireUser } from '../../lib/auth.js';
import { disconnect } from '../../lib/google.js';

export default route({
  POST: async (req, res) => {
    const user = await requireUser(req);
    await disconnect(user.id);
    res.status(200).json({ ok: true });
  },
});
