// Small helpers shared by every API function. Handlers use Vercel's Node signature
// (request, response); the dev server in dev/server.js emulates the same surface.

export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export const bad = (msg, extra) => new HttpError(400, msg, extra);
export const unauthorized = (msg = 'Sign in to continue.') => new HttpError(401, msg);
export const notFound = (msg = 'Not found.') => new HttpError(404, msg);

/**
 * Build a handler that dispatches on HTTP method and turns thrown errors into JSON.
 *   export default route({ GET: async (req, res) => {...}, POST: ... })
 * Every state-changing request must carry `X-Requested-With: fetch`; together with
 * SameSite=Lax cookies that keeps cross-site forms from driving the API.
 */
export function route(handlers) {
  return async function handler(req, res) {
    const method = (req.method || 'GET').toUpperCase();
    try {
      const fn = handlers[method];
      if (!fn) {
        res.setHeader('Allow', Object.keys(handlers).join(', '));
        throw new HttpError(405, 'Method not allowed.');
      }
      if (method !== 'GET' && method !== 'HEAD' && !handlers.allowCrossSite) {
        const marker = req.headers['x-requested-with'];
        if (marker !== 'fetch') throw new HttpError(403, 'Missing request marker.');
      }
      await fn(req, res);
    } catch (e) {
      if (e instanceof HttpError) {
        res.status(e.status).json({ error: e.message, ...(e.extra || {}) });
      } else {
        console.error('[api]', method, req.url, e);
        const msg = e && e.code === 'NO_DATABASE' ? e.message : 'Something went wrong on the server.';
        res.status(500).json({ error: msg });
      }
    }
  };
}

export function body(req) {
  const b = req.body;
  if (b == null || b === '') return {};
  if (typeof b === 'string') {
    try { return JSON.parse(b); } catch (e) { throw bad('Body must be JSON.'); }
  }
  if (typeof b === 'object') return b;
  throw bad('Body must be JSON.');
}

export const isDate = (s) => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};
export const isId = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(s);

export function origin(req) {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || (process.env.VERCEL ? 'https' : 'http');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

export function isSecure(req) {
  return !!process.env.VERCEL || req.headers['x-forwarded-proto'] === 'https';
}
