-- Orders (phase 4): an unguessable token so a customer can open their own order page without an account,
-- plus an index to throttle repeated pending orders from the same phone.
alter table public.orders add column public_token uuid not null default gen_random_uuid();
create unique index orders_public_token_idx on public.orders (public_token);
create index orders_pending_phone_idx on public.orders (customer_phone, created_at) where status = 'pending';
