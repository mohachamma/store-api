-- Editable storefront content: the animated brands strip and the offers / sale banners.
-- Everything here is managed from the admin dashboard (see CLAUDE.md "UI → API → admin" rule).

-- Brands: can be hidden without deleting, and may link somewhere (e.g. a brand page or a search).
alter table public.brands
  add column is_active boolean not null default true,
  add column link_url  text;

drop policy brands_public_read on public.brands;
create policy brands_public_read on public.brands for select to anon, authenticated using (is_active);

-- Offers: promotional banners shown on the storefront (e.g. "35% off only this Friday").
create table public.offers (
  id            uuid primary key default gen_random_uuid(),
  label         jsonb check (label is null or public.is_i18n(label)),       -- small caption, e.g. "Limited offer"
  title         jsonb not null check (public.is_i18n(title)),
  subtitle      jsonb check (subtitle is null or public.is_i18n(subtitle)),
  cta_label     jsonb check (cta_label is null or public.is_i18n(cta_label)),
  link_url      text,                                                        -- where the button goes ("/sale", a collection, ...)
  collection_id uuid references public.collections (id) on delete set null,
  image_path    text,
  theme         text not null default 'dark' check (theme in ('dark', 'light')),
  show_countdown boolean not null default false,                             -- countdown to ends_at
  sort_order    integer not null default 0,
  is_active     boolean not null default true,
  starts_at     timestamptz,
  ends_at       timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (ends_at is null or starts_at is null or ends_at > starts_at),
  check (not show_countdown or ends_at is not null)
);
create index offers_active_idx on public.offers (sort_order) where is_active;
create trigger offers_updated before update on public.offers
  for each row execute function public.set_updated_at();

alter table public.offers enable row level security;
create policy offers_admin_all on public.offers for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy offers_public_read on public.offers for select to anon, authenticated
  using (is_active and (starts_at is null or starts_at <= now()) and (ends_at is null or ends_at > now()));

-- More public settings: brands_strip = { enabled, animated, speed, pause_on_hover, title }, sale_page = { enabled, title, subtitle }.
drop policy site_settings_public_read on public.site_settings;
create policy site_settings_public_read on public.site_settings for select to anon, authenticated
  using (key in ('announcement', 'store_info', 'brands_strip', 'sale_page'));
