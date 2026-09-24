// Starts the OAuth round trip. The browser navigates here, so it is a GET.
import { route, origin } from '../../lib/http.js';
import { requireUser, signState } from '../../lib/auth.js';
import { requireConfig, authUrl } from '../../lib/google.js';

export default route({
  GET: async (req, res) => {
    const user = await requireUser(req);
    requireConfig();
    const redirectUri = `${origin(req)}/api/google/callback`;
    const state = signState({ uid: user.id });
    res.redirect(302, authUrl(redirectUri, state));
  },
});
