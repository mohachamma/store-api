-- Hero slides can now be reordered from the dashboard (stable ordering needs a creation time).
alter table public.slides add column created_at timestamptz not null default now();
