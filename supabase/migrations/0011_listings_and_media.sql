-- 0011 — Listings, product details, media, variants, attribute values, slug and status history,
-- search vectors and geography (v5.2 migration plan).
--
-- Products and services share one `listings` table with a type discriminator. Public visibility is
-- decided by listing state AND seller state, and every surface follows that one decision, so the rule
-- lives in `public.listing_is_visible()` rather than being restated per query:
--
--   draft, pending_review          → not public, not purchasable (owner and staff preview only)
--   approved, active               → public, purchasable, indexable
--   sold, expired, archived        → public with "No longer available" (D2, N7), not purchasable, noindex
--   rejected, suspended, deleted   → not public at all (404)
--   seller suspended or closed     → nothing of that seller is public
--
-- Media follows the same decision: variants become public only once the listing is approved, and are
-- withdrawn the moment it stops being public. The original is never served publicly, and a variant may
-- never point at the original object.
--
-- Slug history keeps the 301 redirects; a slug that has ever belonged to another listing can never be
-- taken. Status history is append-only and written by a trigger, so it cannot be skipped.

-- ---------------------------------------------------------------------------------------------------
-- Listings
-- ---------------------------------------------------------------------------------------------------
create table public.listings (
  id uuid primary key default gen_random_uuid(),
  seller_user_id uuid not null references public.seller_profiles (user_id) on delete restrict,
  listing_type_code text not null references public.listing_types (code) on delete restrict,
  category_id uuid not null references public.categories (id) on delete restrict,
  slug text not null,
  title text not null,
  description text not null,
  content_language text not null references public.locales (code) on delete restrict,
  currency_code char(3) not null references public.currencies (code) on delete restrict,
  price_minor bigint,
  is_negotiable boolean not null default false,
  status text not null default 'draft',
  country_code char(2) not null references public.countries (code) on delete restrict,
  governorate text,
  city text,
  location extensions.geography(Point, 4326),
  submitted_at timestamptz,
  approved_at timestamptz,
  published_at timestamptz,
  sold_at timestamptz,
  expires_at timestamptz,
  archived_at timestamptz,
  deleted_at timestamptz,
  view_count bigint not null default 0,
  search_vector_en tsvector generated always as (
    setweight(to_tsvector('english'::regconfig, coalesce(title, '')), 'A')
    || setweight(to_tsvector('english'::regconfig, coalesce(description, '')), 'B')
  ) stored,
  search_vector_ar tsvector generated always as (
    setweight(to_tsvector('arabic'::regconfig, coalesce(title, '')), 'A')
    || setweight(to_tsvector('arabic'::regconfig, coalesce(description, '')), 'B')
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint listings_slug_format check (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,118}[a-z0-9])$'),
  constraint listings_title_length check (length(btrim(title)) between 3 and 140),
  constraint listings_description_length check (length(btrim(description)) between 10 and 20000),
  constraint listings_status_allowed check (status in (
    'draft', 'pending_review', 'approved', 'active', 'sold', 'expired', 'archived', 'rejected', 'suspended', 'deleted'
  )),
  constraint listings_price_positive check (price_minor is null or price_minor >= 0),
  constraint listings_live_needs_price check (status not in ('approved', 'active') or price_minor is not null),
  constraint listings_approved_has_time check (status not in ('approved', 'active') or approved_at is not null),
  constraint listings_sold_has_time check ((status = 'sold') = (sold_at is not null)),
  constraint listings_archived_has_time check ((status = 'archived') = (archived_at is not null)),
  constraint listings_deleted_has_time check ((status = 'deleted') = (deleted_at is not null)),
  unique (id, currency_code)
);
comment on table public.listings is
  'Products and services in one table with a type discriminator. `status` plus the seller state decides every public surface.';
comment on column public.listings.price_minor is
  'Integer minor units of `currency_code`. NULL only while a custom service has no fixed price (request → quote).';

