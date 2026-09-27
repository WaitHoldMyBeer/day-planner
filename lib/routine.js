// Claude's suggestions (beta). The routine runs on the user's own computer and talks to the
// planner with a bearer key; the planner stores only the key's sha256. See routine/SPEC.md.
import crypto from 'node:crypto';
import { q, one, tx } from './db.js';
import { HttpError, bad, notFound, unauthorized, isDate, isId } from './http.js';
import { cleanSuggestion, cleanBrief, cleanFingerprint, cleanText } from './validate.js';

const MAX_KEYS = 5;
const MAX_REPORT = 60;
const MAX_WITHDRAW = 60;
const KEY_HASH = /^[a-f0-9]{64}$/;

// Kept in suggestions.data next to the routine's content, but owned by the server.
// `withdrawn` marks a dismissal by the routine (the item became moot), never by the user.
const SERVER_FIELDS = ['todoId', 'dismissedReason', 'resurfacedAt', 'withdrawn'];
// Per-run fields that must not make identical content look changed.
const VOLATILE = ['resurface', 'runId', 'generatedAt'];

export const hashKey = (key) => crypto.createHash('sha256').update(String(key), 'utf8').digest('hex');
const newRev = () => crypto.randomBytes(8).toString('hex');

// ---- authentication and the flag

/** The user a routine key belongs to. Marks the key used. Never looks at cookies. */
export async function requireRoutineUser(req) {
  const m = /^Bearer\s+(\S{1,512})$/i.exec(String(req.headers.authorization || '').trim());
  if (!m) throw unauthorized('Send the routine key as Authorization: Bearer <key>.');
  const row = await one(
    `UPDATE routine_keys k SET last_used_at = now() FROM users u
     WHERE k.key_hash = $1 AND u.id = k.user_id
     RETURNING u.id, u.name, k.id AS key_id`,
    [hashKey(m[1])]
  );
  if (!row) throw unauthorized('Unknown routine key. Pair this computer with the planner again.');
  return { id: String(row.id), name: row.name || '', keyId: String(row.key_id) };
}

export async function isEnabled(userId) {
  const row = await one(`SELECT data->'beta'->'suggestions' = 'true'::jsonb AS enabled FROM settings WHERE user_id = $1`, [userId]);
  return !!(row && row.enabled);
}

export async function requireEnabled(userId) {
  if (!(await isEnabled(userId))) {
    throw new HttpError(409, "Claude's suggestions are turned off in the planner (User menu → Beta features).", { code: 'disabled' });
  }
}

// Sets beta.suggestions without touching other settings; bumps rev so clients pick it up.
async function enableFlag(userId) {
  await q(
    `INSERT INTO settings (user_id, data, rev, updated_at) VALUES ($1, '{"beta":{"suggestions":true}}'::jsonb, $2, now())
     ON CONFLICT (user_id) DO UPDATE SET
       data = settings.data || jsonb_build_object('beta',
         (CASE WHEN jsonb_typeof(settings.data->'beta') = 'object' THEN settings.data->'beta' ELSE '{}'::jsonb END)
         || '{"suggestions":true}'::jsonb),
       rev = EXCLUDED.rev, updated_at = now()
     WHERE settings.data->'beta'->'suggestions' IS DISTINCT FROM 'true'::jsonb`,
    [userId, newRev()]
  );
}

// ---- shapes returned to clients

const publicKey = (r) => ({ id: String(r.id), name: r.name, createdAt: r.created_at, lastUsedAt: r.last_used_at || null });

function present(row) {
  const { todoId = null, dismissedReason = null, resurfacedAt = null, withdrawn = null, ...rest } = row.data;
  return {
    ...rest,
    fingerprint: row.fingerprint,
    status: row.status,
    firstSeen: row.first_seen,
    updatedAt: row.updated_at,
    rev: row.rev,
    todoId,
    dismissedReason,
    resurfacedAt,
    withdrawn,
  };
}

// The routine's view of history: enough to learn from, without the full card.
function historyItem(row) {
  const d = row.data;
  return {
    fingerprint: row.fingerprint,
    title: d.title,
    status: row.status,
    priority: d.priority,
    source: { kind: d.source && d.source.kind, label: d.source && d.source.label },
    due: d.due ?? null,
    addedBy: d.addedBy,
    todoId: d.todoId ?? null,
    dismissedReason: d.dismissedReason ?? null,
    withdrawn: d.withdrawn ? d.withdrawn.reason : null,
    updatedAt: row.updated_at,
  };
}

