// End-to-end tests for Claude's suggestions (routine/SPEC.md) against a real Postgres.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createServer } from '../dev/server.js';
import { closeDb, q } from '../lib/db.js';

process.env.AUTH_SECRET = process.env.AUTH_SECRET || 'test-secret-that-is-long-enough-123456';
process.env.INVITE_CODE = process.env.INVITE_CODE || 'testcode';

let server; let base;
const stamp = `${Date.now()}${crypto.randomBytes(3).toString('hex')}`;
const emailA = `ra${stamp}@example.com`;
const emailB = `rb${stamp}@example.com`;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const keyA = crypto.randomBytes(32).toString('base64url');
const keyB = crypto.randomBytes(32).toString('base64url');

// A session-authenticated client with its own cookie jar.
function client() {
  const jar = new Map();
  return async function call(method, path, body, headers = {}) {
    const res = await fetch(base + path, {
      method,
      headers: {
        'Content-Type': 'application/json', 'X-Requested-With': 'fetch',
        Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
    const raw = res.headers.get('set-cookie');
    if (raw) {
      for (const c of raw.split(/,(?=[^;]+=)/)) {
        const [k, ...v] = c.split(';')[0].trim().split('=');
        if (v.join('=') === '') jar.delete(k); else jar.set(k, v.join('='));
      }
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* not json */ }
    return { status: res.status, json, text };
  };
}
const A = client();
const B = client();
const anon = client();

// The routine: bearer key, no cookie.
async function routine(key, method, path, body, headers = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json', 'X-Requested-With': 'fetch',
      ...(key ? { Authorization: `Bearer ${key}` } : {}), ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* not json */ }
  return { status: res.status, json };
}

const sug = (n, over = {}) => ({
  fingerprint: `canvas:assignment:78035:99123${n}`,
  title: `MATH 170A HW ${n}`,
  priority: 'high',
  why: 'Due Tue 29 Sep 23:59, not submitted.',
  source: {
    kind: 'canvas', account: null, label: 'Canvas · MATH 170A',
    url: `https://canvas.ucsd.edu/courses/78035/assignments/99123${n}`, ref: `99123${n}`,
  },
  due: '2026-09-29T23:59:00-07:00',
  duration: 90,
  tag: 'math170a',
  duplicateOf: null,
  addedBy: 'routine',
  resurface: false,
  ...over,
});
const brief = (over = {}) => ({
  date: '2026-09-27', runId: '2026-09-27T07:06', generatedAt: '2026-09-27T07:19:44-07:00',
  summary: 'Two things are due in the next 48 hours.',
  high: [{ title: 'MATH 170A HW 1', why: 'Due Tuesday.', due: '2026-09-29T23:59:00-07:00',
    source: { label: 'Canvas', url: 'https://canvas.ucsd.edu/courses/78035' }, fingerprint: 'canvas:assignment:78035:991231' }],
  medium: [], low: [],
  coverage: [{ source: 'School mail', status: 'ok', detail: '38 threads since last run' },
    { source: 'Gradescope', status: 'skipped', detail: 'Not signed in in Chrome' }],
  mentor: { status: 'corrected', corrections: 2, notes: ['Raised PHYS 2DL prelab to high: due before lab.'] },
  questions: ['Should the second account be scanned?'],
  ...over,
});
const report = (suggestions, over = {}) => ({ runId: '2026-09-27T07:06', date: '2026-09-27', brief: brief(), suggestions, ...over });
const zero = { created: 0, updated: 0, unchanged: 0, resurfaced: 0, keptHandled: 0 };

async function routineMember(call = A) {
  const r = await call('GET', '/api/sync?date=2026-09-27');
  assert.equal(r.status, 200);
  return r.json.routine;
}
async function suggestionOf(fp, call = A) {
  return (await routineMember(call)).suggestions.find((s) => s.fingerprint === fp);
}

before(async () => {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL must be set for tests');
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await q('DELETE FROM users WHERE email = ANY($1::text[])', [[emailA, emailB]]).catch(() => {});
  await closeDb();
  await new Promise((r) => server.close(r));
});

test('two accounts and a to-do', async () => {
  let r = await A('POST', '/api/auth/register', { email: emailA, password: 'correct horse battery', name: 'Alpha', invite: 'testcode' });
  assert.equal(r.status, 200);
  r = await B('POST', '/api/auth/register', { email: emailB, password: 'correct horse battery', name: 'Bravo', invite: 'testcode' });
  assert.equal(r.status, 200);
  r = await A('PUT', '/api/todos/t1', { title: 'Call bank', tag: 'event', duration: 45, order: 1000, scheduled: [{ date: '2026-09-27', blockId: 'b1' }], rev: 'rev0001' });
  assert.equal(r.status, 200);
});

test('settings round trip preserves beta and drops unknown keys in it', async () => {
  let r = await A('PUT', '/api/settings', { colors: ['#112233'], beta: { suggestions: false, other: true }, rev: 'rev0002' });
  assert.equal(r.status, 200);
  r = await A('GET', '/api/settings');
  assert.deepEqual(r.json.settings.beta, { suggestions: false });
  assert.deepEqual(r.json.settings.colors, ['#112233']);
  r = await A('PUT', '/api/settings', { colors: [], beta: { suggestions: 'yes' }, rev: 'rev0003' });
  assert.equal(r.status, 400);
  r = await A('PUT', '/api/settings', { colors: [], beta: 'on', rev: 'rev0003' });
  assert.equal(r.status, 400);
});

test('a save that omits beta or colours keeps the stored value', async () => {
  // an older tab knows only about colours
  let r = await A('PUT', '/api/settings', { colors: ['#445566'], rev: 'rev0004' });
  assert.equal(r.status, 200);
  r = await A('GET', '/api/settings');
  assert.deepEqual(r.json.settings.beta, { suggestions: false });
  assert.deepEqual(r.json.settings.colors, ['#445566']);
  // a flag-only save keeps the colours; an empty beta object changes nothing
  r = await A('PUT', '/api/settings', { beta: {}, rev: 'rev0005' });
  assert.equal(r.status, 200);
  r = await A('GET', '/api/settings');
  assert.deepEqual(r.json.settings.beta, { suggestions: false });
  assert.deepEqual(r.json.settings.colors, ['#445566']);
});

test('sync carries the routine member while the flag is off', async () => {
  assert.deepEqual(await routineMember(), { enabled: false, keys: [] });
});

test('pair rejects a bad hash, a missing session and a missing marker', async () => {
  let r = await A('POST', '/api/routine/pair', { hash: 'abc', name: 'x' });
  assert.equal(r.status, 400);
  r = await A('POST', '/api/routine/pair', { hash: sha(keyA).toUpperCase(), name: 'x' });
  assert.equal(r.status, 400);
  r = await A('POST', '/api/routine/pair', { name: 'x' });
  assert.equal(r.status, 400);
  r = await anon('POST', '/api/routine/pair', { hash: sha(keyA), name: 'x' });
  assert.equal(r.status, 401);
  r = await A('POST', '/api/routine/pair', { hash: sha(keyA), name: 'x' }, { 'X-Requested-With': '' });
  assert.equal(r.status, 403);
  assert.equal((await routineMember()).keys.length, 0);
});

test('pair links a key, turns the flag on, and never echoes the hash', async () => {
  let r = await A('POST', '/api/routine/pair', { hash: sha(keyA), name: '  kenan-desktop ' });
  assert.equal(r.status, 200);
  assert.match(r.json.key.id, /^\d+$/);
  assert.equal(r.json.key.name, 'kenan-desktop');
  assert.ok(r.json.key.createdAt);
  assert.ok(!r.text.includes(sha(keyA)));
  const id = r.json.key.id;

  r = await A('GET', '/api/settings');
  assert.equal(r.json.settings.beta.suggestions, true);
  assert.deepEqual(r.json.settings.colors, ['#445566']);

  r = await A('GET', '/api/sync?date=2026-09-27');
  assert.ok(!r.text.includes(sha(keyA)));
  const m = r.json.routine;
  assert.equal(m.enabled, true);
  assert.equal(m.keys.length, 1);
  assert.deepEqual(Object.keys(m.keys[0]).sort(), ['createdAt', 'id', 'lastUsedAt', 'name']);
  assert.equal(m.keys[0].lastUsedAt, null);
  assert.deepEqual(m.suggestions, []);
  assert.equal(m.brief, null);

  // Pairing the same key again is idempotent.
  r = await A('POST', '/api/routine/pair', { hash: sha(keyA), name: 'kenan-desktop' });
  assert.equal(r.status, 200);
  assert.equal(r.json.key.id, id);
  assert.equal((await routineMember()).keys.length, 1);
});

test('context rejects a missing or unknown key, and ignores cookies', async () => {
  let r = await routine(null, 'GET', '/api/routine/context');
  assert.equal(r.status, 401);
  r = await routine('not-a-real-key', 'GET', '/api/routine/context');
  assert.equal(r.status, 401);
  r = await routine(sha(keyA), 'GET', '/api/routine/context');
  assert.equal(r.status, 401, 'the stored hash is not a credential');
  r = await A('GET', '/api/routine/context');
  assert.equal(r.status, 401, 'a session cookie is not a routine key');
  r = await routine(null, 'POST', '/api/routine/report', report([]));
  assert.equal(r.status, 401);
});

test('context returns to-dos and an empty suggestion list', async () => {
  const r = await routine(keyA, 'GET', '/api/routine/context');
  assert.equal(r.status, 200);
  assert.equal(r.json.enabled, true);
  assert.deepEqual(r.json.user, { name: 'Alpha' });
  assert.ok(r.json.serverTime);
  assert.deepEqual(r.json.todos, [
    { id: 't1', title: 'Call bank', tag: 'event', duration: 45, done: false, scheduled: [{ date: '2026-09-27', blockId: 'b1' }] },
  ]);
  assert.deepEqual(r.json.suggestions, []);
  assert.deepEqual(r.json.feedback, { accepted30d: 0, dismissed30d: 0 });
  assert.equal(r.json.lastBrief, null);
  assert.ok((await routineMember()).keys[0].lastUsedAt, 'last_used_at is updated');
});

test('report creates suggestions and a brief', async () => {
  const r = await routine(keyA, 'POST', '/api/routine/report', report([sug(1), sug(2), sug(3)]));
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ...zero, created: 3 });

  const m = await routineMember();
  assert.equal(m.suggestions.length, 3);
  const s1 = m.suggestions.find((s) => s.fingerprint === sug(1).fingerprint);
  assert.equal(s1.status, 'new');
  assert.equal(s1.title, 'MATH 170A HW 1');
  assert.equal(s1.source.url, sug(1).source.url);
  assert.equal(s1.todoId, null);
  assert.equal(s1.dismissedReason, null);
  assert.equal(s1.resurfacedAt, null);
  assert.ok(s1.firstSeen && s1.updatedAt && s1.rev);
  assert.ok(!('resurface' in s1));
  assert.equal(m.brief.date, '2026-09-27');
  assert.equal(m.brief.mentor.corrections, 2);
  assert.equal(m.brief.coverage[1].status, 'skipped');

  const c = await routine(keyA, 'GET', '/api/routine/context');
  assert.deepEqual(c.json.lastBrief, { date: '2026-09-27', runId: '2026-09-27T07:06' });
  assert.equal(c.json.suggestions.length, 3);
});

