/* Ananta Beauty storefront logic. Talks to the store API (/api on Vercel), which keeps
   products, orders, accounts and settings in Supabase. Only the bag and the sign-in token
   are kept in this browser. */
(function () {
  'use strict';
  // site root, wherever the folder is served from (a root, or a path under a host)
  var ROOT = (function () { try { var sc = document.querySelector('script[src*="js/app.js"]'); return new URL('../', sc.src).href; } catch (e) { return '/'; } })();
  var KEY_TOKEN = 'ananta.token', KEY_CART = 'ananta.cart', KEY_COUPON = 'ananta.coupon';
  var CATLABEL = { serums: 'Hair serum', sprays: 'Rosemary spray', shampoos: 'Onion shampoo', combos: 'Combo' };
  var S = { catalog: null };
  var REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // store settings the storefront may show (set from /api/config at boot; never gateway keys)
  var CFG = { shipping: { flat: 49, freeOver: 499, note: '' }, store: { name: 'Ananta Beauty' }, tax: { rate: 0, label: 'Tax' }, payments: { cod: true, online: false } };
  var MOBILE_Q = '(max-width: 720px)';
  function isMobile() { return !!(window.matchMedia && window.matchMedia(MOBILE_Q).matches); }
  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function rupees(n) { return '\u20B9' + (Math.round(Number(n) * 100) / 100).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 }); }
  function qs(name) { return new URLSearchParams(location.search).get(name) || ''; }
  function page() { return (location.pathname.split('/').pop() || 'index.html').replace('.html', '') || 'index'; }

  function toast(msg) {
    var t = $('#toast'); if (!t) return;
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.classList.remove('show'); }, 2800);
  }

  // ---------- API
  async function api(method, path, body) {
    var token = '';
    try { token = localStorage.getItem(KEY_TOKEN) || ''; } catch (e) { /* storage blocked */ }
    try {
      var opts = { method: method, headers: { 'Content-Type': 'application/json' } };
      if (token) opts.headers.Authorization = 'Bearer ' + token;
      if (body !== undefined && method !== 'GET') opts.body = JSON.stringify(body);
      var r = await fetch(ROOT + 'api' + path, opts);
      var data = null; try { data = await r.json(); } catch (e) { data = { error: 'Unexpected reply from the store.' }; }
      if (r.status === 401 && token && path.indexOf('/auth/') !== 0) { try { localStorage.removeItem(KEY_TOKEN); } catch (e) { /* ignore */ } }
      return { status: r.status, body: data || {} };
    } catch (e) {
      return { status: 0, body: { error: 'Could not reach the store. Check your connection and try again.' } };
    }
  }
  function setSession(token) { if (token) localStorage.setItem(KEY_TOKEN, token); else localStorage.removeItem(KEY_TOKEN); }

  // ---------- sign in / create account, shown inside a page (checkout, my account)
  function authGate(container, intro, onDone) {
    container.innerHTML = '<div class="auth-wrap" style="grid-column:1/-1;padding:10px 0 60px"><div class="auth">' +
      (intro ? '<p class="muted" style="margin:0 0 18px;text-align:center">' + esc(intro) + '</p>' : '') +
      '<div class="tabs" role="tablist" aria-label="Account"><button type="button" role="tab" aria-selected="true" data-g="login">Sign in</button><button type="button" role="tab" aria-selected="false" data-g="register">Create account</button></div>' +
      '<form class="stack" data-form="login" novalidate><h2 style="font-size:1.6rem">Welcome back</h2>' +
      '<label class="l">Email<input class="field" type="email" name="email" autocomplete="email" required></label>' +
      '<label class="l">Password<input class="field" type="password" name="password" autocomplete="current-password" required></label>' +
      '<div class="err" role="alert"></div><button class="btn" type="submit">Sign in</button></form>' +
      '<form class="stack" data-form="register" novalidate hidden><h2 style="font-size:1.6rem">Create your account</h2>' +
      '<label class="l">Full name<input class="field" name="name" autocomplete="name" required></label>' +
      '<label class="l">Email<input class="field" type="email" name="email" autocomplete="email" required></label>' +
      '<label class="l">Password (8+ characters)<input class="field" type="password" name="password" minlength="8" autocomplete="new-password" required></label>' +
      '<div class="err" role="alert"></div><button class="btn" type="submit">Create account</button></form></div></div>';
    var tabs = $$('[data-g]', container), forms = $$('form[data-form]', container);
    tabs.forEach(function (t) { t.addEventListener('click', function () {
      tabs.forEach(function (x) { x.setAttribute('aria-selected', x === t ? 'true' : 'false'); });
      forms.forEach(function (fm) { fm.hidden = fm.getAttribute('data-form') !== t.getAttribute('data-g'); });
    }); });
    forms.forEach(function (fm) { fm.addEventListener('submit', async function (e) {
      e.preventDefault();
      var isReg = fm.getAttribute('data-form') === 'register', errEl = $('.err', fm), btn = $('button[type=submit]', fm);
      errEl.textContent = '';
      var body = { email: fm.elements.email.value.trim(), password: fm.elements.password.value };
      if (isReg) body.name = fm.elements.name.value.trim();
      if (!body.email || !body.password || (isReg && !body.name)) { errEl.textContent = 'Please fill in every field.'; return; }
      btn.disabled = true;
      var r = await api('POST', isReg ? '/auth/register' : '/auth/login', body);
      btn.disabled = false;
      if (r.status !== (isReg ? 201 : 200)) { errEl.textContent = r.body.error || 'Could not sign in.'; return; }
      setSession(r.body.token); toast(isReg ? 'Account created' : 'Signed in');
      onDone(r.body.user);
    }); });
  }

  // ---------- Razorpay checkout (online payment)
  function loadRazorpay() {
    if (window.Razorpay) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var sc = document.createElement('script'); sc.src = 'https://checkout.razorpay.com/v1/checkout.js';
      sc.onload = function () { resolve(); }; sc.onerror = function () { reject(new Error('Could not load the payment window. Check your connection.')); };
      document.head.appendChild(sc);
    });
  }
  // opens the Razorpay window; resolves { paid: true, order } or { paid: false, message }
  async function payOnline(orderId, rz) {
    await loadRazorpay();
    return new Promise(function (resolve) {
      var settled = false;
      var rp = new window.Razorpay({
        key: rz.keyId, order_id: rz.orderId, amount: rz.amount, currency: rz.currency, name: rz.name, description: rz.description,
        image: ROOT + 'img/logo.png', prefill: rz.prefill, theme: { color: '#a8325e' },
        handler: async function (resp) {
          settled = true;
          var v = await api('POST', '/payments/razorpay/verify', { orderId: orderId, razorpay_order_id: resp.razorpay_order_id, razorpay_payment_id: resp.razorpay_payment_id, razorpay_signature: resp.razorpay_signature });
          resolve(v.status === 200 ? { paid: true, order: v.body.order } : { paid: false, message: v.body.error || 'We could not confirm the payment. Contact us with your order number.' });
        },
        modal: { ondismiss: async function () {
          if (settled) return;
          var c = await api('POST', '/payments/razorpay/cancel', { orderId: orderId });
          if (c.status === 200 && c.body.paid) resolve({ paid: true, order: c.body.order });
          else resolve({ paid: false, message: 'Payment was not completed, so nothing was charged and the order was cancelled. Your bag is still here.' });
        } }
      });
      rp.on('payment.failed', function (resp) { toast((resp && resp.error && resp.error.description) || 'Payment failed. You can try again.'); });
      rp.open();
    });
  }

  // ---------- cart
  function getCart() { try { return JSON.parse(localStorage.getItem(KEY_CART) || '[]'); } catch (e) { return []; } }
  function setCart(c) { localStorage.setItem(KEY_CART, JSON.stringify(c)); updateCartCount(); window.dispatchEvent(new Event('cart-changed')); }
  function cartCount() { return getCart().reduce(function (s, x) { return s + (x.qty || 0); }, 0); }
  function updateCartCount() {
    var n = cartCount(), el = $('#cart-count'); if (el) el.textContent = n;
    var tc = $('#tab-count'); if (tc) tc.textContent = n;
    var btn = $('.cart-btn'); if (btn && !REDUCED) { btn.classList.remove('bump'); void btn.offsetWidth; btn.classList.add('bump'); }
  }
  function addToCart(pid, qty) {
    var c = getCart(), f = c.find(function (x) { return x.productId === pid; });
    if (f) f.qty = Math.min(20, f.qty + qty); else c.push({ productId: pid, qty: qty });
    setCart(c);
    if (isMobile()) openBagSheet(); else toast('Added to your bag');
  }

  // ---------- reveal + chrome
  function initReveal(root) {
    var els = $$('.reveal:not(.in)', root || document);
    if (!('IntersectionObserver' in window) || REDUCED) { els.forEach(function (e) { e.classList.add('in'); }); return; }
    var io = new IntersectionObserver(function (ents) {
      ents.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
    els.forEach(function (e) { io.observe(e); });
  }
  function initChrome() {
    var h = $('header.site');
    var onScroll = function () { if (h) h.classList.toggle('scrolled', window.scrollY > 8); };
    window.addEventListener('scroll', onScroll, { passive: true }); onScroll();
    var burger = $('.burger'), menu = $('#menu');
    if (burger && menu) burger.addEventListener('click', function () {
      var open = menu.classList.toggle('open'); burger.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    injectAppShell();
    var cur = page();
    var map = { index: 'home', shop: 'shop', product: 'shop', cart: '', checkout: '', order: '', about: 'about', faq: 'faq', contact: 'contact', login: 'account', dashboard: 'account' };
    $$('[data-nav]').forEach(function (a) { if (map[cur] === a.getAttribute('data-nav')) a.setAttribute('aria-current', 'page'); });
    updateCartCount();
    document.addEventListener('click', function (ev) {
      var b = ev.target.closest && ev.target.closest('[data-add]');
      if (b && !b.disabled) { ev.preventDefault(); addToCart(b.getAttribute('data-add'), 1); return; }
      if (ev.target.closest && ev.target.closest('[data-inc],[data-dec],[data-rm]')) onCartClick(ev);
    });
    // hero: words are animated by CSS; the arch settles when visible
    var art = $('#heroArt'); if (art) setTimeout(function () { art.classList.add('in'); }, 200);
    if (!REDUCED) {
      var hi = $('.hero .arch img');
      if (hi) window.addEventListener('scroll', function () {
        var y = Math.min(window.scrollY, 600); hi.style.translate = '0 ' + (y * 0.06) + 'px';
      }, { passive: true });
    }
  }


  // ---------- app shell (mobile): bottom tab bar, bag sheet, filter sheet, newsletter signup
  var ICONS = {
    home: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/></svg>',
    shop: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="2"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2"/></svg>',
    bag: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 8h14l-1 12H6zM9 8V6a3 3 0 0 1 6 0v2"/></svg>',
    account: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>'
  };
  function injectAppShell() {
    var cur = page();
    var tb = document.createElement('nav');
    tb.className = 'tabbar'; tb.setAttribute('aria-label', 'App sections');
    var tabs = [['home', 'Home', 'index.html'], ['shop', 'Shop', 'shop.html'], ['bag', 'Bag', '#'], ['account', 'Account', 'dashboard.html']];
    tb.innerHTML = tabs.map(function (t) {
      var active = (t[0] === 'home' && cur === 'index') || (t[0] === 'shop' && (cur === 'shop' || cur === 'product')) || (t[0] === 'account' && (cur === 'dashboard' || cur === 'login'));
      var inner = ICONS[t[0]] + '<span>' + t[1] + (t[0] === 'bag' ? ' <b class="tab-count" id="tab-count">0</b>' : '') + '</span>';
      if (t[0] === 'bag') return '<button type="button" data-tab="bag" id="tab-bag" aria-label="Open your bag">' + inner + '</button>';
      return '<a href="' + t[2] + '" data-tab="' + t[0] + '"' + (active ? ' aria-current="page"' : '') + '>' + inner + '</a>';
    }).join('');
    document.body.appendChild(tb);
    var sheet = document.createElement('div');
    sheet.className = 'sheet-wrap'; sheet.id = 'bagsheet';
    sheet.innerHTML = '<div class="sheet-scrim" data-close="1"></div><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="bagsheet-h"><div class="grab" aria-hidden="true"></div>' +
      '<div class="sheet-head"><h3 id="bagsheet-h">Your bag</h3><button class="sheet-x" type="button" data-close="1" aria-label="Close">&times;</button></div><div class="sheet-body" id="bagsheet-body"></div></div>';
    document.body.appendChild(sheet);
    $('#tab-bag').addEventListener('click', function () { openBagSheet(); });
    sheet.addEventListener('click', function (e) { if (e.target.getAttribute && e.target.getAttribute('data-close')) closeBagSheet(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { closeBagSheet(); var tbar = $('#toolbar'); if (tbar) tbar.classList.remove('open'); } });
    // shop: filters and sort open as a bottom sheet on mobile
    var of = $('#openFilter'), tbar = $('#toolbar');
    if (of && tbar) {
      of.addEventListener('click', function () { tbar.classList.add('open'); document.body.classList.add('sheet-open'); });
      $$('[data-close-filter]').forEach(function (b) { b.addEventListener('click', function () { tbar.classList.remove('open'); document.body.classList.remove('sheet-open'); }); });
    }
    // newsletter signup: saved to the store's subscriber list (Admin > Messages)
    var nl = $('#newsletter');
    if (nl) nl.addEventListener('submit', async function (e) {
      e.preventDefault();
      var input = nl.querySelector('input[type=email]'); var email = (input && input.value || '').trim();
      if (!email) { toast('Enter your email first.'); return; }
      var r = await api('POST', '/newsletter', { email: email });
      toast(r.status === 200 ? 'Thanks, you are on the list.' : (r.body.error || 'Could not sign you up right now.'));
      if (r.status === 200) nl.reset();
    });
  }
  async function openBagSheet() {
    var sheet = $('#bagsheet'), body = $('#bagsheet-body');
    if (!sheet || !body) return;
    var cart = getCart();
    if (!cart.length) {
      body.innerHTML = '<p class="muted">Your bag is empty.</p><a class="btn" href="shop.html">Go to the shop</a>';
    } else {
      body.innerHTML = '<div class="empty" style="padding:18px 0">Checking your bag&hellip;</div>';
      var coupon = localStorage.getItem(KEY_COUPON) || '';
      var r = await api('POST', '/quote', { items: cart, couponCode: coupon });
      var q = r.body || {};
      var lines = (q.lines || []).map(function (l) {
        return '<div class="sheet-line"><img src="' + esc(l.image) + '" alt=""><div><b>' + esc(l.name) + '</b><span class="muted">' + l.qty + ' &times; ' + rupees(l.unitPrice) + '</span></div><strong>' + rupees(l.lineTotal) + '</strong></div>';
      }).join('');
      body.innerHTML = lines + '<div class="sheet-totals">' + totalsHtml(q) + '</div>' +
        (q.couponMessage ? '<p class="muted" style="font-size:.9rem">' + esc(q.couponMessage) + '</p>' : '') +
        '<div class="sheet-actions"><a class="btn" href="checkout.html">Checkout</a><a class="btn ghost" href="cart.html">View bag</a></div>';
    }
    sheet.classList.add('open'); document.body.classList.add('sheet-open');
  }
  function closeBagSheet() {
    var sheet = $('#bagsheet'); if (sheet) sheet.classList.remove('open');
    document.body.classList.remove('sheet-open');
  }

  // ---------- policy pages (text is edited in Admin > Policies)
  async function renderPolicy() {
    var root = $('#policy'), slug = qs('p') || 'privacy';
    var r = await api('GET', '/policies/' + encodeURIComponent(slug));
    if (r.status !== 200) { root.innerHTML = '<div class="empty">We could not find that policy. <a href="policy.html?p=privacy">Read the privacy policy</a>.</div>'; return; }
    var pol = r.body.policy;
    document.title = pol.title + ' | Ananta Beauty';
    $('#crumb') && ($('#crumb').textContent = pol.title);
    var paras = String(pol.body || '').split(/\n\s*\n/).map(function (t) { return '<p>' + esc(t) + '</p>'; }).join('');
    root.innerHTML = '<span class="eyebrow">Policies</span><h1>' + esc(pol.title) + '</h1>' +
      (String(pol.body || '').trim() ? '<div class="policy-body">' + paras + '</div>' :
        '<div class="policy-body"><p>This policy is being updated. For any question about it, <a href="contact.html">contact us</a> and we will answer directly.</p></div>') +
      '<p class="muted" style="font-size:.88rem;margin-top:26px">Last updated: ' + (pol.updatedAt ? new Date(pol.updatedAt).toLocaleDateString('en-IN', { dateStyle: 'medium' }) : 'not yet published') + '</p>';
    var links = ['privacy', 'terms', 'shipping', 'returns', 'refund'];
    var titles = { privacy: 'Privacy', terms: 'Terms', shipping: 'Shipping', returns: 'Returns', refund: 'Refunds' };
    var more = $('#policy-links');
    if (more) more.innerHTML = links.filter(function (x) { return x !== slug; }).map(function (x) { return '<a class="chip" href="policy.html?p=' + x + '">' + titles[x] + '</a>'; }).join('');
    document.title = pol.title + ' | Ananta Beauty';
  }

  // ---------- product rendering
  function productCard(p, i) {
    var img1 = p.images[0] || '', img2 = p.images[1] || '';
    var out = !p.inStock;
    return '<article class="pcard reveal d' + (i % 3) + '">' +
      '<a class="thumb" href="product.html?slug=' + esc(p.slug) + '" tabindex="-1" aria-hidden="true">' +
      '<img src="' + esc(img1) + '" alt="" loading="lazy">' +
      (img2 && img2 !== img1 ? '<img class="alt" src="' + esc(img2) + '" alt="" loading="lazy">' : '') +
      '<span class="badge' + (out ? ' out' : '') + '">' + (out ? 'Sold out' : esc(CATLABEL[p.category] || '')) + '</span></a>' +
      '<div class="body"><h3><a href="product.html?slug=' + esc(p.slug) + '">' + esc(p.name) + '</a></h3>' +
      '<p class="short">' + esc(p.shortDesc) + '</p>' +
      '<div class="row"><div class="price">' + rupees(p.price) + (p.compareAt ? ' <s>' + rupees(p.compareAt) + '</s>' : '') + '</div>' +
      '<button class="add-quick" type="button" data-add="' + esc(p.id) + '"' + (out ? ' disabled' : '') + '>' + (out ? 'Sold out' : 'Add to bag') + '</button></div></div></article>';
  }

  async function renderHome() {
    var r = await api('GET', '/products?sort=featured');
    var list = (r.body.products || []).filter(function (p) { return p.featured; }).slice(0, 4);
    if (!list.length) list = (r.body.products || []).slice(0, 4);
    S.catalog = r.body.products || [];
    var root = $('#featured');
    root.innerHTML = list.map(productCard).join('') || '<div class="empty">The range is loading. Try again in a moment.</div>';
    initReveal(root);
  }

  async function renderShop() {
    var grid = $('#grid'), count = $('#count'), chips = $$('#chips .chip'), q = $('#q'), sort = $('#sort');
    var state = { cat: qs('cat') || 'all', q: qs('q'), sort: qs('sort') || 'featured' };
    q.value = state.q; sort.value = state.sort;
    chips.forEach(function (c) { c.setAttribute('aria-pressed', c.dataset.cat === state.cat ? 'true' : 'false'); });
    var timer = null;
    async function load() {
      var url = '/products?category=' + encodeURIComponent(state.cat) + '&q=' + encodeURIComponent(state.q) + '&sort=' + encodeURIComponent(state.sort);
      var r = await api('GET', url);
      S.catalog = r.body.products || S.catalog || [];
      var list = r.body.products || [];
      count.textContent = list.length + (list.length === 1 ? ' product' : ' products');
      grid.innerHTML = list.length ? list.map(productCard).join('') : '<div class="empty" style="grid-column:1/-1">Nothing matches that yet. Try another ingredient, or <a href="shop.html">clear the filters</a>.</div>';
      initReveal(grid);
      var p = new URLSearchParams(); if (state.cat !== 'all') p.set('cat', state.cat); if (state.q) p.set('q', state.q); if (state.sort !== 'featured') p.set('sort', state.sort);
      history.replaceState(null, '', 'shop.html' + (p.toString() ? '?' + p.toString() : ''));
    }
    chips.forEach(function (c) { c.addEventListener('click', function () { state.cat = c.dataset.cat; chips.forEach(function (x) { x.setAttribute('aria-pressed', x === c ? 'true' : 'false'); }); load(); }); });
    q.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(function () { state.q = q.value.trim(); load(); }, 220); });
    sort.addEventListener('change', function () { state.sort = sort.value; load(); });
    load();
  }

  async function renderProduct() {
    var slug = qs('slug'), root = $('#pd');
    var r = await api('GET', '/products/' + encodeURIComponent(slug));
    if (r.status !== 200) { root.innerHTML = '<div class="empty" style="grid-column:1/-1">We could not find that product. <a href="shop.html">Back to the shop</a>.</div>'; return; }
    var p = r.body.product;
    document.title = p.name + ' | Ananta Beauty';
    $('#crumb').textContent = p.name;
    var imgs = p.images.length ? p.images : [''];
    var qty = 1;
    root.innerHTML =
      '<div class="gallery"><div class="main">' + imgs.map(function (s, i) { return '<img class="' + (i === 0 ? 'on' : '') + '" src="' + esc(s) + '" alt="' + esc(p.name) + ', photo ' + (i + 1) + '">'; }).join('') + '</div>' +
      (imgs.length > 1 ? '<div class="thumbs" role="group" aria-label="Choose photo">' + imgs.map(function (s, i) { return '<button type="button" data-i="' + i + '" aria-current="' + (i === 0) + '" aria-label="Photo ' + (i + 1) + '"><img src="' + esc(s) + '" alt=""></button>'; }).join('') + '</div>' : '') + '</div>' +
      '<div class="buy-col"><span class="pill-soft">' + esc(CATLABEL[p.category] || '') + '</span>' +
      '<h1 style="margin-top:14px">' + esc(p.name) + '</h1>' +
      '<div class="price">' + rupees(p.price) + (p.compareAt ? ' <s>' + rupees(p.compareAt) + '</s>' : '') + '</div>' +
      '<p class="short">' + esc(p.shortDesc) + '</p>' +
      '<div class="buybox"><div class="buy-row" style="margin-top:0"><div class="qty" role="group" aria-label="Quantity"><button type="button" id="dec" aria-label="One less">&minus;</button><output id="qty" aria-live="polite">1</output><button type="button" id="inc" aria-label="One more">+</button></div>' +
      '<button class="btn" type="button" id="add"' + (p.inStock ? '' : ' disabled') + '>' + (p.inStock ? 'Add to bag' : 'Sold out for now') + '</button></div>' +
      '<div class="buy-row"><button class="linkbtn" type="button" id="wish">Save to wishlist</button></div></div>' +
      '<div class="perks"><div>Cash on delivery available</div><div>Pay in cash or UPI when it arrives</div><div>Ingredient list on the pack label</div></div></div>';
    // description and details sit full-width at the bottom of the page (Ankur's note, 10 Nov)
    var descEl = $('#pd-desc');
    if (descEl) descEl.innerHTML =
      '<div class="wrap pd-desc"><span class="eyebrow">About this product</span>' +
      '<h2>' + esc(p.name) + ', <em class="serif">the description</em></h2>' +
      '<div class="desc-body"><p>' + esc(p.description || p.shortDesc) + '</p></div>' +
      '<div class="acc">' +
      '<details open><summary>Directions</summary><p>Follow the directions printed on the pack. This page does not add to them.</p></details>' +
      '<details><summary>Shipping and returns</summary><p>Shipping is a flat ' + rupees(CFG.shipping.flat) + ' on orders under ' + rupees(CFG.shipping.freeOver) + ', and free above that. ' + esc(CFG.shipping.note || '') + ' Return policy: <a href="policy.html?p=returns">read the returns policy</a>.</p></details>' +
      '</div></div>';
    root.classList.add('pd');
    // gallery
    $$('.gallery .thumbs button', root).forEach(function (b) {
      b.addEventListener('click', function () {
        var i = +b.dataset.i;
        $$('.gallery .main img', root).forEach(function (im, k) { im.classList.toggle('on', k === i); });
        $$('.gallery .thumbs button', root).forEach(function (x, k) { x.setAttribute('aria-current', k === i ? 'true' : 'false'); });
      });
    });
    $('#dec', root).addEventListener('click', function () { qty = Math.max(1, qty - 1); $('#qty', root).textContent = qty; });
    $('#inc', root).addEventListener('click', function () { qty = Math.min(20, qty + 1); $('#qty', root).textContent = qty; });
    $('#add', root).addEventListener('click', function () { addToCart(p.id, qty); });
    $('#wish', root).addEventListener('click', async function () {
      if (!localStorage.getItem(KEY_TOKEN)) { location.href = 'login.html?next=' + encodeURIComponent(location.pathname.split('/').pop() + location.search); return; }
      var w = await api('POST', '/me/wishlist', { productId: p.id });
      toast(w.status === 200 ? 'Saved to your wishlist' : (w.body.error || 'Could not save that right now'));
    });
    var rel = $('#related');
    rel.innerHTML = (r.body.related || []).map(productCard).join('');
    initReveal(root); initReveal(rel);
  }

  // ---------- cart + checkout
  function lineHtml(l) {
    return '<div class="line"><img src="' + esc(l.image) + '" alt=""><div><h3><a href="product.html?slug=' + esc(l.slug) + '">' + esc(l.name) + '</a></h3>' +
      '<div class="sub">' + rupees(l.unitPrice) + ' each' + (l.inStock ? '' : ' &middot; <span style="color:var(--danger)">not enough stock, please lower the quantity</span>') + '</div></div>' +
      '<div class="right"><strong>' + rupees(l.lineTotal) + '</strong><div class="qty" role="group" aria-label="Quantity for ' + esc(l.name) + '"><button type="button" data-dec="' + esc(l.productId) + '" aria-label="One less">&minus;</button><output>' + l.qty + '</output><button type="button" data-inc="' + esc(l.productId) + '" aria-label="One more">+</button></div>' +
      '<button class="linkbtn" type="button" data-rm="' + esc(l.productId) + '">Remove</button></div></div>';
  }
  function totalsHtml(q) {
    return '<dl><dt>Subtotal</dt><dd>' + rupees(q.subtotal) + '</dd>' +
      (q.discount ? '<dt>Discount' + (q.coupon ? ' (' + esc(q.coupon.code) + ')' : '') + '</dt><dd style="color:var(--ok)">-' + rupees(q.discount) + '</dd>' : '') +
      '<dt>Shipping</dt><dd>' + (q.shipping === 0 ? 'Free' : rupees(q.shipping)) + '</dd>' +
      (q.tax ? '<dt>' + esc(q.taxLabel || 'Tax') + '</dt><dd>' + rupees(q.tax) + '</dd>' : '') +
      '<dt class="total">Total</dt><dd class="total">' + rupees(q.total) + '</dd></dl>';
  }
  function couponBox(value, msg, kind) {
    return '<form class="coupon" id="coupon-form" novalidate><label class="sr" for="coupon" style="position:absolute;left:-9999px">Coupon code</label><input class="field" id="coupon" placeholder="Coupon code" value="' + esc(value) + '" autocomplete="off"><button class="btn ghost small" type="submit">Apply</button></form>' +
      '<p class="coupon-msg ' + (kind || '') + '" id="coupon-msg" aria-live="polite">' + esc(msg || '') + '</p>';
  }

  async function renderCart() {
    var root = $('#cart-root');
    var c = getCart();
    if (!c.length) {
      root.innerHTML = '<div class="panel" style="grid-column:1/-1;text-align:center;padding:50px"><h2>Your bag is empty</h2><p class="lead" style="margin:10px auto 24px">The range is all in the shop. Start with the problem you want solved.</p><a class="btn" href="shop.html">Go to the shop</a></div>';
      return;
    }
    var coupon = localStorage.getItem(KEY_COUPON) || '';
    var r = await api('POST', '/quote', { items: c, couponCode: coupon });
    var q = r.body;
    var kept = c.filter(function (x) { return q.lines.some(function (l) { return l.productId === x.productId; }); });
    if (kept.length !== c.length) setCart(kept);
    var msg = q.couponMessage || '';
    var kind = q.coupon ? 'ok' : (coupon ? 'bad' : '');
    root.innerHTML =
      '<div class="panel" id="lines">' + q.lines.map(lineHtml).join('') + '</div>' +
      '<aside class="panel summary" style="position:sticky;top:110px"><h2 style="font-size:1.5rem">Summary</h2>' +
      couponBox(coupon, msg, kind) + '<div style="height:14px"></div>' + totalsHtml(q) +
      '<a class="btn" href="checkout.html" style="width:100%;margin-top:6px"' + (q.lines.some(function (l) { return !l.inStock; }) ? ' aria-disabled="true"' : '') + '>Checkout <span class="arrow" aria-hidden="true">&rarr;</span></a>' +
      '<p class="muted" style="font-size:.85rem;margin:14px 0 0">Free shipping on ' + rupees(CFG.shipping.freeOver) + ' and above. ' + esc(CFG.shipping.note || '') + '</p></aside>';
        $('#coupon-form').addEventListener('submit', async function (e) {
      e.preventDefault();
      var code = $('#coupon').value.trim().toUpperCase();
      if (code) localStorage.setItem(KEY_COUPON, code); else localStorage.removeItem(KEY_COUPON);
      renderCart();
    });
  }
  function onCartClick(e) {
    var t = e.target.closest('button'); if (!t) return;
    var c = getCart();
    var id = t.getAttribute('data-inc') || t.getAttribute('data-dec') || t.getAttribute('data-rm');
    if (!id) return;
    var f = c.find(function (x) { return x.productId === id; }); if (!f) return;
    if (t.hasAttribute('data-inc')) f.qty = Math.min(20, f.qty + 1);
    if (t.hasAttribute('data-dec')) f.qty = Math.max(1, f.qty - 1);
    if (t.hasAttribute('data-rm')) c = c.filter(function (x) { return x.productId !== id; });
    setCart(c); if (page() === 'cart') renderCart();
  }

  function snapshotCheckout() {
    var f = $('#checkout-form'); if (!f) return null;
    var s = { pay: (f.elements.pay && f.elements.pay.value) || 'cod' };
    ['name', 'phone', 'email', 'line1', 'line2', 'city', 'state', 'pincode', 'notes'].forEach(function (k) { s[k] = f.elements[k] ? f.elements[k].value : ''; });
    return s;
  }
  function restoreCheckout(s) {
    var f = $('#checkout-form'); if (!f || !s) return;
    ['name', 'phone', 'email', 'line1', 'line2', 'city', 'state', 'pincode', 'notes'].forEach(function (k) { if (s[k] && f.elements[k]) f.elements[k].value = s[k]; });
    var r = f.querySelector('input[name=pay][value=' + s.pay + ']'); if (r) r.checked = true;
  }
  async function renderCheckout() {
    var root = $('#checkout-root');
    var c = getCart();
    if (!c.length) { location.href = 'cart.html'; return; }
    var me = null;
    if (localStorage.getItem(KEY_TOKEN)) { var m = await api('GET', '/me'); if (m.status === 200) me = m.body.user; }
    if (!me) { authGate(root, 'Sign in or create an account to place your order. Your bag is saved.', function () { renderCheckout(); }); return; }
    var coupon = localStorage.getItem(KEY_COUPON) || '';
    var q = (await api('POST', '/quote', { items: c, couponCode: coupon })).body;
    var addrs = (me && me.addresses) || [];
    var def = addrs.find(function (a) { return a.isDefault; }) || addrs[0] || {};
    var pre = function (k) { return esc(def[k] || ''); };
    root.innerHTML =
      '<form class="panel stack" id="checkout-form" novalidate style="gap:16px">' +
      '<h2 style="font-size:1.5rem">Delivery</h2>' +
      (addrs.length ? '<label class="l">Saved addresses<select class="field" id="saved"><option value="">Enter a new address</option>' + addrs.map(function (a) { return '<option value="' + esc(a.id) + '"' + (a.id === def.id ? ' selected' : '') + '>' + esc(a.label + ': ' + a.line1 + ', ' + a.city) + '</option>'; }).join('') + '</select></label>' : '') +
      '<div class="two"><label class="l">Full name<input class="field" name="name" required autocomplete="name" value="' + pre('name') + (me && !def.name ? esc(me.name) : '') + '"></label>' +
      '<label class="l">Phone<input class="field" name="phone" required autocomplete="tel" inputmode="tel" value="' + pre('phone') + '"></label></div>' +
      '<label class="l">Email (for order updates)<input class="field" type="email" name="email" required autocomplete="email" value="' + esc(me ? me.email : '') + '"></label>' +
      '<label class="l">Address<input class="field" name="line1" required autocomplete="address-line1" value="' + pre('line1') + '"></label>' +
      '<label class="l">Apartment, floor, landmark (optional)<input class="field" name="line2" autocomplete="address-line2" value="' + pre('line2') + '"></label>' +
      '<div class="two"><label class="l">City<input class="field" name="city" required autocomplete="address-level2" value="' + pre('city') + '"></label>' +
      '<label class="l">State<input class="field" name="state" required autocomplete="address-level1" value="' + pre('state') + '"></label></div>' +
      '<label class="l">Pincode<input class="field" name="pincode" required inputmode="numeric" maxlength="6" autocomplete="postal-code" value="' + pre('pincode') + '"></label>' +
      '<label class="l">Note for the courier (optional)<textarea class="field" name="notes" rows="2"></textarea></label>' +
      '<h2 style="font-size:1.5rem;margin-top:8px">Payment</h2>' +
      (CFG.payments.online ? '<label class="pay-opt"><input type="radio" name="pay" value="razorpay" checked><span><b>Pay online</b><small>UPI, cards, net banking and wallets, secured by Razorpay.</small></span></label>' : '') +
      '<label class="pay-opt"><input type="radio" name="pay" value="cod"' + (CFG.payments.online ? '' : ' checked') + '><span><b>Pay on delivery</b><small>Pay the courier in cash or UPI when the order arrives.</small></span></label>' +
      '<div class="err" role="alert" id="checkout-err"></div>' +
      '<button class="btn" type="submit" id="place"' + (q.lines.some(function (l) { return !l.inStock; }) ? ' disabled' : '') + '>Place order &middot; ' + rupees(q.total) + '</button>' +
      '<p class="muted" style="font-size:.85rem;margin:0">By placing the order you agree to our <a href="policy.html?p=terms">terms</a> and <a href="policy.html?p=returns">returns policy</a>.</p>' +
      '</form>' +
      '<aside class="panel summary" style="position:sticky;top:110px"><h2 style="font-size:1.5rem">Your order</h2>' +
      q.lines.map(function (l) { return '<div style="display:flex;gap:12px;align-items:center;margin-bottom:12px"><img src="' + esc(l.image) + '" alt="" style="width:52px;height:52px;border-radius:12px;object-fit:cover;background:var(--blush-2)"><div style="flex:1;font-size:.92rem"><b>' + esc(l.name) + '</b><div class="muted">Qty ' + l.qty + '</div></div><strong>' + rupees(l.lineTotal) + '</strong></div>'; }).join('') +
      '<div class="divider" style="margin:14px 0"></div>' + couponBox(coupon, q.couponMessage, q.coupon ? 'ok' : (coupon ? 'bad' : '')) + '<div style="height:12px"></div>' + totalsHtml(q) + '<p class="muted" style="font-size:.85rem"><a href="cart.html">Edit your bag</a></p></aside>';

    if (addrs.length) $('#saved').addEventListener('change', function () {
      var v = this.value; var a = addrs.find(function (x) { return x.id === v; }) || {};
      ['name', 'phone', 'line1', 'line2', 'city', 'state', 'pincode'].forEach(function (k) { var el = root.querySelector('[name="' + k + '"]'); if (el) el.value = a[k] || ''; });
    });
    $('#coupon-form').addEventListener('submit', async function (e) {
      e.preventDefault(); var code = $('#coupon').value.trim().toUpperCase();
      if (code) localStorage.setItem(KEY_COUPON, code); else localStorage.removeItem(KEY_COUPON);
      var snap = snapshotCheckout();
      await renderCheckout();
      restoreCheckout(snap);
    });
    $('#checkout-form').addEventListener('submit', async function (e) {
      e.preventDefault();
      var f = e.target, err = $('#checkout-err'); err.textContent = '';
      var fd = {}; ['name', 'phone', 'line1', 'line2', 'city', 'state', 'pincode', 'notes', 'email'].forEach(function (k) { fd[k] = (f.elements[k] && f.elements[k].value || '').trim(); });
      var missing = ['name', 'phone', 'line1', 'city', 'state', 'pincode', 'email'].filter(function (k) { return !fd[k]; });
      if (missing.length) { err.textContent = 'Please fill in ' + missing[0] + '.'; f.elements[missing[0]].focus(); return; }
      var btn = $('#place'); btn.disabled = true; btn.textContent = 'Placing your order\u2026';
      var pay = f.elements.pay.value;
      var r = await api('POST', '/orders', { items: getCart(), couponCode: coupon, email: fd.email, paymentMethod: pay, notes: fd.notes,
        address: { name: fd.name, phone: fd.phone, line1: fd.line1, line2: fd.line2, city: fd.city, state: fd.state, pincode: fd.pincode } });
      if (r.status !== 201) {
        err.textContent = r.body.error || 'Could not place the order. Please try again.';
        btn.disabled = false; btn.textContent = 'Place order \u00b7 ' + rupees(q.total);
        return;
      }
      var o = r.body.order;
      if (r.body.razorpay) {
        btn.textContent = 'Waiting for payment\u2026';
        var res;
        try { res = await payOnline(o.id, r.body.razorpay); } catch (ex) { res = { paid: false, message: ex.message }; await api('POST', '/payments/razorpay/cancel', { orderId: o.id }); }
        if (!res.paid) { err.textContent = res.message; btn.disabled = false; btn.textContent = 'Place order \u00b7 ' + rupees(q.total); return; }
      }
      setCart([]); localStorage.removeItem(KEY_COUPON);
      var dest = 'order.html?id=' + encodeURIComponent(o.id) + (r.body.guestToken ? '&key=' + encodeURIComponent(r.body.guestToken) : '&email=' + encodeURIComponent(fd.email)) + '&new=1';
      location.href = dest;
    });
  }

  function payLabel(o) {
    if (o.paymentMethod === 'cod') return 'Pay on delivery (cash or UPI)';
    return { paid: 'Paid online', awaiting_payment: 'Online payment pending', payment_cancelled: 'Online payment not completed', paid_needs_refund: 'Paid online (refund due)' }[o.paymentStatus] || 'Online payment';
  }
  async function renderOrder() {
    var root = $('#order-root'), id = qs('id');
    var params = qs('key') ? '?key=' + encodeURIComponent(qs('key')) : (qs('email') ? '?email=' + encodeURIComponent(qs('email')) : '');
    var r = await api('GET', '/orders/' + encodeURIComponent(id) + params);
    if (r.status !== 200) { root.innerHTML = '<div class="empty">We could not find that order. <a href="dashboard.html">Check My account</a> if you are signed in.</div>'; return; }
    var o = r.body.order, STAGES = ['placed', 'packed', 'shipped', 'delivered'];
    var idx = STAGES.indexOf(o.status);
    var isNew = qs('new') === '1';
    if (isNew) $('#order-title').textContent = 'Order placed';
    root.innerHTML =
      '<div class="panel reveal in">' +
      (isNew ? '<div style="display:flex;gap:14px;align-items:center;margin-bottom:6px"><svg width="46" height="46" viewBox="0 0 46 46" aria-hidden="true"><circle cx="23" cy="23" r="21" fill="#e6eee3" style="transform-origin:center;animation:pop .6s var(--ease) both"/><path d="M14 24 l6 6 l12 -13" fill="none" stroke="#4f6b4f" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="40" stroke-dashoffset="40" style="animation:draw .7s .25s var(--ease) forwards"/></svg><div><h2 style="margin:0;font-size:1.6rem">Thanks, ' + esc(o.customerName.split(' ')[0]) + '. We have your order.</h2><p class="muted" style="margin:0">We will send updates to ' + esc(o.email) + '.</p></div></div>' : '') +
      '<div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:12px;align-items:center;margin-top:14px"><div><span class="eyebrow" style="margin:0">Order number</span><h2 style="margin:4px 0 0">' + esc(o.id) + '</h2></div><span class="status-pill ' + esc(o.status) + '">' + esc(o.status) + '</span></div>' +
      (o.status === 'cancelled' ? '<p class="notice" style="background:#fbe5e3;color:#7a1c16">This order was cancelled. Any stock was returned to the shelf.</p>' :
        '<div class="tracker" aria-label="Order progress">' + STAGES.map(function (s, i) { return '<div class="' + (i <= idx ? 'done' : '') + (i === idx ? ' now' : '') + '">' + s[0].toUpperCase() + s.slice(1) + '</div>'; }).join('') + '</div>') +
      '<div class="divider" style="margin:22px 0"></div>' +
      o.items.map(function (l) { return '<div class="line"><img src="' + esc(l.image) + '" alt=""><div><h3>' + esc(l.name) + '</h3><div class="sub">Qty ' + l.qty + ' &middot; ' + rupees(l.unitPrice) + ' each</div></div><strong>' + rupees(l.lineTotal) + '</strong></div>'; }).join('') +
      '<div class="summary" style="margin-top:18px;max-width:420px;margin-left:auto">' + totalsHtml(o) + '</div>' +
      '<div class="two" style="margin-top:20px"><div class="card" style="padding:20px"><b>Delivering to</b><p style="margin:6px 0 0">' + esc(o.address.name) + '<br>' + esc(o.address.line1) + (o.address.line2 ? ', ' + esc(o.address.line2) : '') + '<br>' + esc(o.address.city) + ', ' + esc(o.address.state) + ' ' + esc(o.address.pincode) + '</p></div>' +
      '<div class="card" style="padding:20px"><b>Payment</b><p style="margin:6px 0 0">' + payLabel(o) + '</p>' + (o.paymentStatus === 'awaiting_payment' && o.status !== 'cancelled' ? '<button class="btn small" type="button" id="paynow" style="margin-top:10px">Pay ' + rupees(o.total) + ' now</button>' : '') + '<p class="muted" style="margin:6px 0 0;font-size:.88rem">Placed ' + new Date(o.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) + '</p></div></div>' +
      '<div style="margin-top:24px;display:flex;gap:12px;flex-wrap:wrap"><a class="btn" href="shop.html">Keep shopping</a>' + (localStorage.getItem(KEY_TOKEN) ? '<a class="btn ghost" href="dashboard.html">My orders</a>' : '') + '</div></div>';
    var pn = $('#paynow');
    if (pn) pn.addEventListener('click', async function () {
      pn.disabled = true;
      var st = await api('POST', '/payments/razorpay/order', { orderId: o.id });
      if (st.status !== 200) { toast(st.body.error || 'Could not start the payment.'); pn.disabled = false; return; }
      var res; try { res = await payOnline(o.id, st.body.razorpay); } catch (ex) { res = { paid: false, message: ex.message }; }
      if (!res.paid) toast(res.message);
      renderOrder();
    });
  }

  // ---------- auth
  function initAuth() {
    var tabs = $$('.auth .tabs button'), lf = $('#login-form'), rf = $('#register-form');
    var next = qs('next') || 'dashboard.html';
    tabs.forEach(function (t) { t.addEventListener('click', function () {
      tabs.forEach(function (x) { x.setAttribute('aria-selected', x === t ? 'true' : 'false'); });
      lf.hidden = t.dataset.tab !== 'login'; rf.hidden = t.dataset.tab !== 'register';
    }); });
    lf.addEventListener('submit', async function (e) {
      e.preventDefault();
      var email = lf.elements.email.value.trim(), pw = lf.elements.password.value;
      var err = $('#login-err'); err.textContent = '';
      if (!email || !pw) { err.textContent = 'Enter your email and password.'; return; }
      var r = await api('POST', '/auth/login', { email: email, password: pw });
      if (r.status !== 200) { err.textContent = r.body.error || 'Could not sign in.'; return; }
      setSession(r.body.token); location.href = next;
    });
    rf.addEventListener('submit', async function (e) {
      e.preventDefault();
      var err = $('#register-err'); err.textContent = '';
      var body = { name: rf.elements.name.value.trim(), email: rf.elements.email.value.trim(), password: rf.elements.password.value };
      var r = await api('POST', '/auth/register', body);
      if (r.status !== 201) { err.textContent = r.body.error || 'Could not create the account.'; return; }
      setSession(r.body.token); location.href = next;
    });
    if (localStorage.getItem(KEY_TOKEN) && qs('mode') !== 'switch') {
      api('GET', '/me').then(function (m) { if (m.status === 200) location.href = next; });
    }
  }

  // ---------- dashboard
  async function renderDashboard() {
    var m = await api('GET', '/me');
    if (m.status !== 200) {
      $('#hello').textContent = 'Your account'; $('#hello-sub').textContent = 'Sign in to see your orders, addresses and wishlist.';
      authGate($('#acct-root'), '', function () { location.reload(); });
      return;
    }
    var me = m.body.user;
    $('#hello').textContent = 'Hi, ' + me.name.split(' ')[0];
    $('#hello-sub').textContent = 'Signed in as ' + me.email;
    var tabs = $$('.acct nav button');
    var panel = $('#acct-panel');
    async function show(name) {
      tabs.forEach(function (t) { t.setAttribute('aria-selected', t.dataset.tab === name ? 'true' : 'false'); });
      panel.innerHTML = '<div class="empty">Loading&hellip;</div>';
      if (name === 'orders') return ordersTab();
      if (name === 'addresses') return addressesTab();
      if (name === 'wishlist') return wishlistTab();
      return profileTab();
    }
    tabs.forEach(function (t) { t.addEventListener('click', function () { show(t.dataset.tab); }); });
    async function ordersTab() {
      var r = await api('GET', '/me/orders'); var list = r.body.orders || [];
      panel.innerHTML = '<div class="tab-panel"><h2 style="font-size:1.6rem">Your orders</h2>' + (list.length ? list.map(function (o) {
        return '<article class="order-card reveal in"><div class="top"><div><b>' + esc(o.id) + '</b> <span class="muted" style="font-size:.88rem">&middot; ' + new Date(o.createdAt).toLocaleDateString('en-IN', { dateStyle: 'medium' }) + '</span></div><span class="status-pill ' + esc(o.status) + '">' + esc(o.status) + '</span></div>' +
          '<div class="thumbs">' + o.items.map(function (l) { return '<img src="' + esc(l.image) + '" alt="" title="' + esc(l.name) + '">'; }).join('') + '</div>' +
          '<div class="top"><span>' + o.items.reduce(function (s, l) { return s + l.qty; }, 0) + ' item(s) &middot; <strong>' + rupees(o.total) + '</strong></span><a class="link-arrow" href="order.html?id=' + esc(o.id) + '">Details <span aria-hidden="true">&rarr;</span></a></div></article>';
      }).join('') : '<div class="empty">No orders yet. <a href="shop.html">Find your first routine</a>.</div>') + '</div>';
    }
    async function addressesTab() {
      var mm = await api('GET', '/me'); var addrs = mm.body.user.addresses || [];
      panel.innerHTML = '<div class="tab-panel"><h2 style="font-size:1.6rem">Addresses</h2><div class="grid g2" style="margin-bottom:26px">' + (addrs.length ? addrs.map(function (a) {
        return '<div class="addr-card reveal in"><div class="top" style="display:flex;justify-content:space-between"><b>' + esc(a.label) + '</b>' + (a.isDefault ? '<span class="pill-soft">Default</span>' : '') + '</div><p style="margin:8px 0">' + esc(a.name) + '<br>' + esc(a.line1) + (a.line2 ? ', ' + esc(a.line2) : '') + '<br>' + esc(a.city) + ', ' + esc(a.state) + ' ' + esc(a.pincode) + '<br>' + esc(a.phone) + '</p><button class="linkbtn" type="button" data-del="' + esc(a.id) + '">Remove</button></div>';
      }).join('') : '<div class="empty" style="grid-column:1/-1">No saved addresses yet.</div>') + '</div>' +
        '<form class="panel stack" id="addr-form" novalidate><h3>Add an address</h3><div class="two"><label class="l">Label<input class="field" name="label" value="Home"></label><label class="l">Full name<input class="field" name="name" required></label></div>' +
        '<div class="two"><label class="l">Phone<input class="field" name="phone" required></label><label class="l">Pincode<input class="field" name="pincode" required maxlength="6"></label></div>' +
        '<label class="l">Address<input class="field" name="line1" required></label><label class="l">Apartment, landmark (optional)<input class="field" name="line2"></label>' +
        '<div class="two"><label class="l">City<input class="field" name="city" required></label><label class="l">State<input class="field" name="state" required></label></div>' +
        '<label class="l" style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="isDefault"> Make this my default</label><div class="err" id="addr-err" role="alert"></div><div><button class="btn small" type="submit">Save address</button></div></form></div>';
      $('#addr-form').addEventListener('submit', async function (e) {
        e.preventDefault(); var f = e.target; var body = {};
        ['label', 'name', 'phone', 'pincode', 'line1', 'line2', 'city', 'state'].forEach(function (k) { body[k] = (f.elements[k].value || '').trim(); });
        body.isDefault = f.elements.isDefault.checked;
        var r = await api('POST', '/me/addresses', body);
        if (r.status !== 201) { $('#addr-err').textContent = r.body.error; return; }
        toast('Address saved'); addressesTab();
      });
      $$('[data-del]', panel).forEach(function (b) { b.addEventListener('click', async function () {
        await api('DELETE', '/me/addresses/' + b.dataset.del); toast('Address removed'); addressesTab();
      }); });
    }
    async function wishlistTab() {
      var r = await api('GET', '/me/wishlist'); var items = r.body.items || [];
      panel.innerHTML = '<div class="tab-panel"><h2 style="font-size:1.6rem">Wishlist</h2>' + (items.length ? '<div class="pgrid">' + items.map(function (p, i) {
        return productCard(p, i) + '';
      }).join('') + '</div>' : '<div class="empty">Nothing saved yet. Tap "Save to wishlist" on any product.</div>') + '</div>';
      $$('.pcard', panel).forEach(function (card, i) {
        var p = items[i]; var b = document.createElement('button'); b.type = 'button'; b.className = 'linkbtn'; b.style.padding = '12px 18px 16px'; b.textContent = 'Remove from wishlist';
        b.addEventListener('click', async function () { await api('DELETE', '/me/wishlist/' + p.id); toast('Removed'); wishlistTab(); });
        card.querySelector('.body').appendChild(b);
      });
      initReveal(panel);
    }
    async function profileTab() {
      var mm = await api('GET', '/me'); var u = mm.body.user;
      panel.innerHTML = '<div class="tab-panel"><h2 style="font-size:1.6rem">Profile</h2><form class="panel stack" id="prof-form" novalidate style="max-width:560px"><label class="l">Name<input class="field" name="name" value="' + esc(u.name) + '" required></label><label class="l">Phone (optional)<input class="field" name="phone" value="' + esc(u.phone) + '"></label><label class="l">Email<input class="field" value="' + esc(u.email) + '" disabled></label><div class="err" id="prof-err" role="alert"></div><div style="display:flex;gap:10px;flex-wrap:wrap"><button class="btn small" type="submit">Save changes</button><button class="btn ghost small" type="button" id="logout">Sign out</button></div><p class="muted" style="font-size:.85rem;margin:0">Signing out clears this device\'s session only.</p></form>' +
        '<form class="panel stack" id="pw-form" novalidate style="max-width:560px;margin-top:22px"><h3>Change password</h3><label class="l">Current password<input class="field" type="password" name="current" autocomplete="current-password" required></label><label class="l">New password (8 or more characters)<input class="field" type="password" name="password" autocomplete="new-password" minlength="8" required></label><div class="err" id="pw-err" role="alert"></div><div><button class="btn small" type="submit">Update password</button></div></form></div>';
      $('#pw-form').addEventListener('submit', async function (e) {
        e.preventDefault(); var f = e.target; $('#pw-err').textContent = '';
        var r = await api('PUT', '/me/password', { current: f.elements.current.value, password: f.elements.password.value });
        if (r.status !== 200) { $('#pw-err').textContent = r.body.error || 'Could not change the password.'; return; }
        f.reset(); toast('Password updated');
      });
      $('#prof-form').addEventListener('submit', async function (e) {
        e.preventDefault(); var r = await api('PUT', '/me', { name: e.target.elements.name.value, phone: e.target.elements.phone.value });
        if (r.status !== 200) { $('#prof-err').textContent = r.body.error; return; }
        $('#hello').textContent = 'Hi, ' + r.body.user.name.split(' ')[0]; toast('Profile saved');
      });
      $('#logout').addEventListener('click', async function () { await api('POST', '/auth/logout'); setSession(''); location.href = 'index.html'; });
    }
    show('orders');
  }

  // ---------- contact + static pages
  function initContact() {
    var f = $('#contact-form'); if (!f) return;
    f.addEventListener('submit', async function (e) {
      e.preventDefault();
      var err = $('#contact-err'); err.textContent = '';
      var body = { name: f.elements.name.value.trim(), email: f.elements.email.value.trim(), message: (f.elements.topic.value + ': ' + f.elements.message.value).trim() };
      if (!body.name || !f.elements.message.value.trim()) { err.textContent = 'Add your name and a message.'; return; }
      var r = await api('POST', '/contact', body);
      if (r.status !== 200) { err.textContent = r.body.error || 'Could not send that. Try again.'; return; }
      f.reset(); toast('Thanks. We have your message and will reply soon.');
    });
  }

  // text on static pages that comes from Admin > Settings
  function fillConfig() {
    var map = { 'ship-flat': rupees(CFG.shipping.flat), 'ship-free': rupees(CFG.shipping.freeOver), 'ship-note': CFG.shipping.note || '', hours: (CFG.store && CFG.store.hours) || '' };
    $$('[data-cfg]').forEach(function (el) { var v = map[el.getAttribute('data-cfg')]; if (v) el.textContent = v; });
  }

  // ---------- boot
  async function boot() {
    initChrome();
    var ready = Promise.resolve();
    window.AnantaApp.ready = ready;
    try { var cfgRes = await api('GET', '/config'); if (cfgRes.status === 200) { CFG.shipping = cfgRes.body.shipping || CFG.shipping; CFG.tax = cfgRes.body.tax || CFG.tax; CFG.store = cfgRes.body.store || CFG.store; CFG.payments = cfgRes.body.payments || CFG.payments; } } catch (e) { /* defaults stay */ }
    fillConfig();
    var p = document.body.dataset.page === 'admin' ? 'admin' : page();
    try {
      if (p === 'index') await renderHome();
      else if (p === 'shop') await renderShop();
      else if (p === 'product') await renderProduct();
      else if (p === 'cart') await renderCart();
      else if (p === 'checkout') await renderCheckout();
      else if (p === 'order') await renderOrder();
      else if (p === 'login') initAuth();
      else if (p === 'dashboard') await renderDashboard();
      else if (p === 'contact') initContact();
      else if (p === 'policy') await renderPolicy();
    } catch (err) {
      console.error(err);
      toast('Something did not load. Refresh and try again.');
    }
    initReveal();
    window.addEventListener('cart-changed', updateCartCount);
  }
  window.AnantaApp = { api: api, toast: toast, getCart: getCart, setCart: setCart, rupees: rupees, ready: null };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