const SUGGESTION_COLS = 'fingerprint, data, status, rev, first_seen, updated_at';

export async function buildContext(user) {
  const [todos, suggestions, feedback, brief] = await Promise.all([
    q('SELECT id, data FROM todos WHERE user_id = $1', [user.id]),
    // Every status from the last 60 days, plus anything still open however old.
    q(
      `SELECT ${SUGGESTION_COLS} FROM suggestions
       WHERE user_id = $1 AND (status = 'new' OR updated_at > now() - interval '60 days')
       ORDER BY updated_at DESC`,
      [user.id]
    ),
    // A withdrawal by the routine is not the user's judgement, so it is counted apart.
    one(
      `SELECT count(*) FILTER (WHERE status = 'accepted')::int AS accepted,
              count(*) FILTER (WHERE status = 'dismissed' AND NOT data ? 'withdrawn')::int AS dismissed,
              count(*) FILTER (WHERE status = 'dismissed' AND data ? 'withdrawn')::int AS withdrawn
       FROM suggestions WHERE user_id = $1 AND updated_at > now() - interval '30 days'`,
      [user.id]
    ),
    one(`SELECT date, data->>'runId' AS run_id FROM briefs WHERE user_id = $1 ORDER BY date DESC LIMIT 1`, [user.id]),
  ]);
  return {
    enabled: true,
    user: { name: user.name },
    serverTime: new Date().toISOString(),
    todos: todos.rows
      .sort((a, b) => (Number(a.data.order) || 0) - (Number(b.data.order) || 0))
      .map((r) => ({
        id: r.id,
        title: r.data.title,
        tag: r.data.tag ?? null,
        duration: r.data.duration ?? null,
        done: !!r.data.done,
        scheduled: Array.isArray(r.data.scheduled) ? r.data.scheduled : [],
      })),
    suggestions: suggestions.rows.map(historyItem),
    feedback: { accepted30d: feedback.accepted, dismissed30d: feedback.dismissed, withdrawn30d: feedback.withdrawn },
    lastBrief: brief ? { date: brief.date, runId: brief.run_id } : null,
  };
}

/** The `routine` member of GET /api/sync. */
export async function buildSyncMember(userId) {
  const [enabled, keys] = await Promise.all([
    isEnabled(userId),
    q('SELECT id, name, created_at, last_used_at FROM routine_keys WHERE user_id = $1 ORDER BY id', [userId]),
  ]);
  const out = { enabled, keys: keys.rows.map(publicKey) };
  if (!enabled) return out;
  const [suggestions, brief] = await Promise.all([
    q(
      `SELECT ${SUGGESTION_COLS} FROM suggestions
       WHERE user_id = $1 AND (status = 'new' OR updated_at > now() - interval '7 days')
       ORDER BY updated_at DESC`,
      [userId]
    ),
    one('SELECT data FROM briefs WHERE user_id = $1 ORDER BY date DESC LIMIT 1', [userId]),
  ]);
  out.suggestions = suggestions.rows.map(present);
  out.brief = brief ? brief.data : null;
  return out;
}

// ---- report (key-authenticated)

function content(data) {
  const out = { ...data };
  for (const k of [...SERVER_FIELDS, ...VOLATILE]) delete out[k];
  return out;
}

// Deep equality that ignores key order (JSONB does not keep it).
function same(a, b) {
  if (a === b) return true;
  if (a == null || b == null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a); const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && same(a[k], b[k]));
}

