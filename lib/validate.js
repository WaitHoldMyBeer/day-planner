// Server-side shape checks for the documents the app stores. Keeps junk out of the database
// without forcing the client model into relational columns.
import { bad, isDate, isId } from './http.js';

const DAY_MIN = 1440;

function str(v, max, field) {
  if (v == null) return '';
  if (typeof v !== 'string') throw bad(`${field} must be text.`);
  return v.length > max ? v.slice(0, max) : v;
}
function num(v, lo, hi, field) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw bad(`${field} must be a number.`);
  return Math.max(lo, Math.min(hi, n));
}
const REV = /^[A-Za-z0-9]{6,40}$/;
export function rev(v) {
  if (typeof v !== 'string' || !REV.test(v)) throw bad('Missing revision.');
  return v;
}

export function cleanBlocks(arr) {
  if (!Array.isArray(arr)) throw bad('blocks must be a list.');
  if (arr.length > 500) throw bad('Too many blocks in one day.');
  return arr.map((b) => {
    if (!b || typeof b !== 'object') throw bad('Bad block.');
    const out = {
      id: str(b.id, 80, 'block id'),
      name: str(b.name, 300, 'name'),
      start: num(b.start, 0, DAY_MIN, 'start'),
      duration: num(b.duration, 1, DAY_MIN, 'duration'),
      color: str(b.color, 30, 'color'),
      locked: !!b.locked,
    };
    if (!out.id) throw bad('Block needs an id.');
    if (b.todoId) out.todoId = str(b.todoId, 80, 'todoId');
    if (b.tag) out.tag = str(b.tag, 60, 'tag');
    if (b.gcalId) out.gcalId = str(b.gcalId, 300, 'gcalId');
    if (b.gcalLink) out.gcalLink = str(b.gcalLink, 600, 'gcalLink');
    return out;
  });
}

export function cleanTodo(t) {
  if (!t || typeof t !== 'object') throw bad('Bad task.');
  const out = {
    title: str(t.title, 500, 'title'),
    tag: t.tag ? str(t.tag, 60, 'tag') : null,
    duration: t.duration == null || t.duration === '' ? null : num(t.duration, 5, DAY_MIN, 'duration'),
    color: t.color ? str(t.color, 30, 'color') : null,
    order: Number.isFinite(Number(t.order)) ? Number(t.order) : 0,
    done: !!t.done,
    scheduled: Array.isArray(t.scheduled)
      ? t.scheduled.slice(0, 200).map((s) => ({ date: str(s && s.date, 10, 'date'), blockId: str(s && s.blockId, 80, 'blockId') }))
      : [],
    createdAt: str(t.createdAt, 40, 'createdAt') || new Date().toISOString(),
    updatedAt: str(t.updatedAt, 40, 'updatedAt') || new Date().toISOString(),
  };
  return out;
}

export function cleanSettings(s) {
  if (!s || typeof s !== 'object') throw bad('Bad settings.');
  const out = {};
  if (Array.isArray(s.colors)) {
    out.colors = s.colors.slice(0, 10).map((c) => str(c, 30, 'color')).filter((c) => /^#[0-9A-Fa-f]{3,8}$/.test(c));
  }
  if (typeof s.googleColor === 'string') out.googleColor = str(s.googleColor, 30, 'googleColor');
  if (s.beta != null) {
    if (!isObj(s.beta)) throw bad('beta must be an object.');
    out.beta = {};
    if (s.beta.suggestions != null) out.beta.suggestions = flag(s.beta.suggestions, 'beta.suggestions');
  }
  return out;
}

// ---- Claude's suggestions (routine/SPEC.md §3). Input comes from an agent, so wrong types,
// enum values and identifiers are rejected; free text is trimmed and capped instead.

export const FINGERPRINT = /^[a-z0-9][a-z0-9:._@-]{2,159}$/;
const TAG = /^[a-z0-9-]{1,40}$/;
const ISO_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
const PRIORITIES = ['high', 'medium', 'low'];
const SOURCE_KINDS = ['mail', 'canvas', 'gradescope', 'piazza', 'calendar', 'ucsd', 'clickup', 'other'];
const LIST_MAX = 40;

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

function flag(v, field) {
  if (v == null) return false;
  if (typeof v !== 'boolean') throw bad(`${field} must be true or false.`);
  return v;
}

function oneOf(v, allowed, field) {
  if (!allowed.includes(v)) throw bad(`${field} must be one of: ${allowed.join(', ')}.`);
  return v;
}

/**
 * Free text: well-formed, no control characters, whitespace collapsed (newlines kept when
 * multiline), trimmed, capped. The cap never leaves half a surrogate pair, which Postgres
 * rejects inside JSONB.
 */
export function cleanText(v, max, field, multiline = false) {
  if (v == null) return '';
  if (typeof v !== 'string') throw bad(`${field} must be text.`);
  let s = v.toWellFormed().replace(/\r\n?/g, '\n');
  s = multiline
    ? s.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').replace(/[ ]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n')
    : s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ');
  s = s.trim();
  if (s.length > max) s = s.slice(0, max).replace(/[\uD800-\uDBFF]$/, '').trimEnd();
  return s;
}
const optText = (v, max, field) => cleanText(v, max, field) || null;

function list(v, field) {
  if (v == null) return [];
  if (!Array.isArray(v)) throw bad(`${field} must be a list.`);
  return v.slice(0, LIST_MAX);
}

export function cleanFingerprint(v, field = 'fingerprint') {
  if (typeof v !== 'string' || !FINGERPRINT.test(v)) throw bad(`${field} must match ${FINGERPRINT.source}.`);
  return v;
}

