// Server-side shape checks for the documents the app stores. Keeps junk out of the database
// without forcing the client model into relational columns.
import { bad } from './http.js';

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
  return out;
}