function cleanReport(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad('The report must be a JSON object.');
  if (!isDate(b.date)) throw bad('date must be YYYY-MM-DD.');
  const runId = cleanText(b.runId, 60, 'runId') || null;
  if (b.suggestions != null && !Array.isArray(b.suggestions)) throw bad('suggestions must be a list.');
  const list = b.suggestions || [];
  if (list.length > MAX_REPORT) throw bad(`At most ${MAX_REPORT} suggestions per report (got ${list.length}).`);
  const seen = new Set();
  const suggestions = list.map((s, i) => {
    let out;
    try { out = cleanSuggestion(s); } catch (e) {
      if (e instanceof HttpError) throw bad(`suggestions[${i}]: ${e.message}`);
      throw e;
    }
    if (seen.has(out.fingerprint)) throw bad(`suggestions[${i}]: fingerprint ${out.fingerprint} appears twice in this report.`);
    seen.add(out.fingerprint);
    return out;
  });
  if (b.withdraw != null && !Array.isArray(b.withdraw)) throw bad('withdraw must be a list.');
  const wlist = b.withdraw || [];
  if (wlist.length > MAX_WITHDRAW) throw bad(`At most ${MAX_WITHDRAW} withdrawals per report (got ${wlist.length}).`);
  const gone = new Set();
  const withdraw = wlist.map((w, i) => {
    if (!w || typeof w !== 'object' || Array.isArray(w)) throw bad(`withdraw[${i}]: Each withdrawal must be an object.`);
    let fingerprint; let reason;
    try {
      fingerprint = cleanFingerprint(w.fingerprint);
      reason = cleanText(w.reason, 160, 'reason');
    } catch (e) {
      if (e instanceof HttpError) throw bad(`withdraw[${i}]: ${e.message}`);
      throw e;
    }
    if (!reason) throw bad(`withdraw[${i}]: reason is required.`);
    if (seen.has(fingerprint)) throw bad(`withdraw[${i}]: fingerprint ${fingerprint} is both suggested and withdrawn in this report.`);
    if (gone.has(fingerprint)) throw bad(`withdraw[${i}]: fingerprint ${fingerprint} appears twice in withdraw.`);
    gone.add(fingerprint);
    return { fingerprint, reason };
  });
  let brief = null;
  if (b.brief != null) {
    if (typeof b.brief !== 'object' || Array.isArray(b.brief)) throw bad('brief must be an object.');
    if (b.brief.date != null && b.brief.date !== b.date) throw bad('brief.date must match the report date.');
    brief = cleanBrief({ ...b.brief, date: b.date, runId: b.brief.runId ?? runId });
  }
  return { date: b.date, suggestions, withdraw, brief };
}