create unique index listings_slug on public.listings (slug);
create index listings_seller on public.listings (seller_user_id, status, created_at desc);
create index listings_category on public.listings (category_id, status) where status in ('approved', 'active');
create index listings_type on public.listings (listing_type_code, status);
create index listings_search_en on public.listings using gin (search_vector_en);
create index listings_search_ar on public.listings using gin (search_vector_ar);
create index listings_title_trgm on public.listings using gin (title extensions.gin_trgm_ops);
create index listings_location on public.listings using gist (location) where status in ('approved', 'active');
create index listings_expiry on public.listings (expires_at) where status in ('approved', 'active');
create trigger listings_set_updated_at before update on public.listings
  for each row execute function app_private.tg_set_updated_at();

-- Visibility ------------------------------------------------------------------------------------------
create or replace function public.listing_status_is_public(p_status text) returns boolean
language sql
immutable
set search_path = pg_catalog
as $$
  select p_status in ('approved', 'active', 'sold', 'expired', 'archived');
$$;
comment on function public.listing_status_is_public(text) is
  'States whose page stays reachable. Sold, expired and archived render "No longer available" (D2, N7).';

create or replace function public.listing_status_is_purchasable(p_status text) returns boolean
language sql
immutable
set search_path = pg_catalog
as $$
  select p_status in ('approved', 'active');
$$;

create or replace function public.listing_status_is_indexable(p_status text) returns boolean
language sql
immutable
set search_path = pg_catalog
as $$
  select p_status in ('approved', 'active');
$$;

create or replace function public.listing_is_visible(p_listing_id uuid) returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.listings l
    join public.seller_profiles s on s.user_id = l.seller_user_id
    where l.id = p_listing_id
      and public.listing_status_is_public(l.status)
      and s.status = 'active'
  );
$$;
comment on function public.listing_is_visible(uuid) is
  'The single visibility decision every surface follows: listing state AND seller state.';

-- Slug history ------------------------------------------------------------------------------------------
create table public.listing_slug_history (
  id bigint generated always as identity primary key,
  listing_id uuid not null references public.listings (id) on delete cascade,
  slug text not null,
  replaced_at timestamptz not null default now(),
  constraint listing_slug_history_slug_format check (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,118}[a-z0-9])$')
);
comment on table public.listing_slug_history is 'Previous slugs, served as 301 redirects. A slug here can never be reused by another listing.';
create unique index listing_slug_history_slug on public.listing_slug_history (slug);
create index listing_slug_history_listing on public.listing_slug_history (listing_id, replaced_at desc);
create trigger listing_slug_history_append_only before update or delete on public.listing_slug_history
  for each row execute function app_private.tg_reject_write();

create or replace function app_private.tg_listings_slug_rule() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  owner_id uuid;
begin
  select h.listing_id into owner_id from public.listing_slug_history h where h.slug = new.slug;
  if owner_id is not null and owner_id <> new.id then
    raise exception 'slug % belonged to another listing and is permanently redirected', new.slug
      using errcode = 'unique_violation';
  end if;

  if tg_op = 'UPDATE' and new.slug <> old.slug then
    insert into public.listing_slug_history (listing_id, slug) values (old.id, old.slug)
    on conflict (slug) do nothing;
  end if;
  return new;
end;
$$;

create trigger listings_slug_rule before insert or update of slug on public.listings
  for each row execute function app_private.tg_listings_slug_rule();

-- Status history -----------------------------------------------------------------------------------------
create table public.listing_status_history (
  id bigint generated always as identity primary key,
  listing_id uuid not null references public.listings (id) on delete cascade,
  from_status text,
  to_status text not null,
  changed_by uuid references auth.users (id) on delete set null,
  reason text,
  changed_at timestamptz not null default now()
);
comment on table public.listing_status_history is 'Append-only moderation and lifecycle trail, written by a trigger so no path can skip it.';
create index listing_status_history_listing on public.listing_status_history (listing_id, changed_at desc);
create trigger listing_status_history_append_only before update or delete on public.listing_status_history
  for each row execute function app_private.tg_reject_write();

-- One trigger records the change, keeps the media in step and publishes the revalidation event (C11).
create or replace function app_private.tg_listings_status_change() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  was_public boolean := tg_op = 'UPDATE' and public.listing_status_is_public(old.status);
  is_public boolean := public.listing_status_is_public(new.status);
