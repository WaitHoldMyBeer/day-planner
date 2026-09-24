import { route, origin } from '../../lib/http.js';
import { currentUser, verifyState } from '../../lib/auth.js';
import { requireConfig, exchangeCode, saveAccount } from '../../lib/google.js';

export default route({
  GET: async (req, res) => {
    const back = (status) => res.redirect(302, `/?google=${status}`);
    if (req.query.error) return back('denied');
    const user = await currentUser(req);
    if (!user) return back('signedout');
    try { requireConfig(); } catch (e) { return back('notconfigured'); }
    const state = verifyState(req.query.state);
    if (!state || String(state.uid) !== String(user.id)) return back('badstate');
    const code = req.query.code;
    if (!code) return back('error');
    try {
      const tokens = await exchangeCode(code, `${origin(req)}/api/google/callback`);
      await saveAccount(user.id, tokens);
    } catch (e) {
      console.error('[google callback]', e);
      return back(e && e.status === 400 ? 'norefresh' : 'error');
    }
    return back('connected');
  },
});