test('an identical second report is unchanged', async () => {
  const before = await suggestionOf(sug(1).fingerprint);
  // Key order, a volatile runId and the resurface flag on an open item do not count as changes.
  const reversed = (o) => Object.fromEntries(Object.entries(o).reverse());
  const reordered = { runId: 'later-run', ...reversed(sug(1)), source: reversed(sug(1).source), resurface: true };
  const r = await routine(keyA, 'POST', '/api/routine/report', report([reordered, sug(2), sug(3)], { runId: '2026-09-27T09:00' }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ...zero, unchanged: 3 });
  const afterRow = await suggestionOf(sug(1).fingerprint);
  assert.equal(afterRow.rev, before.rev);
});

test('a changed suggestion is updated and the brief is replaced', async () => {
  const before = await suggestionOf(sug(1).fingerprint);
  const r = await routine(keyA, 'POST', '/api/routine/report',
    report([sug(1, { due: '2026-09-30T23:59:00-07:00' }), sug(2), sug(3)], { brief: brief({ summary: 'Corrected by the mentor.' }) }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ...zero, updated: 1, unchanged: 2 });
  const m = await routineMember();
  const s1 = m.suggestions.find((s) => s.fingerprint === sug(1).fingerprint);
  assert.equal(s1.due, '2026-09-30T23:59:00-07:00');
  assert.notEqual(s1.rev, before.rev);
  assert.equal(s1.firstSeen, before.firstSeen);
  assert.equal(m.brief.summary, 'Corrected by the mentor.');
});