begin
  insert into public.listing_status_history (listing_id, from_status, to_status, changed_by)
  values (new.id, case when tg_op = 'UPDATE' then old.status end, new.status, public.current_user_id());

  if is_public and not was_public then
    perform public.enqueue_outbox_event('listing', new.id::text, 'listing.published',
      jsonb_build_object('listing_id', new.id, 'seller_user_id', new.seller_user_id, 'status', new.status));
  elsif was_public and not is_public then
    -- Withdrawal: public variants stop being public immediately; the worker removes the objects and
    -- invalidates the public cache. Originals stay private and untouched.
    update public.media_variants v
       set is_public = false, removed_at = now()
      from public.listing_media m
     where m.id = v.listing_media_id and m.listing_id = new.id and v.is_public;
    perform public.enqueue_outbox_event('listing', new.id::text, 'listing.withdrawn',
      jsonb_build_object('listing_id', new.id, 'seller_user_id', new.seller_user_id, 'status', new.status));
  elsif is_public then
    perform public.enqueue_outbox_event('listing', new.id::text, 'listing.updated',
      jsonb_build_object('listing_id', new.id, 'seller_user_id', new.seller_user_id, 'status', new.status));
  end if;
  return null;
end;
$$;

-- ---------------------------------------------------------------------------------------------------
-- Product details
-- ---------------------------------------------------------------------------------------------------
create table public.listing_product_details (
  listing_id uuid primary key references public.listings (id) on delete cascade,
  condition text not null,
  quantity integer not null default 1,
  brand text,
  model text,
  sku text,
  weight_grams integer,
  length_mm integer,
  width_mm integer,
  height_mm integer,
  warranty_months smallint,
  shipping_profile_id uuid references public.shipping_profiles (id) on delete set null,
  is_pickup_available boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint listing_product_details_condition_allowed check (condition in ('new', 'like_new', 'used', 'refurbished')),
  constraint listing_product_details_quantity_positive check (quantity >= 0),
  constraint listing_product_details_dimensions_positive check (
    (weight_grams is null or weight_grams > 0)
    and (length_mm is null or length_mm > 0)
    and (width_mm is null or width_mm > 0)
    and (height_mm is null or height_mm > 0)
  ),
  constraint listing_product_details_warranty_positive check (warranty_months is null or warranty_months >= 0)
);
comment on table public.listing_product_details is
  'Physical-goods fields. Service fields arrive with listing_service_details in 0015.';
create index listing_product_details_shipping_profile on public.listing_product_details (shipping_profile_id);
create trigger listing_product_details_set_updated_at before update on public.listing_product_details
  for each row execute function app_private.tg_set_updated_at();

-- The shipping profile must belong to the same seller as the listing.
create or replace function app_private.tg_product_details_shipping_rule() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  listing_seller uuid;
  profile_seller uuid;
begin
  if new.shipping_profile_id is null then
    return new;
  end if;
  select l.seller_user_id into listing_seller from public.listings l where l.id = new.listing_id;
  select p.seller_user_id into profile_seller from public.shipping_profiles p where p.id = new.shipping_profile_id;
  if listing_seller is distinct from profile_seller then
    raise exception 'the shipping profile belongs to another seller' using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

create trigger listing_product_details_shipping_rule before insert or update on public.listing_product_details
  for each row execute function app_private.tg_product_details_shipping_rule();

-- ---------------------------------------------------------------------------------------------------
-- Attribute values
-- ---------------------------------------------------------------------------------------------------
create table public.listing_attribute_values (
  listing_id uuid not null references public.listings (id) on delete cascade,
  attribute_definition_id uuid not null references public.attribute_definitions (id) on delete restrict,
  value_text text,
  value_number numeric,
  value_boolean boolean,
  option_ids uuid[] not null default '{}'::uuid[],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (listing_id, attribute_definition_id),
  constraint listing_attribute_values_exactly_one_value check (
    (case when value_text is not null then 1 else 0 end)
    + (case when value_number is not null then 1 else 0 end)
    + (case when value_boolean is not null then 1 else 0 end)
    + (case when array_length(option_ids, 1) is not null then 1 else 0 end) = 1
  ),
  constraint listing_attribute_values_text_length check (value_text is null or length(value_text) <= 500)
);
comment on table public.listing_attribute_values is 'One row per attribute a listing answers. Exactly one value column is populated.';
create index listing_attribute_values_by_attribute on public.listing_attribute_values (attribute_definition_id, value_text);
create index listing_attribute_values_options on public.listing_attribute_values using gin (option_ids);
create trigger listing_attribute_values_set_updated_at before update on public.listing_attribute_values
  for each row execute function app_private.tg_set_updated_at();

