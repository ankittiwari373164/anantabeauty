# Ananta Beauty store

A live e-commerce store: storefront, customer accounts, checkout with Razorpay or cash on delivery and an admin
panel. It runs on **Vercel** (website + API) with all data in **Supabase** (Postgres database +
photo storage).

```
site/                 everything Vercel deploys (set Vercel "Root Directory" to site)
  *.html, css, js     the storefront
  admin/              the admin panel  (yourdomain/admin)
  api/main.js         the store API: products, cart prices, orders, accounts, admin
  api/keepalive.js    daily ping that keeps the free Supabase project awake
  api/razorpay-webhook.js   Razorpay payment confirmations
  api/_lib/store.js   all store rules (prices, coupons, stock, tax, shipping)
  vercel.json         routes + the daily cron job
supabase/schema.sql         database tables, security and functions (run once)
supabase/seed-products.sql  the 10 starting products (run once)
supabase/migration-002-razorpay.sql  only for databases set up before v4
.github/workflows/keepalive.yml   backup keep-alive (every 2 days)
```

## 1. Supabase (database)

1. Go to supabase.com → **New project**. Choose region **Mumbai (ap-south-1)**. Save the database password somewhere safe.
2. Open **SQL Editor → New query**, paste the whole of `supabase/schema.sql`, click **Run**.
3. New query again: paste `supabase/seed-products.sql`, click **Run**.
4. Create your admin login (new query, use your own email and a strong password, 10+ characters):
   ```sql
   select app_create_admin('you@yourdomain.in', 'Your-Strong-Password', 'Your name');
   ```
   Run the same line again any time to reset the admin password.
5. Open **Project Settings → API Keys** (or **Settings → API**) and copy:
   - **Project URL** (looks like `https://abcd1234.supabase.co`)
   - the **secret key** (`sb_secret_...`) — or on older projects the **service_role** key.
   Never put this key in the website code or share it. It only goes into Vercel.

## 2. Vercel (website)

1. Upload this whole folder to your GitHub repo (replace the old files).
2. Vercel → your project → **Settings → Environment Variables**, add:
   | Name | Value |
   |---|---|
   | `SUPABASE_URL` | your Project URL |
   | `SUPABASE_SECRET_KEY` | your secret / service_role key |
   | `CRON_SECRET` | any long random text (protects the keep-alive link) |
   | `RAZORPAY_KEY_ID` | from Razorpay (see section 5) |
   | `RAZORPAY_KEY_SECRET` | from Razorpay (see section 5) |
3. **Settings → Build and Deployment**: Framework Preset **Other**, Root Directory **site**.
4. **Deployments → ⋯ → Redeploy**.
5. Check: open `https://your-site/api/health` — it should show `{"ok":true,"products":10}`.

## 3. Keeping Supabase awake (free plan pauses after 7 days idle)

- **Main:** Vercel Cron calls `/api/keepalive` every day at 03:17 UTC (`vercel.json`). It writes a
  row to the `heartbeat` table. Check it in Vercel → project → **Settings → Cron Jobs**, or in
  Supabase → Table Editor → `heartbeat` (`pinged_at` should be within the last day).
- **Backup:** the GitHub Action in `.github/workflows/keepalive.yml` pings every 2 days. Add
  repo secrets `SUPABASE_URL` and `SUPABASE_SECRET_KEY` (GitHub → repo → Settings → Secrets and
  variables → Actions). Run it once by hand from the **Actions** tab to check it is green.
  GitHub pauses scheduled actions in repos with no commits for 60 days, which is why Vercel Cron is the main one.

## 5. Razorpay (online payments)

1. Razorpay Dashboard → **Account & Settings → API Keys → Generate Key**. Start in **Test mode**.
2. Put the Key ID and Key Secret into Vercel as `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`, then redeploy.
   "Pay online" appears at checkout automatically. Remove the two variables to switch it off.
3. Webhook (makes sure an order is marked paid even if the customer closes the tab right after paying):
   Razorpay → **Settings → Webhooks → Add New Webhook**
   - URL: `https://YOUR-SITE/api/razorpay-webhook`
   - Events: `payment.captured`, `payment.authorized`, `order.paid`
   - Secret: anything (the store double-checks every webhook with Razorpay's API instead).
4. Test with Razorpay's test UPI/cards. When it works, generate **Live mode** keys, swap them into Vercel, redeploy.
5. If you already ran an older `schema.sql`, run `supabase/migration-002-razorpay.sql` once in the SQL Editor.

How it works: the order is saved as "Awaiting payment" and its stock is held. Paid → "Paid online"
(payments left "authorized" are captured automatically). Customer closes the payment window → the
order is cancelled and the stock and coupon are released. Orders left unpaid for 2+ hours are closed
by the daily cron. Refunds are done in the Razorpay dashboard; an order shown as "Paid, but order
cancelled" needs one.

## 4. First things to do in the admin (yourdomain/admin)

- **Products:** set real stock numbers (they start at 40 each), edit prices, upload photos.
- **Settings:** shipping rate, free-shipping amount, GST rate (0 if prices include GST), GSTIN, support hours.
- **Policies:** write Privacy, Terms, Returns, Shipping and Refund text.
- **Coupons:** create your own codes (there are none to start with).

## How it is secured

- Every table has Row Level Security on with no public access; only the API (with the secret key) can read or write.
- Passwords are hashed with bcrypt inside Postgres. Sign-in tokens are stored as SHA-256 hashes and expire after 30 days.
- Prices, discounts, tax and shipping are always recalculated on the server. Stock and coupon use are
  updated in one database transaction, so two customers cannot buy the last item twice.

## Not included yet

- Order emails/SMS: new orders show in Admin → Orders; customers see status on their order page.
