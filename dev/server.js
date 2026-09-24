// Local development server. Serves public/ and routes /api/* to the functions in api/,
// giving handlers the same (req, res) helpers Vercel's Node runtime provides:
// req.query, req.cookies, req.body, res.status(), res.json(), res.send(), res.redirect().
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_DIR = path.join(ROOT, 'api');
const PUBLIC_DIR = path.join(ROOT, 'public');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8',
};

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.name.endsWith('.js') && !entry.name.startsWith('_')) out.push(p);
  }
  return out;
}

function buildRoutes() {
  return walk(API_DIR).map((file) => {
    let rel = path.relative(API_DIR, file).replace(/\\/g, '/').replace(/\.js$/, '');
    if (rel.endsWith('/index')) rel = rel.slice(0, -6);
    if (rel === 'index') rel = '';
    const segs = rel ? rel.split('/') : [];
    const params = [];
    const re = new RegExp('^/api' + segs.map((s) => {
      const m = s.match(/^\[(.+)\]$/);
      if (m) { params.push(m[1]); return '/([^/]+)'; }
      return '/' + s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('') + '/?$');
    const staticSegs = segs.filter((s) => !s.startsWith('[')).length;
    return { file, re, params, weight: staticSegs * 10 + segs.length };
  }).sort((a, b) => b.weight - a.weight);
}

const modules = new Map();
async function load(file) {
  if (!modules.has(file)) modules.set(file, import(pathToFileURL(file).href).then((m) => m.default));
  return modules.get(file);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function decorate(req, res, query) {
  req.query = query;
  req.cookies = parseCookies(req.headers.cookie);
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => { if (!res.getHeader('content-type')) res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(obj)); return res; };
  res.send = (data) => { if (typeof data === 'object' && !Buffer.isBuffer(data)) return res.json(data); res.end(data); return res; };
  res.redirect = (a, b) => { const [code, url] = typeof a === 'number' ? [a, b] : [307, a]; res.statusCode = code; res.setHeader('Location', url); res.end(); return res; };
}

export function createServer() {
  const routes = buildRoutes();
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/') || url.pathname === '/api') {
        const route = routes.find((r) => r.re.test(url.pathname));
        if (!route) { res.statusCode = 404; res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ error: 'No such API route.' })); }
        const m = url.pathname.match(route.re);
        const query = Object.fromEntries(url.searchParams.entries());
        route.params.forEach((p, i) => { query[p] = decodeURIComponent(m[i + 1]); });
        const raw = await readBody(req);
        decorate(req, res, query);
        const ct = String(req.headers['content-type'] || '');
        if (ct.includes('application/json') && raw) { try { req.body = JSON.parse(raw); } catch (e) { req.body = raw; } }
        else req.body = raw;
        const handler = await load(route.file);
        await handler(req, res);
        if (!res.writableEnded) res.end();
        return;
      }
      // static
      let p = decodeURIComponent(url.pathname);
      if (p === '/' || p === '') p = '/index.html';
      const file = path.normalize(path.join(PUBLIC_DIR, p));
      if (!file.startsWith(PUBLIC_DIR)) { res.statusCode = 403; return res.end(); }
      let stat = null;
      try { stat = fs.statSync(file); } catch (e) { /* missing */ }
      if (!stat || !stat.isFile()) { res.statusCode = 404; res.setHeader('Content-Type', 'text/plain'); return res.end('Not found'); }
      res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
      res.setHeader('Cache-Control', 'no-cache');
      fs.createReadStream(file).pipe(res);
    } catch (e) {
      console.error('[dev]', e);
      if (!res.headersSent) { res.statusCode = 500; res.setHeader('Content-Type', 'application/json'); }
      if (!res.writableEnded) res.end(JSON.stringify({ error: 'dev server error' }));
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  createServer().listen(port, () => console.log(`Day Planner dev server: http://localhost:${port}`));
}
