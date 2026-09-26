/* Day Planner — front end. React 18 + htm, no build step.
   Talks to the API in /api. State model:
   - one document per day (blocks), one per task, one settings document;
   - every write carries a fresh `rev`; polls that return a rev this page wrote are echoes and
     are ignored, anything else is a change from another device and is applied.               */
(function () {
'use strict';
const { useState, useEffect, useRef, useCallback, useMemo, Fragment } = React;
const html = htm.bind(React.createElement);

/* ------------------------------------------------------------------ */
/* constants + helpers                                                 */
/* ------------------------------------------------------------------ */

const DAY_MIN = 1440;
const PX = 1;
const SNAP = 15;
const MAX_COLORS = 10;
const DEFAULT_DURATION = 60;
const GOOGLE_COLOR = '#4285F4';
const DEFAULT_COLORS = ['#039BE5', '#0B8043', '#F6BF26', '#F4511E', '#8E24AA', '#3F51B5'];
const QUICK_BLOCKS = [
  { key: 'focus', label: 'Focus', sub: '1 hr 30 min', duration: 90, color: '#039BE5' },
  { key: 'break', label: 'Break', sub: '15 min', duration: 15, color: '#F6BF26' },
  { key: 'custom', label: 'Custom', sub: 'choose length', duration: null, color: '#8E24AA' },
];
const DUR_CHIPS = [15, 30, 45, 60, 90, 120];

const pad = (n) => String(n).padStart(2, '0');
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const snap = (m) => Math.round(m / SNAP) * SNAP;
const clone = (o) => ({ ...o });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fmt(mins) {
  const m = ((mins % DAY_MIN) + DAY_MIN) % DAY_MIN;
  let h = Math.floor(m / 60);
  const mm = m % 60;
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 === 0 ? 12 : h % 12;
  return mm === 0 ? `${h} ${ap}` : `${h}:${pad(mm)} ${ap}`;
}
const toHHMM = (m) => `${pad(Math.floor(clamp(m, 0, 1439) / 60))}:${pad(clamp(m, 0, 1439) % 60)}`;
const fromHHMM = (s) => {
  const [h, m] = String(s || '0:0').split(':').map(Number);
  return clamp((h || 0) * 60 + (m || 0), 0, DAY_MIN);
};
function durLabel(d) {
  if (!d) return '';
  const h = Math.floor(d / 60);
  const m = d % 60;
  if (h && m) return `${h} hr ${m} min`;
  if (h) return `${h} hr`;
  return `${m} min`;
}
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
const parts = (s) => s.split('-').map(Number);
function shiftDate(s, n) {
  const [y, m, d] = parts(s);
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}
function prettyDate(s) {
  const [y, m, d] = parts(s);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}
function shortDate(s) {
  const [y, m, d] = parts(s);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}
const isValidDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const dayStart = (s) => { const [y, m, d] = parts(s); return new Date(y, m - 1, d); };
const dayMinToDate = (s, mins) => { const [y, m, d] = parts(s); return new Date(y, m - 1, d, 0, mins); };

let uid = 0;
const newId = (p) => `${p}${Date.now().toString(36)}${(uid++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const genRev = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const nowIso = () => new Date().toISOString();

function hashColor(str, palette) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}

// "Gym 45m #event" -> { title: "Gym", duration: 45, tag: "event" }
function parseQuickAdd(raw) {
  let s = String(raw || '').trim();
  let tag = null;
  let duration = null;
  s = s.replace(/(^|\s)#([\w-]+)/g, (m, sp, t) => { tag = t.toLowerCase(); return sp ? ' ' : ''; });
  s = s.replace(/(^|\s)(\d+(?:\.\d+)?)\s*h(?:r|rs|our|ours)?(?:\s*(\d+)\s*(?:m|min|mins)?)?(?=\s|$)/i, (m, sp, h, mm) => {
    duration = Math.round(parseFloat(h) * 60 + (mm ? parseInt(mm, 10) : 0));
    return ' ';
  });
  if (duration == null) {
    s = s.replace(/(^|\s)(\d+)\s*(?:m|min|mins)(?=\s|$)/i, (m, sp, mm) => { duration = parseInt(mm, 10); return ' '; });
  }
  if (duration != null) duration = clamp(Math.round(duration / 5) * 5, 5, DAY_MIN);
  return { title: s.replace(/\s+/g, ' ').trim(), tag, duration };
}

// Minutes-of-day span of a Google event on a given date (events crossing midnight are clipped).
function eventMinutes(ev, dateStr) {
  const d0 = dayStart(dateStr).getTime();
  if (ev.allDay) return { startMin: 0, endMin: DAY_MIN };
  const s = Date.parse(ev.start), e = Date.parse(ev.end);
  const startMin = clamp(Math.round((s - d0) / 60000), 0, DAY_MIN);
  const endMin = clamp(Math.round((e - d0) / 60000), 0, DAY_MIN);
  return { startMin, endMin };
}

/* ------------------------------------------------------------------ */
/* layout engine                                                       */
/* One rule: find two overlapping blocks, move the one that may move,  */
/* keep moving it the way it first went. Locked blocks and the block   */
/* being held never move. If nothing can move, placement fails.        */
/* ------------------------------------------------------------------ */

const overlaps = (a, b) => a.start < b.start + b.duration && b.start < a.start + a.duration;

function resolve(list, anchorId, forcedDir) {
  const T = list.map(clone);
  const anchor = T.find((t) => t.id === anchorId);
  if (!anchor) return null;
  if (anchor.start < 0 || anchor.start + anchor.duration > DAY_MIN) return null;
  const center = {};
  T.forEach((t) => (center[t.id] = t.start + t.duration / 2));
  const dirs = {};
  const fixed = (t) => t.id === anchorId || t.locked;
  for (let iter = 0; iter < 800; iter++) {
    let a = null, b = null;
    outer: for (let i = 0; i < T.length; i++) {
      for (let j = i + 1; j < T.length; j++) {
        if (overlaps(T[i], T[j])) { a = T[i]; b = T[j]; break outer; }
      }
    }
    if (!a) return T;
    if (fixed(a) && fixed(b)) return null;
    let mover, wall;
    if (fixed(a)) { mover = b; wall = a; }
    else if (fixed(b)) { mover = a; wall = b; }
    else if (dirs[a.id] && !dirs[b.id]) { mover = a; wall = b; }
    else if (dirs[b.id] && !dirs[a.id]) { mover = b; wall = a; }
    else {
      const da = Math.abs(center[a.id] - center[anchorId]);
      const db = Math.abs(center[b.id] - center[anchorId]);
      mover = da >= db ? a : b;
      wall = mover === a ? b : a;
    }
    let dir = dirs[mover.id];
    if (!dir) { dir = forcedDir || (center[mover.id] >= center[wall.id] ? 1 : -1); dirs[mover.id] = dir; }
    mover.start = dir === 1 ? wall.start + wall.duration : wall.start - mover.duration;
    if (mover.start < 0 || mover.start + mover.duration > DAY_MIN) return null;
  }
  return null;
}
function place(list, anchorId) {
  return resolve(list, anchorId, null) || resolve(list, anchorId, 1) || resolve(list, anchorId, -1);
}

/* ------------------------------------------------------------------ */
/* calendar export                                                     */
/* ------------------------------------------------------------------ */

function stamp(dateStr, mins) {
  const dt = dayMinToDate(dateStr, mins);
  return `${dt.getFullYear()}${pad(dt.getMonth() + 1)}${pad(dt.getDate())}T${pad(dt.getHours())}${pad(dt.getMinutes())}00`;
}
function gcalLink(t, dateStr) {
  const dates = `${stamp(dateStr, t.start)}/${stamp(dateStr, t.start + t.duration)}`;
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(t.name || 'Untitled')}&dates=${dates}`;
}
const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
function buildICS(blocks, dateStr) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Day Planner//EN', 'CALSCALE:GREGORIAN'];
  blocks.forEach((t) => {
    lines.push('BEGIN:VEVENT', `UID:${t.id}-${dateStr}@dayplanner`, `DTSTAMP:${stamp(dateStr, 0)}`,
      `DTSTART:${stamp(dateStr, t.start)}`, `DTEND:${stamp(dateStr, t.start + t.duration)}`,
      `SUMMARY:${esc(t.name || 'Untitled')}`, 'END:VEVENT');
  });
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}
function buildCSV(blocks, dateStr) {
  const csvDate = (mins) => { const dt = dayMinToDate(dateStr, mins); return `${pad(dt.getMonth() + 1)}/${pad(dt.getDate())}/${dt.getFullYear()}`; };
  const csvTime = (mins) => { const dt = dayMinToDate(dateStr, mins); let h = dt.getHours(); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 === 0 ? 12 : h % 12; return `${h}:${pad(dt.getMinutes())} ${ap}`; };
  const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const lines = ['Subject,Start Date,Start Time,End Date,End Time,All Day Event,Description'];
  [...blocks].sort((a, b) => a.start - b.start).forEach((t) => {
    const end = t.start + t.duration;
    lines.push([q(t.name || 'Untitled'), csvDate(t.start), csvTime(t.start), csvDate(end), csvTime(end), 'False', q(t.tag ? `#${t.tag}` : '')].join(','));
  });
  return lines.join('\r\n');
}
function downloadText(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ------------------------------------------------------------------ */
/* Claude's suggestions (beta): helpers                                */
/* Everything here comes from a routine on the user's computer, so it  */
/* is coerced defensively; a malformed field renders as empty, never   */
/* as a crash.                                                         */
/* ------------------------------------------------------------------ */

const PRIORITIES = ['high', 'medium', 'low'];
const PRIO_LABEL = { high: 'High', medium: 'Medium', low: 'Low' };
const PAIR_PARAMS = ['pair', 'name'];
const PILL = { ok: 'ok', partial: 'warn', corrected: 'warn', skipped: 'mute', error: 'bad' };
const EMPTY_ROUTINE = { enabled: false, keys: [], suggestions: [], brief: null };

const txt = (v) => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
const safeUrl = (u) => (typeof u === 'string' && /^https:\/\/\S+$/i.test(u) ? u : null);
const listOf = (v) => (Array.isArray(v) ? v : []);
function parseWhen(iso) {
  if (typeof iso !== 'string' || !iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t) : null;
}
const clockLabel = (d) => fmt(d.getHours() * 60 + d.getMinutes());
// "Tue, Sep 29 · 11:59 PM"
const whenLabel = (d) => `${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} · ${clockLabel(d)}`;
// time only when it is today, otherwise date and time
const sinceLabel = (d, now) => (d.toDateString() === now.toDateString() ? clockLabel(d) : whenLabel(d));
const suggStatus = (s) => (s.status === 'accepted' || s.status === 'dismissed' ? s.status : 'new');
const suggPrio = (s) => (PRIORITIES.includes(s.priority) ? s.priority : 'low');
const dueMs = (s) => { const d = parseWhen(s.due); return d ? d.getTime() : Infinity; };
const normBeta = (b) => ({ ...(b && typeof b === 'object' ? b : {}), suggestions: !!(b && b.suggestions) });

// p.routine may be absent (older server) or partial; always return the full shape.
function normRoutine(r) {
  if (!r || typeof r !== 'object') return EMPTY_ROUTINE;
  return {
    enabled: !!r.enabled,
    keys: listOf(r.keys).filter((k) => k && typeof k === 'object' && k.id != null).map((k) => ({ ...k, id: String(k.id) })),
    suggestions: listOf(r.suggestions).filter((s) => s && typeof s === 'object' && typeof s.fingerprint === 'string' && s.fingerprint),
    brief: r.brief && typeof r.brief === 'object' ? r.brief : null,
  };
}
function withSuggestion(r, row) {
  const list = r.suggestions.slice();
  const i = list.findIndex((x) => x.fingerprint === row.fingerprint);
  if (i >= 0) list[i] = row; else list.push(row);
  return { ...r, suggestions: list };
}
// Local mutations are optimistic. ops.sugg / ops.keys hold the local version of every row a
// mutation touched, with `settled` = the ops.seq value stamped when the server acknowledged it.
// A poll carries the ops.seq it started at: rows still in flight, or settled after the poll
// started, keep their local version; once a poll that started after the ack arrives, the
// server is trusted again and the entry is dropped.
function mergeRoutine(remote, ops, startedAt) {
  const current = (e) => e.settled != null && startedAt >= e.settled;
  const sugg = remote.suggestions.slice();
  for (const [fp, e] of [...ops.sugg]) {
    if (current(e)) { ops.sugg.delete(fp); continue; }
    const i = sugg.findIndex((s) => s.fingerprint === fp);
    if (i >= 0) sugg[i] = e.row; else sugg.push(e.row);
  }
  let keys = remote.keys.slice();
  for (const [id, e] of [...ops.keys]) {
    if (current(e)) { ops.keys.delete(id); continue; }
    keys = keys.filter((k) => k.id !== id);
    if (e.row) keys.push(e.row);
  }
  return { ...remote, suggestions: sugg, keys };
}
// Remove only the named query parameters, keeping any others (a pairing link must survive
// the ?google= cleanup and the sign-in screen).
function stripParams(names) {
  const u = new URL(window.location.href);
  let changed = false;
  names.forEach((n) => { if (u.searchParams.has(n)) { u.searchParams.delete(n); changed = true; } });
  if (changed) window.history.replaceState({}, '', u.pathname + u.search + u.hash);
}

/* ------------------------------------------------------------------ */
/* store: REST API with an echo-safe write queue                       */
/* ------------------------------------------------------------------ */

const store = (() => {
  const ownRevs = new Set();
  const ownRevList = [];
  const inflight = new Map();     // path -> { pending, promise }
  const failed = new Map();       // path -> data of the last write that did not reach the server
  const pendingDeletes = new Set();
  const statusListeners = new Set();
  const drainListeners = new Set();
  const authListeners = new Set();
  let lastError = null;
  let offline = false;
  let seq = 0;

  const state = () => ({ busy: inflight.size > 0, error: lastError, offline, failed: failed.size });
  const notify = () => statusListeners.forEach((cb) => cb(state()));

  async function req(method, url, bodyObj) {
    let r;
    try {
      r = await fetch(url, {
        method,
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
        body: bodyObj === undefined ? undefined : JSON.stringify(bodyObj),
      });
    } catch (e) {
      const err = new Error('You appear to be offline.');
      err.offline = true;
      if (!offline) { offline = true; notify(); }
      throw err;
    }
    if (offline) { offline = false; notify(); }
    let data = null;
    try { data = await r.json(); } catch (e) { /* no body */ }
    if (r.status === 401) {
      authListeners.forEach((cb) => cb());
      const e = new Error('Signed out.'); e.status = 401; throw e;
    }
    if (!r.ok) {
      const e = new Error((data && data.error) || `Request failed (${r.status}).`);
      e.status = r.status; e.data = data || {};
      throw e;
    }
    return data;
  }

  function urlFor(path) {
    if (path.startsWith('days/')) return '/api/days/' + path.slice(5);
    if (path.startsWith('todos/')) return '/api/todos/' + encodeURIComponent(path.slice(6));
    if (path === 'settings/palette') return '/api/settings';
    throw new Error('Unknown path ' + path);
  }

  function rememberRev(rev) {
    ownRevs.add(rev);
    ownRevList.push(rev);
    if (ownRevList.length > 3000) ownRevs.delete(ownRevList.shift());
  }

  function writeDoc(path, data) {
    seq++;
    failed.delete(path);
    let qd = inflight.get(path);
    if (qd) { qd.pending = data; return qd.promise; }
    qd = { pending: null, promise: null };
    inflight.set(path, qd);
    notify();
    qd.promise = (async () => {
      let d = data;
      while (d) {
        let ok = false;
        for (let attempt = 0; attempt < 2 && !ok; attempt++) {
          try {
            await req('PUT', urlFor(path), d);
            ok = true;
            if (lastError) { lastError = null; notify(); }
          } catch (e) {
            if (e.status === 401) { ok = true; break; }
            if (attempt === 0 && (e.offline || e.status >= 500)) { await sleep(800); continue; }
            failed.set(path, d);
            lastError = e;
            notify();
          }
        }
        d = qd.pending;
        qd.pending = null;
      }
      inflight.delete(path);
      notify();
      drainListeners.forEach((cb) => cb(path));
    })();
    return qd.promise;
  }

  async function deleteDoc(path) {
    seq++;
    failed.delete(path);
    pendingDeletes.add(path);
    const qd = inflight.get(path);
    if (qd) { qd.pending = null; try { await qd.promise; } catch (e) { /* reported already */ } }
    try {
      await req('DELETE', urlFor(path));
      if (lastError) { lastError = null; notify(); }
    } catch (e) {
      if (e.status !== 404 && e.status !== 401) { lastError = e; notify(); }
    }
  }

  function retryFailed() {
    for (const [path, d] of [...failed.entries()]) { failed.delete(path); writeDoc(path, d); }
  }

  return {
    req,
    sync: (date) => req('GET', '/api/sync?date=' + encodeURIComponent(date)),
    writeDoc, deleteDoc, retryFailed, rememberRev,
    isOwn: (rev) => !!rev && ownRevs.has(rev),
    inFlight: (path) => inflight.has(path),
    hasFailed: (path) => failed.has(path),
    failedCount: () => failed.size,
    isPendingDelete: (path) => pendingDeletes.has(path),
    reconcileDeletes: (remoteIds) => { for (const p of [...pendingDeletes]) { if (!remoteIds.has(p.slice(6))) pendingDeletes.delete(p); } },
    seq: () => seq,
    state,
    onStatus: (cb) => { statusListeners.add(cb); return () => statusListeners.delete(cb); },
    onDrain: (cb) => { drainListeners.add(cb); return () => drainListeners.delete(cb); },
    onAuthLost: (cb) => { authListeners.add(cb); return () => authListeners.delete(cb); },
  };
})();

/* ------------------------------------------------------------------ */
/* icons                                                               */
/* ------------------------------------------------------------------ */

const svg = (d, p) => html`<svg viewBox="0 0 24 24" aria-hidden="true" ...${p}><path fill="currentColor" d=${d} /></svg>`;
const Ico = {
  lock: (p) => svg('M12 1a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2h-1V6a5 5 0 0 0-5-5m0 2a3 3 0 0 1 3 3v3H9V6a3 3 0 0 1 3-3', p),
  unlock: (p) => svg('M12 1a5 5 0 0 0-5 5h2a3 3 0 0 1 6 0v3H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2h-1V6a5 5 0 0 0-5-5', p),
  paint: (p) => svg('M12 2a10 10 0 0 0 0 20 2 2 0 0 0 2-2 2 2 0 0 0-.5-1.3 2 2 0 0 1-.5-1.2 1.5 1.5 0 0 1 1.5-1.5H17a5 5 0 0 0 5-5c0-4.4-4.5-8-10-8m-5.5 9a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3m3-4a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3m5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3m3.5 4a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3', p),
  trash: (p) => svg('M9 3v1H4v2h16V4h-5V3zM6 8v11a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8zm3 2h2v9H9zm4 0h2v9h-2z', p),
  cal: (p) => svg('M19 4h-1V2h-2v2H8V2H6v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2m0 16H5V10h14zm0-12H5V6h14z', p),
  plus: (p) => svg('M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z', p),
  close: (p) => svg('M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7l1.4-1.4L10.6 10.6l6.3-6.3z', p),
  left: (p) => svg('M15.4 7.4 14 6l-6 6 6 6 1.4-1.4L10.8 12z', p),
  right: (p) => svg('M8.6 16.6 10 18l6-6-6-6-1.4 1.4 4.6 4.6z', p),
  up: (p) => svg('M12 8l6 6-1.4 1.4L12 10.8l-4.6 4.6L6 14z', p),
  down: (p) => svg('M12 16l-6-6 1.4-1.4L12 13.2l4.6-4.6L18 10z', p),
  grip: (p) => svg('M9 5a2 2 0 1 1 0 4 2 2 0 0 1 0-4m6 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4M9 11a2 2 0 1 1 0 4 2 2 0 0 1 0-4m6 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4m-6 6a2 2 0 1 1 0 4 2 2 0 0 1 0-4m6 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4', p),
  chev: (p) => svg('M7.4 8.6 12 13.2l4.6-4.6L18 10l-6 6-6-6z', p),
  clock: (p) => svg('M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20m0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16m.5-13H11v6l5.2 3.1.8-1.2-4.5-2.7z', p),
  check: (p) => svg('M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z', p),
  export: (p) => svg('M19 12v7H5v-7H3v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7zm-6 .67 2.59-2.58L17 11.5l-5 5-5-5 1.41-1.41L11 12.67V3h2z', p),
  ext: (p) => svg('M14 3v2h3.6l-9.8 9.8 1.4 1.4L19 6.4V10h2V3zM5 5h5V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5h-2v5H5z', p),
  refresh: (p) => svg('M17.65 6.35A8 8 0 1 0 19.9 13h-2.1a6 6 0 1 1-1.6-5.2L13 11h7V4z', p),
};
const G = (p) => html`<span className="gicon" ...${p}>G</span>`;

/* ------------------------------------------------------------------ */
/* auth screen                                                         */
/* ------------------------------------------------------------------ */

function AuthScreen({ onSignedIn, notice }) {
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [invite, setInvite] = useState('');
  const [err, setErr] = useState(notice || null);
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      const r = await store.req('POST', mode === 'login' ? '/api/auth/login' : '/api/auth/register',
        mode === 'login' ? { email, password } : { email, password, name, invite });
      onSignedIn(r.user);
    } catch (e2) {
      setErr(e2.message || 'Something went wrong.');
    } finally { setBusy(false); }
  };
  return html`
    <div className="auth">
      <form className="auth-card" onSubmit=${submit}>
        <div className="auth-brand"><${Ico.cal} /><b>Day Planner</b></div>
        <div className="tabs" role="tablist">
          <button type="button" className=${mode === 'login' ? 'on' : ''} onClick=${() => { setMode('login'); setErr(null); }}>Sign in</button>
          <button type="button" className=${mode === 'register' ? 'on' : ''} onClick=${() => { setMode('register'); setErr(null); }}>Create account</button>
        </div>
        ${err && html`<div className="auth-err" role="alert">${err}</div>`}
        ${mode === 'register' && html`
          <div className="field"><label htmlFor="a-name">Your name</label>
            <input id="a-name" className="inp" value=${name} onChange=${(e) => setName(e.target.value)} autoComplete="name" /></div>`}
        <div className="field"><label htmlFor="a-email">Email</label>
          <input id="a-email" className="inp" type="email" required value=${email} onChange=${(e) => setEmail(e.target.value)} autoComplete="email" inputMode="email" /></div>
        <div className="field"><label htmlFor="a-pass">Password</label>
          <input id="a-pass" className="inp" type="password" required minLength=${mode === 'register' ? 8 : 1} value=${password} onChange=${(e) => setPassword(e.target.value)}
            autoComplete=${mode === 'login' ? 'current-password' : 'new-password'} /></div>
        ${mode === 'register' && html`
          <div className="field"><label htmlFor="a-invite">Invite code</label>
            <input id="a-invite" className="inp" value=${invite} onChange=${(e) => setInvite(e.target.value)} autoComplete="off" /></div>`}
        <button className="btn primary" type="submit" disabled=${busy}>${busy ? 'One moment…' : mode === 'login' ? 'Sign in' : 'Create account'}</button>
        <div className="auth-foot">${mode === 'login' ? 'Your planner syncs to every device you sign in on.' : 'Ask whoever runs this planner for the invite code. Passwords need at least 8 characters.'}</div>
      </form>
    </div>`;
}

