// One function serves every /api/routine/* route (Vercel's Hobby plan caps functions per
// deployment). The app authenticates with the session cookie; the routine on the user's
// computer with `Authorization: Bearer <key>` and never a cookie. Contract: routine/SPEC.md.
//   POST pair {hash, name}               session  link a computer's key; turns the beta flag on
//   POST unpair {id}                     session  forget a key
//   POST accept {fingerprint, todoId}    session  suggestion → accepted
//   POST dismiss {fingerprint, reason?}  session  suggestion → dismissed
//   POST restore {fingerprint}           session  suggestion → new
//   GET  context                         key      to-dos, suggestion history, feedback
//   POST report {runId, date, brief, suggestions}  key  upsert suggestions, replace the day's brief
import { route, body } from '../../lib/http.js';
import { requireUser } from '../../lib/auth.js';
import {
  requireRoutineUser, requireEnabled, buildContext, applyReport, pair, unpair, accept, dismiss, restore,
} from '../../lib/routine.js';

const session = (fn) => route({
  POST: async (req, res) => {
    const user = await requireUser(req);
    res.status(200).json(await fn(user.id, body(req)));
  },
});

const handlers = {
  pair: session(pair),
  unpair: session(unpair),
  accept: session(accept),
  dismiss: session(dismiss),
  restore: session(restore),

  context: route({
    GET: async (req, res) => {
      const user = await requireRoutineUser(req);
      await requireEnabled(user.id);
      res.status(200).json(await buildContext(user));
    },
  }),

  report: route({
    POST: async (req, res) => {
      const user = await requireRoutineUser(req);
      await requireEnabled(user.id);
      res.status(200).json(await applyReport(user.id, body(req)));
    },
  }),
};

export default async function handler(req, res) {
  const action = req.query.action;
  if (!Object.hasOwn(handlers, action)) { res.status(404).json({ error: 'No such route.' }); return; }
  return handlers[action](req, res);
}
