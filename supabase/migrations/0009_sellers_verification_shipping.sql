-- 0009 — Sellers, seller verification and the shipping foundations (v5.2 migration plan).
--
-- Seller verification is manual in V1 (business decisions): a seller submits documents to a private
-- bucket, an administrator reviews them, and approval is what makes the seller verified. Sellers verify
-- both contacts (email and phone), so the verification record carries both timestamps.
--
-- D17: a seller must sit in a marketplace-enabled country. A CHECK cannot read another table, so it is a
-- trigger, the same shape as the address rule in 0005.
--
-- Shipping is the "mixed shipping architecture" of the business decisions: each seller keeps one or more
-- shipping profiles, each profile covers zones, and each zone carries its rates. Checkout prices shipping
-- per seller from the seller's profile. Money follows the currency rules: integer minor units with a
-- `currency_code` per record, and composite `(id, currency_code)` keys so a child can never disagree with
-- its parent's currency.
--
-- This migration also replaces the `is_verified_seller()` placeholder created in 0003.

-- ---------------------------------------------------------------------------------------------------
-- Seller profiles
-- ---------------------------------------------------------------------------------------------------
create table public.seller_profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  slug text not null,
  display_name text not null,
  legal_name text,
  bio text,
  content_language text references public.locales (code) on delete set null,
  logo_object_path text,
  banner_object_path text,
  country_code char(2) not null references public.countries (code) on delete restrict,
  governorate text,
  city text,
  contact_email extensions.citext,
  contact_phone_e164 text,
  status text not null default 'pending',
  suspended_at timestamptz,
  suspension_reason text,
  closed_at timestamptz,
  verification_status text not null default 'unverified',
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint seller_profiles_slug_format check (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])$'),
  constraint seller_profiles_display_name_length check (length(btrim(display_name)) between 2 and 80),
  constraint seller_profiles_bio_length check (bio is null or length(bio) <= 2000),
  constraint seller_profiles_phone_format check (contact_phone_e164 is null or contact_phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  constraint seller_profiles_status_allowed check (status in ('pending', 'active', 'suspended', 'closed')),
  constraint seller_profiles_verification_status_allowed check (verification_status in ('unverified', 'pending', 'verified', 'rejected')),
  constraint seller_profiles_suspended_has_time check ((status = 'suspended') = (suspended_at is not null)),
  constraint seller_profiles_closed_has_time check ((status = 'closed') = (closed_at is not null)),
  constraint seller_profiles_verified_has_time check ((verification_status = 'verified') = (verified_at is not null)),
  constraint seller_profiles_active_needs_verification check (status <> 'active' or verification_status = 'verified')
);
comment on table public.seller_profiles is
  'One storefront per user. `status` drives the suspended-seller visibility rules; `verification_status` is set by the review in seller_verifications.';
create unique index seller_profiles_slug on public.seller_profiles (slug);
create index seller_profiles_status on public.seller_profiles (status, verification_status);
create trigger seller_profiles_set_updated_at before update on public.seller_profiles
  for each row execute function app_private.tg_set_updated_at();
create trigger seller_profiles_audit after insert or update or delete on public.seller_profiles
  for each row execute function audit.tg_record_change();

create or replace function app_private.tg_seller_country_rule() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  enabled boolean;
begin
  select c.is_marketplace_enabled into enabled from public.countries c where c.code = new.country_code;
  if not coalesce(enabled, false) then
    raise exception 'country % is not enabled for sellers', new.country_code using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

create trigger seller_profiles_country_rule before insert or update on public.seller_profiles
  for each row execute function app_private.tg_seller_country_rule();

-- ---------------------------------------------------------------------------------------------------
-- Verification
-- ---------------------------------------------------------------------------------------------------
create table public.seller_verifications (
  id uuid primary key default gen_random_uuid(),
  seller_user_id uuid not null references public.seller_profiles (user_id) on delete cascade,
  status text not null default 'draft',
  email_verified_at timestamptz,
  phone_verified_at timestamptz,
  submitted_at timestamptz,
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users (id) on delete set null,
  decision_reason text,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint seller_verifications_status_allowed check (status in ('draft', 'submitted', 'under_review', 'approved', 'rejected', 'expired')),
  constraint seller_verifications_submitted_has_time check (status = 'draft' or submitted_at is not null),
  constraint seller_verifications_reviewed_has_time check ((status in ('approved', 'rejected')) = (reviewed_at is not null)),
  constraint seller_verifications_reviewer_recorded check (reviewed_at is null or reviewed_by is not null),
  constraint seller_verifications_rejection_has_reason check (status <> 'rejected' or length(btrim(coalesce(decision_reason, ''))) > 0),
  constraint seller_verifications_approval_needs_contacts check (
    status <> 'approved' or (email_verified_at is not null and phone_verified_at is not null)
  )
);
comment on table public.seller_verifications is
  'Manual seller verification (V1). Approval requires both contacts verified; a reviewer is always recorded.';
