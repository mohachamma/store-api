-- Net profit: what things cost us (products, delivery), when parcels were delivered / returned, and the shop's expenses (ads, ...).

alter table public.product_variants add column cost_price integer check (cost_price is null or cost_price >= 0);  -- what we paid for one unit; null = not entered yet

-- Snapshots taken when the order is created, so later price changes do not rewrite history.
alter table public.order_items add column unit_cost integer check (unit_cost is null or unit_cost >= 0);

-- What the delivery company charges US per parcel, by wilaya and delivery type (the customer's fee stays in home_fee / desk_fee).
alter table public.wilayas add column home_cost integer not null default 0 check (home_cost >= 0);
alter table public.wilayas add column desk_cost integer not null default 0 check (desk_cost >= 0);

alter table public.orders add column delivery_cost integer not null default 0 check (delivery_cost >= 0);
alter table public.orders add column delivered_at timestamptz;
alter table public.orders add column returned_at timestamptz;

-- Money the shop spends that is not a product or a parcel: ads, packaging, salaries, rent, ...
create table public.expenses (
  id         uuid primary key default gen_random_uuid(),
  spent_on   date not null,
  category   text not null check (category in ('ads', 'packaging', 'salaries', 'rent', 'other')),
  platform   text check (platform is null or length(platform) <= 40),   -- e.g. facebook, instagram, tiktok (ads)
  amount     integer not null check (amount > 0),
  note       text check (note is null or length(note) <= 200),
  created_at timestamptz not null default now()
);
create index expenses_spent_on_idx on public.expenses (spent_on);

alter table public.expenses enable row level security;   -- no policies: only the API (service key) can read or write
