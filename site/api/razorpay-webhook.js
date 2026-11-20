// Razorpay webhook: Razorpay Dashboard > Settings > Webhooks > Add
//   URL: https://YOUR-SITE/api/razorpay-webhook   Events: payment.captured, payment.authorized, order.paid
// This makes sure an order is marked paid even if the customer closes the tab right after paying.
'use strict';
const store = require('./_lib/store');

function readRaw(req) {
  return new Promise((resolve) => {
    const chunks = []; let done = false;
    const fin = () => { if (!done) { done = true; resolve(Buffer.concat(chunks).toString('utf8')); } };
    req.on('data', (c) => chunks.push(c)); req.on('end', fin); req.on('error', fin);
    setTimeout(fin, 3000);
  });
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method !== 'POST') { res.statusCode = 405; return res.end('{"error":"POST only"}'); }
  try {
    let ev = req.body;
    if (ev === undefined) ev = await readRaw(req);
    if (Buffer.isBuffer(ev)) ev = ev.toString('utf8');
    if (typeof ev === 'string') ev = JSON.parse(ev || '{}');
    const out = await store.razorpayWebhook(ev);
    res.statusCode = out.status; res.end(JSON.stringify(out.body));
  } catch (e) {
    console.error(e);
    res.statusCode = 500; res.end(JSON.stringify({ error: 'Webhook failed' })); // Razorpay retries on non-2xx
  }
};
