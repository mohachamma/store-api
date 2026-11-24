-- Core schema for the store.
--
-- Conventions
--   * Money: integer DZD (no decimals). Totals are recomputed by the API, never trusted from clients.
--   * Translatable text lives in jsonb objects like {"ar": "...", "fr": "...", "en": "..."}; "ar" is required.
--   * Image columns hold either a Supabase Storage path or, for sample data, a path starting with "/"
--     that points to a placeholder asset served by the storefront.
--   * Row Level Security is enabled on EVERY table. The API uses the service role (bypasses RLS);
--     the policies protect against any direct use of the anon/authenticated keys.
--   * Privacy: customer name / phone / commune / address exist on `orders` ONLY while status = 'pending'
--     (enforced by a CHECK constraint). `confirm_order()` / `cancel_order()` clear them atomically.

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------
create type public.order_status   as enum ('pending', 'confirmed', 'shipped', 'delivered', 'cancelled', 'returned');
create type public.payment_method as enum ('cod', 'chargily');
create type public.payment_status as enum ('unpaid', 'pending', 'paid', 'failed', 'refunded');
create type public.delivery_type  as enum ('home', 'desk');
create type public.discount_kind  as enum ('percent', 'fixed');
create type public.slide_kind     as enum ('hero', 'banner');

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
-- True when the caller's JWT carries app_metadata.role = 'admin' (set only by the API / Supabase dashboard).
create function public.is_admin() returns boolean
language sql stable
as $$
  select coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin', false)
$$;

create function public.set_updated_at() returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end
$$;

-- A translatable value: a JSON object that at least has an Arabic text.
create function public.is_i18n(v jsonb) returns boolean
language sql immutable
as $$
  select jsonb_typeof(v) = 'object' and coalesce(length(v ->> 'ar'), 0) > 0
$$;

-- ---------------------------------------------------------------------------
-- Geography & shipping
-- ---------------------------------------------------------------------------
create table public.wilayas (
  code      smallint primary key check (code between 1 and 58),
  name_ar   text not null,
  name_fr   text not null,
  home_fee  integer not null default 0 check (home_fee >= 0),  -- delivery to the door
  desk_fee  integer not null default 0 check (desk_fee >= 0),  -- delivery to a pickup desk
  active    boolean not null default true
);

create table public.communes (
  id          integer primary key,
  wilaya_code smallint not null references public.wilayas (code) on delete cascade,
  name_ar     text not null,
  name_fr     text not null,
  daira_ar    text,
  daira_fr    text
);
create index communes_wilaya_idx on public.communes (wilaya_code);