create unique index seller_verifications_one_open on public.seller_verifications (seller_user_id)
  where status in ('draft', 'submitted', 'under_review');
create index seller_verifications_queue on public.seller_verifications (status, submitted_at);
create trigger seller_verifications_set_updated_at before update on public.seller_verifications
  for each row execute function app_private.tg_set_updated_at();
create trigger seller_verifications_audit after insert or update or delete on public.seller_verifications
  for each row execute function audit.tg_record_change('decision_reason');

create table public.seller_verification_documents (
  id uuid primary key default gen_random_uuid(),
  verification_id uuid not null references public.seller_verifications (id) on delete cascade,
  document_type text not null,
  object_path text not null,
  original_filename text,
  content_type text,
  byte_size bigint,
  status text not null default 'pending',
  review_note text,
  uploaded_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users (id) on delete set null,
  constraint seller_verification_documents_type_allowed check (
    document_type in ('national_id', 'passport', 'commercial_register', 'tax_card', 'bank_statement', 'other')
  ),
  constraint seller_verification_documents_status_allowed check (status in ('pending', 'accepted', 'rejected')),
  constraint seller_verification_documents_path_present check (length(btrim(object_path)) > 0),
  constraint seller_verification_documents_size_positive check (byte_size is null or byte_size > 0),
  constraint seller_verification_documents_reviewed_has_reviewer check (reviewed_at is null or reviewed_by is not null)
);
comment on table public.seller_verification_documents is
  'Identity and business documents. `object_path` points at a private bucket; the file is reachable only through a short-lived API-signed URL (C15).';
create unique index seller_verification_documents_path on public.seller_verification_documents (object_path);
create index seller_verification_documents_by_verification on public.seller_verification_documents (verification_id, document_type);

-- Approval is what makes a seller verified; the two records can never drift apart.
create or replace function app_private.tg_apply_verification_decision() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.status = 'approved' then
    update public.seller_profiles
       set verification_status = 'verified', verified_at = coalesce(new.reviewed_at, now())
     where user_id = new.seller_user_id;
  elsif new.status = 'rejected' then
    update public.seller_profiles
       set verification_status = 'rejected', verified_at = null
     where user_id = new.seller_user_id and status <> 'active';
  elsif new.status in ('submitted', 'under_review') then
    update public.seller_profiles
       set verification_status = 'pending'
     where user_id = new.seller_user_id and verification_status = 'unverified';
  end if;
  return null;
end;
$$;

create trigger seller_verifications_apply_decision after insert or update of status on public.seller_verifications
  for each row execute function app_private.tg_apply_verification_decision();

-- The 0003 placeholder is replaced now that seller_verifications exists.
create or replace function public.is_verified_seller() returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.seller_profiles s
    where s.user_id = public.current_user_id()
      and s.status = 'active'
      and s.verification_status = 'verified'
  );
$$;
comment on function public.is_verified_seller() is 'True when the current user has an active, verified seller profile.';

create or replace function public.is_seller_publicly_visible(p_seller_user_id uuid) returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from public.seller_profiles s
    where s.user_id = p_seller_user_id and s.status = 'active'
  );
$$;
comment on function public.is_seller_publicly_visible(uuid) is
  'A suspended or closed seller is never publicly listed; their listings follow the same rule.';

-- ---------------------------------------------------------------------------------------------------
-- Shipping
-- ---------------------------------------------------------------------------------------------------
create table public.shipping_profiles (
  id uuid primary key default gen_random_uuid(),
  seller_user_id uuid not null references public.seller_profiles (user_id) on delete cascade,
  name text not null,
  currency_code char(3) not null references public.currencies (code) on delete restrict,
  handling_time_days smallint not null default 1,
  is_default boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shipping_profiles_name_length check (length(btrim(name)) between 1 and 80),
  constraint shipping_profiles_handling_time_range check (handling_time_days between 0 and 60),
  unique (seller_user_id, name),
  unique (id, currency_code)
);
comment on table public.shipping_profiles is 'A seller''s shipping configuration. Checkout prices shipping per seller from this profile.';
create unique index shipping_profiles_one_default on public.shipping_profiles (seller_user_id) where is_default;
create index shipping_profiles_seller on public.shipping_profiles (seller_user_id) where is_active;
create trigger shipping_profiles_set_updated_at before update on public.shipping_profiles
  for each row execute function app_private.tg_set_updated_at();

