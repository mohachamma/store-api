-- Who a product is for: powers the dedicated Women's page (and a future Men's page). "unisex" shows on both.
alter table public.products
  add column audience text not null default 'unisex' check (audience in ('women', 'men', 'unisex'));
create index products_audience_idx on public.products (audience) where is_published;

-- Women's page content (editable): visibility, title, subtitle and cover image.
insert into public.site_settings (key, value) values
  ('women_page', '{
    "enabled": true,
    "title": {"ar": "نساء", "fr": "Femme", "en": "Women"},
    "subtitle": {"ar": "أحدث ملابس النساء", "fr": "Les dernières nouveautés pour elle", "en": "The latest for her"},
    "hero_path": null
  }'::jsonb)
on conflict (key) do nothing;

drop policy site_settings_public_read on public.site_settings;
create policy site_settings_public_read on public.site_settings for select to anon, authenticated
  using (key in ('announcement', 'store_info', 'brands_strip', 'sale_page', 'why_us', 'newsletter', 'draft_notice', 'women_page'));
