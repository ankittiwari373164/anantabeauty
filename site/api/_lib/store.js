// Ananta Beauty store API, backed by Supabase (Postgres).
// Every route the storefront and admin use lives here. Prices, coupons, tax and shipping are
// always worked out on the server from database values; the browser never sets a price.
'use strict';
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const STATUSES = ['placed', 'packed', 'shipped', 'delivered', 'cancelled'];
const CATEGORIES = { serums: 'Hair serums', sprays: 'Rosemary sprays', shampoos: 'Onion shampoos', combos: 'Combos and value packs' };
const LOW_STOCK = 5;
const BUCKET = 'product-images';

let _db = null;
function db() {
  if (_db) return _db;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw Object.assign(new Error('Store database is not configured (SUPABASE_URL and SUPABASE_SECRET_KEY).'), { expose: true });
  _db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return _db;
}

// ---------- helpers
const money = (n) => Math.round(Number(n) * 100) / 100;
const num = (n) => (n === null || n === undefined ? null : Number(n));
const rupees = (n) => '₹' + money(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const randHex = (n) => crypto.randomBytes(n).toString('hex');
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || ''));
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

// ---------- Razorpay (online payments). Turned on by RAZORPAY_KEY_ID + RAZORPAY_KEY_SECRET in Vercel.
const rzpId = () => process.env.RAZORPAY_KEY_ID || '';
const rzpSecret = () => process.env.RAZORPAY_KEY_SECRET || '';
const rzpEnabled = () => !!(rzpId() && rzpSecret());
async function rzp(method, path, body) {
  const base = process.env.RAZORPAY_API_BASE || 'https://api.razorpay.com/v1';
  const r = await fetch(base + path, { method, headers: { Authorization: 'Basic ' + Buffer.from(rzpId() + ':' + rzpSecret()).toString('base64'), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error('Razorpay: ' + ((j.error && j.error.description) || ('HTTP ' + r.status))); e.rzp = true; throw e; }
  return j;
}
function safeEqual(a, b) { a = Buffer.from(String(a)); b = Buffer.from(String(b)); return a.length === b.length && crypto.timingSafeEqual(a, b); }

function must({ data, error }) {
  if (error) { const e = new Error(error.message); e.db = error; throw e; }
  return data;
}

function productOut(r) {
  return { id: r.id, slug: r.slug, name: r.name, category: r.category, price: num(r.price), compareAt: num(r.compare_at),
    shortDesc: r.short_desc, description: r.description, images: r.images || [], stock: r.stock, active: r.active,
    featured: r.featured, sourceUrl: r.source_url };
}
function publicProduct(r) { const p = productOut(r); p.inStock = r.stock > 0; delete p.stock; return p; }
function couponOut(r) {
  return { code: r.code, type: r.type, value: num(r.value), minOrder: num(r.min_order), expiresAt: r.expires_at,
    usageLimit: r.usage_limit, used: r.used, active: r.active, note: r.note };
}
function orderOut(r) {
  return { id: r.id, createdAt: r.created_at, status: r.status, statusHistory: r.status_history, customerId: r.customer_id,
    customerName: r.customer_name, email: r.email, phone: r.phone, address: r.address, items: r.items,
    subtotal: num(r.subtotal), discount: num(r.discount), shipping: num(r.shipping), tax: num(r.tax), total: num(r.total),
    coupon: r.coupon, paymentMethod: r.payment_method, paymentStatus: r.payment_status, notes: r.notes,
    paidAt: r.paid_at || null, paymentId: r.razorpay_payment_id || null };
}
function userOut(u) {
  return { id: u.id, role: u.role, name: u.name, email: u.email, phone: u.phone || '', createdAt: u.created_at,
    addresses: u.addresses || [], wishlist: u.wishlist || [] };
}

async function getSettings() {
  const r = must(await db().from('settings').select('*').eq('id', 1).maybeSingle()) || {};
  const store = Object.assign({ name: 'Ananta Beauty', tagline: '', email: '', phone: '', address: '', gstin: '', hours: '' }, r.store || {});
  const sh = r.shipping || {};
  const shipping = { flat: money(Number(sh.flat) >= 0 ? sh.flat : 0), freeOver: money(Number(sh.freeOver) >= 0 ? sh.freeOver : 0), note: String(sh.note || '') };
  const tx = r.tax || {};
  const tax = { rate: Number(tx.rate) || 0, label: String(tx.label || 'GST'), note: String(tx.note || '') };
  return { store, shipping, tax };
}

async function quote(items, couponCode) {
  const settings = await getSettings();
  const ids = [...new Set((items || []).map((i) => String(i.productId || '')).filter(Boolean))].slice(0, 50);
  const rows = ids.length ? must(await db().from('products').select('*').in('id', ids).eq('active', true)) : [];
  const lines = []; const errors = []; let subtotal = 0;
  (items || []).slice(0, 50).forEach((it) => {
    const p = rows.find((x) => x.id === it.productId);
    const qty = Math.max(1, Math.min(20, parseInt(it.qty, 10) || 1));
    if (!p) { errors.push('An item in your cart is no longer available.'); return; }
    const price = num(p.price); const lineTotal = money(price * qty);
    subtotal += lineTotal;
    lines.push({ productId: p.id, slug: p.slug, name: p.name, image: (p.images || [])[0] || '', unitPrice: price, qty, lineTotal, inStock: p.stock >= qty });
  });
  subtotal = money(subtotal);
  let discount = 0, coupon = null, couponMessage = '';
  if (couponCode) {
    const code = String(couponCode).trim().toUpperCase();
    const c = must(await db().from('coupons').select('*').eq('code', code).maybeSingle());
    const today = new Date().toISOString().slice(0, 10);
    if (!c || !c.active) couponMessage = 'That code is not valid.';
    else if (c.expires_at && c.expires_at < today) couponMessage = 'That code has expired.';
    else if (c.usage_limit && c.used >= c.usage_limit) couponMessage = 'That code has been used up.';
    else if (subtotal < num(c.min_order)) couponMessage = 'Add ' + rupees(num(c.min_order) - subtotal) + ' more to use ' + c.code + '.';
    else {
      const v = num(c.value);
      coupon = { code: c.code, type: c.type, value: v };
      discount = c.type === 'percent' ? money(subtotal * v / 100) : money(Math.min(v, subtotal));
      couponMessage = c.code + ' applied: -' + rupees(discount);
    }
  }
  const sc = settings.shipping;
  const shipping = lines.length === 0 ? 0 : (subtotal - discount >= sc.freeOver && sc.freeOver > 0 ? 0 : sc.flat);
  const taxable = Math.max(0, money(subtotal - discount));
  const tax = money(taxable * settings.tax.rate / 100);
  const total = money(taxable + shipping + tax);
  return { lines, subtotal, discount, shipping, tax, taxLabel: settings.tax.label, total, coupon, couponMessage, errors,
    freeShippingOver: sc.freeOver, shippingFlat: sc.flat };
}

function validAddress(a) {
  const need = ['name', 'phone', 'line1', 'city', 'state', 'pincode'];
  for (const k of need) if (!a || !String(a[k] || '').trim()) return 'Please fill in ' + k + ' for delivery.';
  if (!/^\d{6}$/.test(String(a.pincode).trim())) return 'Pincode should be 6 digits.';
  if (!/^[+\d][\d\s-]{7,15}$/.test(String(a.phone).trim())) return 'Phone number does not look right.';
  return null;
}
function cleanAddress(a) {
  return { name: str(a.name, 80), phone: str(a.phone, 20), line1: str(a.line1, 200), line2: str(a.line2, 200),
    city: str(a.city, 80), state: str(a.state, 80), pincode: str(a.pincode, 6) };
}

async function userFromToken(token) {
  if (!token || token.length < 20) return null;
  const s = must(await db().from('sessions').select('user_id, expires_at').eq('token_hash', sha256(token)).maybeSingle());
  if (!s || new Date(s.expires_at) < new Date()) return null;
  return must(await db().from('users').select('*').eq('id', s.user_id).maybeSingle());
}
async function newSession(userId) {
  const token = randHex(32);
  must(await db().from('sessions').insert({ token_hash: sha256(token), user_id: userId }));
  // tidy expired sessions now and then
  if (Math.random() < 0.05) await db().from('sessions').delete().lt('expires_at', new Date().toISOString());
  return token;
}

function productFromBody(b, existing) {
  const name = str(b.name, 200);
  if (!name) return { error: 'Product name is required.' };
  const price = Number(b.price);
  if (!(price >= 0)) return { error: 'Price must be a number.' };
  const stock = parseInt(b.stock, 10); if (isNaN(stock) || stock < 0) return { error: 'Stock must be 0 or more.' };
  if (!CATEGORIES[b.category]) return { error: 'Pick a category.' };
  const slug = String(b.slug || name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 120);
  if (!slug) return { error: 'Product link name (slug) is empty.' };
  const images = Array.isArray(b.images) ? b.images.filter((x) => typeof x === 'string' && x).slice(0, 6) : (existing ? existing.images : []);
  return { row: { slug, name, category: b.category, price: money(price), compare_at: b.compareAt ? money(Number(b.compareAt)) : null,
    short_desc: str(b.shortDesc, 240), description: String(b.description || '').slice(0, 4000), images, stock,
    active: b.active !== false, featured: !!b.featured } };
}
function couponFromBody(b, existing) {
  const code = String(b.code || (existing && existing.code) || '').trim().toUpperCase();
  if (!/^[A-Z0-9_-]{3,20}$/.test(code)) return { error: 'Code: 3 to 20 letters or numbers.' };
  const type = b.type === 'flat' ? 'flat' : 'percent';
  const value = Number(b.value);
  if (!(value > 0) || (type === 'percent' && value > 100)) return { error: 'Value must be above 0 (and up to 100 for percent).' };
  return { row: { code, type, value: money(value), min_order: money(Number(b.minOrder) || 0), expires_at: b.expiresAt || null,
    usage_limit: parseInt(b.usageLimit, 10) || 0, active: b.active !== false, note: str(b.note, 120) } };
}

async function policyList(withBody) {
  const rows = must(await db().from('policies').select('*').order('slug'));
  const order = ['privacy', 'terms', 'returns', 'shipping', 'refund'];
  rows.sort((a, b) => order.indexOf(a.slug) - order.indexOf(b.slug));
  return rows.map((p) => Object.assign({ slug: p.slug, title: p.title, updatedAt: p.updated_at, status: p.status }, withBody ? { body: p.body } : {}));
}

async function summary() {
  const orders = must(await db().from('orders').select('*').order('created_at', { ascending: false }).limit(5000));
  const live = orders.filter((o) => o.status !== 'cancelled' && o.payment_status !== 'awaiting_payment');
  const revenue = money(live.reduce((s, o) => s + num(o.total), 0));
  const byStatus = {}; STATUSES.forEach((s) => { byStatus[s] = 0; });
  orders.forEach((o) => { byStatus[o.status] = (byStatus[o.status] || 0) + 1; });
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    days.push({ day: key, revenue: money(live.filter((o) => String(o.created_at).slice(0, 10) === key).reduce((s, o) => s + num(o.total), 0)) });
  }
  const products = must(await db().from('products').select('id,name,stock'));
  const { count: customerCount } = await db().from('users').select('id', { count: 'exact', head: true }).eq('role', 'customer');
  const { count: couponCount } = await db().from('coupons').select('code', { count: 'exact', head: true });
  return { revenue, orderCount: orders.length, liveOrderCount: live.length, byStatus, productCount: products.length,
    customerCount: customerCount || 0, lowStock: products.filter((p) => p.stock <= LOW_STOCK).map((p) => ({ id: p.id, name: p.name, stock: p.stock })),
    recentOrders: orders.slice(0, 6).map(orderOut), revenueByDay: days, averageOrder: live.length ? money(revenue / live.length) : 0,
    couponCount: couponCount || 0 };
}

async function uploadImage(dataUrl, name) {
  const m = String(dataUrl).match(/^data:image\/(png|jpeg|webp|gif);base64,(.+)$/);
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const base = String(name || 'photo').toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9]+/g, '-').slice(0, 40) || 'photo';
  const path = 'products/' + Date.now() + '-' + randHex(4) + '-' + base + '.' + ext;
  must(await db().storage.from(BUCKET).upload(path, Buffer.from(m[2], 'base64'), { contentType: 'image/' + m[1], upsert: false }));
  return db().storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}

