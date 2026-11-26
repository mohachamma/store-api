-- Active delivery company (chosen from the admin dashboard). "manual" = the admin types the tracking number.
insert into public.site_settings (key, value) values ('delivery', '{"provider": "manual"}'::jsonb)
on conflict (key) do nothing;

-- One order per payment checkout (webhooks look orders up by it).
create unique index if not exists orders_payment_ref_key on public.orders (payment_ref) where payment_ref is not null;
