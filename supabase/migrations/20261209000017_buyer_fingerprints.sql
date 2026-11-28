-- Recognise repeat buyers and refused parcels WITHOUT keeping their phone number or IP address:
-- only one-way keyed fingerprints (HMAC) are stored. They cannot be turned back into the number or the address.
alter table public.orders add column phone_key text check (phone_key is null or length(phone_key) = 64);
alter table public.orders add column ip_key    text check (ip_key    is null or length(ip_key)    = 64);   -- erased after 90 days by the daily cleanup

create index orders_phone_key_idx on public.orders (phone_key) where phone_key is not null;
create index orders_ip_key_idx on public.orders (ip_key, created_at) where ip_key is not null;
