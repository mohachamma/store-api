-- Which ad an order came from (UTM tags of the link the customer clicked) and which campaign an ad expense belongs to.
alter table public.orders add column ad_source   text check (ad_source   is null or length(ad_source)   <= 60);   -- e.g. facebook, tiktok, google
alter table public.orders add column ad_medium   text check (ad_medium   is null or length(ad_medium)   <= 60);   -- e.g. paid, influencer
alter table public.orders add column ad_campaign text check (ad_campaign is null or length(ad_campaign) <= 80);   -- the campaign name the owner chose
alter table public.orders add column ad_content  text check (ad_content  is null or length(ad_content)  <= 80);   -- optional: which creative / video

create index orders_ad_campaign_idx on public.orders (ad_campaign) where ad_campaign is not null;

alter table public.expenses add column campaign text check (campaign is null or length(campaign) <= 80);
