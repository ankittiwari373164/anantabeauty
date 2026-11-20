// Keeps the free Supabase project awake. Vercel Cron calls this once a day (see vercel.json);
// it writes one row, which counts as database activity. Free Supabase projects pause after
// 7 days with no activity, so a daily ping keeps a wide margin.
// It also closes online orders left unpaid for 2+ hours (stock goes back on the shelf).
'use strict';
const store = require('./_lib/store');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.authorization || '';
  if (secret && auth !== 'Bearer ' + secret) { res.statusCode = 401; return res.end(JSON.stringify({ error: 'Unauthorized' })); }
  try {
    const at = await store.heartbeat(req.headers['user-agent'] && /vercel-cron/i.test(req.headers['user-agent']) ? 'vercel-cron' : 'manual');
    let sweep = null;
    if (store.rzpEnabled()) { try { sweep = await store.sweepUnpaid(); } catch (e) { console.error('sweep', e); sweep = { error: e.message }; } }
    res.statusCode = 200; res.end(JSON.stringify({ ok: true, pingedAt: at, unpaidOrders: sweep }));
  } catch (e) {
    console.error(e);
    res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: e.message }));
  }
};