create table public.shipping_zones (
  id uuid primary key default gen_random_uuid(),
  shipping_profile_id uuid not null,
  currency_code char(3) not null,
  name text not null,
  country_code char(2) not null references public.countries (code) on delete restrict,
  governorates text[] not null default '{}'::text[],
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shipping_zones_name_length check (length(btrim(name)) between 1 and 80),
  foreign key (shipping_profile_id, currency_code) references public.shipping_profiles (id, currency_code) on delete cascade,
  unique (shipping_profile_id, name),
  unique (id, currency_code)
);
comment on table public.shipping_zones is
  'Where a profile ships. An empty `governorates` array covers the whole country; otherwise only the listed ones.';
create index shipping_zones_profile on public.shipping_zones (shipping_profile_id, sort_order);
create index shipping_zones_country on public.shipping_zones (country_code) where is_active;
create trigger shipping_zones_set_updated_at before update on public.shipping_zones
  for each row execute function app_private.tg_set_updated_at();

create table public.shipping_rates (
  id uuid primary key default gen_random_uuid(),
  shipping_zone_id uuid not null,
  currency_code char(3) not null,
  method text not null,
  name text not null,
  base_amount_minor bigint not null,
  per_item_amount_minor bigint not null default 0,
  per_kg_amount_minor bigint not null default 0,
  free_over_amount_minor bigint,
  min_delivery_days smallint,
  max_delivery_days smallint,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shipping_rates_method_allowed check (method in ('standard', 'express', 'pickup')),
  constraint shipping_rates_name_length check (length(btrim(name)) between 1 and 80),
  constraint shipping_rates_amounts_positive check (
    base_amount_minor >= 0 and per_item_amount_minor >= 0 and per_kg_amount_minor >= 0
    and (free_over_amount_minor is null or free_over_amount_minor >= 0)
  ),
  constraint shipping_rates_delivery_days_order check (
    (min_delivery_days is null and max_delivery_days is null)
    or (min_delivery_days is not null and max_delivery_days is not null and max_delivery_days >= min_delivery_days and min_delivery_days >= 0)
  ),
  foreign key (shipping_zone_id, currency_code) references public.shipping_zones (id, currency_code) on delete cascade,
  unique (shipping_zone_id, method, name)
);
comment on table public.shipping_rates is
  'Prices for one zone, in integer minor units of the profile currency. `free_over_amount_minor` waives the charge above a subtotal.';
create index shipping_rates_zone on public.shipping_rates (shipping_zone_id, method) where is_active;
create trigger shipping_rates_set_updated_at before update on public.shipping_rates
  for each row execute function app_private.tg_set_updated_at();

select app_private.register_currency_dependency(
  'shipping_profiles.currency_code', 'public', 'shipping_profiles', 'currency_code',
  'shipping profiles priced in the currency'
);
select app_private.register_currency_dependency(
  'shipping_rates.currency_code', 'public', 'shipping_rates', 'currency_code',
  'shipping rates priced in the currency'
);

-- ---------------------------------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------------------------------
alter table public.seller_profiles enable row level security;
alter table public.seller_verifications enable row level security;
alter table public.seller_verification_documents enable row level security;
alter table public.shipping_profiles enable row level security;
alter table public.shipping_zones enable row level security;
alter table public.shipping_rates enable row level security;

-- Storefronts are public while the seller is active; the owner and staff always see their own.
create policy seller_profiles_public_read on public.seller_profiles for select to authenticated
  using (status = 'active');
create policy seller_profiles_self_read on public.seller_profiles for select to authenticated
  using (user_id = public.current_user_id());
create policy seller_profiles_admin_read on public.seller_profiles for select to authenticated
  using (public.has_permission('sellers.profile.read'));
create policy seller_profiles_self_insert on public.seller_profiles for insert to authenticated
  with check (user_id = public.current_user_id());
create policy seller_profiles_self_update on public.seller_profiles for update to authenticated
  using (user_id = public.current_user_id() and status <> 'suspended')
  with check (user_id = public.current_user_id());