// ---------- online payment helpers
async function getOrderRow(id) { return must(await db().from('orders').select('*').eq('id', String(id || '')).maybeSingle()); }
async function startRazorpay(o) {
  const s = await getSettings();
  const ro = await rzp('POST', '/orders', { amount: Math.round(num(o.total) * 100), currency: 'INR', receipt: o.id, notes: { order_id: o.id } });
  must(await db().from('orders').update({ razorpay_order_id: ro.id }).eq('id', o.id));
  return { keyId: rzpId(), orderId: ro.id, amount: ro.amount, currency: ro.currency || 'INR', name: s.store.name || 'Ananta Beauty',
    description: 'Order ' + o.id, prefill: { name: o.customer_name, email: o.email, contact: o.phone } };
}
// make sure a Razorpay payment is captured (accounts without auto-capture leave it "authorized")
async function ensureCaptured(pay) {
  if (pay.status === 'authorized') pay = await rzp('POST', '/payments/' + pay.id + '/capture', { amount: pay.amount, currency: pay.currency || 'INR' });
  return pay.status === 'captured';
}
// ask Razorpay whether this order was paid; if so, record it. Returns true when paid.
async function settleFromRazorpay(o) {
  if (!o.razorpay_order_id || !rzpEnabled()) return false;
  const list = await rzp('GET', '/orders/' + o.razorpay_order_id + '/payments');
  for (const pay of (list.items || [])) {
    if ((pay.status === 'captured' || pay.status === 'authorized') && await ensureCaptured(pay)) {
      must(await db().rpc('app_mark_paid', { p_rzp_order: o.razorpay_order_id, p_payment: pay.id }));
      return true;
    }
  }
  return false;
}
// cancel online orders left unpaid for 2+ hours (run by the daily cron)
async function sweepUnpaid() {
  const cutoff = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  const rows = must(await db().from('orders').select('*').eq('payment_status', 'awaiting_payment').neq('status', 'cancelled').lt('created_at', cutoff).limit(200));
  let paid = 0, cancelled = 0;
  for (const o of rows) {
    try { if (await settleFromRazorpay(o)) { paid++; continue; } } catch (e) { console.error('sweep check', o.id, e.message); continue; }
    if (must(await db().rpc('app_cancel_unpaid', { p_id: o.id }))) cancelled++;
  }
  return { checked: rows.length, paid, cancelled };
}
// webhook from Razorpay. The event body is not trusted: we only take the Razorpay order id from it
// and then ask Razorpay's API directly (with our secret key) whether that order was paid.
async function razorpayWebhook(ev) {
  if (!rzpEnabled()) return { status: 200, body: { ok: true, ignored: 'disabled' } };
  const pay = ev && ev.payload && ev.payload.payment && ev.payload.payment.entity;
  const ord = ev && ev.payload && ev.payload.order && ev.payload.order.entity;
  const rid = (pay && pay.order_id) || (ord && ord.id);
  if (!rid) return { status: 200, body: { ok: true, ignored: ev && ev.event } };
  const o = must(await db().from('orders').select('*').eq('razorpay_order_id', String(rid)).maybeSingle());
  if (!o) return { status: 200, body: { ok: true, ignored: 'unknown order' } };
  if (o.payment_status === 'paid' || o.payment_status === 'paid_needs_refund') return { status: 200, body: { ok: true, order: o.id } };
  const paid = await settleFromRazorpay(o);
  return { status: 200, body: { ok: true, order: o.id, paid } };
}

