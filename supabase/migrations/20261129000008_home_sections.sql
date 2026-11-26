-- Editable home-page sections: category cards, "why us" features, newsletter (+ its subscribers).
-- All managed from the admin dashboard.

-- Curated cards (e.g. Men / Women / Casual / Best seller) linking anywhere in the shop.
create table public.home_cards (
  id         uuid primary key default gen_random_uuid(),
  title      jsonb not null check (public.is_i18n(title)),
  subtitle   jsonb check (subtitle is null or public.is_i18n(subtitle)),
  image_path text not null,
  link_url   text,
  sort_order integer not null default 0,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index home_cards_active_idx on public.home_cards (sort_order) where is_active;
create trigger home_cards_updated before update on public.home_cards
  for each row execute function public.set_updated_at();
alter table public.home_cards enable row level security;
create policy home_cards_admin_all on public.home_cards for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy home_cards_public_read on public.home_cards for select to anon, authenticated using (is_active);

-- Newsletter: the emails customers leave. Personal data, readable by admins only; the API inserts with the service role.
create table public.newsletter_subscribers (
  id         uuid primary key default gen_random_uuid(),
  email      text not null check (email = lower(email) and length(email) between 5 and 200),
  created_at timestamptz not null default now(),
  unique (email)
);
alter table public.newsletter_subscribers enable row level security;
create policy newsletter_admin_all on public.newsletter_subscribers for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Default texts (editable): icons are one of truck, shield, refresh, headset, card, gift, star, heart.
insert into public.site_settings (key, value) values
  ('why_us', '{
    "enabled": true,
    "title": {"ar": "لماذا نحن", "fr": "Pourquoi nous", "en": "Why shop with us"},
    "items": [
      {"icon": "truck",   "title": {"ar": "توصيل إلى 58 ولاية", "fr": "Livraison dans 58 wilayas", "en": "Delivery to 58 wilayas"}, "text": {"ar": "نوصّل طلبك إلى باب بيتك أو إلى مكتب شركة التوصيل.", "fr": "Chez vous ou en point relais, partout en Algérie.", "en": "To your door or to a pickup desk, anywhere in Algeria."}},
      {"icon": "card",    "title": {"ar": "ادفع عند الاستلام", "fr": "Paiement à la livraison", "en": "Pay on delivery"}, "text": {"ar": "تدفع نقداً بعد أن تستلم وتتأكد من طلبك.", "fr": "Vous payez à la réception, après avoir vérifié votre colis.", "en": "You pay when you receive and check your order."}},
      {"icon": "refresh", "title": {"ar": "تبديل سهل", "fr": "Échange facile", "en": "Easy exchanges"}, "text": {"ar": "المقاس غير مناسب؟ نبدّله لك.", "fr": "Mauvaise taille ? Nous l''échangeons.", "en": "Wrong size? We will swap it."}},
      {"icon": "headset", "title": {"ar": "خدمة زبائن", "fr": "Service client", "en": "Customer care"}, "text": {"ar": "نتصل بك لتأكيد كل طلب.", "fr": "Nous vous appelons pour confirmer chaque commande.", "en": "We call you to confirm every order."}}
    ]}'::jsonb),
  ('newsletter', '{
    "enabled": true,
    "title": {"ar": "كن أول من يعلم", "fr": "Soyez les premiers informés", "en": "Be the first to know"},
    "subtitle": {"ar": "اترك بريدك لتصلك أحدث الموديلات والعروض.", "fr": "Laissez votre e-mail pour les nouveautés et offres.", "en": "Leave your email for new drops and offers."},
    "button": {"ar": "اشترك", "fr": "S''abonner", "en": "Subscribe"}
  }'::jsonb)
on conflict (key) do nothing;

drop policy site_settings_public_read on public.site_settings;
create policy site_settings_public_read on public.site_settings for select to anon, authenticated
  using (key in ('announcement', 'store_info', 'brands_strip', 'sale_page', 'why_us', 'newsletter'));
