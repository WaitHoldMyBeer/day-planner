import { route, unauthorized } from '../../lib/http.js';
import { currentUser } from '../../lib/auth.js';

export default route({
  GET: async (req, res) => {
    const u = await currentUser(req);
    if (!u) throw unauthorized();
    res.status(200).json({ user: { id: u.id, email: u.email, name: u.name } });
  },
});
