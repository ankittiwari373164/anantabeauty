// Vercel serverless function: every /api/* request is rewritten here (see vercel.json).
'use strict';
const store = require('./_lib/store');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try {
    const u = new URL(req.url, 'http://x');
    // the rewrite passes the original sub-path as ?__path=...
    const sub = u.searchParams.get('__path');
    u.searchParams.delete('__path');
    const path = sub != null ? '/api/' + sub.replace(/^\/+/, '') : u.pathname;
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body || '{}'); } catch (e) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'Bad JSON.' })); } }
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const qs = u.searchParams.toString();
    const out = await store.handle(req.method, path + (qs ? '?' + qs : ''), body || {}, token);
    res.statusCode = out.status;
    res.end(JSON.stringify(out.body));
  } catch (e) {
    console.error(e);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: e.expose ? e.message : 'Something went wrong on our side. Please try again.' }));
  }
};