// ---------- the router: (method, path with query, body, bearer token) -> { status, body }
async function handle(method, fullPath, body, token) {
  const url = new URL(fullPath, 'http://local');
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const q = url.searchParams;
  method = method.toUpperCase(); body = body || {};
  let m;
  const ok = (x, status) => ({ status: status || 200, body: x });
  const err = (s, msg) => ({ status: s, body: { error: msg } });
  const needUser = async () => { const u = await userFromToken(token); return u ? { user: u } : { res: err(401, 'Please sign in first.') }; };

  // ---- public
  if (p === '/api/health' && method === 'GET') {
    const { count } = await db().from('products').select('id', { count: 'exact', head: true });
    return ok({ ok: true, products: count || 0 });
  }
  if (p === '/api/config' && method === 'GET') {
    const s = await getSettings();
    return ok({ shippingFlat: s.shipping.flat, freeShippingOver: s.shipping.freeOver, statuses: STATUSES, store: s.store, tax: { rate: s.tax.rate, label: s.tax.label }, shipping: s.shipping,
      payments: { cod: true, online: rzpEnabled() } });
  }
  if (p === '/api/policies' && method === 'GET') return ok({ policies: await policyList(false) });
  if ((m = p.match(/^\/api\/policies\/([a-z]+)$/)) && method === 'GET') {
    const pol = must(await db().from('policies').select('*').eq('slug', m[1]).maybeSingle());
    if (!pol) return err(404, 'Policy not found.');
    const s = await getSettings();
    return ok({ policy: { slug: pol.slug, title: pol.title, body: pol.body, updatedAt: pol.updated_at, status: pol.status, store: s.store } });
  }
  if (p === '/api/products' && method === 'GET') {
    let list = must(await db().from('products').select('*').eq('active', true).order('created_at'));
    const cat = q.get('category'), term = (q.get('q') || '').trim().toLowerCase(), sort = q.get('sort') || 'featured';
    if (cat && cat !== 'all') list = list.filter((x) => x.category === cat);
    if (term) list = list.filter((x) => (x.name + ' ' + x.short_desc + ' ' + x.description).toLowerCase().includes(term));
    if (sort === 'price-asc') list.sort((a, b) => a.price - b.price);
    if (sort === 'price-desc') list.sort((a, b) => b.price - a.price);
    if (sort === 'name') list.sort((a, b) => a.name.localeCompare(b.name));
    if (sort === 'featured') list.sort((a, b) => (b.featured ? 1 : 0) - (a.featured ? 1 : 0));
    return ok({ products: list.map(publicProduct), total: list.length });
  }
  if ((m = p.match(/^\/api\/products\/([^/]+)$/)) && method === 'GET') {
    const key = decodeURIComponent(m[1]);
    const all = must(await db().from('products').select('*').eq('active', true));
    const prod = all.find((x) => x.slug === key || x.id === key);
    if (!prod) return err(404, 'Product not found.');
    const related = all.filter((x) => x.id !== prod.id).sort((a, b) => (a.category === prod.category ? -1 : 0) - (b.category === prod.category ? -1 : 0)).slice(0, 3).map(publicProduct);
    return ok({ product: publicProduct(prod), related });
  }
  if (p === '/api/categories' && method === 'GET') {
    const rows = must(await db().from('products').select('category').eq('active', true));
    return ok({ categories: Object.keys(CATEGORIES).map((k) => ({ key: k, label: CATEGORIES[k], count: rows.filter((x) => x.category === k).length })) });
  }
  if (p === '/api/quote' && method === 'POST') return ok(await quote(body.items, body.couponCode));
  if (p === '/api/contact' && method === 'POST') {
    if (!str(body.name, 80) || !str(body.message, 2000)) return err(400, 'Please add your name and a message.');
    if (body.email && !isEmail(body.email)) return err(400, 'That email does not look right.');
    must(await db().from('messages').insert({ name: str(body.name, 80), email: str(body.email, 120), message: str(body.message, 2000) }));
    return ok({ ok: true });
  }
  if (p === '/api/newsletter' && method === 'POST') {
    const email = str(body.email, 120).toLowerCase();
    if (!isEmail(email)) return err(400, 'Please enter a valid email.');
    must(await db().from('subscribers').upsert({ email }, { onConflict: 'email', ignoreDuplicates: true }));
    return ok({ ok: true });
  }

  // ---- accounts
  if (p === '/api/auth/register' && method === 'POST') {
    const name = str(body.name, 80), email = str(body.email, 120).toLowerCase();
    if (!name || !isEmail(email)) return err(400, 'Add your name and a valid email.');
    if (String(body.password || '').length < 8) return err(400, 'Password needs at least 8 characters.');
    const r = await db().rpc('app_register', { p_name: name, p_email: email, p_password: String(body.password).slice(0, 200) });
    if (r.error) { if (/EMAIL_TAKEN|duplicate/.test(r.error.message)) return err(409, 'An account with this email already exists. Try signing in.'); must(r); }
    const u = must(await db().from('users').select('*').eq('id', r.data).single());
    return ok({ token: await newSession(u.id), user: userOut(u) }, 201);
  }
  if (p === '/api/auth/login' && method === 'POST') {
    const uid = must(await db().rpc('app_check_login', { p_email: str(body.email, 120), p_password: String(body.password || '').slice(0, 200) }));
    if (!uid) return err(401, 'That email and password do not match.');
    const u = must(await db().from('users').select('*').eq('id', uid).single());
    return ok({ token: await newSession(u.id), user: userOut(u) });
  }
  if (p === '/api/auth/logout' && method === 'POST') {
    if (token) await db().from('sessions').delete().eq('token_hash', sha256(token));
    return ok({ ok: true });
  }
  if (p.startsWith('/api/me')) {
    const a = await needUser(); if (a.res) return a.res;
    const u = a.user;
    const save = async (patch) => Object.assign(u, must(await db().from('users').update(patch).eq('id', u.id).select('*').single()));
    if (p === '/api/me' && method === 'GET') return ok({ user: userOut(u) });
    if (p === '/api/me' && method === 'PUT') {
      const patch = {};
      if (body.name) patch.name = str(body.name, 80);
      if (typeof body.phone === 'string') patch.phone = str(body.phone, 20);
      if (Object.keys(patch).length) await save(patch);
      return ok({ user: userOut(u) });
    }
    if (p === '/api/me/password' && method === 'PUT') {
      const check = must(await db().rpc('app_check_login', { p_email: u.email, p_password: String(body.current || '') }));
      if (check !== u.id) return err(400, 'Your current password is not right.');
      if (String(body.password || '').length < 8) return err(400, 'New password needs at least 8 characters.');
      must(await db().rpc('app_set_password', { p_user: u.id, p_password: String(body.password).slice(0, 200) }));
      await db().from('sessions').delete().eq('user_id', u.id).neq('token_hash', sha256(token));
      return ok({ ok: true });
    }
    if (p === '/api/me/addresses' && method === 'POST') {
      const bad = validAddress(body); if (bad) return err(400, bad);
      const list = (u.addresses || []).slice(0, 19);
      const addr = Object.assign({ id: 'a' + randHex(4), label: str(body.label || 'Home', 30) }, cleanAddress(body));
      const makeDefault = !!body.isDefault || list.length === 0;
      if (makeDefault) list.forEach((x) => { x.isDefault = false; });
      addr.isDefault = makeDefault; list.push(addr);
      await save({ addresses: list });
      return ok({ addresses: u.addresses }, 201);
    }
    if ((m = p.match(/^\/api\/me\/addresses\/([^/]+)$/)) && method === 'DELETE') {
      await save({ addresses: (u.addresses || []).filter((x) => x.id !== m[1]) });
      return ok({ addresses: u.addresses });
    }
    if (p === '/api/me/wishlist' && method === 'GET') {
      const ids = u.wishlist || [];
      const rows = ids.length ? must(await db().from('products').select('*').in('id', ids)) : [];
      return ok({ items: ids.map((id) => rows.find((r) => r.id === id)).filter(Boolean).map(publicProduct) });
    }
    if (p === '/api/me/wishlist' && method === 'POST') {
      const pr = must(await db().from('products').select('id').eq('id', String(body.productId || '')).maybeSingle());
      if (!pr) return err(404, 'Product not found.');
      const wl = (u.wishlist || []).slice();
      if (!wl.includes(pr.id)) { wl.push(pr.id); await save({ wishlist: wl.slice(-100) }); }
      return ok({ wishlist: u.wishlist });
    }
    if ((m = p.match(/^\/api\/me\/wishlist\/([^/]+)$/)) && method === 'DELETE') {
      await save({ wishlist: (u.wishlist || []).filter((x) => x !== m[1]) });
      return ok({ wishlist: u.wishlist });
    }
    if (p === '/api/me/orders' && method === 'GET') {
      const rows = must(await db().from('orders').select('*').eq('customer_id', u.id).neq('payment_status', 'payment_cancelled').order('created_at', { ascending: false }));
      return ok({ orders: rows.map(orderOut) });
    }
    return err(404, 'Not found.');
  }

  // ---- checkout
  if (p === '/api/orders' && method === 'POST') {
    const uu = await userFromToken(token);
    if (!uu) return err(401, 'Please sign in or create an account to place your order.');
    const online = body.paymentMethod === 'razorpay';
    if (online && !rzpEnabled()) return err(400, 'Online payment is not available right now. Please choose pay on delivery.');
    const qt = await quote(body.items, body.couponCode);
    if (!qt.lines.length) return err(400, 'Your cart is empty.');
    if (qt.errors.length) return err(400, qt.errors[0]);
    if (body.couponCode && !qt.coupon) return err(400, qt.couponMessage || 'That code could not be applied.');
    const bad = validAddress(body.address); if (bad) return err(400, bad);
    const email = String((uu && uu.email) || body.email || '').trim().toLowerCase();
    if (!isEmail(email)) return err(400, 'Add an email so we can send the order updates.');
    const address = cleanAddress(body.address);
    const guestToken = uu ? '' : randHex(12);
    const order = { customerId: uu ? uu.id : '', customerName: address.name, email, phone: address.phone, address,
      items: qt.lines.map((l) => ({ productId: l.productId, slug: l.slug, name: l.name, image: l.image, unitPrice: l.unitPrice, qty: l.qty, lineTotal: l.lineTotal })),
      subtotal: qt.subtotal, discount: qt.discount, shipping: qt.shipping, tax: qt.tax, total: qt.total, coupon: qt.coupon,
      paymentMethod: online ? 'razorpay' : 'cod', paymentStatus: online ? 'awaiting_payment' : 'pay_on_delivery', notes: str(body.notes, 500), guestToken };
    const r = await db().rpc('app_place_order', { p_order: order });
    if (r.error) {
      const sm = /STOCK\|([^|]*)\|(\d+)/.exec(r.error.message);
      if (sm) return err(409, Number(sm[2]) > 0 ? sm[1] + ' only has ' + sm[2] + ' left. Please lower the quantity.' : sm[1] + ' is out of stock.');
      if (/COUPON_UNAVAILABLE/.test(r.error.message)) return err(400, 'That code is no longer available.');
      must(r);
    }
    const saved = must(await db().from('orders').select('*').eq('id', r.data).single());
    let razorpay = null;
    if (online) {
      try { razorpay = await startRazorpay(saved); }
      catch (e) {
        console.error(e);
        await db().rpc('app_cancel_unpaid', { p_id: saved.id });
        return err(502, 'Could not start the online payment. Nothing was charged. Please try again or choose pay on delivery.');
      }
    }
    return ok({ order: orderOut(saved), guestToken: guestToken || null, razorpay }, 201);
  }
  if ((m = p.match(/^\/api\/orders\/([^/]+)$/)) && method === 'GET') {
    const od = must(await db().from('orders').select('*').eq('id', decodeURIComponent(m[1])).maybeSingle());
    if (!od) return err(404, 'Order not found.');
    const viewer = await userFromToken(token);
    const key = q.get('key');
    const allowed = (viewer && (viewer.role === 'admin' || viewer.id === od.customer_id)) ||
      (key && od.guest_token && key === od.guest_token) ||
      ((q.get('email') || '').trim().toLowerCase() === od.email && !!q.get('email'));
    if (!allowed) return err(404, 'Order not found.');
    return ok({ order: orderOut(od) });
  }

  // ---- online payments (Razorpay)
  if (p.startsWith('/api/payments/razorpay/') && method === 'POST') {
    const a = await needUser(); if (a.res) return a.res;
    const o = await getOrderRow(body.orderId);
    if (!o || (o.customer_id !== a.user.id && a.user.role !== 'admin')) return err(404, 'Order not found.');
    if (!rzpEnabled()) return err(400, 'Online payment is not available right now.');
    if (p === '/api/payments/razorpay/order') {
      if (o.status === 'cancelled' || o.payment_status !== 'awaiting_payment') return err(400, 'This order does not need a payment.');
      try { return ok({ razorpay: await startRazorpay(o) }); }
      catch (e) { console.error(e); return err(502, 'Could not start the payment. Please try again in a moment.'); }
    }
    if (p === '/api/payments/razorpay/verify') {
      const rid = String(body.razorpay_order_id || ''), pid = String(body.razorpay_payment_id || ''), sig = String(body.razorpay_signature || '');
      if (!rid || rid !== o.razorpay_order_id) return err(400, 'This payment does not match the order.');
      const expect = crypto.createHmac('sha256', rzpSecret()).update(rid + '|' + pid).digest('hex');
      if (!safeEqual(expect, sig)) return err(400, 'We could not verify this payment. If money was taken, contact us with your order number.');
      try {
        const pay = await rzp('GET', '/payments/' + encodeURIComponent(pid));
        if (pay.order_id !== rid) return err(400, 'This payment does not match the order.');
        await ensureCaptured(pay);
      } catch (e) { console.error('capture check', e.message); /* signature is valid; the webhook or daily check will finish it */ }
      must(await db().rpc('app_mark_paid', { p_rzp_order: rid, p_payment: pid }));
      return ok({ order: orderOut(await getOrderRow(o.id)) });
    }
    if (p === '/api/payments/razorpay/cancel') {
      if (o.payment_status !== 'awaiting_payment' || o.status === 'cancelled') return ok({ order: orderOut(o) });
      try { if (await settleFromRazorpay(o)) return ok({ order: orderOut(await getOrderRow(o.id)), paid: true }); }
      catch (e) { console.error(e); return err(502, 'Could not check the payment with Razorpay. Your order is kept; try again in a moment.'); }
      must(await db().rpc('app_cancel_unpaid', { p_id: o.id }));
      return ok({ order: orderOut(await getOrderRow(o.id)), cancelled: true });
    }
  }

  // ---- admin
  if (p.startsWith('/api/admin')) {
    const a = await needUser(); if (a.res) return a.res;
    if (a.user.role !== 'admin') return err(403, 'Admins only.');
    if (p === '/api/admin/summary' && method === 'GET') return ok(await summary());
    if (p === '/api/admin/orders' && method === 'GET') {
      let qy = db().from('orders').select('*').order('created_at', { ascending: false }).limit(1000);
      const st = q.get('status'); if (st && st !== 'all') qy = qy.eq('status', st);
      return ok({ orders: must(await qy).map(orderOut) });
    }
    if ((m = p.match(/^\/api\/admin\/orders\/([^/]+)\/status$/)) && method === 'PUT') {
      if (!STATUSES.includes(body.status)) return err(400, 'Unknown status.');
      const r = await db().rpc('app_set_order_status', { p_id: m[1], p_status: body.status });
      if (r.error) {
        if (/ORDER_NOT_FOUND/.test(r.error.message)) return err(404, 'Order not found.');
        if (/ORDER_CANCELLED/.test(r.error.message)) return err(400, 'Cancelled orders cannot be reopened. Place a new order instead.');
        must(r);
      }
      return ok({ order: orderOut(must(await db().from('orders').select('*').eq('id', m[1]).single())) });
    }
    if (p === '/api/admin/products' && method === 'GET') return ok({ products: must(await db().from('products').select('*').order('created_at')).map(productOut) });
    if (p === '/api/admin/products' && method === 'POST') {
      const pp = productFromBody(body, null); if (pp.error) return err(400, pp.error);
      const r = await db().from('products').insert(pp.row).select('*').single();
      if (r.error && /duplicate|unique/.test(r.error.message)) return err(409, 'Another product already uses that name or link.');
      return ok({ product: productOut(must(r)) }, 201);
    }
    if ((m = p.match(/^\/api\/admin\/products\/([^/]+)$/))) {
      const pe = must(await db().from('products').select('*').eq('id', m[1]).maybeSingle());
      if (!pe) return err(404, 'Product not found.');
      if (method === 'PUT') {
        const pu = productFromBody(body, productOut(pe)); if (pu.error) return err(400, pu.error);
        const r = await db().from('products').update(pu.row).eq('id', pe.id).select('*').single();
        if (r.error && /duplicate|unique/.test(r.error.message)) return err(409, 'Another product already uses that name or link.');
        return ok({ product: productOut(must(r)) });
      }
      if (method === 'DELETE') { must(await db().from('products').delete().eq('id', pe.id)); return ok({ ok: true }); }
    }
    if (p === '/api/admin/upload' && method === 'POST') {
      const du = String(body.dataUrl || '');
      if (!/^data:image\/(png|jpeg|webp|gif);base64,/.test(du)) return err(400, 'Upload a PNG, JPG, WEBP or GIF image.');
      if (du.length > 4 * 1024 * 1024) return err(400, 'Image is too large. Try a smaller file.');
      return ok({ url: await uploadImage(du, body.name) }, 201);
    }
    if (p === '/api/admin/coupons' && method === 'GET') return ok({ coupons: must(await db().from('coupons').select('*').order('created_at')).map(couponOut) });
    if (p === '/api/admin/coupons' && method === 'POST') {
      const cp = couponFromBody(body, null); if (cp.error) return err(400, cp.error);
      const r = await db().from('coupons').insert(Object.assign(cp.row, { used: 0 })).select('*').single();
      if (r.error && /duplicate|unique/.test(r.error.message)) return err(409, 'That code already exists.');
      return ok({ coupon: couponOut(must(r)) }, 201);
    }
    if ((m = p.match(/^\/api\/admin\/coupons\/([^/]+)$/))) {
      const code = decodeURIComponent(m[1]);
      const ce = must(await db().from('coupons').select('*').eq('code', code).maybeSingle());
      if (!ce) return err(404, 'Coupon not found.');
      if (method === 'PUT') {
        const cu = couponFromBody(body, ce); if (cu.error) return err(400, cu.error);
        delete cu.row.code;
        return ok({ coupon: couponOut(must(await db().from('coupons').update(cu.row).eq('code', code).select('*').single())) });
      }
      if (method === 'DELETE') { must(await db().from('coupons').delete().eq('code', code)); return ok({ ok: true }); }
    }
    if (p === '/api/admin/customers' && method === 'GET') {
      const users = must(await db().from('users').select('id,name,email,phone,created_at').eq('role', 'customer').order('created_at', { ascending: false }));
      const orders = must(await db().from('orders').select('customer_id,total,status').not('customer_id', 'is', null));
      return ok({ customers: users.map((u) => {
        const mine = orders.filter((o) => o.customer_id === u.id);
        return { id: u.id, name: u.name, email: u.email, phone: u.phone || '', createdAt: u.created_at, orders: mine.length,
          spend: money(mine.filter((o) => o.status !== 'cancelled').reduce((s, o) => s + num(o.total), 0)) };
      }) });
    }
    if (p === '/api/admin/messages' && method === 'GET') {
      const rows = must(await db().from('messages').select('*').order('created_at', { ascending: false }).limit(500));
      const subs = must(await db().from('subscribers').select('*').order('created_at', { ascending: false }).limit(2000));
      return ok({ messages: rows.map((r) => ({ id: r.id, name: r.name, email: r.email, message: r.message, read: r.read, createdAt: r.created_at })),
        subscribers: subs.map((s) => ({ email: s.email, createdAt: s.created_at })) });
    }
    if ((m = p.match(/^\/api\/admin\/messages\/([^/]+)$/)) && method === 'DELETE') {
      must(await db().from('messages').delete().eq('id', m[1])); return ok({ ok: true });
    }
    if (p === '/api/admin/settings' && method === 'GET') return ok({ settings: await getSettings() });
    if (p === '/api/admin/settings' && method === 'PUT') {
      const cur = await getSettings(); const b = body || {};
      if (b.store) ['name', 'tagline', 'email', 'phone', 'address', 'gstin', 'hours'].forEach((k) => { if (b.store[k] !== undefined) cur.store[k] = str(b.store[k], 300); });
      if (!cur.store.name) return err(400, 'Store name cannot be empty.');
      if (b.shipping) {
        const fl = Number(b.shipping.flat), fo = Number(b.shipping.freeOver);
        if (!(fl >= 0) || !(fo >= 0)) return err(400, 'Shipping amounts must be 0 or more.');
        cur.shipping = { flat: money(fl), freeOver: money(fo), note: str(b.shipping.note, 300) };
      }
      if (b.tax) {
        const tr = Number(b.tax.rate);
        if (!(tr >= 0 && tr <= 100)) return err(400, 'Tax rate must be between 0 and 100.');
        cur.tax = { rate: tr, label: str(b.tax.label || 'GST', 30), note: str(b.tax.note, 300) };
      }
      must(await db().from('settings').upsert({ id: 1, store: cur.store, shipping: cur.shipping, tax: cur.tax, updated_at: new Date().toISOString() }));
      return ok({ settings: await getSettings() });
    }
    if (p === '/api/admin/policies' && method === 'GET') return ok({ policies: await policyList(true) });
    if ((m = p.match(/^\/api\/admin\/policies\/([a-z]+)$/)) && method === 'PUT') {
      const pb = String(body.body || '').slice(0, 20000);
      if (!pb.trim()) return err(400, 'Policy text cannot be empty.');
      const r = must(await db().from('policies').update({ body: pb, status: 'final', updated_at: new Date().toISOString() }).eq('slug', m[1]).select('*'));
      if (!r.length) return err(404, 'Policy not found.');
      return ok({ policy: { slug: r[0].slug, title: r[0].title, body: r[0].body, status: r[0].status, updatedAt: r[0].updated_at } });
    }
  }
  return err(404, 'Not found.');
}

async function heartbeat(source) {
  return must(await db().rpc('app_heartbeat', { p_source: source || 'cron' }));
}

module.exports = { handle, heartbeat, sweepUnpaid, razorpayWebhook, rzpEnabled, STATUSES };