-- The value must match the attribute's declared type, and options must belong to that attribute.
create or replace function app_private.tg_listing_attribute_value_rule() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  kind text;
  option_count integer;
begin
  select d.data_type into kind from public.attribute_definitions d where d.id = new.attribute_definition_id;
  if kind is null then
    raise exception 'attribute % does not exist', new.attribute_definition_id using errcode = 'foreign_key_violation';
  end if;

  if kind = 'text' and new.value_text is null then
    raise exception 'attribute expects text' using errcode = 'check_violation';
  elsif kind = 'number' and new.value_number is null then
    raise exception 'attribute expects a number' using errcode = 'check_violation';
  elsif kind = 'boolean' and new.value_boolean is null then
    raise exception 'attribute expects a boolean' using errcode = 'check_violation';
  elsif kind in ('single_select', 'multi_select') then
    if array_length(new.option_ids, 1) is null then
      raise exception 'attribute expects at least one option' using errcode = 'check_violation';
    end if;
    if kind = 'single_select' and array_length(new.option_ids, 1) > 1 then
      raise exception 'attribute accepts a single option' using errcode = 'check_violation';
    end if;
    select count(*) into option_count
      from public.attribute_options o
     where o.id = any(new.option_ids) and o.attribute_definition_id = new.attribute_definition_id;
    if option_count <> array_length(new.option_ids, 1) then
      raise exception 'one or more options do not belong to this attribute' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

create trigger listing_attribute_values_rule before insert or update on public.listing_attribute_values
  for each row execute function app_private.tg_listing_attribute_value_rule();

