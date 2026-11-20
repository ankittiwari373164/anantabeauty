-- Ananta Beauty store: Supabase database schema.
-- Run this whole file once in Supabase: Dashboard > SQL Editor > New query > paste > Run.
-- It is safe to run again: it only creates what is missing.
--
-- Security model: every table has Row Level Security ON with no public policies, so the
-- public (anon) key cannot read or write anything. Only the store's API on Vercel, which holds
-- the secret key, talks to the database. Passwords are hashed with bcrypt inside Postgres.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- ---------- tables
create table if not exists public.settings (
  id          int primary key default 1 check (id = 1),
  store       jsonb not null default '{}'::jsonb,
  shipping    jsonb not null default '{"flat":49,"freeOver":499,"note":""}'::jsonb,
  tax         jsonb not null default '{"rate":0,"label":"GST","note":""}'::jsonb,
  updated_at  timestamptz not null default now()
);

create table if not exists public.policies (
  slug        text primary key,
  title       text not null,
  body        text not null default '',
  status      text not null default 'draft' check (status in ('draft','final')),
  updated_at  timestamptz
);

create table if not exists public.products (
  id          text primary key default ('p' || substr(md5(random()::text || clock_timestamp()::text), 1, 10)),
  slug        text not null unique,
  name        text not null,
  category    text not null check (category in ('serums','sprays','shampoos','combos')),
  price       numeric(10,2) not null check (price >= 0),
  compare_at  numeric(10,2),
  short_desc  text not null default '',
  description text not null default '',
  images      jsonb not null default '[]'::jsonb,
  stock       int not null default 0 check (stock >= 0),
  active      boolean not null default true,
  featured    boolean not null default false,
  source_url  text,
  created_at  timestamptz not null default now()
);

create table if not exists public.coupons (
  code        text primary key,
  type        text not null check (type in ('percent','flat')),
  value       numeric(10,2) not null check (value > 0),
  min_order   numeric(10,2) not null default 0,
  expires_at  date,
  usage_limit int not null default 0,          -- 0 = no limit
  used        int not null default 0,
  active      boolean not null default true,
  note        text not null default '',
  created_at  timestamptz not null default now()
);

create table if not exists public.users (
  id          uuid primary key default gen_random_uuid(),
  role        text not null default 'customer' check (role in ('customer','admin')),
  name        text not null,
  email       text not null,
  pass_hash   text not null,
  phone       text not null default '',
  addresses   jsonb not null default '[]'::jsonb,
  wishlist    jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now()
);
create unique index if not exists users_email_key on public.users (lower(email));

create table if not exists public.sessions (
  token_hash  text primary key,                -- sha256 of the browser token; the token itself is never stored
  user_id     uuid not null references public.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '30 days'
);
create index if not exists sessions_user_idx on public.sessions (user_id);

create sequence if not exists public.order_number start 100001;

create table if not exists public.orders (
  id              text primary key,
  created_at      timestamptz not null default now(),
  status          text not null default 'placed' check (status in ('placed','packed','shipped','delivered','cancelled')),
  status_history  jsonb not null default '[]'::jsonb,
  customer_id     uuid references public.users(id) on delete set null,
  customer_name   text not null,
  email           text not null,
  phone           text not null,
  address         jsonb not null,
  items           jsonb not null,
  subtotal        numeric(10,2) not null,
  discount        numeric(10,2) not null default 0,
  shipping        numeric(10,2) not null default 0,
  tax             numeric(10,2) not null default 0,
  total           numeric(10,2) not null,
  coupon          jsonb,
  payment_method  text not null default 'cod',
  payment_status  text not null default 'pay_on_delivery',
  notes           text not null default '',
  guest_token     text
);
create index if not exists orders_customer_idx on public.orders (customer_id);
create index if not exists orders_created_idx on public.orders (created_at desc);

create table if not exists public.messages (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  email       text not null default '',
  message     text not null,
  read        boolean not null default false,
  created_at  timestamptz not null default now()
);

create table if not exists public.subscribers (
  email       text primary key,
  created_at  timestamptz not null default now()
);

-- one row the keep-alive job writes to, so the project always shows recent database activity
create table if not exists public.heartbeat (
  id          int primary key default 1 check (id = 1),
  pinged_at   timestamptz not null default now(),
  source      text not null default ''
);

