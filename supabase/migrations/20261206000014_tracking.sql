-- Automatic order tracking and WhatsApp messages.

-- The customer's language when ordering (used to write the WhatsApp messages in his language).
alter table public.orders add column locale text not null default 'ar' check (locale in ('ar', 'fr', 'en'));

-- When we last asked the delivery company about this parcel (so the customer's page can refresh it on demand without spamming the company).
alter table public.orders add column tracking_checked_at timestamptz;