-- ---------------------------------------------------------------------------------------------------
-- Tags on listings
-- ---------------------------------------------------------------------------------------------------
create table public.listing_tags (
  listing_id uuid not null references public.listings (id) on delete cascade,
  tag_id uuid not null references public.tags (id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (listing_id, tag_id)
);
create index listing_tags_by_tag on public.listing_tags (tag_id, listing_id);

create or replace function app_private.tg_listing_tags_usage() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'INSERT' then
    update public.tags set usage_count = usage_count + 1 where id = new.tag_id;
    return new;
  end if;
  update public.tags set usage_count = greatest(usage_count - 1, 0) where id = old.tag_id;
  return old;
end;
$$;

create trigger listing_tags_usage after insert or delete on public.listing_tags
  for each row execute function app_private.tg_listing_tags_usage();

-- ---------------------------------------------------------------------------------------------------
-- Media
-- ---------------------------------------------------------------------------------------------------
create table public.listing_media (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references public.listings (id) on delete cascade,
  kind text not null default 'image',
  original_object_path text,
  video_url text,
  status text not null default 'uploaded',
  position integer not null default 0,
  is_primary boolean not null default false,
  content_type text,
  byte_size bigint,
  width integer,
  height integer,
  checksum bytea,
  validation_error_type text,
  metadata_stripped_at timestamptz,
  published_at timestamptz,
  withdrawn_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint listing_media_kind_allowed check (kind in ('image', 'video_link')),
  constraint listing_media_status_allowed check (status in ('uploaded', 'validating', 'processing', 'ready', 'rejected', 'withdrawn')),
  constraint listing_media_source_matches_kind check (
    (kind = 'image' and original_object_path is not null and video_url is null)
    or (kind = 'video_link' and video_url is not null and original_object_path is null)
  ),
  constraint listing_media_video_host_allowed check (
    video_url is null or video_url ~ '^https://(www\.)?(youtube\.com/|youtu\.be/|vimeo\.com/)'
  ),
  constraint listing_media_dimensions_positive check (
    (byte_size is null or byte_size > 0) and (width is null or width > 0) and (height is null or height > 0)
  ),
  constraint listing_media_rejected_has_reason check (status <> 'rejected' or validation_error_type is not null),
  constraint listing_media_error_type_format check (validation_error_type is null or validation_error_type ~ '^[A-Za-z][A-Za-z0-9_]*$')
);
comment on table public.listing_media is
  'Uploaded originals live in a private bucket and are never served publicly, including as a fallback. Video is a YouTube or Vimeo link in V1.';
create unique index listing_media_original_path on public.listing_media (original_object_path) where original_object_path is not null;
create unique index listing_media_one_primary on public.listing_media (listing_id) where is_primary;
create index listing_media_listing on public.listing_media (listing_id, position, id);
create trigger listing_media_set_updated_at before update on public.listing_media
  for each row execute function app_private.tg_set_updated_at();

create table public.media_variants (
  id uuid primary key default gen_random_uuid(),
  listing_media_id uuid not null references public.listing_media (id) on delete cascade,
  variant_key text not null,
  format text not null,
  object_path text not null,
  width integer not null,
  height integer not null,
  byte_size bigint not null,
  is_public boolean not null default false,
  published_at timestamptz,
  removed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint media_variants_variant_key_format check (variant_key ~ '^[a-z0-9][a-z0-9_]*$'),
  constraint media_variants_format_allowed check (format in ('webp', 'avif', 'jpeg')),
  constraint media_variants_dimensions_positive check (width > 0 and height > 0 and byte_size > 0),
  constraint media_variants_public_has_time check (not is_public or published_at is not null),
  constraint media_variants_removed_is_not_public check (removed_at is null or not is_public),
  unique (listing_media_id, variant_key, format)
);
comment on table public.media_variants is
  'Generated renditions. A variant is public only while its listing is publicly visible; withdrawal clears the flag and the worker deletes the object.';
create unique index media_variants_object_path on public.media_variants (object_path);
create index media_variants_public on public.media_variants (listing_media_id) where is_public;

-- A variant may never point at the original object, and may only go public for a visible listing.
create or replace function app_private.tg_media_variants_rule() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  media public.listing_media;
begin
  select * into media from public.listing_media m where m.id = new.listing_media_id;
  if media.id is null then
    raise exception 'media % does not exist', new.listing_media_id using errcode = 'foreign_key_violation';
  end if;
  if media.kind <> 'image' then
    raise exception 'only image media has variants' using errcode = 'restrict_violation';
  end if;
  if media.original_object_path is not null and new.object_path = media.original_object_path then
    raise exception 'a variant may never point at the private original' using errcode = 'restrict_violation';
  end if;
  if new.is_public and not public.listing_is_visible(media.listing_id) then
    raise exception 'variants become public only once the listing is approved' using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

create trigger media_variants_rule before insert or update on public.media_variants
  for each row execute function app_private.tg_media_variants_rule();

-- Now that media_variants exists, the listing status trigger can be attached.
create trigger listings_status_change after insert or update of status on public.listings
  for each row execute function app_private.tg_listings_status_change();

select app_private.register_currency_dependency(
  'listings.currency_code', 'public', 'listings', 'currency_code',
  'listings priced in the currency',
  $$status <> 'deleted'$$
);

-- ---------------------------------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------------------------------
alter table public.listings enable row level security;
alter table public.listing_slug_history enable row level security;
alter table public.listing_status_history enable row level security;
alter table public.listing_product_details enable row level security;
alter table public.listing_attribute_values enable row level security;
alter table public.listing_tags enable row level security;
alter table public.listing_media enable row level security;
alter table public.media_variants enable row level security;

create policy listings_public_read on public.listings for select to authenticated
  using (public.listing_status_is_public(status) and public.is_seller_publicly_visible(seller_user_id));
create policy listings_owner_read on public.listings for select to authenticated
  using (seller_user_id = public.current_user_id());
create policy listings_staff_read on public.listings for select to authenticated
  using (public.has_permission('catalog.listing.read'));
create policy listings_owner_insert on public.listings for insert to authenticated
  with check (seller_user_id = public.current_user_id() and status in ('draft', 'pending_review'));
create policy listings_owner_update on public.listings for update to authenticated
  using (seller_user_id = public.current_user_id() and status not in ('suspended', 'deleted'))
  with check (seller_user_id = public.current_user_id());
create policy listings_staff_update on public.listings for update to authenticated
  using (public.has_permission('catalog.listing.moderate') and public.is_aal2())
  with check (public.has_permission('catalog.listing.moderate') and public.is_aal2());

create policy listing_slug_history_public_read on public.listing_slug_history for select to authenticated
  using (public.listing_is_visible(listing_id));
create policy listing_slug_history_owner_read on public.listing_slug_history for select to authenticated
  using (exists (select 1 from public.listings l where l.id = listing_id and l.seller_user_id = public.current_user_id()));

create policy listing_status_history_owner_read on public.listing_status_history for select to authenticated
  using (exists (select 1 from public.listings l where l.id = listing_id and l.seller_user_id = public.current_user_id()));
create policy listing_status_history_staff_read on public.listing_status_history for select to authenticated
  using (public.has_permission('catalog.listing.read'));

create policy listing_product_details_public_read on public.listing_product_details for select to authenticated
  using (public.listing_is_visible(listing_id));
create policy listing_product_details_owner_all on public.listing_product_details for all to authenticated
  using (exists (select 1 from public.listings l where l.id = listing_id and l.seller_user_id = public.current_user_id()))
  with check (exists (select 1 from public.listings l where l.id = listing_id and l.seller_user_id = public.current_user_id()));

create policy listing_attribute_values_public_read on public.listing_attribute_values for select to authenticated
  using (public.listing_is_visible(listing_id));
create policy listing_attribute_values_owner_all on public.listing_attribute_values for all to authenticated
  using (exists (select 1 from public.listings l where l.id = listing_id and l.seller_user_id = public.current_user_id()))
  with check (exists (select 1 from public.listings l where l.id = listing_id and l.seller_user_id = public.current_user_id()));

create policy listing_tags_public_read on public.listing_tags for select to authenticated
  using (public.listing_is_visible(listing_id));
create policy listing_tags_owner_all on public.listing_tags for all to authenticated
  using (exists (select 1 from public.listings l where l.id = listing_id and l.seller_user_id = public.current_user_id()))
  with check (exists (select 1 from public.listings l where l.id = listing_id and l.seller_user_id = public.current_user_id()));

-- Media rows carry private object paths, so the public may read only what a visible listing needs.
create policy listing_media_public_read on public.listing_media for select to authenticated
  using (public.listing_is_visible(listing_id) and status = 'ready');
create policy listing_media_owner_all on public.listing_media for all to authenticated
  using (exists (select 1 from public.listings l where l.id = listing_id and l.seller_user_id = public.current_user_id()))
  with check (exists (select 1 from public.listings l where l.id = listing_id and l.seller_user_id = public.current_user_id()));
create policy listing_media_staff_read on public.listing_media for select to authenticated
  using (public.has_permission('catalog.listing.read'));

create policy media_variants_public_read on public.media_variants for select to authenticated
  using (is_public);
create policy media_variants_owner_read on public.media_variants for select to authenticated
  using (exists (
    select 1 from public.listing_media m join public.listings l on l.id = m.listing_id
    where m.id = listing_media_id and l.seller_user_id = public.current_user_id()
  ));

grant select, insert, update on public.listings to authenticated;
grant select on public.listing_slug_history to authenticated;
grant select on public.listing_status_history to authenticated;
grant select, insert, update, delete on public.listing_product_details to authenticated;
grant select, insert, update, delete on public.listing_attribute_values to authenticated;
grant select, insert, delete on public.listing_tags to authenticated;
grant select, insert, update, delete on public.listing_media to authenticated;
grant select on public.media_variants to authenticated;

-- ---------------------------------------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema app_private from public;

grant execute on function
  public.listing_status_is_public(text),
  public.listing_status_is_purchasable(text),
  public.listing_status_is_indexable(text),
  public.listing_is_visible(uuid)
  to authenticated;