-- ---------- lock everything down (RLS on, no policies = no access with the public key)
do $$
declare t text;
begin
  foreach t in array array['settings','policies','products','coupons','users','sessions','orders','messages','subscribers','heartbeat'] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- ---------- functions (run with the API's secret key only)

-- create a customer account; returns the new user id
create or replace function public.app_register(p_name text, p_email text, p_password text)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare uid uuid;
begin
  if exists (select 1 from users where lower(email) = lower(trim(p_email))) then
    raise exception 'EMAIL_TAKEN';
  end if;
  insert into users (role, name, email, pass_hash)
  values ('customer', left(trim(p_name), 80), lower(trim(p_email)), crypt(p_password, gen_salt('bf', 10)))
  returning id into uid;
  return uid;
end $$;

-- check a login; returns the user id or null
create or replace function public.app_check_login(p_email text, p_password text)
returns uuid language sql stable security definer set search_path = public, extensions as $$
  select id from users
  where lower(email) = lower(trim(p_email)) and pass_hash = crypt(p_password, pass_hash)
  limit 1;
$$;

-- change a password (used by "change password" in the account page)
create or replace function public.app_set_password(p_user uuid, p_password text)
returns void language sql security definer set search_path = public, extensions as $$
  update users set pass_hash = crypt(p_password, gen_salt('bf', 10)) where id = p_user;
$$;

-- create the store admin, or reset an existing account to admin with a new password.
-- Run in the SQL editor:  select app_create_admin('you@yourdomain.in', 'a-long-password', 'Your name');
create or replace function public.app_create_admin(p_email text, p_password text, p_name text default 'Store admin')
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare uid uuid;
begin
  if length(p_password) < 10 then raise exception 'Admin password needs at least 10 characters.'; end if;
  select id into uid from users where lower(email) = lower(trim(p_email));
  if uid is null then
    insert into users (role, name, email, pass_hash)
    values ('admin', p_name, lower(trim(p_email)), crypt(p_password, gen_salt('bf', 10))) returning id into uid;
  else
    update users set role = 'admin', pass_hash = crypt(p_password, gen_salt('bf', 10)) where id = uid;
    delete from sessions where user_id = uid;
  end if;
  return uid;
end $$;

-- place an order in one transaction: checks and takes stock, counts the coupon, numbers the order.
-- p_order holds the priced order the API built from current database prices.
create or replace function public.app_place_order(p_order jsonb)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare
  line jsonb; left_stock int; pname text; oid text; ccode text;
begin
  for line in select * from jsonb_array_elements(p_order->'items') loop
    update products set stock = stock - (line->>'qty')::int
     where id = line->>'productId' and active and stock >= (line->>'qty')::int;
    if not found then
      select name, stock into pname, left_stock from products where id = line->>'productId';
      raise exception 'STOCK|%|%', coalesce(pname, 'An item'), coalesce(left_stock, 0);
    end if;
  end loop;

  ccode := p_order->'coupon'->>'code';
  if ccode is not null then
    update coupons set used = used + 1
     where code = ccode and active and (usage_limit = 0 or used < usage_limit)
       and (expires_at is null or expires_at >= current_date);
    if not found then raise exception 'COUPON_UNAVAILABLE'; end if;
  end if;

  oid := 'AB' || nextval('order_number');
  insert into orders (id, status, status_history, customer_id, customer_name, email, phone, address, items,
                      subtotal, discount, shipping, tax, total, coupon, payment_method, payment_status, notes, guest_token)
  values (oid, 'placed', jsonb_build_array(jsonb_build_object('status','placed','at', now())),
          nullif(p_order->>'customerId','')::uuid, p_order->>'customerName', p_order->>'email', p_order->>'phone',
          p_order->'address', p_order->'items',
          (p_order->>'subtotal')::numeric, (p_order->>'discount')::numeric, (p_order->>'shipping')::numeric,
          (p_order->>'tax')::numeric, (p_order->>'total')::numeric,
          case when ccode is null then null else p_order->'coupon' end,
          coalesce(p_order->>'paymentMethod','cod'), coalesce(p_order->>'paymentStatus','pay_on_delivery'),
          coalesce(p_order->>'notes',''), nullif(p_order->>'guestToken',''));
  return oid;
end $$;

-- change an order's status; cancelling puts the stock back
create or replace function public.app_set_order_status(p_id text, p_status text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare cur text; line jsonb;
begin
  select status into cur from orders where id = p_id for update;
  if cur is null then raise exception 'ORDER_NOT_FOUND'; end if;
  if cur = p_status then return; end if;
  if cur = 'cancelled' then raise exception 'ORDER_CANCELLED'; end if;
  if p_status = 'cancelled' then
    for line in select * from jsonb_array_elements((select items from orders where id = p_id)) loop
      update products set stock = stock + (line->>'qty')::int where id = line->>'productId';
    end loop;
  end if;
  update orders set status = p_status,
    status_history = status_history || jsonb_build_array(jsonb_build_object('status', p_status, 'at', now()))
  where id = p_id;
end $$;

-- keep-alive: a real write, so Supabase sees activity
create or replace function public.app_heartbeat(p_source text default '')
returns timestamptz language sql security definer set search_path = public as $$
  insert into heartbeat (id, pinged_at, source) values (1, now(), left(p_source, 40))
  on conflict (id) do update set pinged_at = excluded.pinged_at, source = excluded.source
  returning pinged_at;
$$;

-- only the server (service_role / secret key) may call these
do $$
declare f text;
begin
  foreach f in array array[
    'app_register(text,text,text)', 'app_check_login(text,text)', 'app_set_password(uuid,text)',
    'app_create_admin(text,text,text)', 'app_place_order(jsonb)', 'app_set_order_status(text,text)', 'app_heartbeat(text)'] loop
    execute format('revoke all on function public.%s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function public.%s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function public.%s from authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function public.%s to service_role', f); end if;
  end loop;
end $$;

-- ---------- storage bucket for product photos (public read; uploads only through the API)
do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'storage' and table_name = 'buckets') then
    insert into storage.buckets (id, name, public) values ('product-images', 'product-images', true)
    on conflict (id) do nothing;
  end if;
end $$;

-- ---------- starting rows
insert into public.settings (id, store) values (1, jsonb_build_object(
  'name', 'Ananta Beauty', 'tagline', 'Herbal hair care',
  'email', 'anantabeautycares@gmail.com', 'phone', '+91 83173 97819',
  'address', 'Ananta Beauty Private Limited, F No. 204, Vmaks Heights Apartment, Ananth Nagar, Electronics City Phase 2, Bangalore 560100, Karnataka',
  'gstin', '', 'hours', 'Monday to Saturday, 10am to 6pm'))
on conflict (id) do nothing;

insert into public.policies (slug, title, body, status) values
  ('privacy',  'Privacy policy',   '', 'draft'),
  ('terms',    'Terms of service', '', 'draft'),
  ('returns',  'Returns policy',   '', 'draft'),
  ('shipping', 'Shipping policy',  '', 'draft'),
  ('refund',   'Refund policy',    '', 'draft')
on conflict (slug) do nothing;

insert into public.heartbeat (id, source) values (1, 'setup') on conflict (id) do nothing;

-- ========== Razorpay online payments (same as migration-002-razorpay.sql) ==========
alter table public.orders add column if not exists razorpay_order_id   text;
alter table public.orders add column if not exists razorpay_payment_id text;
alter table public.orders add column if not exists paid_at             timestamptz;
create index if not exists orders_rzp_idx on public.orders (razorpay_order_id);

-- Cancel an online order that was never paid: puts stock back and frees the coupon use.
-- Returns true if it cancelled the order.
create or replace function public.app_cancel_unpaid(p_id text)
returns boolean language plpgsql security definer set search_path = public as $$
declare o record; line jsonb;
begin
  select * into o from orders where id = p_id for update;
  if o.id is null or o.status = 'cancelled' or o.payment_status <> 'awaiting_payment' then return false; end if;
  for line in select * from jsonb_array_elements(o.items) loop
    update products set stock = stock + (line->>'qty')::int where id = line->>'productId';
  end loop;
  if o.coupon is not null then
    update coupons set used = greatest(used - 1, 0) where code = o.coupon->>'code';
  end if;
  update orders set status = 'cancelled', payment_status = 'payment_cancelled',
    status_history = status_history || jsonb_build_array(jsonb_build_object('status','cancelled','at', now(), 'note','online payment not completed'))
  where id = p_id;
  return true;
end $$;

-- Mark an online order paid (called after the Razorpay signature or webhook is verified).
-- If the order had already been cancelled, it is flagged for a refund instead.
create or replace function public.app_mark_paid(p_rzp_order text, p_payment text)
returns text language plpgsql security definer set search_path = public as $$
declare o record;
begin
  select * into o from orders where razorpay_order_id = p_rzp_order for update;
  if o.id is null then return null; end if;
  if o.payment_status = 'paid' or o.payment_status = 'paid_needs_refund' then return o.id; end if;
  update orders set
    payment_status = case when o.status = 'cancelled' then 'paid_needs_refund' else 'paid' end,
    razorpay_payment_id = p_payment, paid_at = now()
  where id = o.id;
  return o.id;
end $$;

do $$
declare f text;
begin
  foreach f in array array['app_cancel_unpaid(text)', 'app_mark_paid(text,text)'] loop
    execute format('revoke all on function public.%s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function public.%s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function public.%s from authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function public.%s to service_role', f); end if;
  end loop;
end $$;