test('a dismissed suggestion stays dismissed when reported again', async () => {
  const fp = sug(2).fingerprint;
  let r = await A('POST', '/api/routine/dismiss', { fingerprint: fp, reason: 'not mine' });
  assert.equal(r.status, 200);
  assert.equal(r.json.suggestion.status, 'dismissed');
  assert.equal(r.json.suggestion.dismissedReason, 'not mine');

  r = await routine(keyA, 'POST', '/api/routine/report', report([sug(2, { title: 'Renamed upstream' })]));
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ...zero, keptHandled: 1 });
  const s2 = await suggestionOf(fp);
  assert.equal(s2.status, 'dismissed');
  assert.equal(s2.title, 'MATH 170A HW 2');
  assert.equal(s2.dismissedReason, 'not mine');

  const c = await routine(keyA, 'GET', '/api/routine/context');
  const h = c.json.suggestions.find((s) => s.fingerprint === fp);
  assert.equal(h.status, 'dismissed');
  assert.equal(h.dismissedReason, 'not mine');
  assert.deepEqual(h.source, { kind: 'canvas', label: 'Canvas · MATH 170A' });
  assert.equal(c.json.feedback.dismissed30d, 1);
});

test('resurface returns a handled suggestion to new with the new content', async () => {
  const fp = sug(2).fingerprint;
  const r = await routine(keyA, 'POST', '/api/routine/report',
    report([sug(2, { title: 'MATH 170A HW 2 (new due date)', due: '2026-10-02T23:59:00-07:00', resurface: true })]));
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ...zero, resurfaced: 1 });
  const s2 = await suggestionOf(fp);
  assert.equal(s2.status, 'new');
  assert.equal(s2.title, 'MATH 170A HW 2 (new due date)');
  assert.ok(s2.resurfacedAt);
  assert.equal(s2.dismissedReason, null);
});

