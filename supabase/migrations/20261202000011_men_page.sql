-- Men's page content (editable), same shape as the Women's page. Products choose it with products.audience.
insert into public.site_settings (key, value) values
  ('men_page', '{
    "enabled": true,
    "title": {"ar": "رجال", "fr": "Homme", "en": "Men"},
    "subtitle": {"ar": "أحدث ملابس الرجال", "fr": "Les dernières nouveautés pour lui", "en": "The latest for him"},
    "hero_path": null
  }'::jsonb)
on conflict (key) do nothing;

drop policy site_settings_public_read on public.site_settings;
create policy site_settings_public_read on public.site_settings for select to anon, authenticated
  using (key in ('announcement', 'store_info', 'brands_strip', 'sale_page', 'why_us', 'newsletter', 'draft_notice', 'women_page', 'men_page'));
