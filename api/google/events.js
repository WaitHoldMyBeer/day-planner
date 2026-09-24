// GET    /api/google/events?timeMin=ISO&timeMax=ISO   -> events on the primary calendar in that window
// POST   /api/google/events  {summary, start, end, description?}  -> create an event
// DELETE /api/google/events?id=...                    -> delete an event
import { route, body, bad } from '../../lib/http.js';
import { requireUser } from '../../lib/auth.js';
import { listEvents, createEvent, deleteEvent } from '../../lib/google.js';

const isIso = (s) => typeof s === 'string' && !Number.isNaN(Date.parse(s));

export default route({
  GET: async (req, res) => {
    const user = await requireUser(req);
    const { timeMin, timeMax } = req.query;
    if (!isIso(timeMin) || !isIso(timeMax)) throw bad('timeMin and timeMax must be ISO timestamps.');
    if (Date.parse(timeMax) - Date.parse(timeMin) > 8 * 86400000) throw bad('Window too large.');
    const events = await listEvents(user.id, new Date(timeMin).toISOString(), new Date(timeMax).toISOString());
    res.status(200).json({ events });
  },
  POST: async (req, res) => {
    const user = await requireUser(req);
    const b = body(req);
    const summary = String(b.summary || '').trim().slice(0, 300) || 'Untitled';
    if (!isIso(b.start) || !isIso(b.end)) throw bad('start and end must be ISO timestamps.');
    if (Date.parse(b.end) <= Date.parse(b.start)) throw bad('end must be after start.');
    const event = await createEvent(user.id, {
      summary,
      description: String(b.description || '').slice(0, 2000),
      start: new Date(b.start).toISOString(),
      end: new Date(b.end).toISOString(),
    });
    res.status(200).json({ event });
  },
  DELETE: async (req, res) => {
    const user = await requireUser(req);
    const id = req.query.id;
    if (typeof id !== 'string' || !id || id.length > 300) throw bad('Bad event id.');
    await deleteEvent(user.id, id);
    res.status(200).json({ ok: true });
  },
});