/* ------------------------------------------------------------------ */
/* root                                                                */
/* ------------------------------------------------------------------ */

function Root() {
  const [user, setUser] = useState(undefined);
  const [notice, setNotice] = useState(null);
  useEffect(() => {
    let dead = false;
    store.req('GET', '/api/auth/me').then((r) => { if (!dead) setUser(r.user); }).catch((e) => {
      if (dead) return;
      setUser(null);
      if (e.status === 401) {
        // a Google round trip that landed here without a session
        const g = new URLSearchParams(window.location.search).get('google');
        if (g) {
          setNotice(g === 'connected' ? 'Google Calendar connected. Sign in to continue.' : 'Sign in first, then connect Google Calendar again from the Google menu.');
          stripParams(['google']);
        }
      } else setNotice(e.offline ? 'You appear to be offline.' : e.message);
    });
    const off = store.onAuthLost(() => setUser(null));
    return () => { dead = true; off(); };
  }, []);
  if (user === undefined) return html`<div className="boot">Loading…</div>`;
  if (!user) return html`<${AuthScreen} notice=${notice} onSignedIn=${(u) => { setNotice(null); setUser(u); }} />`;
  return html`<${Planner} user=${user} onSignOut=${async () => { try { await store.req('POST', '/api/auth/logout'); } catch (e) { /* cookie is cleared server side either way */ } setUser(null); }} />`;
}

/* ------------------------------------------------------------------ */
/* planner                                                             */
/* ------------------------------------------------------------------ */