/** Apply one run's report: upsert suggestions per SPEC §4, withdraw moot ones, and replace that day's brief. */
export async function applyReport(userId, body) {
  const report = cleanReport(body);
  return tx(async (c) => {
    // Serializes reports per user so two runs cannot both insert or both judge the same row.
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`routine-report:${userId}`]);
    const fps = report.suggestions.map((s) => s.fingerprint);
    const existing = new Map();
    if (fps.length) {
      const r = await c.query(
        'SELECT fingerprint, data, status FROM suggestions WHERE user_id = $1 AND fingerprint = ANY($2::text[]) FOR UPDATE',
        [userId, fps]
      );
      for (const row of r.rows) existing.set(row.fingerprint, row);
    }
    const counts = { created: 0, updated: 0, unchanged: 0, resurfaced: 0, keptHandled: 0, withdrawn: 0 };
    const write = (sql, data, extra = []) => c.query(sql, [userId, data.fingerprint, JSON.stringify(data), newRev(), ...extra]);
    for (const s of report.suggestions) {
      const incoming = content(s);
      const row = existing.get(s.fingerprint);
      if (!row) {
        await write(
          `INSERT INTO suggestions (user_id, fingerprint, data, status, rev, first_seen, updated_at)
           VALUES ($1, $2, $3, 'new', $4, now(), now())`,
          incoming
        );
        counts.created++;
      } else if (row.status === 'new') {
        if (same(content(row.data), incoming)) { counts.unchanged++; continue; }
        const next = row.data.resurfacedAt ? { ...incoming, resurfacedAt: row.data.resurfacedAt } : incoming;
        await write('UPDATE suggestions SET data = $3, rev = $4, updated_at = now() WHERE user_id = $1 AND fingerprint = $2', next);
        counts.updated++;
      } else if (s.resurface) {
        // A material change: take the new content and put it back in front of the user.
        await write(
          `UPDATE suggestions SET status = 'new', data = $3, rev = $4, updated_at = now() WHERE user_id = $1 AND fingerprint = $2`,
          { ...incoming, resurfacedAt: new Date().toISOString() }
        );
        counts.resurfaced++;
      } else {
        counts.keptHandled++;
      }
    }
    // Only an open item can be withdrawn; anything the user already handled stays theirs.
    const at = new Date().toISOString();
    for (const w of report.withdraw) {
      const r = await c.query(
        `UPDATE suggestions SET status = 'dismissed',
           data = (data - 'todoId' - 'dismissedReason') || $3::jsonb, rev = $4, updated_at = now()
         WHERE user_id = $1 AND fingerprint = $2 AND status = 'new'`,
        [userId, w.fingerprint, JSON.stringify({ withdrawn: { reason: w.reason, at } }), newRev()]
      );
      counts.withdrawn += r.rowCount;
    }
    if (report.brief) {
      await c.query(
        `INSERT INTO briefs (user_id, date, data, updated_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (user_id, date) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
        [userId, report.date, JSON.stringify(report.brief)]
      );
    }
    return counts;
  });
}

// ---- session-side mutations (the app)

function keyId(v) {
  const s = typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : v;
  if (typeof s !== 'string' || !/^[1-9]\d{0,17}$/.test(s)) throw bad('Bad key id.');
  return s;
}

export async function pair(userId, b) {
  const hash = b.hash;
  if (typeof hash !== 'string' || !KEY_HASH.test(hash)) throw bad('hash must be the sha256 hex digest of the key (64 lowercase hex characters).');
  const name = cleanText(b.name, 60, 'name');
  const inUse = new HttpError(409, 'That key is already linked to an account. Generate a new key on that computer.', { code: 'key_in_use' });
  const existing = await one('SELECT id, user_id, name FROM routine_keys WHERE key_hash = $1', [hash]);
  if (existing && String(existing.user_id) !== String(userId)) throw inUse;
  let row;
  if (existing) {
    row = await one(
      'UPDATE routine_keys SET name = $3 WHERE id = $1 AND user_id = $2 RETURNING id, name, created_at',
      [existing.id, userId, name || existing.name]
    );
  } else {
    const n = await one('SELECT count(*)::int AS n FROM routine_keys WHERE user_id = $1', [userId]);
    if (n.n >= MAX_KEYS) throw bad(`At most ${MAX_KEYS} computers can be linked. Unlink one first.`, { code: 'too_many_keys' });
    try {
      row = await one(
        'INSERT INTO routine_keys (user_id, key_hash, name) VALUES ($1, $2, $3) RETURNING id, name, created_at',
        [userId, hash, name]
      );
    } catch (e) {
      if (e && e.code === '23505') throw inUse;
      throw e;
    }
  }
  await enableFlag(userId);
  return { key: { id: String(row.id), name: row.name, createdAt: row.created_at } };
}

export async function unpair(userId, b) {
  await q('DELETE FROM routine_keys WHERE user_id = $1 AND id = $2', [userId, keyId(b.id)]);
  return { ok: true };
}

// Server fields describe the current status only, so every transition clears them first.
async function setStatus(userId, fingerprint, status, extra = {}) {
  const row = await one(
    `UPDATE suggestions SET status = $3, data = (data - 'todoId' - 'dismissedReason' - 'withdrawn') || $4::jsonb, rev = $5, updated_at = now()
     WHERE user_id = $1 AND fingerprint = $2
     RETURNING ${SUGGESTION_COLS}`,
    [userId, fingerprint, status, JSON.stringify(extra), newRev()]
  );
  if (!row) throw notFound('No such suggestion.');
  return { ok: true, suggestion: present(row) };
}

export async function accept(userId, b) {
  const fingerprint = cleanFingerprint(b.fingerprint);
  if (!isId(b.todoId)) throw bad('todoId must be a to-do id.');
  return setStatus(userId, fingerprint, 'accepted', { todoId: b.todoId });
}

export async function dismiss(userId, b) {
  const fingerprint = cleanFingerprint(b.fingerprint);
  const reason = cleanText(b.reason, 120, 'reason');
  return setStatus(userId, fingerprint, 'dismissed', reason ? { dismissedReason: reason } : {});
}

export async function restore(userId, b) {
  return setStatus(userId, cleanFingerprint(b.fingerprint), 'new');
}
