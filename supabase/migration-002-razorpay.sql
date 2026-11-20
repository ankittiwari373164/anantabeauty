-- Ananta Beauty: Razorpay online payments.
-- If you already ran schema.sql before, run THIS file once in Supabase > SQL Editor.
-- (schema.sql now includes it too, so a brand-new project only needs schema.sql.)

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
