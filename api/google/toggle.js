import { route, body, HttpError } from '../../lib/http.js';
import { requireUser } from '../../lib/auth.js';
import { getAccount, setEnabled, status } from '../../lib/google.js';

export default route({
  POST: async (req, res) => {
    const user = await requireUser(req);
    const acct = await getAccount(user.id);
    if (!acct) throw new HttpError(409, 'Connect Google Calendar first.', { code: 'not_connected' });
    await setEnabled(user.id, !!body(req).enabled);
    res.status(200).json(await status(user.id));
  },
});
