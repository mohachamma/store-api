-- Public bucket for product / look / slide images. Only exists on Supabase (guarded, so plain Postgres skips it).
-- Uploads go through the API (service role); admins may also manage objects directly.
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public)
    values ('product-images', 'product-images', true)
    on conflict (id) do nothing;

    execute $p$
      create policy "product_images_public_read" on storage.objects
        for select to anon, authenticated using (bucket_id = 'product-images')
    $p$;
    execute $p$
      create policy "product_images_admin_write" on storage.objects
        for all to authenticated
        using (bucket_id = 'product-images' and public.is_admin())
        with check (bucket_id = 'product-images' and public.is_admin())
    $p$;
  end if;
end $$;