create policy seller_profiles_admin_update on public.seller_profiles for update to authenticated
  using (public.has_permission('sellers.profile.manage') and public.is_aal2())
  with check (public.has_permission('sellers.profile.manage') and public.is_aal2());

create policy seller_verifications_self_read on public.seller_verifications for select to authenticated
  using (seller_user_id = public.current_user_id());
create policy seller_verifications_self_insert on public.seller_verifications for insert to authenticated
  with check (seller_user_id = public.current_user_id() and status in ('draft', 'submitted'));
create policy seller_verifications_self_update on public.seller_verifications for update to authenticated
  using (seller_user_id = public.current_user_id() and status in ('draft', 'submitted'))
  with check (seller_user_id = public.current_user_id() and status in ('draft', 'submitted'));
create policy seller_verifications_reviewer_read on public.seller_verifications for select to authenticated
  using (public.has_permission('sellers.verification.review'));
create policy seller_verifications_reviewer_update on public.seller_verifications for update to authenticated
  using (public.has_permission('sellers.verification.review') and public.is_aal2())
  with check (public.has_permission('sellers.verification.review') and public.is_aal2());

create policy seller_verification_documents_self_all on public.seller_verification_documents for all to authenticated
  using (exists (select 1 from public.seller_verifications v where v.id = verification_id and v.seller_user_id = public.current_user_id()))
  with check (exists (select 1 from public.seller_verifications v where v.id = verification_id and v.seller_user_id = public.current_user_id() and v.status in ('draft', 'submitted')));
create policy seller_verification_documents_reviewer_read on public.seller_verification_documents for select to authenticated
  using (public.has_permission('sellers.verification.review'));
create policy seller_verification_documents_reviewer_update on public.seller_verification_documents for update to authenticated
  using (public.has_permission('sellers.verification.review') and public.is_aal2())
  with check (public.has_permission('sellers.verification.review') and public.is_aal2());

-- Shipping configuration is readable by anyone who can see the storefront (buyers need the rates) and
-- writable only by its owner.
create policy shipping_profiles_public_read on public.shipping_profiles for select to authenticated
  using (is_active and public.is_seller_publicly_visible(seller_user_id));
create policy shipping_profiles_owner_all on public.shipping_profiles for all to authenticated
  using (seller_user_id = public.current_user_id())
  with check (seller_user_id = public.current_user_id());

create policy shipping_zones_public_read on public.shipping_zones for select to authenticated
  using (is_active and exists (
    select 1 from public.shipping_profiles p
    where p.id = shipping_profile_id and p.is_active and public.is_seller_publicly_visible(p.seller_user_id)
  ));
create policy shipping_zones_owner_all on public.shipping_zones for all to authenticated
  using (exists (select 1 from public.shipping_profiles p where p.id = shipping_profile_id and p.seller_user_id = public.current_user_id()))
  with check (exists (select 1 from public.shipping_profiles p where p.id = shipping_profile_id and p.seller_user_id = public.current_user_id()));

create policy shipping_rates_public_read on public.shipping_rates for select to authenticated
  using (is_active and exists (
    select 1 from public.shipping_zones z join public.shipping_profiles p on p.id = z.shipping_profile_id
    where z.id = shipping_zone_id and z.is_active and p.is_active and public.is_seller_publicly_visible(p.seller_user_id)
  ));
create policy shipping_rates_owner_all on public.shipping_rates for all to authenticated
  using (exists (
    select 1 from public.shipping_zones z join public.shipping_profiles p on p.id = z.shipping_profile_id
    where z.id = shipping_zone_id and p.seller_user_id = public.current_user_id()
  ))
  with check (exists (
    select 1 from public.shipping_zones z join public.shipping_profiles p on p.id = z.shipping_profile_id
    where z.id = shipping_zone_id and p.seller_user_id = public.current_user_id()
  ));

grant select, insert, update on public.seller_profiles to authenticated;
grant select, insert, update on public.seller_verifications to authenticated;
grant select, insert, update, delete on public.seller_verification_documents to authenticated;
grant select, insert, update, delete on public.shipping_profiles to authenticated;
grant select, insert, update, delete on public.shipping_zones to authenticated;
grant select, insert, update, delete on public.shipping_rates to authenticated;

-- ---------------------------------------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema app_private from public;

grant execute on function
  public.is_verified_seller(),
  public.is_seller_publicly_visible(uuid)
  to authenticated;
