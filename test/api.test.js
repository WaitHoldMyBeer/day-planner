// End-to-end API tests against a real Postgres (DATABASE_URL). Run with `npm test`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../dev/server.js';
import { closeDb, q } from '../lib/db.js';

process.env.AUTH_SECRET = process.env.AUTH_SECRET || 'test-secret-that-is-long-enough-123456';
process.env.INVITE_CODE = process.env.INVITE_CODE || 'testcode';

let server; let base; const jar = new Map();
const email = `t${Date.now()}@example.com`;

function cookieHeader() { return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; '); }
function storeCookies(res) {
  const raw = res.headers.get('set-cookie');
  if (!raw) return;
  for (const c of raw.split(/,(?=[^;]+=)/)) {
    const [kv] = c.split(';');
    const [k, ...v] = kv.trim().split('=');
    const val = v.join('=');
    if (val === '') jar.delete(k); else jar.set(k, val);
  }
}
async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', Cookie: cookieHeader() },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  storeCookies(res);
  let json = null;
  try { json = await res.json(); } catch (e) { /* not json */ }
  return { status: res.status, json, headers: res.headers };
}

before(async () => {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL must be set for tests');
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await q('DELETE FROM users WHERE email = $1', [email]).catch(() => {});
  await closeDb();
  await new Promise((r) => server.close(r));
});

test('unauthenticated requests are rejected', async () => {
  const r = await call('GET', '/api/sync?date=2026-09-24');
  assert.equal(r.status, 401);
});

test('state changes need the request marker', async () => {
  const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 403);
});

test('register requires the invite code and a sane password', async () => {
  let r = await call('POST', '/api/auth/register', { email, password: 'correct horse battery', name: 'Test', invite: 'wrong' });
  assert.equal(r.status, 400);
  assert.equal(r.json.field, 'invite');
  r = await call('POST', '/api/auth/register', { email, password: 'short', name: 'Test', invite: 'testcode' });
  assert.equal(r.status, 400);
  r = await call('POST', '/api/auth/register', { email, password: 'correct horse battery', name: 'Test', invite: 'testcode' });
  assert.equal(r.status, 200);
  assert.equal(r.json.user.email, email);
  assert.ok(jar.has('dp_session'));
});

test('duplicate registration is refused', async () => {
  const r = await call('POST', '/api/auth/register', { email, password: 'correct horse battery', invite: 'testcode' });
  assert.equal(r.status, 400);
});

test('me returns the signed-in user', async () => {
  const r = await call('GET', '/api/auth/me');
  assert.equal(r.status, 200);
  assert.equal(r.json.user.name, 'Test');
});

test('day round trip and sync', async () => {
  let r = await call('GET', '/api/sync?date=2026-09-24');
  assert.equal(r.status, 200);
  assert.equal(r.json.day, null);
  assert.deepEqual(r.json.todos, []);
  assert.equal(r.json.google.connected, false);

  const blocks = [{ id: 'b1', name: 'Gym', start: 600, duration: 45, color: '#039BE5', locked: false, tag: 'event' }];
  r = await call('PUT', '/api/days/2026-09-24', { blocks, rev: 'abc123def' });
  assert.equal(r.status, 200);

  r = await call('GET', '/api/days/2026-09-24');
  assert.equal(r.json.day.rev, 'abc123def');
  assert.equal(r.json.day.blocks[0].name, 'Gym');
  assert.equal(r.json.day.blocks[0].tag, 'event');

  r = await call('GET', '/api/sync?date=2026-09-24');
  assert.equal(r.json.day.blocks.length, 1);

  r = await call('PUT', '/api/days/2026-09-24', { blocks: 'nope', rev: 'abc123def' });
  assert.equal(r.status, 400);
  r = await call('PUT', '/api/days/2026-13-99', { blocks: [], rev: 'abc123def' });
  assert.equal(r.status, 400);
});

test('other days stay untouched', async () => {
  const r = await call('GET', '/api/days/2026-09-25');
  assert.equal(r.json.day, null);
});

test('todos upsert, list, delete', async () => {
  let r = await call('PUT', '/api/todos/t1', { title: 'Call bank', duration: 30, order: 1000, done: false, scheduled: [], rev: 'rev0001' });
  assert.equal(r.status, 200);
  r = await call('PUT', '/api/todos/t2', { title: 'Write update', tag: 'work', duration: null, order: 2000, rev: 'rev0002' });
  assert.equal(r.status, 200);
  r = await call('GET', '/api/todos');
  assert.equal(r.json.todos.length, 2);
  const t2 = r.json.todos.find((t) => t.id === 't2');
  assert.equal(t2.tag, 'work');
  assert.equal(t2.duration, null);
  r = await call('PUT', '/api/todos/t1', { title: 'Call bank', duration: 45, order: 500, done: true, scheduled: [{ date: '2026-09-24', blockId: 'b1' }], rev: 'rev0003' });
  assert.equal(r.status, 200);
  r = await call('DELETE', '/api/todos/t2');
  assert.equal(r.status, 200);
  r = await call('GET', '/api/todos');
  assert.equal(r.json.todos.length, 1);
  assert.equal(r.json.todos[0].done, true);
  assert.equal(r.json.todos[0].scheduled[0].blockId, 'b1');
  r = await call('PUT', '/api/todos/bad%20id!', { title: 'x', rev: 'rev0004' });
  assert.equal(r.status, 400);
});

