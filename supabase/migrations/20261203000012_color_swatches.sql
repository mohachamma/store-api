-- Color swatches: each variant can carry the exact color to show as a small round dot (chosen in the dashboard),
-- and each product photo can be linked to a color so the storefront shows that color's photos when it is tapped.
alter table public.product_variants
  add column color_hex text check (color_hex is null or color_hex ~ '^#[0-9a-f]{6}$');

alter table public.product_images
  add column color text check (color is null or length(color) <= 40);