function httpsUrl(v, field) {
  if (v == null || v === '') return null;
  if (typeof v !== 'string') throw bad(`${field} must be an https:// link or null.`);
  const s = v.trim();
  let u = null;
  try { u = new URL(s); } catch (e) { /* rejected below */ }
  if (!u || u.protocol !== 'https:' || !/^https:\/\//i.test(s)) throw bad(`${field} must be an https:// link or null.`);
  if (u.href.length > 2000) throw bad(`${field} is too long.`);
  return u.href;
}

function isoTime(v, field) {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || !ISO_OFFSET.test(v) || Number.isNaN(Date.parse(v))) {
    throw bad(`${field} must be an ISO 8601 time with offset (2026-09-29T23:59:00-07:00) or null.`);
  }
  return v;
}

function minutes(v, field) {
  if (v == null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw bad(`${field} must be a number of minutes or null.`);
  return Math.max(5, Math.min(DAY_MIN, Math.round(v)));
}

function tag(v) {
  if (v == null || v === '') return null;
  if (typeof v !== 'string') throw bad('tag must be text or null.');
  const t = v.trim().toLowerCase().slice(0, 40);
  if (!TAG.test(t)) throw bad(`tag must match ${TAG.source} or be null.`);
  return t;
}

function duplicateOf(d) {
  if (d == null) return null;
  if (!isObj(d)) throw bad('duplicateOf must be an object or null.');
  if (!isId(d.todoId)) throw bad('duplicateOf.todoId must be a to-do id.');
  return {
    todoId: d.todoId,
    title: cleanText(d.title, 300, 'duplicateOf.title'),
    confidence: oneOf(d.confidence, ['high', 'possible'], 'duplicateOf.confidence'),
  };
}

/** One suggestion as sent by the routine. Unknown keys are dropped. */
export function cleanSuggestion(s) {
  if (!isObj(s)) throw bad('Each suggestion must be an object.');
  const title = cleanText(s.title, 300, 'title');
  if (!title) throw bad('title is required.');
  if (!isObj(s.source)) throw bad('source must be an object.');
  const src = s.source;
  return {
    fingerprint: cleanFingerprint(s.fingerprint),
    title,
    priority: oneOf(s.priority, PRIORITIES, 'priority'),
    why: cleanText(s.why, 240, 'why'),
    source: {
      kind: oneOf(src.kind, SOURCE_KINDS, 'source.kind'),
      account: optText(src.account, 200, 'source.account'),
      label: cleanText(src.label, 120, 'source.label'),
      url: httpsUrl(src.url, 'source.url'),
      ref: optText(src.ref, 200, 'source.ref'),
    },
    due: isoTime(s.due, 'due'),
    duration: minutes(s.duration, 'duration'),
    tag: tag(s.tag),
    duplicateOf: duplicateOf(s.duplicateOf),
    addedBy: s.addedBy == null ? 'routine' : oneOf(s.addedBy, ['routine', 'mentor'], 'addedBy'),
    resurface: flag(s.resurface, 'resurface'),
  };
}

function briefItem(it, field) {
  if (!isObj(it)) throw bad(`${field} must be an object.`);
  const title = cleanText(it.title, 300, `${field}.title`);
  if (!title) throw bad(`${field}.title is required.`);
  let source = null;
  if (it.source != null) {
    if (!isObj(it.source)) throw bad(`${field}.source must be an object or null.`);
    source = { label: cleanText(it.source.label, 120, `${field}.source.label`), url: httpsUrl(it.source.url, `${field}.source.url`) };
  }
  return {
    title,
    why: cleanText(it.why, 240, `${field}.why`),
    due: isoTime(it.due, `${field}.due`),
    source,
    fingerprint: it.fingerprint == null ? null : cleanFingerprint(it.fingerprint, `${field}.fingerprint`),
  };
}

function coverageItem(c, i) {
  const field = `brief.coverage[${i}]`;
  if (!isObj(c)) throw bad(`${field} must be an object.`);
  return {
    source: cleanText(c.source, 80, `${field}.source`),
    status: oneOf(c.status, ['ok', 'partial', 'skipped', 'error'], `${field}.status`),
    detail: cleanText(c.detail, 240, `${field}.detail`),
  };
}

function mentor(m) {
  if (m == null) return null;
  if (!isObj(m)) throw bad('brief.mentor must be an object or null.');
  if (m.corrections != null && (typeof m.corrections !== 'number' || !Number.isFinite(m.corrections))) {
    throw bad('brief.mentor.corrections must be a number.');
  }
  return {
    status: oneOf(m.status, ['ok', 'corrected', 'skipped'], 'brief.mentor.status'),
    corrections: Math.max(0, Math.min(1000, Math.round(m.corrections || 0))),
    notes: list(m.notes, 'brief.mentor.notes').map((n, i) => cleanText(n, 400, `brief.mentor.notes[${i}]`)).filter(Boolean),
  };
}

/** The daily brief. Each list keeps its first 40 items. */
export function cleanBrief(b) {
  if (!isObj(b)) throw bad('brief must be an object.');
  if (!isDate(b.date)) throw bad('brief.date must be YYYY-MM-DD.');
  const out = {
    date: b.date,
    runId: optText(b.runId, 60, 'brief.runId'),
    generatedAt: isoTime(b.generatedAt, 'brief.generatedAt'),
    summary: cleanText(b.summary, 2000, 'brief.summary', true),
  };
  for (const p of PRIORITIES) out[p] = list(b[p], `brief.${p}`).map((it, i) => briefItem(it, `brief.${p}[${i}]`));
  out.coverage = list(b.coverage, 'brief.coverage').map(coverageItem);
  out.mentor = mentor(b.mentor);
  out.questions = list(b.questions, 'brief.questions').map((x, i) => cleanText(x, 400, `brief.questions[${i}]`)).filter(Boolean);
  return out;
}