test('repeating tasks, their copies and unstacked tasks keep their fields', async () => {
  const repeat = { days: [1, 3, 5], start: 660, from: '2026-09-30', until: null, skip: ['2026-10-02'], version: 1 };
  let r = await call('PUT', '/api/todos/s1', { title: 'Gym', duration: 45, order: 3000, repeat, rev: 'rev0101' });
  assert.equal(r.status, 200);
  r = await call('PUT', '/api/todos/s1-2026-10-05', { title: 'Gym', order: 3000, seriesId: 's1', forDate: '2026-10-05', rev: 'rev0102' });
  assert.equal(r.status, 200);
  r = await call('PUT', '/api/todos/u1', { title: 'Gym', order: 4000, unstacked: true, junk: 'dropped', rev: 'rev0103' });
  assert.equal(r.status, 200);
  r = await call('GET', '/api/todos');
  const byId = new Map(r.json.todos.map((t) => [t.id, t]));
  assert.deepEqual(byId.get('s1').repeat, repeat);
  assert.equal(byId.get('s1-2026-10-05').seriesId, 's1');
  assert.equal(byId.get('s1-2026-10-05').forDate, '2026-10-05');
  assert.equal(byId.get('u1').unstacked, true);
  assert.equal(byId.get('u1').junk, undefined);
  for (const id of ['s1', 's1-2026-10-05', 'u1']) await call('DELETE', '/api/todos/' + id);
});

test('bad repeat rules are refused', async () => {
  const ok = { days: [1, 3], start: null, from: '2026-09-30', until: '2026-12-31', skip: [], version: 2 };
  let r = await call('PUT', '/api/todos/s2', { title: 'Read', repeat: ok, rev: 'rev0201' });
  assert.equal(r.status, 200);
  const bads = [
    { days: [7] },
    { days: [1, 1] },
    { days: [] },
    { start: 1440 },
    { from: 'tomorrow' },
    { skip: ['2026-10-01', 'not a date'] },
  ];
  for (const patch of bads) {
    r = await call('PUT', '/api/todos/s2', { title: 'Read', repeat: { ...ok, ...patch }, rev: 'rev0202' });
    assert.equal(r.status, 400, JSON.stringify(patch));
  }
  r = await call('PUT', '/api/todos/s2', { title: 'Read', seriesId: 'bad id!', rev: 'rev0203' });
  assert.equal(r.status, 400);
  r = await call('PUT', '/api/todos/s2', { title: 'Read', seriesId: 's1', forDate: '2026-02-30', rev: 'rev0204' });
  assert.equal(r.status, 400);
  r = await call('GET', '/api/todos');
  assert.deepEqual(r.json.todos.find((t) => t.id === 's2').repeat, ok);
  await call('DELETE', '/api/todos/s2');
});

test('blocks keep seriesDate and seriesVersion', async () => {
  const blocks = [{ id: 'b9', name: 'Gym', start: 660, duration: 45, color: '#039BE5', locked: false, todoId: 's1', seriesDate: '2026-10-05', seriesVersion: 3 }];
  let r = await call('PUT', '/api/days/2026-10-05', { blocks, rev: 'rev0301' });
  assert.equal(r.status, 200);
  r = await call('GET', '/api/days/2026-10-05');
  assert.equal(r.json.day.blocks[0].seriesDate, '2026-10-05');
  assert.equal(r.json.day.blocks[0].seriesVersion, 3);
  r = await call('PUT', '/api/days/2026-10-05', { blocks: [{ ...blocks[0], seriesDate: '10/05/2026' }], rev: 'rev0302' });
  assert.equal(r.status, 400);
  r = await call('PUT', '/api/days/2026-10-05', { blocks: [{ ...blocks[0], seriesVersion: 1.5 }], rev: 'rev0303' });
  assert.equal(r.status, 400);
});

test('settings round trip', async () => {
  let r = await call('PUT', '/api/settings', { colors: ['#112233', 'nothex', '#ABCDEF'], rev: 'rev0005' });
  assert.equal(r.status, 200);
  r = await call('GET', '/api/settings');
  assert.deepEqual(r.json.settings.colors, ['#112233', '#ABCDEF']);
});

test('google endpoints report not configured / not connected', async () => {
  let r = await call('GET', '/api/google/status');
  assert.equal(r.status, 200);
  assert.equal(r.json.connected, false);
  r = await call('POST', '/api/google/toggle', { enabled: true });
  assert.equal(r.status, 409);
  r = await call('GET', '/api/google/events?timeMin=2026-09-24T00:00:00Z&timeMax=2026-09-25T00:00:00Z');
  assert.ok(r.status === 503 || r.status === 409, `got ${r.status}`);
  r = await call('GET', '/api/google/connect');
  assert.ok(r.status === 503 || r.status === 302);
});

test('data is private per user', async () => {
  const saved = new Map(jar);
  jar.clear();
  const other = `o${Date.now()}@example.com`;
  let r = await call('POST', '/api/auth/register', { email: other, password: 'another good password', invite: 'testcode' });
  assert.equal(r.status, 200);
  r = await call('GET', '/api/sync?date=2026-09-24');
  assert.equal(r.json.day, null);
  assert.deepEqual(r.json.todos, []);
  await q('DELETE FROM users WHERE email = $1', [other]);
  jar.clear();
  for (const [k, v] of saved) jar.set(k, v);
});

test('wrong password and logout', async () => {
  let r = await call('POST', '/api/auth/login', { email, password: 'wrong password!!' });
  assert.equal(r.status, 400);
  r = await call('POST', '/api/auth/logout');
  assert.equal(r.status, 200);
  r = await call('GET', '/api/auth/me');
  assert.equal(r.status, 401);
  r = await call('POST', '/api/auth/login', { email, password: 'correct horse battery' });
  assert.equal(r.status, 200);
  r = await call('GET', '/api/auth/me');
  assert.equal(r.status, 200);
});

test('static index is served', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(text.includes('<title>'));
});