test('accept stores the to-do id', async () => {
  const fp = sug(1).fingerprint;
  let r = await A('POST', '/api/routine/accept', { fingerprint: fp, todoId: 'tabc123' });
  assert.equal(r.status, 200);
  const s1 = await suggestionOf(fp);
  assert.equal(s1.status, 'accepted');
  assert.equal(s1.todoId, 'tabc123');
  const c = await routine(keyA, 'GET', '/api/routine/context');
  assert.equal(c.json.feedback.accepted30d, 1);
  assert.equal(c.json.suggestions.find((s) => s.fingerprint === fp).todoId, 'tabc123');

  r = await A('POST', '/api/routine/accept', { fingerprint: fp, todoId: 'bad id!' });
  assert.equal(r.status, 400);
  r = await A('POST', '/api/routine/accept', { fingerprint: 'canvas:assignment:0:0', todoId: 't1' });
  assert.equal(r.status, 404);
  r = await A('POST', '/api/routine/accept', { fingerprint: 'BAD', todoId: 't1' });
  assert.equal(r.status, 400);
});

test('restore returns a dismissed suggestion to new', async () => {
  const fp = sug(3).fingerprint;
  let r = await A('POST', '/api/routine/dismiss', { fingerprint: fp, reason: 'x'.repeat(200) });
  assert.equal(r.status, 200);
  assert.equal(r.json.suggestion.dismissedReason.length, 120);
  r = await A('POST', '/api/routine/restore', { fingerprint: fp });
  assert.equal(r.status, 200);
  const s3 = await suggestionOf(fp);
  assert.equal(s3.status, 'new');
  assert.equal(s3.dismissedReason, null);
});

test('invalid reports are rejected whole', async () => {
  const bad = async (body) => {
    const r = await routine(keyA, 'POST', '/api/routine/report', body);
    assert.equal(r.status, 400, JSON.stringify(r.json));
    return r.json.error;
  };
  assert.match(await bad(report([sug(4), sug(5, { fingerprint: 'Canvas Assignment 5' })])), /suggestions\[1\].*fingerprint/);
  await bad(report([sug(4, { priority: 'urgent' })]));
  await bad(report([sug(4, { source: { ...sug(4).source, url: 'http://canvas.ucsd.edu/x' } })]));
  await bad(report([sug(4, { source: { ...sug(4).source, kind: 'slack' } })]));
  await bad(report([sug(4, { due: '2026-09-29' })]));
  await bad(report([sug(4, { duration: '90' })]));
  await bad(report([sug(4, { duplicateOf: { todoId: 't1', title: 'x', confidence: 'maybe' } })]));
  await bad(report([sug(4, { source: 'canvas' })]));
  await bad(report([sug(4), sug(4)]));
  await bad(report(Array.from({ length: 61 }, (_, i) => sug(100 + i))));
  await bad(report([sug(4)], { brief: brief({ coverage: [{ source: 'x', status: 'fine', detail: '' }] }) }));
  await bad(report([sug(4)], { brief: brief({ high: [{ title: 'x', source: { label: 'y', url: 'javascript:alert(1)' } }] }) }));
  await bad(report([sug(4)], { brief: brief({ date: '2026-09-28' }) }));
  await bad(report([sug(4)], { date: 'tomorrow' }));
  await bad(report('nope'));
  await bad('nope');
  await bad([sug(4)]);
  assert.equal(await suggestionOf(sug(4).fingerprint), undefined, 'nothing from a rejected report was stored');
});

