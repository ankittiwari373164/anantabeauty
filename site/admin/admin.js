/* Ananta Beauty admin. Uses the same API as the storefront (AnantaApp). Admin role required. */
(function () {
  'use strict';
  var A = window.AnantaApp; if (!A) return;
  var api = A.api, toast = A.toast, rupees = A.rupees;
  var root = document.getElementById('admin-root');
  var TAB = 'overview';
  var CATS = { serums: 'Hair serums', sprays: 'Rosemary sprays', shampoos: 'Onion shampoos', combos: 'Combos' };
  var STATUSES = ['placed', 'packed', 'shipped', 'delivered', 'cancelled'];
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function $(s, r) { return (r || root).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || root).querySelectorAll(s)); }
  function fmtDate(s) { return new Date(s).toLocaleDateString('en-IN', { dateStyle: 'medium' }); }
  function fmtDT(s) { return new Date(s).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }); }
  function resize(file, max) {
    return new Promise(function (res, rej) {
      var img = new Image(), url = URL.createObjectURL(file);
      img.onload = function () {
        var s = Math.min(1, max / Math.max(img.width, img.height));
        var c = document.createElement('canvas'); c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
        res(c.toDataURL('image/jpeg', 0.86));
      };
      img.onerror = function () { rej(new Error('Could not read that image.')); };
      img.src = url;
    });
  }

  function loginView(msg) {
    root.innerHTML = '<main class="auth-wrap wrap" style="min-height:100vh"><form class="auth stack" id="a-login" novalidate>' +
      '<span class="eyebrow">Store admin</span><h1 style="font-size:2rem">Sign in</h1>' +
      '<p class="muted" style="margin:0">For store staff only.</p>' +
      '<label class="l">Email<input class="field" type="email" name="email" required autocomplete="username"></label>' +
      '<label class="l">Password<input class="field" type="password" name="password" required autocomplete="current-password"></label>' +
      '<div class="err" id="a-err" role="alert">' + esc(msg || '') + '</div><button class="btn" type="submit">Sign in</button>' +
      '<p class="muted" style="font-size:.85rem;margin:0"><a href="/">Back to the storefront</a></p></form></main>';
    $('#a-login').addEventListener('submit', async function (e) {
      e.preventDefault();
      var r = await api('POST', '/auth/login', { email: e.target.email.value.trim(), password: e.target.password.value });
      if (r.status !== 200) { $('#a-err').textContent = r.body.error || 'Could not sign in.'; return; }
      if (r.body.user.role !== 'admin') { $('#a-err').textContent = 'This account does not have admin access.'; return; }
      localStorage.setItem('ananta.token', r.body.token); go(TAB);
    });
  }

  function shell(active, inner) {
    var items = [['overview', 'Overview'], ['orders', 'Orders'], ['products', 'Products'], ['coupons', 'Coupons'], ['customers', 'Customers'], ['messages', 'Messages'], ['policies', 'Policies'], ['settings', 'Settings']];
    root.innerHTML = '<div class="admin"><aside><a class="brand" href="/" style="margin-bottom:6px"><img src="/img/logo.png" alt="" width="40" height="40" style="background:#fff"><span><b>Ananta</b><small>Admin</small></span></a>' +
      '<nav aria-label="Admin sections">' + items.map(function (i) { return '<button type="button" data-t="' + i[0] + '"' + (i[0] === active ? ' aria-current="true"' : '') + '>' + i[1] + '</button>'; }).join('') + '<button type="button" id="a-out" style="margin-top:14px;opacity:.8">Sign out</button></nav>' +
      '</aside>' +
      '<main id="a-main">' + inner + '</main></div><div class="modal" id="modal" role="dialog" aria-modal="true" aria-labelledby="m-title"><div class="box" id="m-box"></div></div>';
    $$('aside nav button[data-t]').forEach(function (b) { b.addEventListener('click', function () { go(b.dataset.t); }); });
    $('#a-out').addEventListener('click', async function () { await api('POST', '/auth/logout'); localStorage.removeItem('ananta.token'); loginView(); });
    $('#modal').addEventListener('click', function (e) { if (e.target.id === 'modal') closeModal(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });
  }
  function openModal(html) { $('#m-box').innerHTML = html; $('#modal').classList.add('open'); var f = $('#m-box input, #m-box select, #m-box textarea, #m-box button'); if (f) f.focus(); }
  function closeModal() { var m = document.getElementById('modal'); if (m) m.classList.remove('open'); }

  async function go(tab) {
    TAB = tab;
    var me = await api('GET', '/me');
    if (me.status !== 200 || me.body.user.role !== 'admin') { loginView(me.status === 403 ? 'This account does not have admin access.' : ''); return; }
    if (tab === 'overview') return overview();
    if (tab === 'orders') return orders();
    if (tab === 'products') return products();
    if (tab === 'coupons') return coupons();
    if (tab === 'customers') return customers();
    if (tab === 'messages') return messages();
    if (tab === 'settings') return settings();
    if (tab === 'policies') return policies();
  }

  function payLabel(o) {
    if (o.paymentMethod === 'cod') return 'Pay on delivery';
    var t = { paid: 'Paid online', awaiting_payment: 'Awaiting payment', payment_cancelled: 'Payment not completed', paid_needs_refund: '<b style="color:var(--danger)">Paid, but order cancelled: refund in Razorpay</b>' }[o.paymentStatus] || 'Online';
    return t + (o.paymentId ? ' <span class="muted" style="font-size:.8rem">' + esc(o.paymentId) + '</span>' : '');
  }
  function statusPill(s) { return '<span class="status-pill ' + esc(s) + '">' + esc(s) + '</span>'; }

  async function overview() {
    var r = await api('GET', '/admin/summary'); var s = r.body;
    var max = Math.max.apply(null, [1].concat(s.revenueByDay.map(function (d) { return d.revenue; })));
    var bars = s.revenueByDay.map(function (d) {
      var h = Math.max(4, Math.round(d.revenue / max * 150));
      return '<div style="height:' + h + 'px" title="' + esc(d.day) + ': ' + rupees(d.revenue) + '"><span>' + (d.revenue ? rupees(d.revenue) : '') + '</span><em>' + d.day.slice(5) + '</em></div>';
    }).join('');
    shell('overview', '<h1>Overview</h1><p class="muted" style="margin:0">Live numbers from the store database.</p>' +
      '<div class="kpis"><div class="kpi"><span>Revenue (not cancelled)</span><b>' + rupees(s.revenue) + '</b></div><div class="kpi"><span>Orders</span><b>' + s.orderCount + '</b></div><div class="kpi"><span>Average order</span><b>' + rupees(s.averageOrder) + '</b></div><div class="kpi"><span>Customers</span><b>' + s.customerCount + '</b></div></div>' +
      '<div class="a-grid"><section class="table-wrap" style="padding:20px"><h3>Last 7 days</h3><div class="bars" style="margin-top:26px">' + bars + '</div></section>' +
      '<section class="table-wrap" style="padding:20px"><h3>Order stages</h3>' + STATUSES.map(function (st) { return '<div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #f0e6eb">' + statusPill(st) + '<b>' + (s.byStatus[st] || 0) + '</b></div>'; }).join('') +
      '<h3 style="margin-top:22px">Low stock (5 or fewer)</h3>' + (s.lowStock.length ? s.lowStock.map(function (p) { return '<div style="display:flex;justify-content:space-between;padding:8px 0;font-size:.92rem"><span>' + esc(p.name) + '</span><b style="color:var(--danger)">' + p.stock + '</b></div>'; }).join('') : '<p class="muted">Nothing low right now.</p>') + '</section></div>' +
      '<h3 style="margin:26px 0 10px">Recent orders</h3>' + ordersTable(s.recentOrders, false));
    bindOrderSelects();
  }

  function ordersTable(list, full) {
    if (!list.length) return '<div class="empty">No orders yet. Place a test order from the storefront to see it here.</div>';
    return '<div class="table-wrap"><table class="t"><thead><tr><th>Order</th><th>Date</th><th>Customer</th><th>Items</th><th>Total</th><th>Payment</th><th>Status</th><th></th></tr></thead><tbody>' +
      list.map(function (o) {
        return '<tr><td><b>' + esc(o.id) + '</b></td><td>' + fmtDate(o.createdAt) + '</td><td>' + esc(o.customerName) + '<div class="muted" style="font-size:.8rem">' + esc(o.email) + '</div></td><td>' + o.items.reduce(function (s, l) { return s + l.qty; }, 0) + '</td><td><b>' + rupees(o.total) + '</b></td><td style="font-size:.85rem">' + payLabel(o) + '</td>' +
          '<td><select class="status-sel" data-status="' + esc(o.id) + '" aria-label="Status for ' + esc(o.id) + '">' + STATUSES.map(function (st) { return '<option value="' + st + '"' + (st === o.status ? ' selected' : '') + '>' + st + '</option>'; }).join('') + '</select></td>' +
          '<td><button class="linkbtn" type="button" data-view="' + esc(o.id) + '">View</button></td></tr>';
      }).join('') + '</tbody></table></div>';
  }
  var ORDERS_CACHE = [];
  function bindOrderSelects() {
    $$('select[data-status]').forEach(function (sel) {
      sel.addEventListener('change', async function () {
        var r = await api('PUT', '/admin/orders/' + sel.dataset.status + '/status', { status: sel.value });
        if (r.status !== 200) { toast(r.body.error || 'Could not change the status'); sel.value = sel.dataset.prev || sel.value; return; }
        toast(r.body.order.id + ' is now ' + r.body.order.status + '. The customer will see it in their account.');
      });
      sel.dataset.prev = sel.value;
    });
    $$('[data-view]').forEach(function (b) { b.addEventListener('click', function () { viewOrder(b.dataset.view); }); });
  }
  async function viewOrder(id) {
    var r = await api('GET', '/admin/orders'); var o = (r.body.orders || []).find(function (x) { return x.id === id; });
    if (!o) return;
    openModal('<h2 id="m-title" style="font-size:1.6rem">' + esc(o.id) + ' ' + statusPill(o.status) + '</h2>' +
      '<p class="muted">' + fmtDT(o.createdAt) + ' &middot; ' + payLabel(o) + '</p>' +
      '<div class="two"><div class="card" style="padding:16px"><b>Deliver to</b><p style="margin:6px 0 0">' + esc(o.address.name) + '<br>' + esc(o.address.line1) + (o.address.line2 ? ', ' + esc(o.address.line2) : '') + '<br>' + esc(o.address.city) + ', ' + esc(o.address.state) + ' ' + esc(o.address.pincode) + '<br>' + esc(o.address.phone) + '<br>' + esc(o.email) + '</p></div>' +
      '<div class="card" style="padding:16px"><b>Totals</b><p style="margin:6px 0 0">Subtotal ' + rupees(o.subtotal) + '<br>Discount ' + (o.discount ? '-' + rupees(o.discount) : 'none') + (o.coupon ? ' (' + esc(o.coupon.code) + ')' : '') + '<br>Shipping ' + (o.shipping ? rupees(o.shipping) : 'free') + '<br><b>Total ' + rupees(o.total) + '</b></p></div></div>' +
      '<h3 style="margin-top:18px">Items</h3>' + o.items.map(function (l) { return '<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #f0e6eb"><span>' + esc(l.name) + ' &times; ' + l.qty + '</span><b>' + rupees(l.lineTotal) + '</b></div>'; }).join('') +
      (o.notes ? '<p style="margin-top:14px"><b>Note:</b> ' + esc(o.notes) + '</p>' : '') +
      '<h3 style="margin-top:18px">History</h3>' + o.statusHistory.map(function (h) { return '<div class="muted" style="font-size:.9rem">' + fmtDT(h.at) + ' &middot; ' + esc(h.status) + '</div>'; }).join('') +
      '<div style="margin-top:20px"><button class="btn ghost small" type="button" onclick="document.getElementById(\'modal\').classList.remove(\'open\')">Close</button></div>');
  }

  async function orders() {
    var filter = (window.__ordersFilter || 'all');
    var r = await api('GET', '/admin/orders?status=' + filter);
    var list = r.body.orders || [];
    shell('orders', '<div class="a-bar"><div><h1>Orders</h1><p class="muted" style="margin:0">Change a status and the customer sees it the next time they open their account.</p></div>' +
      '<label class="l" style="min-width:180px">Show<select class="field" id="f-status"><option value="all">All orders</option>' + STATUSES.map(function (s) { return '<option value="' + s + '"' + (s === filter ? ' selected' : '') + '>' + s + '</option>'; }).join('') + '</select></label></div>' + ordersTable(list, true));
    $('#f-status').addEventListener('change', function (e) { window.__ordersFilter = e.target.value; orders(); });
    bindOrderSelects();
  }

  async function products() {
    var r = await api('GET', '/admin/products'); var list = r.body.products || [];
    shell('products', '<div class="a-bar"><div><h1>Products</h1><p class="muted" style="margin:0">Add, edit and hide products. Keep stock numbers up to date: an item sells out automatically at 0.</p></div><button class="btn small" type="button" id="new-p">Add a product</button></div>' +
      '<div class="table-wrap"><table class="t"><thead><tr><th>Photo</th><th>Name</th><th>Category</th><th>Price</th><th>Stock</th><th>Live</th><th></th></tr></thead><tbody>' +
      list.map(function (p) {
        return '<tr><td>' + (p.images[0] ? '<img src="' + esc(p.images[0]) + '" alt="">' : '') + '</td><td><b>' + esc(p.name) + '</b><div class="muted" style="font-size:.8rem">' + esc(p.slug) + '</div></td><td>' + esc(CATS[p.category] || p.category) + '</td><td>' + rupees(p.price) + '</td>' +
          '<td><input class="field" style="width:90px;padding:8px 12px" type="number" min="0" value="' + p.stock + '" data-stock="' + esc(p.id) + '" aria-label="Stock for ' + esc(p.name) + '"></td>' +
          '<td>' + (p.active ? '<span class="pill-soft">Live</span>' : '<span class="muted">Hidden</span>') + '</td>' +
          '<td style="white-space:nowrap"><button class="linkbtn" type="button" data-edit="' + esc(p.id) + '">Edit</button> &nbsp; <button class="linkbtn" type="button" data-del-p="' + esc(p.id) + '" style="color:var(--danger)">Delete</button></td></tr>';
      }).join('') + '</tbody></table></div>');
    $$('[data-stock]').forEach(function (inp) { inp.addEventListener('change', async function () {
      var p = list.find(function (x) { return x.id === inp.dataset.stock; });
      var body = Object.assign({}, p, { stock: parseInt(inp.value, 10) || 0 });
      var rr = await api('PUT', '/admin/products/' + p.id, body);
      toast(rr.status === 200 ? 'Stock updated. The shop shows it now.' : (rr.body.error || 'Could not update stock'));
    }); });
    $$('[data-edit]').forEach(function (b) { b.addEventListener('click', function () { productForm(list.find(function (x) { return x.id === b.dataset.edit; })); }); });
    $$('[data-del-p]').forEach(function (b) { b.addEventListener('click', async function () {
      if (!confirm('Delete this product from the store?')) return;
      await api('DELETE', '/admin/products/' + b.dataset.delP); toast('Product deleted'); products();
    }); });
    $('#new-p').addEventListener('click', function () { productForm(null); });
  }

  function productForm(p) {
    p = p || { name: '', slug: '', category: 'serums', price: '', compareAt: '', stock: 10, shortDesc: '', description: '', images: [], active: true, featured: false };
    var imgs = p.images.slice();
    function paint() {
      $('#imgs').innerHTML = imgs.map(function (s, i) { return '<div><img src="' + esc(s) + '" alt=""><button type="button" data-rmimg="' + i + '" aria-label="Remove photo">&times;</button></div>'; }).join('') || '<span class="muted">No photos yet.</span>';
      $$('[data-rmimg]').forEach(function (b) { b.addEventListener('click', function () { imgs.splice(+b.dataset.rmimg, 1); paint(); }); });
    }
    openModal('<h2 id="m-title" style="font-size:1.6rem">' + (p.id ? 'Edit product' : 'New product') + '</h2>' +
      '<form class="stack" id="pf" novalidate style="gap:12px;margin-top:14px">' +
      '<div class="two"><label class="l">Name<input class="field" name="name" required value="' + esc(p.name) + '"></label><label class="l">Category<select class="field" name="category">' + Object.keys(CATS).map(function (k) { return '<option value="' + k + '"' + (k === p.category ? ' selected' : '') + '>' + CATS[k] + '</option>'; }).join('') + '</select></label></div>' +
      '<div class="two"><label class="l">Price (₹)<input class="field" name="price" type="number" min="0" step="0.01" required value="' + esc(p.price) + '"></label><label class="l">Was price (optional)<input class="field" name="compareAt" type="number" min="0" step="0.01" value="' + esc(p.compareAt || '') + '"></label></div>' +
      '<div class="two"><label class="l">Stock<input class="field" name="stock" type="number" min="0" required value="' + esc(p.stock) + '"></label><label class="l">Short line (shop card)<input class="field" name="shortDesc" maxlength="240" value="' + esc(p.shortDesc) + '"></label></div>' +
      '<label class="l">Description<textarea class="field" name="description" rows="5">' + esc(p.description) + '</textarea></label>' +
      '<div><span class="l" style="display:block;margin-bottom:6px">Photos (resized in your browser)</span><div class="imgs" id="imgs"></div><input type="file" id="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple style="margin-top:10px"><p class="muted" id="upmsg" style="font-size:.85rem;margin:6px 0 0" aria-live="polite"></p></div>' +
      '<div class="two"><label class="l" style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="active"' + (p.active ? ' checked' : '') + '> Show in the shop</label><label class="l" style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="featured"' + (p.featured ? ' checked' : '') + '> Show on the home page</label></div>' +
      '<div class="err" id="pf-err" role="alert"></div><div style="display:flex;gap:10px;flex-wrap:wrap"><button class="btn small" type="submit">Save product</button><button class="btn ghost small" type="button" onclick="document.getElementById(\'modal\').classList.remove(\'open\')">Cancel</button></div></form>');
    paint();
    $('#file').addEventListener('change', async function (e) {
      var files = Array.prototype.slice.call(e.target.files || []).slice(0, 6 - imgs.length);
      for (var i = 0; i < files.length; i++) {
        $('#upmsg').textContent = 'Uploading ' + (i + 1) + ' of ' + files.length + '\u2026';
        try {
          var du = await resize(files[i], 1400);
          var r = await api('POST', '/admin/upload', { dataUrl: du, name: files[i].name });
          if (r.status !== 201) { $('#upmsg').textContent = r.body.error; break; }
          imgs.push(r.body.url); paint();
        } catch (err) { $('#upmsg').textContent = err.message; break; }
      }
      $('#upmsg').textContent = files.length ? 'Photos added. Save the product to keep them.' : '';
      e.target.value = '';
    });
    $('#pf').addEventListener('submit', async function (e) {
      e.preventDefault(); var f = e.target, err = $('#pf-err'); err.textContent = '';
      var body = { name: f.name.value.trim(), category: f.category.value, price: f.price.value, compareAt: f.compareAt.value || null, stock: f.stock.value, shortDesc: f.shortDesc.value.trim(), description: f.description.value.trim(), active: f.active.checked, featured: f.featured.checked, images: imgs };
      var r = p.id ? await api('PUT', '/admin/products/' + p.id, body) : await api('POST', '/admin/products', body);
      if (r.status !== 200 && r.status !== 201) { err.textContent = r.body.error || 'Could not save.'; return; }
      closeModal(); toast('Product saved. The storefront is updated.'); products();
    });
  }

  async function coupons() {
    var r = await api('GET', '/admin/coupons'); var list = r.body.coupons || [];
    shell('coupons', '<h1>Coupons</h1><p class="muted">Percent or flat, with a minimum order, expiry and usage limit. Codes are checked at checkout and counted when an order is placed.</p>' +
      '<div class="a-grid"><div class="table-wrap"><table class="t"><thead><tr><th>Code</th><th>Offer</th><th>Min order</th><th>Expires</th><th>Used</th><th>Active</th><th></th></tr></thead><tbody>' +
      (list.length ? list.map(function (c) {
        return '<tr><td><b>' + esc(c.code) + '</b></td><td>' + (c.type === 'percent' ? c.value + '%' : rupees(c.value) + ' off') + '</td><td>' + (c.minOrder ? rupees(c.minOrder) : '\u2014') + '</td><td>' + esc(c.expiresAt || 'never') + '</td><td>' + c.used + (c.usageLimit ? ' / ' + c.usageLimit : '') + '</td>' +
          '<td><input type="checkbox" data-cact="' + esc(c.code) + '"' + (c.active ? ' checked' : '') + ' aria-label="Active ' + esc(c.code) + '"></td><td><button class="linkbtn" type="button" data-cdel="' + esc(c.code) + '" style="color:var(--danger)">Delete</button></td></tr>';
      }).join('') : '<tr><td colspan="7"><div class="empty">No coupons yet.</div></td></tr>') +
      '</tbody></table></div>' +
      '<form class="panel stack" id="cf" novalidate><h3>New coupon</h3><label class="l">Code<input class="field" name="code" required placeholder="SPRING15"></label>' +
      '<div class="two"><label class="l">Type<select class="field" name="type"><option value="percent">Percent off</option><option value="flat">Flat amount off</option></select></label><label class="l">Value<input class="field" name="value" type="number" min="1" step="1" required></label></div>' +
      '<div class="two"><label class="l">Min order (₹)<input class="field" name="minOrder" type="number" min="0" value="0"></label><label class="l">Usage limit (0 = no limit)<input class="field" name="usageLimit" type="number" min="0" value="0"></label></div>' +
      '<label class="l">Expires on<input class="field" name="expiresAt" type="date"></label><div class="err" id="cf-err" role="alert"></div><button class="btn small" type="submit">Create coupon</button></form></div>');
    $$('[data-cact]').forEach(function (cb) { cb.addEventListener('change', async function () {
      var c = list.find(function (x) { return x.code === cb.dataset.cact; });
      await api('PUT', '/admin/coupons/' + c.code, Object.assign({}, c, { active: cb.checked })); toast(c.code + (cb.checked ? ' is on' : ' is off'));
    }); });
    $$('[data-cdel]').forEach(function (b) { b.addEventListener('click', async function () {
      if (!confirm('Delete ' + b.dataset.cdel + '?')) return; await api('DELETE', '/admin/coupons/' + b.dataset.cdel); coupons();
    }); });
    $('#cf').addEventListener('submit', async function (e) {
      e.preventDefault(); var f = e.target, err = $('#cf-err'); err.textContent = '';
      var rr = await api('POST', '/admin/coupons', { code: f.code.value, type: f.type.value, value: f.value.value, minOrder: f.minOrder.value, usageLimit: f.usageLimit.value, expiresAt: f.expiresAt.value || null, active: true });
      if (rr.status !== 201) { err.textContent = rr.body.error || 'Could not create it.'; return; }
      toast('Coupon ' + rr.body.coupon.code + ' created'); coupons();
    });
  }

  async function customers() {
    var r = await api('GET', '/admin/customers'); var list = r.body.customers || [];
    shell('customers', '<h1>Customers</h1><p class="muted">People who created an account, with their order count and spend (not cancelled).</p>' +
      '<div class="table-wrap"><table class="t"><thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Joined</th><th>Orders</th><th>Spend</th></tr></thead><tbody>' +
      (list.length ? list.map(function (c) { return '<tr><td><b>' + esc(c.name) + '</b></td><td>' + esc(c.email) + '</td><td>' + esc(c.phone || '\u2014') + '</td><td>' + fmtDate(c.createdAt) + '</td><td>' + c.orders + '</td><td>' + rupees(c.spend) + '</td></tr>'; }).join('') : '<tr><td colspan="6"><div class="empty">No customers yet.</div></td></tr>') +
      '</tbody></table></div>');
  }

  async function messages() {
    var r = await api('GET', '/admin/messages'); var list = r.body.messages || []; var subs = r.body.subscribers || [];
    shell('messages', '<h1>Messages</h1><p class="muted">Messages sent through the contact form. Reply to the customer by email or phone.</p>' +
      (list.length ? list.map(function (m) { return '<article class="card" style="margin-bottom:14px;padding:20px"><div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px"><b>' + esc(m.name) + '</b><span class="muted" style="font-size:.85rem">' + fmtDT(m.createdAt) + '</span></div><p class="muted" style="margin:4px 0">' + esc(m.email || 'no email given') + '</p><p style="margin:10px 0 0;white-space:pre-line">' + esc(m.message) + '</p></article>'; }).join('') : '<div class="empty">No messages yet.</div>') +
      '<h2 style="margin-top:34px;font-size:1.5rem">Newsletter subscribers (' + subs.length + ')</h2>' +
      (subs.length ? '<div class="buy-row" style="margin:8px 0 14px"><button class="btn ghost small" type="button" id="copy-subs">Copy all emails</button></div><div class="table-wrap"><table class="t"><thead><tr><th>Email</th><th>Joined</th></tr></thead><tbody>' +
        subs.map(function (x) { return '<tr><td>' + esc(x.email) + '</td><td>' + fmtDate(x.createdAt) + '</td></tr>'; }).join('') + '</tbody></table></div>' : '<div class="empty">No subscribers yet.</div>'));
    var cb = document.getElementById('copy-subs');
    if (cb) cb.addEventListener('click', function () {
      var text = subs.map(function (x) { return x.email; }).join(', ');
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(function () { toast('Emails copied'); }, function () { toast('Could not copy'); });
    });
  }


  // ---------- settings: store details, shipping and tax
  async function settings() {
    var r = await api('GET', '/admin/settings'); var s = (r.body && r.body.settings) || null;
    if (!s) { shell('settings', '<h1>Settings</h1><p class="muted">Could not load the settings. Refresh and try again.</p>'); return; }
    var st = s.store || {}, sh = s.shipping || {}, tx = s.tax || {};
    shell('settings', '<div class="a-bar"><div><h1>Settings</h1><p class="muted" style="margin:0">Store details, shipping and tax. Changes show on the storefront straight away.</p></div></div>' +
      '<form id="sf" class="card" style="padding:22px;margin-bottom:18px">' +
      '<h3>Store details</h3><div class="two">' +
      '<label class="l">Store name<input class="field" name="storename" value="' + esc(st.name) + '" required></label>' +
      '<label class="l">Tagline<input class="field" name="tagline" value="' + esc(st.tagline) + '"></label>' +
      '<label class="l">Contact email<input class="field" name="email" type="email" value="' + esc(st.email) + '"></label>' +
      '<label class="l">Contact phone<input class="field" name="phone" value="' + esc(st.phone) + '"></label>' +
      '<label class="l" style="grid-column:1/-1">Registered address<input class="field" name="address" value="' + esc(st.address) + '"></label>' +
      '<label class="l">GSTIN<input class="field" name="gstin" value="' + esc(st.gstin) + '" placeholder="Not set"></label>' +
      '<label class="l">Support hours (shown on the contact page)<input class="field" name="hours" value="' + esc(st.hours) + '"></label></div>' +
      '<h3 style="margin-top:22px">Shipping</h3><div class="two">' +
      '<label class="l">Flat shipping (&#8377;)<input class="field" name="flat" type="number" min="0" step="1" value="' + esc(sh.flat) + '"></label>' +
      '<label class="l">Free shipping from (&#8377;)<input class="field" name="freeOver" type="number" min="0" step="1" value="' + esc(sh.freeOver) + '"></label>' +
      '<label class="l" style="grid-column:1/-1">Shipping note shown to customers<input class="field" name="shipnote" value="' + esc(sh.note) + '"></label></div>' +
      '<h3 style="margin-top:22px">Tax</h3><div class="two">' +
      '<label class="l">Tax rate (%)<input class="field" name="rate" type="number" min="0" max="100" step="0.01" value="' + esc(tx.rate) + '"></label>' +
      '<label class="l">Label shown at checkout<input class="field" name="label" value="' + esc(tx.label) + '"></label></div>' +
      '<p class="muted" style="font-size:.85rem">Leave the rate at 0 if your prices already include tax.</p>' +
      '<div class="buy-row" style="margin-top:18px"><button class="btn" type="submit">Save settings</button></div>' +
      '<p class="muted" id="sf-msg" role="status" style="margin-top:12px"></p></form>');
    function fail(msg) { $('#sf-msg').textContent = msg; $('#sf-msg').style.color = 'var(--danger)'; }
    $('#sf').addEventListener('submit', async function (e) {
      e.preventDefault();
      var f = e.target;
      var body = {
        store: { name: f.storename.value, tagline: f.tagline.value, email: f.email.value, phone: f.phone.value, address: f.address.value, gstin: f.gstin.value, hours: f.hours.value },
        shipping: { flat: f.flat.value, freeOver: f.freeOver.value, note: f.shipnote.value },
        tax: { rate: f.rate.value, label: f.label.value }
      };
      var out = await api('PUT', '/admin/settings', body);
      if (out.status !== 200) return fail(out.body.error || 'Could not save. Check the fields and try again.');
      toast('Settings saved');
      settings();
    });
  }

  // ---------- policies: editable text for Privacy, Terms, Returns, Shipping, Refund
  async function policies() {
    var r = await api('GET', '/admin/policies'); var list = r.body.policies || [];
    shell('policies', '<div class="a-bar"><div><h1>Policy pages</h1><p class="muted" style="margin:0">The storefront shows this text on each policy page. Write each policy here. A policy with no text shows a short "contact us" note instead.</p></div></div>' +
      list.map(function (p) {
        return '<details class="card" style="padding:18px 22px;margin-bottom:12px"' + '' + '><summary style="cursor:pointer;font-weight:700;display:flex;justify-content:space-between;gap:12px;align-items:center"><span>' + esc(p.title) + '</span>' + statusPill(String(p.body || '').trim() ? 'published' : 'empty') + '</summary>' +
          '<form class="pf" data-slug="' + esc(p.slug) + '" style="margin-top:14px"><label class="l">Text (blank lines start a new paragraph)<textarea class="field" name="body" rows="12" style="font-family:inherit">' + esc(p.body) + '</textarea></label>' +
          '<div class="buy-row" style="margin-top:12px"><button class="btn small" type="submit">Save ' + esc(p.title.toLowerCase()) + '</button><a class="linkbtn" href="/policy?p=' + esc(p.slug) + '" target="_blank" rel="noopener">View page</a>' + (p.updatedAt ? '<span class="muted" style="font-size:.85rem">Saved ' + fmtDT(p.updatedAt) + '</span>' : '') + '</div></form></details>';
      }).join(''));
    $$('form.pf').forEach(function (f) {
      f.addEventListener('submit', async function (e) {
        e.preventDefault();
        var out = await api('PUT', '/admin/policies/' + f.dataset.slug, { body: f.body.value });
        if (out.status === 200) { toast('Saved. The page shows the new text.'); policies(); }
        else toast(out.body.error || 'Could not save that policy.');
      });
    });
  }

  // boot once the storefront script has set up the API (AnantaApp.ready)
  document.addEventListener('DOMContentLoaded', function () {
    Promise.resolve(A.ready).then(function () { go('overview'); });
  });
})();