-- ---------------------------------------------------------------------------
-- Catalog
-- ---------------------------------------------------------------------------
create table public.brands (
  id         uuid primary key default gen_random_uuid(),
  slug       text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name       text not null,
  logo_path  text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table public.categories (
  id         uuid primary key default gen_random_uuid(),
  slug       text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name       jsonb not null check (public.is_i18n(name)),
  image_path text,
  sort_order integer not null default 0,
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.collections (
  id            uuid primary key default gen_random_uuid(),
  slug          text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  title         jsonb not null check (public.is_i18n(title)),
  subtitle      jsonb check (subtitle is null or public.is_i18n(subtitle)),
  hero_path     text,
  is_published  boolean not null default false,
  sort_order    integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create trigger collections_updated before update on public.collections
  for each row execute function public.set_updated_at();

create table public.products (
  id           uuid primary key default gen_random_uuid(),
  slug         text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name         jsonb not null check (public.is_i18n(name)),
  description  jsonb check (description is null or public.is_i18n(description)),
  category_id  uuid not null references public.categories (id) on delete restrict,
  brand_id     uuid references public.brands (id) on delete set null,
  is_published boolean not null default false,
  is_new       boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index products_category_idx on public.products (category_id) where is_published;
create index products_brand_idx on public.products (brand_id);
create trigger products_updated before update on public.products
  for each row execute function public.set_updated_at();

create table public.product_images (
  id         uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products (id) on delete cascade,
  path       text not null,
  alt        jsonb check (alt is null or jsonb_typeof(alt) = 'object'),
  sort_order integer not null default 0
);
create index product_images_product_idx on public.product_images (product_id, sort_order);

create table public.product_variants (
  id               uuid primary key default gen_random_uuid(),
  product_id       uuid not null references public.products (id) on delete cascade,
  sku              text unique,
  size             text not null check (length(size) > 0),
  color            text not null default '',
  stock            integer not null default 0 check (stock >= 0),
  price            integer not null check (price > 0),
  compare_at_price integer,
  created_at       timestamptz not null default now(),
  unique (product_id, size, color),
  check (compare_at_price is null or compare_at_price > price)
);
create index product_variants_product_idx on public.product_variants (product_id);

create table public.collection_products (
  collection_id uuid not null references public.collections (id) on delete cascade,
  product_id    uuid not null references public.products (id) on delete cascade,
  sort_order    integer not null default 0,
  primary key (collection_id, product_id)
);
create index collection_products_product_idx on public.collection_products (product_id);

-- "Looks": editorial photos tagged with the products worn in them.
create table public.looks (
  id            uuid primary key default gen_random_uuid(),
  collection_id uuid references public.collections (id) on delete cascade,
  image_path    text not null,
  alt           jsonb check (alt is null or jsonb_typeof(alt) = 'object'),
  sort_order    integer not null default 0,
  is_published  boolean not null default true
);
create index looks_collection_idx on public.looks (collection_id, sort_order);

create table public.look_products (
  look_id    uuid not null references public.looks (id) on delete cascade,
  product_id uuid not null references public.products (id) on delete cascade,
  sort_order integer not null default 0,
  primary key (look_id, product_id)
);
create index look_products_product_idx on public.look_products (product_id);

-- ---------------------------------------------------------------------------
-- Storefront content
-- ---------------------------------------------------------------------------
create table public.slides (
  id            uuid primary key default gen_random_uuid(),
  kind          public.slide_kind not null default 'hero',
  title         jsonb check (title is null or public.is_i18n(title)),
  subtitle      jsonb check (subtitle is null or public.is_i18n(subtitle)),
  image_path    text not null,
  collection_id uuid references public.collections (id) on delete set null,
  link_url      text,
  sort_order    integer not null default 0,
  is_active     boolean not null default true,
  starts_at     timestamptz,
  ends_at       timestamptz,
  check (ends_at is null or starts_at is null or ends_at > starts_at)
);

-- Small key/value store: 'announcement' (translatable bar text), 'store_info'.
create table public.site_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
create trigger site_settings_updated before update on public.site_settings
  for each row execute function public.set_updated_at();

create table public.discount_codes (
  id           uuid primary key default gen_random_uuid(),
  code         text not null unique check (code = upper(code) and code ~ '^[A-Z0-9_-]{3,32}$'),
  kind         public.discount_kind not null,
  value        integer not null check (value > 0),
  min_subtotal integer not null default 0 check (min_subtotal >= 0),
  max_uses     integer check (max_uses is null or max_uses > 0),
  used_count   integer not null default 0 check (used_count >= 0),
  starts_at    timestamptz,
  expires_at   timestamptz,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  check (kind <> 'percent' or value <= 100),
  check (expires_at is null or starts_at is null or expires_at > starts_at)
);

-- ---------------------------------------------------------------------------
-- Customers (optional accounts) & favorites
-- ---------------------------------------------------------------------------
create table public.customers (
  id         uuid primary key references auth.users (id) on delete cascade,
  full_name  text,
  phone      text,
  created_at timestamptz not null default now()
);

create table public.favorites (
  customer_id uuid not null references public.customers (id) on delete cascade,
  product_id  uuid not null references public.products (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (customer_id, product_id)
);

-- ---------------------------------------------------------------------------
-- Orders
-- ---------------------------------------------------------------------------
create sequence public.order_number_seq start 1001;

create table public.orders (
  id               uuid primary key default gen_random_uuid(),
  order_number     bigint not null unique default nextval('public.order_number_seq'),
  customer_id      uuid references public.customers (id) on delete set null,
  status           public.order_status not null default 'pending',
  payment_method   public.payment_method not null default 'cod',
  payment_status   public.payment_status not null default 'unpaid',
  payment_ref      text,                      -- e.g. the Chargily checkout id
  delivery_type    public.delivery_type not null default 'home',
  wilaya_code      smallint not null references public.wilayas (code),
  discount_code_id uuid references public.discount_codes (id) on delete set null,
  subtotal         integer not null check (subtotal >= 0),
  shipping_fee     integer not null default 0 check (shipping_fee >= 0),
  discount_total   integer not null default 0 check (discount_total >= 0),
  total            integer not null check (total >= 0),

  -- Personal data: present only while the order is pending (see constraints below).
  customer_name    text,
  customer_phone   text,
  commune_id       integer references public.communes (id),
  address          text,

  -- Delivery company data kept after confirmation.
  delivery_company text,
  tracking_number  text,
  delivery_status  text,

  confirmed_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint orders_total_matches check (total = subtotal + shipping_fee - discount_total),
  -- Personal data is mandatory while pending and must not exist afterwards.
  constraint orders_pii_pending check (
    (status = 'pending' and customer_name is not null and customer_phone is not null
       and commune_id is not null and address is not null)
    or
    (status <> 'pending' and customer_name is null and customer_phone is null
       and commune_id is null and address is null)
  ),
  -- Anything that left the "pending/cancelled" stage went through the delivery company.
  constraint orders_tracking_required check (status in ('pending', 'cancelled') or tracking_number is not null)
);
create index orders_status_created_idx on public.orders (status, created_at desc);
create index orders_wilaya_idx on public.orders (wilaya_code);
create index orders_customer_idx on public.orders (customer_id);
create index orders_tracking_idx on public.orders (tracking_number) where tracking_number is not null;
create trigger orders_updated before update on public.orders
  for each row execute function public.set_updated_at();

create table public.order_items (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references public.orders (id) on delete cascade,
  variant_id    uuid references public.product_variants (id) on delete set null,
  product_name  text not null,               -- snapshot, so history survives product edits
  size          text not null,
  color         text not null default '',
  unit_price    integer not null check (unit_price >= 0),
  quantity      integer not null check (quantity between 1 and 20),
  line_total    integer generated always as (unit_price * quantity) stored
);
create index order_items_order_idx on public.order_items (order_id);
create index order_items_variant_idx on public.order_items (variant_id);

-- In-app events for the admin dashboard (delivered live through Supabase Realtime). No personal data here.
create table public.admin_events (
  id         bigint generated always as identity primary key,
  type       text not null,
  order_id   uuid references public.orders (id) on delete cascade,
  payload    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  read_at    timestamptz
);
create index admin_events_unread_idx on public.admin_events (created_at desc) where read_at is null;

-- A new order always produces an event, regardless of which code path created it.
create function public.emit_new_order_event() returns trigger
language plpgsql
as $$
begin
  insert into public.admin_events (type, order_id, payload)
  values ('order_created', new.id,
          jsonb_build_object('order_number', new.order_number, 'total', new.total, 'wilaya_code', new.wilaya_code));
  return new;
end
$$;
create trigger orders_emit_event after insert on public.orders
  for each row execute function public.emit_new_order_event();

-- ---------------------------------------------------------------------------
-- Order lifecycle functions (called by the API with the service role)
-- ---------------------------------------------------------------------------
-- Confirm a pending order: store the delivery company's tracking data and erase all personal data, atomically.
create function public.confirm_order(p_order_id uuid, p_company text, p_tracking text, p_delivery_status text)
returns void
language plpgsql
as $$
begin
  if coalesce(length(p_tracking), 0) = 0 then
    raise exception 'tracking number is required' using errcode = '22023';
  end if;
  update public.orders
     set status = 'confirmed',
         delivery_company = p_company,
         tracking_number = p_tracking,
         delivery_status = p_delivery_status,
         confirmed_at = now(),
         customer_name = null, customer_phone = null, commune_id = null, address = null
   where id = p_order_id and status = 'pending';
  if not found then
    raise exception 'order % is not pending', p_order_id using errcode = 'P0002';
  end if;
end
$$;

-- Cancel a pending/confirmed order: erase personal data and put the stock back.
create function public.cancel_order(p_order_id uuid) returns void
language plpgsql
as $$
declare
  v_status public.order_status;
begin
  select status into v_status from public.orders where id = p_order_id for update;
  if v_status is null then
    raise exception 'order % not found', p_order_id using errcode = 'P0002';
  end if;
  if v_status not in ('pending', 'confirmed') then
    raise exception 'order % cannot be cancelled from status %', p_order_id, v_status using errcode = '22023';
  end if;

  update public.product_variants v
     set stock = v.stock + i.quantity
    from public.order_items i
   where i.order_id = p_order_id and i.variant_id = v.id;

  update public.orders
     set status = 'cancelled',
         customer_name = null, customer_phone = null, commune_id = null, address = null
   where id = p_order_id;
end
$$;

-- Cleanup job: cancel orders that stayed pending for too long (their personal data is erased too).
create function public.expire_pending_orders(p_days integer default 14) returns integer
language plpgsql
as $$
declare
  r record;
  n integer := 0;
begin
  if p_days < 1 then
    raise exception 'p_days must be >= 1' using errcode = '22023';
  end if;
  for r in
    select id from public.orders
     where status = 'pending' and created_at < now() - make_interval(days => p_days)
  loop
    perform public.cancel_order(r.id);
    n := n + 1;
  end loop;
  return n;
end
$$;

-- These functions mutate orders: only the service role (the API) may run them.
-- Supabase grants EXECUTE to anon/authenticated by default, so revoke from them explicitly.
revoke all on function public.confirm_order(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.cancel_order(uuid) from public, anon, authenticated;
revoke all on function public.expire_pending_orders(integer) from public, anon, authenticated;
grant execute on function public.confirm_order(uuid, text, text, text) to service_role;
grant execute on function public.cancel_order(uuid) to service_role;
grant execute on function public.expire_pending_orders(integer) to service_role;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.wilayas             enable row level security;
alter table public.communes            enable row level security;
alter table public.brands              enable row level security;
alter table public.categories          enable row level security;
alter table public.collections         enable row level security;
alter table public.products            enable row level security;
alter table public.product_images      enable row level security;
alter table public.product_variants    enable row level security;
alter table public.collection_products enable row level security;
alter table public.looks               enable row level security;
alter table public.look_products       enable row level security;
alter table public.slides              enable row level security;
alter table public.site_settings       enable row level security;
alter table public.discount_codes      enable row level security;
alter table public.customers           enable row level security;
alter table public.favorites           enable row level security;
alter table public.orders              enable row level security;
alter table public.order_items         enable row level security;
alter table public.admin_events        enable row level security;

-- Admins can do everything on every table.
do $$
declare t text;
begin
  foreach t in array array[
    'wilayas','communes','brands','categories','collections','products','product_images','product_variants',
    'collection_products','looks','look_products','slides','site_settings','discount_codes','customers',
    'favorites','orders','order_items','admin_events'
  ] loop
    execute format(
      'create policy %I on public.%I for all to authenticated using (public.is_admin()) with check (public.is_admin())',
      t || '_admin_all', t);
  end loop;
end $$;

-- Public read of storefront data (published / active rows only).
create policy wilayas_public_read    on public.wilayas    for select to anon, authenticated using (active);
create policy communes_public_read   on public.communes   for select to anon, authenticated using (true);
create policy brands_public_read     on public.brands     for select to anon, authenticated using (true);
create policy categories_public_read on public.categories for select to anon, authenticated using (is_active);
create policy collections_public_read on public.collections for select to anon, authenticated using (is_published);
create policy products_public_read   on public.products   for select to anon, authenticated using (is_published);

create policy product_images_public_read on public.product_images for select to anon, authenticated
  using (exists (select 1 from public.products p where p.id = product_id and p.is_published));
create policy product_variants_public_read on public.product_variants for select to anon, authenticated
  using (exists (select 1 from public.products p where p.id = product_id and p.is_published));
create policy collection_products_public_read on public.collection_products for select to anon, authenticated
  using (exists (select 1 from public.collections c where c.id = collection_id and c.is_published)
         and exists (select 1 from public.products p where p.id = product_id and p.is_published));

create policy looks_public_read on public.looks for select to anon, authenticated using (is_published);
create policy look_products_public_read on public.look_products for select to anon, authenticated
  using (exists (select 1 from public.looks l where l.id = look_id and l.is_published)
         and exists (select 1 from public.products p where p.id = product_id and p.is_published));

create policy slides_public_read on public.slides for select to anon, authenticated
  using (is_active and (starts_at is null or starts_at <= now()) and (ends_at is null or ends_at > now()));
create policy site_settings_public_read on public.site_settings for select to anon, authenticated
  using (key in ('announcement', 'store_info'));

-- Customers see and edit only their own profile, favorites and orders.
create policy customers_own_select on public.customers for select to authenticated using (id = auth.uid());
create policy customers_own_insert on public.customers for insert to authenticated with check (id = auth.uid());
create policy customers_own_update on public.customers for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());
create policy favorites_own_all on public.favorites for all to authenticated
  using (customer_id = auth.uid()) with check (customer_id = auth.uid());
create policy orders_own_select on public.orders for select to authenticated using (customer_id = auth.uid());
create policy order_items_own_select on public.order_items for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_id and o.customer_id = auth.uid()));
-- discount_codes: no public policy on purpose (codes are validated by the API only).
-- admin_events: admins only (policy above).

-- ---------------------------------------------------------------------------
-- Realtime: stream admin events to the dashboard (Supabase only; skipped elsewhere).
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.admin_events;
  end if;
end $$;
