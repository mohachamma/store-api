-- Customers page (CRM) for people who made an account: their email (copied from the sign-in the first time we see them) and a private note from the owner.
alter table public.customers add column email text check (email is null or length(email) <= 200);
alter table public.customers add column admin_note text check (admin_note is null or length(admin_note) <= 500);
create index customers_created_idx on public.customers (created_at desc);
