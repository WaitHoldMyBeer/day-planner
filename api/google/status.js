import { route } from '../../lib/http.js';
import { requireUser } from '../../lib/auth.js';
import { status } from '../../lib/google.js';

export default route({
  GET: async (req, res) => {
    const user = await requireUser(req);
    res.status(200).json(await status(user.id));
  },
});
