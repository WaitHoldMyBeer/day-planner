// Postgres access. One pool per warm function instance; the schema is created on first use.
import pg from 'pg';

const { Pool } = pg;
let pool = null;
let schemaReady = null;

function connectionString() {
  return process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRES_PRISMA_URL || '';
}

function getPool() {
  if (pool) return pool;
  const cs = connectionString();
  if (!cs) {
    const e = new Error('No database configured. Set DATABASE_URL (Vercel: Storage tab, create a Neon Postgres database).');
    e.code = 'NO_DATABASE';
    throw e;
  }
  let host = '';
  try { host = new URL(cs).hostname; } catch (e) { /* leave empty */ }
  const local = host === 'localhost' || host === '127.0.0.1' || host === 'postgres' || host === '';
  pool = new Pool({
    connectionString: cs,
    max: 3,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 8000,
    allowExitOnIdle: true,
    ssl: local || process.env.PGSSL_DISABLE ? false : { rejectUnauthorized: true },
  });
  pool.on('error', (err) => console.error('[db] idle client error', err));
  return pool;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  pass_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
CREATE TABLE IF NOT EXISTS days (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  data JSONB NOT NULL,
  rev TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, date)
);
CREATE TABLE IF NOT EXISTS todos (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  data JSONB NOT NULL,
  rev TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, id)
);
CREATE TABLE IF NOT EXISTS settings (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data JSONB NOT NULL,
  rev TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS google_accounts (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email TEXT,
  refresh_token TEXT NOT NULL,
  access_token TEXT,
  expires_at TIMESTAMPTZ,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

export async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = getPool().query(SCHEMA).then(() => true).catch((e) => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

/** Run one query after making sure the schema exists. */
export async function q(text, params = []) {
  await ensureSchema();
  return getPool().query(text, params);
}

export async function one(text, params = []) {
  const r = await q(text, params);
  return r.rows[0] || null;
}

export async function closeDb() {
  if (pool) { const p = pool; pool = null; schemaReady = null; await p.end(); }
}