test('long text is capped, not rejected', async () => {
  const r = await routine(keyA, 'POST', '/api/routine/report', report(
    [sug(6, { why: `${'w'.repeat(239)}😀 and more`, tag: 'Math-170A', duration: 5000 })],
    { brief: brief({ high: Array.from({ length: 45 }, (_, i) => ({ title: `Item ${i}` })) }) }
  ));
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ...zero, created: 1 });
  const m = await routineMember();
  const s6 = m.suggestions.find((s) => s.fingerprint === sug(6).fingerprint);
  assert.equal(s6.why, 'w'.repeat(239), 'never split a surrogate pair');
  assert.equal(s6.tag, 'math-170a');
  assert.equal(s6.duration, 1440);
  assert.equal(m.brief.high.length, 40);
});

test('flag off answers 409 disabled for the routine and hides the member', async () => {
  let r = await A('PUT', '/api/settings', { colors: ['#112233'], beta: { suggestions: false }, rev: 'rev0004' });
  assert.equal(r.status, 200);
  r = await routine(keyA, 'GET', '/api/routine/context');
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'disabled');
  assert.ok(r.json.error);
  r = await routine(keyA, 'POST', '/api/routine/report', report([sug(7)]));
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'disabled');
  const m = await routineMember();
  assert.deepEqual(Object.keys(m).sort(), ['enabled', 'keys']);
  assert.equal(m.enabled, false);
  assert.equal(m.keys.length, 1);
  r = await A('PUT', '/api/settings', { colors: ['#112233'], beta: { suggestions: true }, rev: 'rev0005' });
  assert.equal(r.status, 200);
  assert.equal(await suggestionOf(sug(7).fingerprint), undefined);
});

test("a second user's key cannot see the first user's data", async () => {
  let r = await B('POST', '/api/routine/pair', { hash: sha(keyA), name: 'stolen' });
  assert.equal(r.status, 409, 'a key already linked elsewhere is not reassigned');
  r = await B('POST', '/api/routine/pair', { hash: sha(keyB), name: 'bravo-laptop' });
  assert.equal(r.status, 200);

  r = await routine(keyB, 'GET', '/api/routine/context');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.user, { name: 'Bravo' });
  assert.deepEqual(r.json.todos, []);
  assert.deepEqual(r.json.suggestions, []);
  assert.equal(r.json.lastBrief, null);

  // Same fingerprint, separate namespace.
  r = await routine(keyB, 'POST', '/api/routine/report', report([sug(1)]));
  assert.deepEqual(r.json, { ...zero, created: 1 });
  assert.equal((await suggestionOf(sug(1).fingerprint, B)).status, 'new');
  assert.equal((await suggestionOf(sug(1).fingerprint, A)).status, 'accepted');

  r = await B('POST', '/api/routine/dismiss', { fingerprint: sug(3).fingerprint });
  assert.equal(r.status, 404, "B's session cannot touch A's suggestions");
  const mA = await routineMember(A);
  assert.equal(mA.keys.length, 1);
  assert.equal(mA.keys[0].name, 'kenan-desktop');
});

test('unpair forgets a key and pairing is capped at five', async () => {
  const [k] = (await routineMember()).keys;
  let r = await B('POST', '/api/routine/unpair', { id: k.id });
  assert.equal(r.status, 200);
  assert.equal((await routine(keyA, 'GET', '/api/routine/context')).status, 200, "B cannot unpair A's key");

  r = await A('POST', '/api/routine/unpair', { id: k.id });
  assert.deepEqual(r.json, { ok: true });
  assert.equal((await routine(keyA, 'GET', '/api/routine/context')).status, 401);
  r = await A('POST', '/api/routine/unpair', { id: 'x1' });
  assert.equal(r.status, 400);

  for (let i = 0; i < 5; i++) {
    r = await A('POST', '/api/routine/pair', { hash: sha(`extra-${stamp}-${i}`), name: `pc${i}` });
    assert.equal(r.status, 200);
  }
  r = await A('POST', '/api/routine/pair', { hash: sha(`extra-${stamp}-6`), name: 'one too many' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /5/);
  assert.equal((await routineMember()).keys.length, 5);
});

test('unknown actions, wrong methods and missing markers', async () => {
  let r = await A('GET', '/api/routine/nope');
  assert.equal(r.status, 404);
  assert.ok(r.json.error);
  r = await A('GET', '/api/routine/constructor');
  assert.equal(r.status, 404);
  r = await routine(keyB, 'GET', '/api/routine/report');
  assert.equal(r.status, 405);
  r = await routine(keyB, 'POST', '/api/routine/report', report([]), { 'X-Requested-With': '' });
  assert.equal(r.status, 403);
});