function Planner({ user, onSignOut }) {
  const [status, setStatus] = useState(store.state());
  const [dateStr, setDateStr] = useState(todayStr());
  const [blocks, setBlocksState] = useState([]);
  const [dayLoaded, setDayLoaded] = useState(false);
  const [todos, setTodosState] = useState([]);
  const [todosLoaded, setTodosLoaded] = useState(false);
  const [colors, setColors] = useState(DEFAULT_COLORS);

  const [google, setGoogle] = useState({ configured: false, connected: false, enabled: false, email: null });
  const [gEvents, setGEvents] = useState([]);
  const [gState, setGState] = useState('idle');
  const [gError, setGError] = useState(null);
  const [gReload, setGReload] = useState(0);
  const [gMenu, setGMenu] = useState(false);
  const [gConfirm, setGConfirm] = useState(false);
  const [gBusy, setGBusy] = useState(false);
  const [gPopover, setGPopover] = useState(null);

  const [ghost, setGhost] = useState(null);
  const [draggingId, setDraggingId] = useState(null);
  const [liftedTodo, setLiftedTodo] = useState(null);
  const [proxy, setProxy] = useState(null);
  const [insertAt, setInsertAt] = useState(null);
  const [colorTarget, setColorTarget] = useState(null);
  const [trashArmed, setTrashArmed] = useState(false);

  const [paintOpen, setPaintOpen] = useState(false);
  const [userMenu, setUserMenu] = useState(false);
  const [blockModal, setBlockModal] = useState(null);
  const [todoModal, setTodoModal] = useState(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [toast, setToast] = useState(null);
  const [now, setNow] = useState(() => new Date());
  const [quickText, setQuickText] = useState('');

  // Claude's suggestions (beta)
  const [beta, setBeta] = useState({ suggestions: false });
  const [routine, setRoutineState] = useState(EMPTY_ROUTINE);
  const [sideTab, setSideTab] = useState('todo');
  const [briefOpen, setBriefOpen] = useState(false);
  const [pairAsk, setPairAsk] = useState(null);
  const [pairBusy, setPairBusy] = useState(false);
  const [unlinkArm, setUnlinkArm] = useState(null);
  const [unlinkBusy, setUnlinkBusy] = useState(false);

  const scrollRef = useRef(null);
  const gridRef = useRef(null);
  const listRef = useRef(null);
  const dragRef = useRef(null);
  const blocksRef = useRef([]);
  const todosRef = useRef([]);
  const dateRef = useRef(dateStr);
  const dayLoadedRef = useRef(false);
  const todosLoadedRef = useRef(false);
  const dayRevRef = useRef(null);
  const settingsRevRef = useRef(null);
  const toastTimer = useRef(null);
  const blockModalRef = useRef(null);
  // the whole settings document as last seen or written; every write sends all of it
  const settingsRef = useRef({ colors: DEFAULT_COLORS, beta: { suggestions: false } });
  const routineRef = useRef(EMPTY_ROUTINE);
  const routineOps = useRef({ seq: 0, sugg: new Map(), keys: new Map() });
  const pairAskRef = useRef(null);
  const pollNowRef = useRef(() => {});
  dateRef.current = dateStr;
  blockModalRef.current = blockModal;
  pairAskRef.current = pairAsk;

  const setBlocks = useCallback((b) => { blocksRef.current = b; setBlocksState(b); }, []);
  const setTodos = useCallback((t) => { todosRef.current = t; setTodosState(t); }, []);
  const setRoutine = useCallback((r) => { routineRef.current = r; setRoutineState(r); }, []);

  const say = useCallback((msg) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  }, []);

  /* ---------------- sync ---------------- */

  useEffect(() => store.onStatus(setStatus), []);

  const applyDay = (day) => {
    const bl = day && Array.isArray(day.blocks) ? day.blocks.map(clone) : [];
    setBlocks(bl);
    dayRevRef.current = day ? day.rev : null;
  };

  const applySync = (p, date, seqAtStart, routineSeqAtStart) => {
    if (p.google) setGoogle(p.google);
    if (date === dateRef.current) {
      const path = 'days/' + date;
      const remoteRev = p.day ? p.day.rev : null;
      const dragging = dragRef.current && dragRef.current.started;
      if (!dayLoadedRef.current) { applyDay(p.day); dayLoadedRef.current = true; setDayLoaded(true); }
      else if (!(remoteRev && store.isOwn(remoteRev)) && !store.inFlight(path) && !store.hasFailed(path) && !dragging && remoteRev !== dayRevRef.current) applyDay(p.day);
    }
    const sRev = p.settings ? p.settings.rev : null;
    if (p.settings && !store.isOwn(sRev) && !store.inFlight('settings/palette') && !store.hasFailed('settings/palette') && sRev !== settingsRevRef.current) {
      const { rev: _rev, ...data } = p.settings;
      const cols = Array.isArray(data.colors) && data.colors.length ? data.colors.slice(0, MAX_COLORS) : settingsRef.current.colors;
      const b = normBeta(data.beta);
      settingsRef.current = { ...data, colors: cols, beta: b };
      setColors(cols);
      setBeta(b);
      settingsRevRef.current = sRev;
    }
    setRoutine(mergeRoutine(normRoutine(p.routine), routineOps.current, routineSeqAtStart || 0));
    const remote = new Map((p.todos || []).map((t) => [t.id, t]));
    let cur = todosRef.current.slice();
    let touched = false;
    for (const [id, t] of remote) {
      const path = 'todos/' + id;
      if (store.isPendingDelete(path)) continue;
      const i = cur.findIndex((x) => x.id === id);
      if (store.isOwn(t.rev)) { if (i < 0 && !store.inFlight(path)) { cur.push(t); touched = true; } continue; }
      if (store.inFlight(path) || store.hasFailed(path)) continue;
      if (i < 0) { cur.push(t); touched = true; } else if (cur[i].rev !== t.rev) { cur[i] = t; touched = true; }
    }
    if (seqAtStart === store.seq()) {
      for (const t of cur.slice()) {
        const path = 'todos/' + t.id;
        if (!remote.has(t.id) && !store.inFlight(path) && !store.hasFailed(path)) { cur = cur.filter((x) => x.id !== t.id); touched = true; }
      }
    }
    store.reconcileDeletes(new Set(remote.keys()));
    if (touched) setTodos(cur);
    if (!todosLoadedRef.current) { todosLoadedRef.current = true; setTodosLoaded(true); }
  };
  const applyRef = useRef(applySync);
  applyRef.current = applySync;

  // reset the day view when the date changes; the poll below loads it
  useEffect(() => {
    setBlocks([]);
    setDayLoaded(false);
    dayLoadedRef.current = false;
    dayRevRef.current = null;
  }, [dateStr, setBlocks]);

  useEffect(() => {
    let dead = false, timer = null, running = false;
    const schedule = (ms) => { clearTimeout(timer); timer = setTimeout(tick, ms != null ? ms : (document.hidden ? 60000 : 15000)); };
    const tick = async () => {
      if (dead) return;
      if (running) { schedule(2000); return; }
      running = true;
      const date = dateRef.current;
      const seqAt = store.seq();
      const routineSeqAt = routineOps.current.seq;
      try {
        const p = await store.sync(date);
        if (!dead) { applyRef.current(p, date, seqAt, routineSeqAt); if (store.failedCount()) store.retryFailed(); }
      } catch (e) { /* status indicator reports offline / errors */ }
      finally { running = false; if (!dead) schedule(); }
    };
    tick();
    const wake = () => { if (!document.hidden) schedule(0); };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('focus', wake);
    window.addEventListener('online', wake);
    const offDrain = store.onDrain(() => schedule(500));
    pollNowRef.current = () => { if (!dead) schedule(0); };
    return () => {
      dead = true; clearTimeout(timer);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('focus', wake);
      window.removeEventListener('online', wake);
      offDrain();
    };
  }, [dateStr]);

  /* ---------------- google events ---------------- */

  useEffect(() => {
    if (!google.connected || !google.enabled) { setGEvents([]); setGState('idle'); setGError(null); return undefined; }
    let dead = false, timer = null;
    const load = async () => {
      setGState((s) => (s === 'ok' ? s : 'loading'));
      const min = dayStart(dateStr).toISOString();
      const max = dayStart(shiftDate(dateStr, 1)).toISOString();
      try {
        const r = await store.req('GET', `/api/google/events?timeMin=${encodeURIComponent(min)}&timeMax=${encodeURIComponent(max)}`);
        if (!dead) { setGEvents(r.events || []); setGState('ok'); setGError(null); }
      } catch (e) {
        if (!dead) {
          setGState('error'); setGError(e);
          const code = e.data && e.data.code;
          if (code === 'reconnect' || code === 'not_connected') setGoogle((g) => ({ ...g, connected: false, enabled: false }));
        }
      }
      if (!dead) timer = setTimeout(load, 120000);
    };
    load();
    return () => { dead = true; clearTimeout(timer); };
  }, [dateStr, google.connected, google.enabled, gReload]);

  // result of the OAuth round trip arrives as ?google=...
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const g = params.get('google');
    if (!g) return;
    const msgs = {
      connected: 'Google Calendar connected.',
      denied: 'Google sign-in was cancelled.',
      notconfigured: 'Google Calendar is not set up on this server yet.',
      norefresh: 'Google did not send a refresh token. Remove Day Planner at myaccount.google.com/permissions, then connect again.',
      signedout: 'Sign in first, then connect Google Calendar.',
    };
    say(msgs[g] || 'Could not connect Google Calendar. Try again.');
    stripParams(['google']);
  }, [say]);

  // a pairing link from `bin/bp pair` arrives as ?pair=<sha256 hex>&name=<host>; it stays in the
  // URL (through sign-in if needed) until the user links or cancels
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.has('pair')) return;
    const hash = String(params.get('pair') || '').trim().toLowerCase();
    const name = String(params.get('name') || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60);
    if (!/^[a-f0-9]{64}$/.test(hash)) {
      say('That pairing link is not valid. Run bin/bp pair again.');
      stripParams(PAIR_PARAMS);
      return;
    }
    setPairAsk({ hash, name });
  }, [say]);

  /* ---------------- misc effects ---------------- */

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !dayLoaded) return;
    const isT = dateStr === todayStr();
    el.scrollTop = isT ? Math.max(0, now.getHours() * 60 - 90) : 7 * 60 - 20;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateStr, dayLoaded]);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      setPaintOpen(false); setExportOpen(false); setTodoModal(null); setGMenu(false); setUserMenu(false); setGPopover(null); setGConfirm(false);
      setBriefOpen(false); setUnlinkArm(null);
      if (pairAskRef.current) { setPairAsk(null); stripParams(PAIR_PARAMS); }
      const m = blockModalRef.current;
      if (m) { if (m.mode === 'create') setBlocks(m.revertTo); setBlockModal(null); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setBlocks]);

  /* ---------------- persistence helpers ---------------- */

  const commitBlocks = useCallback((date, next) => {
    const rev = genRev();
    store.rememberRev(rev);
    if (date === dateRef.current) { setBlocks(next); dayRevRef.current = rev; }
    store.writeDoc('days/' + date, { blocks: next.map(clone), rev });
  }, [setBlocks]);

  const saveTodo = useCallback((todo) => {
    const rev = genRev();
    store.rememberRev(rev);
    const t = { ...todo, rev, updatedAt: nowIso() };
    const cur = todosRef.current.slice();
    const i = cur.findIndex((x) => x.id === t.id);
    if (i >= 0) cur[i] = t; else cur.push(t);
    setTodos(cur);
    const { id, ...body } = t;
    store.writeDoc('todos/' + id, body);
    return t;
  }, [setTodos]);

  const removeTodo = useCallback((id) => {
    setTodos(todosRef.current.filter((t) => t.id !== id));
    store.deleteDoc('todos/' + id);
  }, [setTodos]);

  // Merge a patch into the settings document and write all of it, so colors and beta flags
  // never overwrite each other. `beta` merges one level deep.
  const saveSettings = useCallback((patch) => {
    const cur = settingsRef.current;
    const next = { ...cur, ...patch };
    if (patch.beta) next.beta = normBeta({ ...cur.beta, ...patch.beta });
    settingsRef.current = next;
    const rev = genRev();
    store.rememberRev(rev);
    settingsRevRef.current = rev;
    if (patch.colors) setColors(next.colors);
    if (patch.beta) setBeta(next.beta);
    store.writeDoc('settings/palette', { ...next, rev });
  }, []);
  const savePalette = useCallback((cols) => saveSettings({ colors: cols }), [saveSettings]);

  const linkTodo = useCallback((todoId, date, blockId) => {
    const t = todosRef.current.find((x) => x.id === todoId);
    if (!t) return;
    const sched = (t.scheduled || []).filter((s) => s.blockId !== blockId);
    saveTodo({ ...t, scheduled: [...sched, { date, blockId }] });
  }, [saveTodo]);

  const unlinkBlock = useCallback((block) => {
    if (!block || !block.todoId) return;
    const t = todosRef.current.find((x) => x.id === block.todoId);
    if (!t || !t.scheduled) return;
    const sched = t.scheduled.filter((s) => s.blockId !== block.id);
    if (sched.length !== t.scheduled.length) saveTodo({ ...t, scheduled: sched });
  }, [saveTodo]);

  /* ---------------- derived ---------------- */

  const sortedTodos = useMemo(() => [...todos].sort((a, b) => (a.order || 0) - (b.order || 0) || String(a.createdAt || '').localeCompare(String(b.createdAt || ''))), [todos]);
  const activeTodos = useMemo(() => sortedTodos.filter((t) => !t.done), [sortedTodos]);
  const doneTodos = useMemo(() => sortedTodos.filter((t) => t.done), [sortedTodos]);
  const knownTags = useMemo(() => { const s = new Set(['event']); todos.forEach((t) => { if (t.tag) s.add(t.tag); }); return [...s]; }, [todos]);
  const tagColor = useCallback((tag, own) => own || (tag ? hashColor(tag, colors) : null), [colors]);
  const todoColor = useCallback((t) => t.color || (t.tag ? hashColor(t.tag, colors) : colors[1] || colors[0]), [colors]);
  const sortedBlocks = useMemo(() => [...blocks].sort((a, b) => a.start - b.start), [blocks]);
  const importedIds = useMemo(() => new Set(blocks.filter((b) => b.gcalId).map((b) => b.gcalId)), [blocks]);
  const gTimed = useMemo(() => gEvents.filter((e) => !e.allDay && !importedIds.has(e.id)).map((e) => ({ ...e, ...eventMinutes(e, dateStr) })).filter((e) => e.endMin > e.startMin), [gEvents, importedIds, dateStr]);
  const gAllDay = useMemo(() => gEvents.filter((e) => e.allDay), [gEvents]);
  const isToday = dateStr === todayStr();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const ready = dayLoaded && todosLoaded;
  const gOn = google.connected && google.enabled;
  const betaOn = !!beta.suggestions;
  const tab = betaOn ? sideTab : 'todo';
  const newCount = useMemo(() => routine.suggestions.filter((s) => suggStatus(s) === 'new').length, [routine]);
  // flag turned off (here or on another device): fall back to the To do tab and close the brief
  useEffect(() => { if (!betaOn) { setSideTab('todo'); setBriefOpen(false); } }, [betaOn]);

  /* ---------------- geometry ---------------- */

  const yToMin = (clientY) => (clientY - gridRef.current.getBoundingClientRect().top) / PX;
  const overGrid = (x, y) => {
    if (!gridRef.current || !scrollRef.current) return false;
    const g = gridRef.current.getBoundingClientRect();
    const s = scrollRef.current.getBoundingClientRect();
    return x >= g.left - 8 && x <= g.right + 8 && y >= s.top && y <= s.bottom;
  };
  const overList = (x, y) => {
    if (!listRef.current) return false;
    const r = listRef.current.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  };
  const listInsertIndex = (y, exceptId) => {
    const items = listRef.current ? [...listRef.current.querySelectorAll('[data-todo-id]')] : [];
    let idx = 0;
    for (const el of items) {
      if (el.dataset.todoId === exceptId || el.classList.contains('done')) continue;
      const r = el.getBoundingClientRect();
      if (y > r.top + r.height / 2) idx++;
    }
    return idx;
  };

  /* ---------------- block creation ---------------- */

  const createBlock = (spec, startMin, date) => {
    const dur = spec.duration || DEFAULT_DURATION;
    const block = { id: newId('b'), name: spec.name || '', start: clamp(snap(startMin), 0, DAY_MIN - dur), duration: dur, color: spec.color, locked: false };
    if (spec.todoId) block.todoId = spec.todoId;
    if (spec.tag) block.tag = spec.tag;
    const before = blocksRef.current.map(clone);
    const out = place([...before, block], block.id);
    if (!out) { say('No room there. A locked block is in the way.'); return; }
    if (spec.duration && spec.name) {
      commitBlocks(date, out);
      if (spec.todoId) linkTodo(spec.todoId, date, block.id);
      say(`${spec.name} · ${fmt(block.start)} – ${fmt(block.start + dur)}`);
    } else {
      setBlocks(out);
      setBlockModal({ mode: 'create', draft: clone(block), revertTo: before, needDuration: !spec.duration, date });
    }
  };

  /* ---------------- pointer drag engine ---------------- */

  const H = useRef({});
  const tMove = useCallback((e) => H.current.onMove(e), []);
  const tUp = useCallback((e) => H.current.onUp(e), []);
  const tCancel = useCallback(() => H.current.onCancel(), []);
  const preventTouch = useCallback((ev) => { const s = dragRef.current; if (s && s.started) ev.preventDefault(); }, []);
  const preventCtx = useCallback((ev) => { if (dragRef.current) ev.preventDefault(); }, []);

  const cleanupSession = (willWrite) => {
    const s = dragRef.current;
    if (s) { clearTimeout(s.timer); cancelAnimationFrame(s.raf); }
    dragRef.current = null;
    window.removeEventListener('pointermove', tMove);
    window.removeEventListener('pointerup', tUp);
    window.removeEventListener('pointercancel', tCancel);
    window.removeEventListener('touchmove', preventTouch);
    window.removeEventListener('contextmenu', preventCtx);
    setGhost(null); setDraggingId(null); setLiftedTodo(null); setProxy(null);
    setInsertAt(null); setColorTarget(null); setTrashArmed(false);
    document.body.style.cursor = '';
    void willWrite;
  };

  const autoScroll = () => {
    const s = dragRef.current;
    if (!s || !s.started) return;
    const el = scrollRef.current;
    if (el && s.kind !== 'color') {
      const r = el.getBoundingClientRect();
      if (s.x >= r.left && s.x <= r.right) {
        const edge = 48;
        let dy = 0;
        if (s.y < r.top + edge && s.y > r.top - 30) dy = -Math.ceil(((r.top + edge - s.y) / edge) * 12);
        else if (s.y > r.bottom - edge && s.y < r.bottom + 30) dy = Math.ceil(((s.y - (r.bottom - edge)) / edge) * 12);
        if (dy) { el.scrollTop += dy; updateDrag(s); }
      }
    }
    s.raf = requestAnimationFrame(() => H.current.autoScroll());
  };

  const beginDrag = () => {
    const s = dragRef.current;
    if (!s || s.started) return;
    if (s.kind === 'block' && s.locked) { cleanupSession(false); say('This block is locked. Unlock it to move or resize.'); return; }
    s.started = true;
    clearTimeout(s.timer);
    document.body.style.cursor = s.kind === 'block' && s.mode !== 'move' ? 'ns-resize' : 'grabbing';
    if (s.kind === 'block') {
      s.snapshot = blocksRef.current.map(clone);
      const t = s.snapshot.find((x) => x.id === s.id);
      if (!t) { cleanupSession(false); return; }
      s.s0 = t.start; s.d0 = t.duration;
      s.grab = yToMin(s.y0) - t.start;
      setDraggingId(s.id);
    } else if (s.kind === 'todo') {
      setLiftedTodo(s.todo.id);
      setProxy({ x: s.x, y: s.y, label: s.todo.title, color: todoColor(s.todo) });
    } else if (s.kind === 'quick') {
      setProxy({ x: s.x, y: s.y, label: s.block.label, color: s.block.color });
    } else if (s.kind === 'color') {
      setTrashArmed(true);
      setProxy({ x: s.x, y: s.y, swatch: s.hex });
    }
    updateDrag(s);
    s.raf = requestAnimationFrame(() => H.current.autoScroll());
  };

  const updateDrag = (s) => {
    if (s.kind === 'block') {
      const next = s.snapshot.map(clone);
      const t = next.find((x) => x.id === s.id);
      if (!t) return;
      const m = yToMin(s.y);
      if (s.mode === 'move') t.start = clamp(snap(m - s.grab), 0, DAY_MIN - t.duration);
      else if (s.mode === 'top') { const end = s.s0 + s.d0; const st = clamp(snap(m), 0, end - SNAP); t.start = st; t.duration = end - st; }
      else { const end = clamp(snap(m), s.s0 + SNAP, DAY_MIN); t.duration = end - s.s0; }
      if (t.start !== s.s0 || t.duration !== s.d0) s.moved = true;
      const out = place(next, s.id);
      if (out) setBlocks(out);
      return;
    }
    if (s.kind === 'todo' || s.kind === 'quick') {
      const label = s.kind === 'todo' ? s.todo.title : s.block.label;
      const dur = (s.kind === 'todo' ? s.todo.duration : s.block.duration) || DEFAULT_DURATION;
      setProxy((p) => (p ? { ...p, x: s.x, y: s.y } : p));
      if (overGrid(s.x, s.y)) {
        s.over = 'grid';
        const start = clamp(snap(yToMin(s.y)), 0, DAY_MIN - dur);
        s.start = start;
        setGhost({ start, duration: dur, label });
        setInsertAt(null);
      } else if (s.kind === 'todo' && overList(s.x, s.y)) {
        s.over = 'list';
        s.insert = listInsertIndex(s.y, s.todo.id);
        setInsertAt(s.insert);
        setGhost(null);
      } else { s.over = null; setGhost(null); setInsertAt(null); }
      return;
    }
    if (s.kind === 'color') {
      setProxy((p) => (p ? { ...p, x: s.x, y: s.y } : p));
      const el = document.elementFromPoint(s.x, s.y);
      const blockEl = el && el.closest ? el.closest('[data-block-id]') : null;
      const trashEl = el && el.closest ? el.closest('[data-trash]') : null;
      s.target = blockEl ? blockEl.dataset.blockId : null;
      s.overTrash = !!trashEl;
      setColorTarget(s.target);
    }
  };

  const onMove = (e) => {
    const s = dragRef.current;
    if (!s || e.pointerId !== s.pointerId) return;
    s.x = e.clientX; s.y = e.clientY;
    const dist = Math.hypot(s.x - s.x0, s.y - s.y0);
    if (!s.started) {
      if (s.pointerType === 'touch') { if (dist > 10) cleanupSession(false); return; }
      if (dist > 4) beginDrag(); else return;
      if (!dragRef.current) return;
    }
    if (dist > 3) s.moved = true;
    updateDrag(s);
  };
  const onCancel = () => { cleanupSession(false); };
  const onUp = (e) => {
    const s = dragRef.current;
    if (!s || e.pointerId !== s.pointerId) return;
    if (!s.started) {
      cleanupSession(false);
      if (s.kind === 'block') {
        const t = blocksRef.current.find((x) => x.id === s.id);
        if (t && s.mode === 'move') setBlockModal({ mode: 'edit', draft: clone(t), date: s.date });
      } else if (s.kind === 'todo') setTodoModal({ todo: clone(s.todo) });
      else if (s.kind === 'quick') say('Drag this onto the calendar to add it.');
      return;
    }
    if (s.kind === 'block') {
      const changed = s.moved && JSON.stringify(blocksRef.current) !== JSON.stringify(s.snapshot);
      cleanupSession(changed);
      if (changed) { commitBlocks(s.date, blocksRef.current); return; }
      if (!s.moved) {
        if (s.snapshot) setBlocks(s.snapshot);
        const t = blocksRef.current.find((x) => x.id === s.id);
        if (t) setBlockModal({ mode: 'edit', draft: clone(t), date: s.date });
      }
      return;
    }
    if (s.kind === 'todo') {
      const over = s.over, start = s.start, insert = s.insert, todo = s.todo;
      cleanupSession(over === 'grid');
      if (over === 'grid') {
        const live = todosRef.current.find((t) => t.id === todo.id) || todo;
        createBlock({ name: live.title, duration: live.duration || null, color: todoColor(live), todoId: live.id, tag: live.tag || null }, start, s.date);
      } else if (over === 'list') reorderTodo(todo.id, insert);
      return;
    }
    if (s.kind === 'quick') {
      const over = s.over, start = s.start, qb = s.block;
      cleanupSession(over === 'grid');
      if (over === 'grid') createBlock({ name: '', duration: qb.duration, color: qb.color }, start, s.date);
      return;
    }
    if (s.kind === 'color') {
      const target = s.target, overTrash = s.overTrash, hex = s.hex;
      cleanupSession(!!target);
      if (target) commitBlocks(s.date, blocksRef.current.map((t) => (t.id === target ? { ...t, color: hex } : t)));
      else if (overTrash) {
        if (colors.length <= 1) { say('Keep at least one color.'); return; }
        savePalette(colors.filter((c) => c !== hex));
        say('Color removed.');
      }
    }
  };

  const startSession = (e, session) => {
    if (!ready) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (!session.allowControls && e.target.closest && e.target.closest('button, input, a, label, select, textarea')) return;
    if (dragRef.current) cleanupSession(false);
    const s = { ...session, pointerId: e.pointerId, pointerType: e.pointerType, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY,
      started: false, moved: false, timer: null, raf: null, date: dateRef.current };
    dragRef.current = s;
    window.addEventListener('pointermove', tMove);
    window.addEventListener('pointerup', tUp);
    window.addEventListener('pointercancel', tCancel);
    window.addEventListener('touchmove', preventTouch, { passive: false });
    window.addEventListener('contextmenu', preventCtx);
    if (session.immediate) { beginDrag(); return; }
    if (e.pointerType === 'touch') s.timer = setTimeout(() => { if (dragRef.current === s && !s.started) H.current.beginDrag(); }, 240);
  };
  H.current = { onMove, onUp, onCancel, beginDrag, updateDrag, autoScroll, cleanupSession };

  /* ---------------- to-do actions ---------------- */

  const addTodo = (raw, openEditor) => {
    const p = parseQuickAdd(raw);
    if (!p.title) return;
    const last = activeTodos[activeTodos.length - 1];
    const order = last ? (last.order || 0) + 1000 : 1000;
    const existing = p.tag ? todos.find((t) => t.tag === p.tag && t.color) : null;
    const t = saveTodo({ id: newId('t'), title: p.title, tag: p.tag, duration: p.duration, color: existing ? existing.color : null, order, done: false, scheduled: [], createdAt: nowIso() });
    setQuickText('');
    if (openEditor) setTodoModal({ todo: clone(t), focus: 'duration' });
  };

  const reorderTodo = (id, insert) => {
    const list = activeTodos;
    const dragged = list.find((t) => t.id === id);
    if (!dragged) return;
    const others = list.filter((t) => t.id !== id);
    const idx = clamp(insert, 0, others.length);
    const before = others[idx - 1];
    const after = others[idx];
    let order;
    if (!before && !after) return;
    else if (!before) order = (after.order || 0) - 1000;
    else if (!after) order = (before.order || 0) + 1000;
    else order = ((before.order || 0) + (after.order || 0)) / 2;
    if (before && after && Math.abs((after.order || 0) - (before.order || 0)) < 1e-6) {
      const seq = [...others.slice(0, idx), dragged, ...others.slice(idx)];
      seq.forEach((t, i) => saveTodo({ ...t, order: (i + 1) * 1000 }));
      return;
    }
    if (order === dragged.order) return;
    saveTodo({ ...dragged, order });
  };
  const nudgeTodo = (id, dir) => {
    const list = activeTodos;
    const i = list.findIndex((t) => t.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    reorderTodo(id, dir < 0 ? j : j + 1);
  };
  const toggleDone = (t) => saveTodo({ ...t, done: !t.done, order: t.done ? ((activeTodos[activeTodos.length - 1] || {}).order || 0) + 1000 : t.order });

  /* ---------------- block modal ---------------- */

  const closeBlockModal = (save) => {
    const m = blockModal;
    if (!m) return;
    setBlockModal(null);
    if (!save) { if (m.mode === 'create') setBlocks(m.revertTo); return; }
    const d = m.draft;
    const cleaned = { ...d, name: (d.name || '').trim() || 'Untitled', duration: Math.max(SNAP, d.duration) };
    const rest = blocksRef.current.filter((t) => t.id !== cleaned.id);
    const out = place([...rest, cleaned], cleaned.id);
    if (!out) { say('Those times collide with a locked block. Nothing changed.'); if (m.mode === 'create') setBlocks(m.revertTo); return; }
    commitBlocks(m.date, out);
    if (m.mode === 'create' && cleaned.todoId) linkTodo(cleaned.todoId, m.date, cleaned.id);
  };
  const deleteBlock = (id) => {
    const b = blocksRef.current.find((t) => t.id === id);
    setBlockModal(null);
    commitBlocks(dateRef.current, blocksRef.current.filter((t) => t.id !== id));
    unlinkBlock(b);
  };
  const toggleLock = (id) => commitBlocks(dateRef.current, blocksRef.current.map((t) => (t.id === id ? { ...t, locked: !t.locked } : t)));

  /* ---------------- google actions ---------------- */

  const gToggle = async (enabled) => {
    setGoogle((g) => ({ ...g, enabled }));
    try { const s = await store.req('POST', '/api/google/toggle', { enabled }); setGoogle(s); }
    catch (e) { say(e.message); }
  };
  const gDisconnect = async () => {
    setGConfirm(false); setGMenu(false);
    try { await store.req('POST', '/api/google/disconnect'); setGoogle((g) => ({ ...g, connected: false, enabled: false, email: null })); say('Google Calendar disconnected.'); }
    catch (e) { say(e.message); }
  };
  const importEvent = (ev) => {
    const { startMin, endMin } = eventMinutes(ev, dateStr);
    if (ev.allDay) { say('All-day events stay in Google Calendar. Add a block for the part of the day you need.'); return; }
    if (endMin <= startMin) { say('That event is not on this day.'); return; }
    const block = { id: newId('b'), name: ev.summary, start: startMin, duration: endMin - startMin, color: GOOGLE_COLOR, locked: true, gcalId: ev.id };
    if (ev.htmlLink) block.gcalLink = ev.htmlLink;
    const out = place([...blocksRef.current.map(clone), block], block.id);
    if (!out) { say('No room: another locked block overlaps this event.'); return; }
    commitBlocks(dateStr, out);
    setGPopover(null);
    say(`Imported "${ev.summary}" as a locked block.`);
  };
  const deleteGoogleEvent = async (ev) => {
    setGBusy(true);
    try {
      await store.req('DELETE', '/api/google/events?id=' + encodeURIComponent(ev.id));
      setGEvents((list) => list.filter((e) => e.id !== ev.id));
      const linked = blocksRef.current.filter((b) => b.gcalId === ev.id);
      if (linked.length) {
        commitBlocks(dateRef.current, blocksRef.current.map((b) => { if (b.gcalId !== ev.id) return b; const c = { ...b, locked: false }; delete c.gcalId; delete c.gcalLink; return c; }));
      }
      setGPopover(null);
      say('Deleted from Google Calendar.');
    } catch (e) { say(e.message); }
    finally { setGBusy(false); }
  };
  const pushToGoogle = async () => {
    const m = blockModal;
    if (!m) return;
    const d = m.draft;
    const name = (d.name || '').trim() || 'Untitled';
    const duration = Math.max(SNAP, d.duration);
    setGBusy(true);
    try {
      const r = await store.req('POST', '/api/google/events', {
        summary: name,
        start: dayMinToDate(m.date, d.start).toISOString(),
        end: dayMinToDate(m.date, d.start + duration).toISOString(),
        description: d.tag ? `#${d.tag}` : '',
      });
      const ev = r.event;
      const cleaned = { ...d, name, duration, locked: true, gcalId: ev.id };
      if (ev.htmlLink) cleaned.gcalLink = ev.htmlLink;
      const rest = blocksRef.current.filter((t) => t.id !== cleaned.id);
      let out = place([...rest, cleaned], cleaned.id);
      if (!out) {
        // event exists in Google now; keep the block where it already was
        const existing = blocksRef.current.find((t) => t.id === d.id);
        out = existing
          ? blocksRef.current.map((t) => (t.id === d.id ? { ...t, name, locked: true, gcalId: ev.id, gcalLink: ev.htmlLink || undefined } : t))
          : [...blocksRef.current, cleaned];
        say('Added to Google Calendar, but the times collide with a locked block here, so the block kept its old place.');
      } else say('Added to Google Calendar.');
      setBlockModal(null);
      commitBlocks(m.date, out);
      if (m.mode === 'create' && cleaned.todoId) linkTodo(cleaned.todoId, m.date, cleaned.id);
      setGReload((k) => k + 1);
    } catch (e) { say(e.message || 'Could not add to Google Calendar.'); }
    finally { setGBusy(false); }
  };
  const removeFromGoogle = async () => {
    const m = blockModal;
    if (!m || !m.draft.gcalId) return;
    const d = m.draft;
    setGBusy(true);
    try {
      await store.req('DELETE', '/api/google/events?id=' + encodeURIComponent(d.gcalId));
      const cleaned = { ...d, name: (d.name || '').trim() || 'Untitled', duration: Math.max(SNAP, d.duration), locked: false };
      delete cleaned.gcalId; delete cleaned.gcalLink;
      const rest = blocksRef.current.filter((t) => t.id !== cleaned.id);
      const out = place([...rest, cleaned], cleaned.id) || blocksRef.current.map((t) => { if (t.id !== d.id) return t; const c = { ...t, locked: false }; delete c.gcalId; delete c.gcalLink; return c; });
      setBlockModal(null);
      commitBlocks(m.date, out);
      setGReload((k) => k + 1);
      say('Deleted from Google Calendar. The block stays here, unlocked.');
    } catch (e) { say(e.message || 'Could not delete from Google Calendar.'); }
    finally { setGBusy(false); }
  };

  /* ---------------- Claude's suggestions (beta) ---------------- */

  const toggleBeta = (on) => saveSettings({ beta: { suggestions: on } });

  // Optimistic status change on one suggestion; rolled back if the server refuses.
  const mutateSuggestion = async (s, patch, url, body, failMsg) => {
    const ops = routineOps.current;
    const fp = s.fingerprint;
    const prevRow = routineRef.current.suggestions.find((x) => x.fingerprint === fp) || s;
    const prevEntry = ops.sugg.get(fp);
    const entry = { row: { ...prevRow, ...patch, updatedAt: nowIso() }, settled: null };
    ops.sugg.set(fp, entry);
    setRoutine(withSuggestion(routineRef.current, entry.row));
    try {
      await store.req('POST', url, body);
      ops.seq++;
      entry.settled = ops.seq;
    } catch (e) {
      if (e.status === 401) return;
      if (ops.sugg.get(fp) === entry) {
        if (prevEntry) ops.sugg.set(fp, prevEntry); else ops.sugg.delete(fp);
        setRoutine(withSuggestion(routineRef.current, prevRow));
      }
      say(failMsg ? failMsg(e) : e.message || 'Could not reach the server.');
    }
  };

  // Add: a to-do at the bottom of the active list, built the way addTodo builds one, then `accept`.
  const acceptSuggestion = (s) => {
    if (!todosLoadedRef.current) return;
    const title = txt(s.title).trim().slice(0, 500) || 'Untitled';
    const active = todosRef.current.filter((t) => !t.done);
    const order = active.length ? Math.max(...active.map((t) => t.order || 0)) + 1000 : 1000;
    const tag = typeof s.tag === 'string' && /^[a-z0-9-]{1,40}$/.test(s.tag) ? s.tag : null;
    const dur = Number(s.duration);
    const duration = Number.isFinite(dur) && dur > 0 ? clamp(Math.round(dur), 5, DAY_MIN) : null;
    const t = saveTodo({ id: newId('t'), title, tag, duration, color: null, order, done: false, scheduled: [], createdAt: nowIso() });
    say(`Added "${title}" to your to-do list.`);
    mutateSuggestion(s, { status: 'accepted', todoId: t.id }, '/api/routine/accept', { fingerprint: s.fingerprint, todoId: t.id },
      (e) => `The task was added, but Claude's list was not updated: ${e.message}`);
  };
  const dismissSuggestion = (s) => mutateSuggestion(s, { status: 'dismissed' }, '/api/routine/dismiss', { fingerprint: s.fingerprint });
  const restoreSuggestion = (s) => mutateSuggestion(s, { status: 'new' }, '/api/routine/restore', { fingerprint: s.fingerprint });

  const cancelPair = () => { setPairAsk(null); stripParams(PAIR_PARAMS); };
  const linkRoutine = async () => {
    const p = pairAsk;
    if (!p || pairBusy) return;
    setPairBusy(true);
    try {
      const r = await store.req('POST', '/api/routine/pair', { hash: p.hash, name: p.name });
      const ops = routineOps.current;
      if (r && r.key && r.key.id != null) {
        const key = { lastUsedAt: null, ...r.key, id: String(r.key.id) };
        ops.seq++;
        ops.keys.set(key.id, { row: key, settled: ops.seq });
        setRoutine({ ...routineRef.current, keys: [...routineRef.current.keys.filter((k) => k.id !== key.id), key] });
      }
      // the server turns the flag on as part of pairing; mirror it locally without a second write
      if (!settingsRef.current.beta.suggestions) {
        settingsRef.current = { ...settingsRef.current, beta: normBeta({ ...settingsRef.current.beta, suggestions: true }) };
        setBeta(settingsRef.current.beta);
      }
      stripParams(PAIR_PARAMS);
      setPairAsk(null);
      setSideTab('claude');
      setDrawerOpen(true);
      say(`Linked ${p.name || 'the computer'}. Its suggestions will appear under Claude.`);
      pollNowRef.current();
    } catch (e) {
      if (e.status !== 401) say(e.message || 'Could not link that computer.');
    } finally { setPairBusy(false); }
  };

  const unpairKey = async (k) => {
    if (unlinkBusy) return;
    setUnlinkBusy(true);
    try {
      await store.req('POST', '/api/routine/unpair', { id: k.id });
      const ops = routineOps.current;
      ops.seq++;
      ops.keys.set(k.id, { row: null, settled: ops.seq });
      setRoutine({ ...routineRef.current, keys: routineRef.current.keys.filter((x) => x.id !== k.id) });
      say(`Unlinked ${txt(k.name) || 'that computer'}.`);
    } catch (e) {
      if (e.status !== 401) say(e.message || 'Could not unlink that computer.');
    } finally { setUnlinkBusy(false); setUnlinkArm(null); }
  };

  /* ---------------- palette + export ---------------- */

  const addColor = (hex) => {
    if (colors.length >= MAX_COLORS) { say('That is all 10 colors. Drag one to the trash to make room.'); return; }
    if (colors.includes(hex)) return;
    savePalette([...colors, hex]);
  };
  const exportCSV = () => { downloadText(`day-${dateStr}.csv`, buildCSV(blocks, dateStr), 'text/csv;charset=utf-8'); say(`Saved day-${dateStr}.csv`); };
  const exportICS = () => { downloadText(`day-${dateStr}.ics`, buildICS(sortedBlocks, dateStr), 'text/calendar;charset=utf-8'); say(`Saved day-${dateStr}.ics`); };

  /* ---------------- render ---------------- */

  const syncCls = status.offline ? 'offline' : status.error ? 'err' : status.busy ? 'busy' : 'ok';
  const syncText = status.offline ? 'Offline' : status.error ? 'Save failed' : status.busy ? 'Saving' : 'Synced';
  const syncTitle = status.offline ? 'No connection. Changes are kept here and retried.' : status.error ? String(status.error.message || 'Save failed') : 'Changes sync to every device you sign in on.';
  const initials = (user.name || user.email || '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();

  const TodoRow = (t, i, list) => {
    const col = todoColor(t);
    return html`
      <div key=${t.id} data-todo-id=${t.id} className=${'todo' + (t.done ? ' done' : '') + (liftedTodo === t.id ? ' lifted' : '')}
        onPointerDown=${(e) => startSession(e, { kind: 'todo', todo: t })}>
        <span className="grip"><${Ico.grip} /></span>
        <input className="chk" type="checkbox" checked=${!!t.done} aria-label=${t.done ? 'Mark not done' : 'Mark done'} onChange=${() => toggleDone(t)} />
        <div className="main">
          <div className="title">${t.title}</div>
          ${(t.tag || t.duration || (t.scheduled && t.scheduled.length)) ? html`
            <div className="meta">
              ${t.tag && html`<span className="chip tag" style=${{ background: col }}>${t.tag}</span>`}
              ${t.duration && html`<span className="chip"><${Ico.clock} />${durLabel(t.duration)}</span>`}
              ${(t.scheduled || []).slice(-2).map((s) => html`
                <button key=${s.blockId} className="chip sched" title="Go to that day" onClick=${(e) => { e.stopPropagation(); if (isValidDate(s.date)) setDateStr(s.date); }}>
                  <${Ico.cal} />${shortDate(s.date)}
                </button>`)}
            </div>` : null}
        </div>
        ${!t.done && html`
          <div className="ud">
            <button aria-label="Move up" disabled=${i === 0} onClick=${() => nudgeTodo(t.id, -1)}><${Ico.up} /></button>
            <button aria-label="Move down" disabled=${i === list.length - 1} onClick=${() => nudgeTodo(t.id, 1)}><${Ico.down} /></button>
          </div>`}
      </div>`;
  };

  return html`
    <div className="app">
      <header className="head">
        <div className="brand"><${Ico.cal} /><b>Day Planner</b></div>
        <div className="nav">
          <button className="btn icon round" aria-label="Previous day" onClick=${() => setDateStr((d) => shiftDate(d, -1))}><${Ico.left} /></button>
          <button className="btn icon round" aria-label="Next day" onClick=${() => setDateStr((d) => shiftDate(d, 1))}><${Ico.right} /></button>
        </div>
        <div className="datewrap">
          <input id="date" className="dateinput" type="date" value=${dateStr} onChange=${(e) => { if (isValidDate(e.target.value)) setDateStr(e.target.value); }} />
          <span className="datelabel"><span className="long">${prettyDate(dateStr)}</span><span className="short">${shortDate(dateStr)}</span>${isToday ? html`<small>Today</small>` : null}</span>
        </div>
        ${!isToday && html`<button className="btn" onClick=${() => setDateStr(todayStr())}>Today</button>`}
        <span className="spacer"></span>
        <span className=${'sync ' + syncCls} title=${syncTitle}><i></i><span>${syncText}</span></span>

        <div style=${{ position: 'relative' }}>
          <button className=${'btn google' + (gMenu ? ' on' : '')} title="Google Calendar" aria-label="Google Calendar" onClick=${() => { setGMenu((v) => !v); setPaintOpen(false); setUserMenu(false); setGConfirm(false); }}>
            <${G} />${gOn ? html`<i className="badge"></i>` : null}<span>Google</span>
          </button>
          ${gMenu && html`
            <div className="pop wide" style=${{ right: 0, top: 42 }}>
              <h4>Google Calendar</h4>
              ${!google.configured ? html`<p>Not set up on this server yet. Add <b>GOOGLE_CLIENT_ID</b> and <b>GOOGLE_CLIENT_SECRET</b> to the deployment, then reload.</p>`
              : !google.connected ? html`
                <p>See your Google Calendar events on each day, import them as locked blocks, or send blocks to Google.</p>
                <a className="btn primary" href="/api/google/connect" style=${{ display: 'inline-flex' }}>Connect Google Calendar</a>`
              : html`
                <div className="who" title=${google.email || ''}>Connected${google.email ? ` as ${google.email}` : ''}</div>
                <label className="switch"><input type="checkbox" checked=${!!google.enabled} onChange=${(e) => gToggle(e.target.checked)} /><span>Show Google events on the day</span></label>
                ${gState === 'error' && gError && html`<p style=${{ color: 'var(--danger)' }}>${gError.message}</p>`}
                <div className="row2">
                  <button className="btn" onClick=${() => setGReload((k) => k + 1)} disabled=${!google.enabled}><${Ico.refresh} /> Refresh</button>
                  ${gConfirm
                    ? html`<button className="btn danger" onClick=${gDisconnect}>Confirm disconnect</button>`
                    : html`<button className="btn" onClick=${() => setGConfirm(true)}>Disconnect</button>`}
                </div>`}
            </div>`}
        </div>

        <div style=${{ position: 'relative' }}>
          <button className=${'btn icon round paint' + (paintOpen ? ' on' : '')} title="Colors" aria-label="Colors" onClick=${() => { setPaintOpen((v) => !v); setGMenu(false); setUserMenu(false); }}><${Ico.paint} /></button>
          ${paintOpen && html`
            <div className="pop" style=${{ right: 0, top: 42 }}>
              <h4>Drag a color onto a block</h4>
              <div className="swatches">
                ${colors.map((c) => html`
                  <button key=${c} className="dot" style=${{ background: c }} title=${c} aria-label=${'Color ' + c}
                    onPointerDown=${(e) => { e.stopPropagation(); startSession(e, { kind: 'color', hex: c, immediate: e.pointerType !== 'touch', allowControls: true }); }}
                    onClick=${(e) => e.preventDefault()}></button>`)}
              </div>
              <div className="pop-foot">
                <label className="mini" title="Add a color" style=${{ cursor: colors.length >= MAX_COLORS ? 'not-allowed' : 'pointer' }}>
                  <${Ico.plus} />
                  <input id="addcolor" type="color" style=${{ position: 'absolute', width: 0, height: 0, opacity: 0 }} onChange=${(e) => addColor(e.target.value.toUpperCase())} />
                </label>
                <button className=${'mini' + (trashArmed ? ' armed' : '')} data-trash="1" title="Drag a color here to remove it" aria-label="Remove color drop zone"><${Ico.trash} /></button>
                <span className="pcount">${colors.length} / ${MAX_COLORS}</span>
              </div>
            </div>`}
        </div>

        <button className="btn primary export" title="Export this day" onClick=${() => setExportOpen(true)}><${Ico.export} /><span>Export</span></button>

        <div style=${{ position: 'relative' }}>
          <button className="avatar" title=${user.email} aria-label="Account" onClick=${() => { setUserMenu((v) => !v); setGMenu(false); setPaintOpen(false); setUnlinkArm(null); }}>${initials}</button>
          ${userMenu && html`
            <div className=${'pop' + (betaOn ? ' wide' : '')} style=${{ right: 0, top: 42 }}>
              <div className="who"><b>${user.name || 'Signed in'}</b></div>
              <p style=${{ overflowWrap: 'anywhere' }}>${user.email}</p>
              <button className="btn" onClick=${onSignOut}>Sign out</button>
              <div className="pop-sec">
                <h4>Beta features</h4>
                <label className="switch"><input type="checkbox" checked=${betaOn} disabled=${!todosLoaded} onChange=${(e) => toggleBeta(e.target.checked)} /><span>Claude's suggestions</span></label>
                ${betaOn && html`
                  <div className="keys">
                    <div className="keys-h">Linked computers</div>
                    ${routine.keys.length === 0
                      ? html`<p>None yet. Run <code>bin/bp pair</code> on your computer; <code>routine/README.md</code> has the setup.</p>`
                      : routine.keys.map((k) => {
                        const used = parseWhen(k.lastUsedAt);
                        return html`
                          <div className="keyrow" key=${k.id}>
                            <div className="km">
                              <div className="kn" title=${txt(k.name)}>${txt(k.name) || 'Unnamed computer'}</div>
                              <div className="ks">${used ? 'Last used ' + sinceLabel(used, now) : 'Not used yet'}</div>
                            </div>
                            ${unlinkArm === k.id
                              ? html`<button className="btn sm danger" disabled=${unlinkBusy} onClick=${() => unpairKey(k)}>${unlinkBusy ? html`<span className="spin"></span>` : 'Confirm unlink'}</button>`
                              : html`<button className="btn sm" onClick=${() => setUnlinkArm(k.id)}>Unlink</button>`}
                          </div>`;
                      })}
                  </div>`}
              </div>
            </div>`}
        </div>
      </header>

      <div className="body">
        <aside className=${'side' + (drawerOpen ? '' : ' closed')}>
          <div className="side-head">
            ${betaOn ? html`
              <div className="tabs side-tabs" role="tablist" aria-label="Sidebar">
                <button type="button" role="tab" aria-selected=${tab === 'todo'} className=${tab === 'todo' ? 'on' : ''} onClick=${() => setSideTab('todo')}>
                  To do <span className="count">${activeTodos.length}</span>
                </button>
                <button type="button" role="tab" aria-selected=${tab === 'claude'} className=${tab === 'claude' ? 'on' : ''} onClick=${() => setSideTab('claude')}>
                  Claude <span className=${'count' + (newCount ? ' new' : '')}>${newCount}</span>
                </button>
              </div>`
            : html`<h3>To do <span className="count">${activeTodos.length}</span></h3>`}
            ${tab === 'todo' && html`
              <${Fragment}>
                <form className="addrow" onSubmit=${(e) => { e.preventDefault(); addTodo(quickText); }}>
                  <input id="quickadd" placeholder="Add a task" value=${quickText} autoComplete="off" onChange=${(e) => setQuickText(e.target.value)} disabled=${!ready}
                    onKeyDown=${(e) => { if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); addTodo(quickText, true); } }} />
                  <button type="submit" aria-label="Add task" disabled=${!ready || !quickText.trim()}><${Ico.plus} /></button>
                </form>
                <div className="addhint">Shortcuts: <b>45m</b> or <b>1h30</b> sets a length, <b>#event</b> sets a tag. <b>Shift+Enter</b> adds and opens the task.</div>
              <//>`}
          </div>
          ${tab === 'todo' ? html`
            <${Fragment}>
              <div className="side-list" ref=${listRef}>
                ${!todosLoaded && html`<div className="empty-list">Loading tasks…</div>`}
                ${todosLoaded && activeTodos.length === 0 && html`<div className="empty-list">No tasks yet. Add one above, then drag it onto the calendar or reorder it by priority.</div>`}
                ${activeTodos.map((t, i) => TodoRow(t, i, activeTodos))}
                ${insertAt !== null && liftedTodo && InsertLine(listRef, insertAt, liftedTodo)}
                ${doneTodos.length > 0 && html`
                  <div className="section">
                    <button onClick=${() => setShowDone((v) => !v)} aria-expanded=${showDone}>
                      <${Ico.chev} style=${{ transform: showDone ? 'none' : 'rotate(-90deg)' }} />Done <span className="count">${doneTodos.length}</span>
                    </button>
                  </div>`}
                ${showDone && doneTodos.map((t, i) => TodoRow(t, i, doneTodos))}
              </div>
              <div className="quick">
                <h4>Quick blocks</h4>
                <div className="row">
                  ${QUICK_BLOCKS.map((b) => html`
                    <div key=${b.key} className="qblock" style=${{ background: b.color }} onPointerDown=${(e) => startSession(e, { kind: 'quick', block: b })}>
                      <div className="t">${b.label}</div><div className="s">${b.sub}</div>
                    </div>`)}
                </div>
              </div>
            <//>`
          : html`
            <${SuggestionsPanel} routine=${routine} now=${now} canAdd=${todosLoaded}
              onAdd=${acceptSuggestion} onDismiss=${dismissSuggestion} onRestore=${restoreSuggestion} onBrief=${() => setBriefOpen(true)} />`}
        </aside>

        <div className="cal">
          ${gOn && gAllDay.length > 0 && html`
            <div className="allday"><span className="lbl">All day</span>
              ${gAllDay.map((ev) => html`<button key=${ev.id} title=${ev.summary} onClick=${() => setGPopover(ev)}>${ev.summary}</button>`)}
            </div>`}
          <div className="scroll" ref=${scrollRef}>
            <div className="canvas" style=${{ height: DAY_MIN * PX + 28 }}>
              <div className="gutter" style=${{ height: DAY_MIN * PX }}>
                ${Array.from({ length: 24 }, (_, h) => h === 0 ? null : html`<div className="hlabel tnum" key=${h} style=${{ top: h * 60 * PX }}>${fmt(h * 60)}</div>`)}
              </div>
              <div className="grid" ref=${gridRef} style=${{ height: DAY_MIN * PX }}>
                ${Array.from({ length: 48 }, (_, i) => html`<div key=${i} className=${'line' + (i % 2 ? ' half' : '')} style=${{ top: i * 30 * PX }}></div>`)}
                ${!dayLoaded && html`<div className="loading">Loading…</div>`}
                ${dayLoaded && blocks.length === 0 && gTimed.length === 0 && !ghost && html`<div className="empty-cal">Nothing scheduled.<br />Drag a task from the list onto a time.</div>`}
                ${gTimed.map((ev) => {
                  const h = (ev.endMin - ev.startMin) * PX;
                  const tight = h < 45;
                  return html`
                    <div key=${'g' + ev.id} className="gblock" style=${{ top: ev.startMin * PX, height: Math.max(h, 15), fontSize: tight ? 11 : 12, padding: tight ? '1px 7px' : '3px 7px' }}
                      title="Google Calendar event. Click to import or delete." onClick=${() => setGPopover(ev)}>
                      <div className="nm">${ev.summary}<span className="gm">Google</span></div>
                      ${!tight && html`<div className="tm tnum">${fmt(ev.startMin)} – ${fmt(ev.endMin)}</div>`}
                    </div>`;
                })}
                ${sortedBlocks.map((t) => {
                  const h = t.duration * PX;
                  const tight = t.duration < 45;
                  return html`
                    <div key=${t.id} data-block-id=${t.id}
                      className=${'block' + (t.locked ? ' locked' : '') + (draggingId === t.id ? ' dragging' : '') + (colorTarget === t.id ? ' target' : '')}
                      style=${{ top: t.start * PX, height: Math.max(h, 15), background: t.color, fontSize: tight ? 11 : 12, padding: tight ? '1px 7px' : '3px 7px', cursor: t.locked ? 'default' : draggingId === t.id ? 'grabbing' : 'grab' }}
                      onPointerDown=${(e) => startSession(e, { kind: 'block', id: t.id, mode: 'move', locked: !!t.locked })}>
                      ${!t.locked && html`
                        <div className="hand t" onPointerDown=${(e) => { e.stopPropagation(); startSession(e, { kind: 'block', id: t.id, mode: 'top', immediate: true }); }}></div>
                        <div className="hand b" onPointerDown=${(e) => { e.stopPropagation(); startSession(e, { kind: 'block', id: t.id, mode: 'bottom', immediate: true }); }}></div>`}
                      <button className=${'lk' + (t.locked ? ' on' : '')} title=${t.locked ? 'Unlock this block' : 'Lock this block in place'} aria-label=${t.locked ? 'Unlock' : 'Lock'}
                        onClick=${(e) => { e.stopPropagation(); toggleLock(t.id); }}>${t.locked ? html`<${Ico.lock} />` : html`<${Ico.unlock} />`}</button>
                      ${tight ? html`<div className="nm">${t.name || 'Untitled'} <span className="tnum" style=${{ fontWeight: 400, opacity: 0.85 }}>${fmt(t.start)}</span></div>` : html`
                        <div className="nm">${t.name || 'Untitled'}${t.tag ? html`<span className="tg">${t.tag}</span>` : null}${t.gcalId ? html`<span className="gm">G</span>` : null}</div>
                        <div className="tm tnum">${fmt(t.start)} – ${fmt(t.start + t.duration)}</div>`}
                    </div>`;
                })}
                ${ghost && html`<div className="ghost tnum" style=${{ top: ghost.start * PX, height: Math.max(ghost.duration * PX, 16) }}>${ghost.label ? ghost.label + ' · ' : ''}${fmt(ghost.start)} – ${fmt(ghost.start + ghost.duration)}</div>`}
              </div>
              ${isToday && html`<div className="nowline" style=${{ top: nowMin * PX }}></div>`}
            </div>
          </div>
        </div>

        <div className="drawer-bar">
          <span>To do</span><span className="count">${activeTodos.length}</span>
          ${betaOn && newCount > 0 && html`<span className="count new">${newCount} from Claude</span>`}
          <button className="btn" onClick=${() => setDrawerOpen((v) => !v)} aria-expanded=${drawerOpen}>${drawerOpen ? 'Hide' : 'Show'} <${Ico.chev} style=${{ transform: drawerOpen ? 'none' : 'rotate(180deg)' }} /></button>
        </div>
      </div>

      ${blockModal && html`
        <${BlockModal} modal=${blockModal} colors=${colors} google=${google} gBusy=${gBusy}
          todo=${blockModal.draft.todoId ? todos.find((t) => t.id === blockModal.draft.todoId) : null}
          onChange=${(patch) => setBlockModal((m) => ({ ...m, draft: { ...m.draft, ...patch } }))}
          onCancel=${() => closeBlockModal(false)} onSave=${() => closeBlockModal(true)} onDelete=${() => deleteBlock(blockModal.draft.id)}
          onMarkDone=${(t) => { saveTodo({ ...t, done: true }); say(`Marked "${t.title}" done.`); }}
          onPush=${pushToGoogle} onRemoveGoogle=${removeFromGoogle} />`}

      ${todoModal && html`
        <${TodoModal} draft=${todoModal.todo} colors=${colors} knownTags=${knownTags} tagColor=${tagColor} focus=${todoModal.focus}
          onChange=${(patch) => setTodoModal((m) => ({ ...m, todo: { ...m.todo, ...patch } }))}
          onCancel=${() => setTodoModal(null)}
          onSave=${() => {
            const t = todoModal.todo;
            const title = (t.title || '').trim();
            if (!title) { say('Give the task a name.'); return; }
            saveTodo({ ...t, title, tag: t.tag ? String(t.tag).trim().toLowerCase().replace(/^#/, '') || null : null });
            setTodoModal(null);
          }}
          onDelete=${() => { removeTodo(todoModal.todo.id); setTodoModal(null); }} />`}

      ${gPopover && html`<${GoogleEventModal} ev=${gPopover} date=${dateStr} busy=${gBusy} onImport=${() => importEvent(gPopover)} onDelete=${() => deleteGoogleEvent(gPopover)} onClose=${() => setGPopover(null)} />`}

      ${briefOpen && betaOn && routine.brief && html`<${BriefModal} brief=${routine.brief} now=${now} onClose=${() => setBriefOpen(false)} />`}

      ${pairAsk && html`<${PairModal} name=${pairAsk.name} hash=${pairAsk.hash} email=${user.email} busy=${pairBusy} onLink=${linkRoutine} onCancel=${cancelPair} />`}

      ${exportOpen && html`
        <div className="scrim" onPointerDown=${() => setExportOpen(false)}>
          <div className="modal wide" onPointerDown=${(e) => e.stopPropagation()}>
            <div className="mhead"><h2>Export ${prettyDate(dateStr)}</h2><button className="x" onClick=${() => setExportOpen(false)} aria-label="Close"><${Ico.close} /></button></div>
            <div className="mbody">
              ${blocks.length === 0 ? html`<p className="note">This day is empty. Add some blocks first.</p>` : html`
                <${Fragment}>
                  <p className="note">Save the day as a calendar file. <b>.ics</b> opens in any calendar app; <b>.csv</b> is for Google Calendar's Settings → Import.
                    ${google.connected ? html` Or open a block and use <b>Add to Google Calendar</b> to send it straight to Google.` : null}</p>
                  <div className="chips" style=${{ marginBottom: 16 }}>
                    <button className="btn primary" onClick=${exportICS}><${Ico.export} /> Save .ics</button>
                    <button className="btn" onClick=${exportCSV}><${Ico.export} /> Save .csv</button>
                  </div>
                  <div className="field"><span className="lbl">Or open one at a time</span>
                    <div className="elist">
                      ${sortedBlocks.map((t) => html`
                        <div className="erow" key=${t.id}><span className="sw" style=${{ background: t.color }}></span><span className="en">${t.name || 'Untitled'}</span>
                          <span className="et tnum">${fmt(t.start)} – ${fmt(t.start + t.duration)}</span>
                          <a className="link" href=${gcalLink(t, dateStr)} target="_blank" rel="noopener noreferrer">Open</a></div>`)}
                    </div>
                  </div>
                <//>`}
            </div>
            <div className="mfoot"><span className="spacer"></span><button className="btn" onClick=${() => setExportOpen(false)}>Close</button></div>
          </div>
        </div>`}

      ${proxy && html`
        <div className=${'proxy' + (proxy.swatch ? ' swatch' : '')} style=${proxy.swatch ? { left: proxy.x, top: proxy.y, background: proxy.swatch } : { left: proxy.x, top: proxy.y, borderColor: proxy.color }}>${proxy.swatch ? null : proxy.label}</div>`}

      ${toast && html`<div className="toast" role="status">${toast}</div>`}
    </div>`;
}

function InsertLine(listRef, index, exceptId) {
  const list = listRef.current;
  if (!list) return null;
  const items = [...list.querySelectorAll('[data-todo-id]')].filter((el) => el.dataset.todoId !== exceptId && !el.classList.contains('done'));
  const lr = list.getBoundingClientRect();
  let y;
  if (items.length === 0) y = 8;
  else if (index >= items.length) { const r = items[items.length - 1].getBoundingClientRect(); y = r.bottom - lr.top + list.scrollTop + 3; }
  else { const r = items[index].getBoundingClientRect(); y = r.top - lr.top + list.scrollTop - 4; }
  return html`<div className="insert" style=${{ top: y }}></div>`;
}

/* ------------------------------------------------------------------ */
/* block modal                                                         */
/* ------------------------------------------------------------------ */

function BlockModal({ modal, colors, todo, google, gBusy, onChange, onCancel, onSave, onDelete, onMarkDone, onPush, onRemoveGoogle }) {
  const d = modal.draft;
  const inputRef = useRef(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  useEffect(() => { if (inputRef.current && !modal.needDuration) inputRef.current.focus(); }, [modal.needDuration]);
  const end = d.start + d.duration;
  const setStart = (v) => { const s = clamp(fromHHMM(v), 0, DAY_MIN - SNAP); onChange({ start: s, duration: clamp(d.duration, SNAP, DAY_MIN - s) }); };
  const setEnd = (v) => { let e = fromHHMM(v); if (e <= d.start) e = Math.min(d.start + SNAP, DAY_MIN); onChange({ duration: e - d.start }); };
  const setDur = (m) => onChange({ duration: clamp(m, SNAP, DAY_MIN - d.start) });
  const gOn = google && google.connected && google.enabled;
  return html`
    <div className="scrim" onPointerDown=${onCancel}>
      <div className="modal" onPointerDown=${(e) => e.stopPropagation()}>
        <div className="mhead"><h2>${modal.mode === 'create' ? (modal.needDuration ? 'How long?' : 'New block') : 'Edit block'}</h2><button className="x" onClick=${onCancel} aria-label="Close"><${Ico.close} /></button></div>
        <div className="mbody">
          ${todo && html`<div className="fromtask">From task <b>${todo.title}</b>${!todo.done && html`<button className="btn" style=${{ height: 28 }} onClick=${() => onMarkDone(todo)}><${Ico.check} /> Done</button>`}</div>`}
          ${d.gcalId && html`
            <div className="gcalrow"><span className="gicon">G</span><span>In <b>Google Calendar</b>${d.locked ? ' · locked' : ''}</span>
              <span className="right">
                ${d.gcalLink && html`<a className="btn" style=${{ height: 28 }} href=${d.gcalLink} target="_blank" rel="noopener noreferrer"><${Ico.ext} /> Open</a>`}
                ${confirmRemove
                  ? html`<button className="btn danger" style=${{ height: 28 }} disabled=${gBusy} onClick=${onRemoveGoogle}>${gBusy ? html`<span className="spin"></span>` : 'Confirm delete from Google'}</button>`
                  : html`<button className="btn" style=${{ height: 28 }} onClick=${() => setConfirmRemove(true)}>Delete from Google</button>`}
              </span>
            </div>`}
          <div className="field"><input ref=${inputRef} id="blockname" className="text" placeholder="Add a title" value=${d.name} onChange=${(e) => onChange({ name: e.target.value })} onKeyDown=${(e) => e.key === 'Enter' && onSave()} /></div>
          <div className="field"><span className="lbl">Length · ${durLabel(d.duration)}</span>
            <div className="chips">${DUR_CHIPS.map((m) => html`<button key=${m} className=${'chipbtn' + (d.duration === m ? ' on' : '')} onClick=${() => setDur(m)}>${durLabel(m)}</button>`)}</div>
          </div>
          <div className="field row">
            <div><label htmlFor="bstart">Starts</label><input id="bstart" className="inp tnum" type="time" step="300" value=${toHHMM(d.start)} onChange=${(e) => setStart(e.target.value)} /></div>
            <div><label htmlFor="bend">Ends</label><input id="bend" className="inp tnum" type="time" step="300" value=${toHHMM(end === DAY_MIN ? 1439 : end)} onChange=${(e) => setEnd(e.target.value)} /></div>
          </div>
          <div className="field"><span className="lbl">Color</span>
            <div className="swatches">${colors.map((c) => html`<button key=${c} className=${'dot' + (c === d.color ? ' sel' : '')} style=${{ background: c, cursor: 'pointer' }} aria-label=${'Use ' + c} onClick=${() => onChange({ color: c })}></button>`)}</div>
          </div>
          <label className="check"><input type="checkbox" checked=${!!d.locked} onChange=${(e) => onChange({ locked: e.target.checked })} /><span>Lock this block<span className="sub"> · other blocks move around it, it never moves</span></span></label>
        </div>
        <div className="mfoot">
          ${modal.mode === 'edit' && html`<button className="btn danger" onClick=${onDelete}>Delete</button>`}
          ${gOn && !d.gcalId && html`<button className="btn google" disabled=${gBusy} onClick=${onPush} title="Create this block as an event in Google Calendar and lock it">${gBusy ? html`<span className="spin"></span>` : html`<${G} />`} Add to Google</button>`}
          <span className="spacer"></span>
          <button className="btn" onClick=${onCancel}>Cancel</button>
          <button className="btn primary" onClick=${onSave}>${modal.mode === 'create' ? 'Add' : 'Save'}</button>
        </div>
      </div>
    </div>`;
}

/* ------------------------------------------------------------------ */
/* google event modal                                                  */
/* ------------------------------------------------------------------ */

function GoogleEventModal({ ev, date, busy, onImport, onDelete, onClose }) {
  const [confirm, setConfirm] = useState(false);
  const { startMin, endMin } = eventMinutes(ev, date);
  const when = ev.allDay ? 'All day' : `${fmt(startMin)} – ${fmt(endMin)}`;
  return html`
    <div className="scrim" onPointerDown=${onClose}>
      <div className="modal" onPointerDown=${(e) => e.stopPropagation()}>
        <div className="mhead"><span className="gicon">G</span><h2>Google Calendar</h2><button className="x" onClick=${onClose} aria-label="Close"><${Ico.close} /></button></div>
        <div className="mbody">
          <div className="gev-title">${ev.summary}</div>
          <div className="gev-time tnum">${when}${ev.location ? ` · ${ev.location}` : ''}</div>
          ${ev.description && html`<div className="gev-desc">${ev.description}</div>`}
          <p className="note">Import it to plan around it here: it becomes a <b>locked block</b> that other blocks move around. Deleting removes it from your Google Calendar.</p>
        </div>
        <div className="mfoot">
          ${confirm
            ? html`<button className="btn danger" disabled=${busy} onClick=${onDelete}>${busy ? html`<span className="spin"></span>` : 'Confirm delete from Google'}</button>`
            : html`<button className="btn danger" onClick=${() => setConfirm(true)}>Delete from Google</button>`}
          ${ev.htmlLink && html`<a className="btn" href=${ev.htmlLink} target="_blank" rel="noopener noreferrer"><${Ico.ext} /> Open</a>`}
          <span className="spacer"></span>
          <button className="btn" onClick=${onClose}>Close</button>
          <button className="btn primary" disabled=${ev.allDay} onClick=${onImport}><${Ico.lock} /> Import as locked block</button>
        </div>
      </div>
    </div>`;
}

/* ------------------------------------------------------------------ */
/* to-do modal                                                         */
/* ------------------------------------------------------------------ */

function TodoModal({ draft, colors, knownTags, tagColor, focus, onChange, onCancel, onSave, onDelete }) {
  const d = draft;
  const inputRef = useRef(null);
  const durRef = useRef(null);
  useEffect(() => {
    const el = focus === 'duration' ? durRef.current : inputRef.current;
    if (el) { el.focus(); if (el.select) el.select(); }
  }, [focus]);
  const [custom, setCustom] = useState(d.duration && !DUR_CHIPS.includes(d.duration) ? String(d.duration) : '');
  const setDur = (m) => { onChange({ duration: m }); setCustom(m && !DUR_CHIPS.includes(m) ? String(m) : ''); };
  return html`
    <div className="scrim" onPointerDown=${onCancel}>
      <div className="modal" onPointerDown=${(e) => e.stopPropagation()}>
        <div className="mhead"><h2>Task</h2><button className="x" onClick=${onCancel} aria-label="Close"><${Ico.close} /></button></div>
        <div className="mbody">
          <div className="field"><input ref=${inputRef} id="todotitle" className="text" placeholder="What needs doing?" value=${d.title || ''} onChange=${(e) => onChange({ title: e.target.value })} onKeyDown=${(e) => e.key === 'Enter' && onSave()} /></div>
          <div className="field"><label htmlFor="todotag">Tag</label>
            <input id="todotag" className="inp" list="taglist" placeholder="event, errand, call…" value=${d.tag || ''} onChange=${(e) => onChange({ tag: e.target.value })} autoComplete="off" />
            <datalist id="taglist">${knownTags.map((t) => html`<option key=${t} value=${t}></option>`)}</datalist>
            ${knownTags.length > 0 && html`
              <div className="chips" style=${{ marginTop: 8 }}>
                ${knownTags.map((t) => html`<button key=${t} className=${'chipbtn' + (d.tag === t ? ' tagc' : '')} style=${d.tag === t ? { background: tagColor(t, d.color) } : null} onClick=${() => onChange({ tag: d.tag === t ? null : t })}>${t}</button>`)}
              </div>`}
          </div>
          <div className="field"><span className="lbl">Length ${d.duration ? '· ' + durLabel(d.duration) : '· choose when placed'}</span>
            <div className="chips">
              <button className=${'chipbtn' + (!d.duration ? ' on' : '')} onClick=${() => setDur(null)}>None</button>
              ${DUR_CHIPS.map((m) => html`<button key=${m} className=${'chipbtn' + (d.duration === m ? ' on' : '')} onClick=${() => setDur(m)}>${durLabel(m)}</button>`)}
              <input ref=${durRef} id="tododur" className="inp tnum" type="number" min="5" max="1440" step="5" placeholder="min" value=${custom} style=${{ width: 72, height: 28 }} aria-label="Length in minutes"
                onChange=${(e) => { setCustom(e.target.value); const n = parseInt(e.target.value, 10); if (n >= 5) onChange({ duration: clamp(Math.round(n / 5) * 5, 5, DAY_MIN) }); }}
                onKeyDown=${(e) => e.key === 'Enter' && onSave()} />
            </div>
          </div>
          <div className="field"><span className="lbl">Color</span>
            <div className="swatches">
              <button className=${'dot' + (!d.color ? ' sel' : '')} title="Automatic" aria-label="Automatic color" style=${{ background: 'transparent', border: '2px dashed var(--faint)', cursor: 'pointer' }} onClick=${() => onChange({ color: null })}></button>
              ${colors.map((c) => html`<button key=${c} className=${'dot' + (c === d.color ? ' sel' : '')} style=${{ background: c, cursor: 'pointer' }} aria-label=${'Use ' + c} onClick=${() => onChange({ color: c })}></button>`)}
            </div>
          </div>
          <label className="check"><input type="checkbox" checked=${!!d.done} onChange=${(e) => onChange({ done: e.target.checked })} /><span>Done</span></label>
        </div>
        <div className="mfoot">
          <button className="btn danger" onClick=${onDelete}>Delete</button>
          <span className="spacer"></span>
          <button className="btn" onClick=${onCancel}>Cancel</button>
          <button className="btn primary" onClick=${onSave}>Save</button>
        </div>
      </div>
    </div>`;
}

/* ------------------------------------------------------------------ */
/* Claude's suggestions (beta): sidebar tab, brief, pairing            */
/* ------------------------------------------------------------------ */

const PILL_LABEL = { ok: 'OK', partial: 'Partial', skipped: 'Skipped', error: 'Error', corrected: 'Corrected' };

function StatusPill({ status }) {
  const s = txt(status);
  return html`<span className=${'pill ' + (PILL[s] || 'mute')}>${PILL_LABEL[s] || s || 'Unknown'}</span>`;
}

function DueChip({ due, now }) {
  const d = parseWhen(due);
  if (!d) return null;
  const over = d.getTime() < now.getTime();
  return html`<span className=${'chip' + (over ? ' overdue' : '')} title=${over ? 'Overdue' : 'Due'}><${Ico.cal} /><span className="ell">${whenLabel(d)}</span></span>`;
}

function SuggestionsPanel({ routine, now, canAdd, onAdd, onDismiss, onRestore, onBrief }) {
  const [showHandled, setShowHandled] = useState(false);
  const all = routine.suggestions;
  const fresh = all.filter((s) => suggStatus(s) === 'new');
  const handled = all.filter((s) => suggStatus(s) !== 'new').sort((a, b) => txt(b.updatedAt).localeCompare(txt(a.updatedAt)));
  const groups = PRIORITIES.map((p) => ({
    p,
    items: fresh.filter((s) => suggPrio(s) === p).sort((a, b) => (dueMs(a) - dueMs(b)) || txt(a.firstSeen).localeCompare(txt(b.firstSeen))),
  })).filter((g) => g.items.length > 0);
  const brief = routine.brief;
  const linked = routine.keys.length > 0;
  const ran = brief ? parseWhen(brief.generatedAt) : null;
  const ranLabel = ran ? sinceLabel(ran, now) : brief && isValidDate(txt(brief.date)) ? shortDate(brief.date) : '';

  const card = (s) => {
    const src = s.source && typeof s.source === 'object' ? s.source : {};
    const label = txt(src.label);
    const url = safeUrl(src.url);
    const dup = s.duplicateOf && typeof s.duplicateOf === 'object' ? s.duplicateOf : null;
    const dur = Number(s.duration);
    return html`
      <div className="sugg" key=${s.fingerprint}>
        <div className="title">${txt(s.title) || 'Untitled'}</div>
        <div className="meta">
          ${label && html`<span className="chip" title=${label}><span className="ell">${label}</span></span>`}
          <${DueChip} due=${s.due} now=${now} />
          ${Number.isFinite(dur) && dur > 0 && html`<span className="chip"><${Ico.clock} />${durLabel(Math.round(dur))}</span>`}
          ${s.addedBy === 'mentor' && html`<span className="chip mentor" title="Added when the mentor reviewed this run">added by mentor</span>`}
        </div>
        ${txt(s.why) && html`<div className="why">${txt(s.why)}</div>`}
        ${dup && html`<div className="dup">${dup.confidence === 'high' ? 'Likely' : 'Possible'} duplicate of “${txt(dup.title) || 'an existing task'}”</div>`}
        <div className="acts">
          ${url && html`<a className="link open" href=${url} target="_blank" rel="noopener noreferrer"><${Ico.ext} />Open</a>`}
          <span className="push">
            <button type="button" className="btn sm" onClick=${() => onDismiss(s)}>Dismiss</button>
            <button type="button" className="btn sm primary" disabled=${!canAdd} onClick=${() => onAdd(s)}>${dup ? 'Add anyway' : 'Add'}</button>
          </span>
        </div>
      </div>`;
  };

  const hrow = (s) => html`
    <div className="hrow" key=${s.fingerprint}>
      <span className="ht" title=${txt(s.title)}>${txt(s.title) || 'Untitled'}</span>
      ${suggStatus(s) === 'accepted'
        ? html`<span className="chip added">Added</span>`
        : html`<${Fragment}><span className="chip">Dismissed</span><button type="button" className="btn sm" onClick=${() => onRestore(s)}>Undo</button><//>`}
    </div>`;

  return html`
    <${Fragment}>
      ${brief && html`
        <div className="claude-run">
          <span>Last run${ranLabel ? ' ' + ranLabel : ''}</span><span aria-hidden="true">·</span>
          <button type="button" className="linkbtn" onClick=${onBrief}>Brief</button>
        </div>`}
      <div className="side-list claude-list">
        ${!linked && html`
          <div className="claude-note">
            <p><b>Link a computer to get suggestions.</b> They come from a Claude routine that runs on your own computer under your own Claude plan; this planner never calls Claude itself.</p>
            <p>Follow the setup guide in <code>routine/README.md</code> in the planner's repository, then run <code>bin/bp pair</code> on that computer and open the link it gives you while signed in here.</p>
          </div>`}
        ${linked && !brief && all.length === 0 && html`<div className="empty-list">No run has reported yet. Suggestions appear here after the routine on your computer finishes a run.</div>`}
        ${groups.map((g) => html`
          <div className="sgroup" key=${g.p}>
            <div className="section">${PRIO_LABEL[g.p]} <span className="count">${g.items.length}</span></div>
            ${g.items.map(card)}
          </div>`)}
        ${brief && fresh.length === 0 && html`<div className="empty-list">Nothing new from Claude.</div>`}
        ${handled.length > 0 && html`
          <div className="section">
            <button type="button" onClick=${() => setShowHandled((v) => !v)} aria-expanded=${showHandled}>
              <${Ico.chev} style=${{ transform: showHandled ? 'none' : 'rotate(-90deg)' }} />Handled <span className="count">${handled.length}</span>
            </button>
          </div>`}
        ${showHandled && handled.length > 0 && html`<div className="hlist">${handled.map(hrow)}</div>`}
      </div>
    <//>`;
}

function BriefModal({ brief, now, onClose }) {
  const b = brief;
  const date = txt(b.date);
  const gen = parseWhen(b.generatedAt);
  const coverage = listOf(b.coverage).filter((c) => c && typeof c === 'object');
  const mentor = b.mentor && typeof b.mentor === 'object' ? b.mentor : null;
  const notes = mentor ? listOf(mentor.notes).map(txt).filter(Boolean) : [];
  const corrections = mentor ? Number(mentor.corrections) : 0;
  const questions = listOf(b.questions).map(txt).filter(Boolean);
  const item = (it, i) => {
    const src = it.source && typeof it.source === 'object' ? it.source : {};
    const label = txt(src.label);
    const url = safeUrl(src.url);
    return html`
      <li key=${i + ':' + txt(it.fingerprint)}>
        <div className="bt">${txt(it.title) || 'Untitled'}</div>
        ${txt(it.why) && html`<div className="bw">${txt(it.why)}</div>`}
        ${(parseWhen(it.due) || label) && html`
          <div className="meta">
            <${DueChip} due=${it.due} now=${now} />
            ${label && (url
              ? html`<a className="chip srclink" href=${url} target="_blank" rel="noopener noreferrer" title=${label}><span className="ell">${label}</span><${Ico.ext} /></a>`
              : html`<span className="chip" title=${label}><span className="ell">${label}</span></span>`)}
          </div>`}
      </li>`;
  };
  return html`
    <div className="scrim" onPointerDown=${onClose}>
      <div className="modal wide" role="dialog" aria-modal="true" aria-labelledby="brief-h" onPointerDown=${(e) => e.stopPropagation()}>
        <div className="mhead"><h2 id="brief-h">Brief${isValidDate(date) ? ' · ' + shortDate(date) : ''}</h2><button className="x" onClick=${onClose} aria-label="Close"><${Ico.close} /></button></div>
        <div className="mbody brief">
          ${gen && html`<p className="brief-when">Generated ${whenLabel(gen)}</p>`}
          ${txt(b.summary) && html`<p className="brief-sum">${txt(b.summary)}</p>`}
          ${PRIORITIES.map((p) => {
            const items = listOf(b[p]).filter((it) => it && typeof it === 'object');
            return html`
              <div className="field" key=${p}><span className="lbl">${PRIO_LABEL[p]} · ${items.length}</span>
                ${items.length > 0 ? html`<ul className="blist">${items.map(item)}</ul>` : html`<p className="brief-none">Nothing at this level.</p>`}
              </div>`;
          })}
          ${coverage.length > 0 && html`
            <div className="field"><span className="lbl">Coverage</span>
              <table className="cov">
                <tbody>
                  ${coverage.map((c, i) => html`
                    <tr key=${i}>
                      <td className="cs">${txt(c.source)}</td>
                      <td><${StatusPill} status=${c.status} /></td>
                      <td className="cd">${txt(c.detail)}</td>
                    </tr>`)}
                </tbody>
              </table>
            </div>`}
          ${mentor && html`
            <div className="field"><span className="lbl">Mentor</span>
              <div className="mentor-line">
                <${StatusPill} status=${mentor.status} />
                ${Number.isFinite(corrections) && corrections > 0 && html`<span>${corrections} correction${corrections === 1 ? '' : 's'}</span>`}
              </div>
              ${notes.length > 0 && html`<ul className="plain">${notes.map((n, i) => html`<li key=${i}>${n}</li>`)}</ul>`}
            </div>`}
          ${questions.length > 0 && html`
            <div className="field"><span className="lbl">Questions</span>
              <ul className="plain">${questions.map((q, i) => html`<li key=${i}>${q}</li>`)}</ul>
            </div>`}
        </div>
        <div className="mfoot"><span className="spacer"></span><button className="btn" onClick=${onClose}>Close</button></div>
      </div>
    </div>`;
}

function PairModal({ name, email, hash, busy, onLink, onCancel }) {
  // Same code `bp pair` prints in the terminal; a link the user did not just create shows a different one.
  const code = `${String(hash || '').slice(0, 4)}-${String(hash || '').slice(4, 8)}`.toUpperCase();
  return html`
    <div className="scrim" onPointerDown=${onCancel}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="pair-h" onPointerDown=${(e) => e.stopPropagation()}>
        <div className="mhead"><h2 id="pair-h" className="pair-h">Link Claude routine on ${name || 'an unnamed computer'}?</h2><button className="x" onClick=${onCancel} aria-label="Close"><${Ico.close} /></button></div>
        <div className="mbody">
          <p className="note">This lets that computer read your to-do list and add suggestions to <b>${email}</b>, so continue only if you just ran <code>bin/bp pair</code> there.</p>
          <div className="field"><span className="lbl">Verification code</span>
            <div className="pair-code tnum">${code}</div>
          </div>
          <p className="note">It must match the code in your terminal. If you did not ask for this, or the code differs, choose Cancel.</p>
        </div>
        <div className="mfoot">
          <span className="spacer"></span>
          <button className="btn" onClick=${onCancel}>Cancel</button>
          <button className="btn primary" disabled=${busy} onClick=${onLink}>${busy ? html`<span className="spin"></span>` : 'Link'}</button>
        </div>
      </div>
    </div>`;
}

const start = () => ReactDOM.createRoot(document.getElementById('root')).render(html`<${Root} />`);
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
