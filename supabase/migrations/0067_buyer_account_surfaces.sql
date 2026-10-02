-- 0067 — Buyer account surfaces (Phase 7-E).
--
-- The application-layer readers and writers for the six things a buyer owns about themselves:
-- favorites, saved searches, addresses, their profile, their settings, and the country reference the
-- address form needs. **No table, column, constraint, index, trigger or policy is created or changed
-- here.** 0005 built `profiles`, `user_settings` and `addresses` with their RLS and their D17 country
-- trigger; 0013 built `favorites` and `saved_searches` with theirs; 0002 built `countries`. This
-- migration adds functions and nothing else.
--
-- **Why functions at all, when those tables already have owner policies.** The policies are written for
-- `authenticated`, and they resolve the caller through `public.current_user_id()`, which reads the JWT
-- `sub` claim. Under the approved architecture (M-1, owner Decision 1 Option B) a browser never reaches
-- the database: every authenticated operation runs through `app_system`, which is not `authenticated`,
-- carries no claims and — by the 0031 role-boundary contract — holds no table privileges at all. So the
-- existing policies answer nothing for this caller, correctly, because they were written for a caller
-- with a session. These are their `app_system` counterparts. Every grant `authenticated` already has is
-- left exactly as 0005 and 0013 left it, and gains nothing here.
--
-- **Ownership is in the statement, never in a branch.** Every function takes the account as its first
-- parameter and puts `user_id = p_user_id` in the predicate itself, so a row belonging to somebody else
-- is not refused — it is never matched. There is no code path that decides whether to apply the scope,
-- which is what makes a stray identifier harmless rather than dangerous. The account itself is never
-- supplied by a browser: the API resolves it from the caller's own access token before any of this is
-- reached, exactly as every reader since 0053 does.
--
-- **What the writers deliberately cannot do.**
--
--   * `buyer_profile_update` writes four columns: display name, full name, locale and timezone. It
--     cannot touch `phone_e164`, `email_verified_at` or `phone_verified_at` — those belong to the
--     verified-contact flow in 0041 and to the `auth.users` sync trigger in 0005 — and it cannot touch
--     `status` or `deleted_at`, which are moderation state. There is no path here by which an account
--     changes what it is allowed to do.
--   * `buyer_settings_update` writes the five notification booleans and the digit style, which is every
--     setting `user_settings` actually defines. `preferences` is deliberately absent: it is a free-form
--     object with no approved keys, and exposing it would be inventing settings rather than surfacing
--     them.
--   * `buyer_saved_search_update` writes `name`, `query` and `notify`. It never writes `last_matched_at`
--     or `last_notified_at`: those are a matching engine's bookkeeping, no matching engine exists, and a
--     surface that set them would be claiming something happened that did not. They are read-only data
--     here, exactly as the schema left them.
--   * There is no favorite writer that can favourite on somebody else's behalf, and no writer anywhere
--     below that takes two accounts.
--
-- **Deletes follow whatever each table already decided.** A favorite is a row in a two-column join table
-- and is deleted outright, which is what its `delete` grant to `authenticated` says. An address has a
-- `deleted_at` column and a constraint forbidding a deleted row from being a default, so removing one is
-- a soft delete that clears its default flags in the same statement. A saved search has neither, so it
-- is deleted outright, which is what its own `delete` grant says.
--
-- **The default-address rule is read off the schema, not invented.** 0005 declares
-- `addresses_one_default_shipping` and `addresses_one_default_billing` as unique partial indexes on
-- `user_id`, so at most one of each can exist per account; and `addresses_default_shipping_purpose`
-- ties a default to a compatible purpose. The writers therefore clear the previous default in the same
-- statement that sets a new one — not as a policy decision, but because the schema admits no other
-- outcome. D17's shipping-country rule stays where 0005 put it, in the trigger; the writers translate
-- its `restrict_violation` into a named outcome instead of letting a raw error reach a caller.

-- ---------------------------------------------------------------------------------------------------
-- Favorites
-- ---------------------------------------------------------------------------------------------------

-- One page of the caller's favorites, each with the marketplace card the repository already defines.
--
-- The card columns are the ones `app_private.public_listings` returns (0046) and are produced the same
-- way, including the join to `currencies` for the minor unit a price cannot be read without. What is
-- different, and deliberate, is that a favorite is returned **whether or not its listing is still
-- publicly visible**: `public.listing_is_visible` is the single visibility decision every surface
-- follows, and it is reported here as `is_available` rather than used as a filter. A favorite whose
-- listing was archived or whose seller was suspended is still the caller's own saved row; hiding it
-- would delete somebody's data from their own screen and leave them unable to tidy it up. The card
-- columns are NULL for such a row, so nothing about a hidden listing is disclosed.
create or replace function app_private.buyer_favorites(
  p_user_id uuid,
  p_limit integer default 20,
  p_cursor_created_at timestamptz default null,
  p_cursor_id uuid default null
) returns table (
  listing_id uuid,
  created_at timestamptz,
  is_available boolean,
  slug text,
  title text,
  city text,
  price_minor bigint,
  currency_code text,
  currency_minor_unit smallint,
  is_negotiable boolean,
  listing_type_code text
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select f.listing_id,
         f.created_at,
         public.listing_is_visible(f.listing_id) as is_available,
         case when public.listing_is_visible(f.listing_id) then l.slug end,
         case when public.listing_is_visible(f.listing_id) then l.title end,
         case when public.listing_is_visible(f.listing_id) then l.city end,
         case when public.listing_is_visible(f.listing_id) then l.price_minor end,
         case when public.listing_is_visible(f.listing_id) then l.currency_code::text end,
         case when public.listing_is_visible(f.listing_id) then c.decimal_places end,
         case when public.listing_is_visible(f.listing_id) then l.is_negotiable end,
         case when public.listing_is_visible(f.listing_id) then l.listing_type_code end
    from public.favorites f
    join public.listings l on l.id = f.listing_id
    join public.currencies c on c.code = l.currency_code
   where f.user_id = p_user_id
     and (
       p_cursor_created_at is null
       or p_cursor_id is null
       or (f.created_at, f.listing_id) < (p_cursor_created_at, p_cursor_id)
     )
   order by f.created_at desc, f.listing_id desc
   limit least(greatest(coalesce(p_limit, 20), 1), 50);
$$;

comment on function app_private.buyer_favorites(uuid, integer, timestamptz, uuid) is
  'One page of one account''s favorites, newest first, keyed on (created_at, listing_id) so a page boundary is a position rather than an offset. Reports whether each favorited listing is still publicly visible and returns the card columns only when it is. Scoped to the account in the statement.';

-- Adds a favorite, or reports that it was already there.
--
-- `public.listing_is_visible` is the admission test, and it is the same one the table's own RLS
-- `with check` applies — so this writer can add exactly what a browser with a session could have added
-- and nothing more. A listing that is not publicly visible cannot be favourited through any path.
create or replace function app_private.buyer_favorite_add(
  p_user_id uuid,
  p_listing_id uuid
) returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  added integer;
begin
  if p_user_id is null or p_listing_id is null then
    raise exception 'buyer_favorite_add requires an account and a listing' using errcode = '22023';
  end if;
  if not public.listing_is_visible(p_listing_id) then
    return 'not_found';
  end if;

  insert into public.favorites (user_id, listing_id)
  values (p_user_id, p_listing_id)
  on conflict (user_id, listing_id) do nothing;
  get diagnostics added = row_count;
  return case when added = 1 then 'added' else 'exists' end;
end;
$$;

comment on function app_private.buyer_favorite_add(uuid, uuid) is
  'Adds one listing to one account''s favorites. Idempotent: favouriting again reports "exists" and moves nothing, so the saved date stays the date it was first saved. A listing that is not publicly visible is reported as not found, which is the same admission test the table''s own RLS check applies.';

-- Removes a favorite. Returns false when there was nothing to remove, which a repeated request gets.
create or replace function app_private.buyer_favorite_remove(
  p_user_id uuid,
  p_listing_id uuid
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  removed integer;
begin
  delete from public.favorites f
   where f.user_id = p_user_id and f.listing_id = p_listing_id;
  get diagnostics removed = row_count;
  return removed = 1;
end;
$$;

comment on function app_private.buyer_favorite_remove(uuid, uuid) is
  'Removes one listing from one account''s favorites, scoped to that account in the statement so somebody else''s favorite matches nothing. Idempotent: removing again removes nothing and says so.';

-- ---------------------------------------------------------------------------------------------------
-- Saved searches
-- ---------------------------------------------------------------------------------------------------

-- One page of the caller's saved searches.
--
-- `last_matched_at` and `last_notified_at` are returned because they are the account's own data, and
-- they are returned read-only: no function in this migration writes either. There is no matching engine
-- in this project, so on a new saved search both are NULL and stay NULL.
create or replace function app_private.buyer_saved_searches(
  p_user_id uuid,
  p_limit integer default 20,
  p_cursor_created_at timestamptz default null,
  p_cursor_id uuid default null
) returns table (
  id uuid,
  name text,
  query jsonb,
  notify boolean,
  last_matched_at timestamptz,
  last_notified_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select s.id, s.name, s.query, s.notify, s.last_matched_at, s.last_notified_at, s.created_at, s.updated_at
    from public.saved_searches s
   where s.user_id = p_user_id
     and (
       p_cursor_created_at is null
       or p_cursor_id is null
       or (s.created_at, s.id) < (p_cursor_created_at, p_cursor_id)
     )
   order by s.created_at desc, s.id desc
   limit least(greatest(coalesce(p_limit, 20), 1), 50);
$$;

comment on function app_private.buyer_saved_searches(uuid, integer, timestamptz, uuid) is
  'One page of one account''s saved searches, newest first, on the same keyset shape every other list in this project uses. Returns last_matched_at and last_notified_at as data; nothing in this migration writes them.';

-- Creates a saved search. The unique (user_id, name) of 0013 is reported rather than raised.
create or replace function app_private.buyer_saved_search_create(
  p_user_id uuid,
  p_name text,
  p_query jsonb,
  p_notify boolean default false
) returns table (outcome text, id uuid)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  new_id uuid;
begin
  if p_user_id is null then
    raise exception 'buyer_saved_search_create requires an account' using errcode = '22023';
  end if;

  begin
    insert into public.saved_searches (user_id, name, query, notify)
    values (p_user_id, btrim(p_name), p_query, coalesce(p_notify, false))
    returning saved_searches.id into new_id;
  exception
    when unique_violation then
      return query select 'duplicate_name'::text, null::uuid;
      return;
  end;

  return query select 'created'::text, new_id;
end;
$$;

comment on function app_private.buyer_saved_search_create(uuid, text, jsonb, boolean) is
  'Creates one saved search for one account. The 0013 unique constraint on (user_id, name) is reported as a named outcome so a caller learns they already have a search by that name instead of receiving a raw constraint error. Never writes last_matched_at or last_notified_at.';

-- Updates a saved search's name, query and notification preference, and nothing else.
create or replace function app_private.buyer_saved_search_update(
  p_user_id uuid,
  p_id uuid,
  p_name text,
  p_query jsonb,
  p_notify boolean
) returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  updated integer;
begin
  if p_user_id is null or p_id is null then
    raise exception 'buyer_saved_search_update requires an account and a saved search' using errcode = '22023';
  end if;

  begin
    update public.saved_searches s
       set name = btrim(p_name),
           query = p_query,
           notify = coalesce(p_notify, false)
     where s.id = p_id and s.user_id = p_user_id;
    get diagnostics updated = row_count;
  exception
    when unique_violation then
      return 'duplicate_name';
  end;

  return case when updated = 1 then 'updated' else 'not_found' end;
end;
$$;

comment on function app_private.buyer_saved_search_update(uuid, uuid, text, jsonb, boolean) is
  'Updates the three fields a person owns on a saved search: its name, its query and whether it notifies. Scoped to the account in the statement, so somebody else''s saved search is reported as not found rather than refused. last_matched_at and last_notified_at are never written here: no matching engine exists, and setting them would claim something happened that did not.';

create or replace function app_private.buyer_saved_search_delete(
  p_user_id uuid,
  p_id uuid
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  removed integer;
begin
  delete from public.saved_searches s
   where s.id = p_id and s.user_id = p_user_id;
  get diagnostics removed = row_count;
  return removed = 1;
end;
$$;

comment on function app_private.buyer_saved_search_delete(uuid, uuid) is
  'Deletes one of one account''s saved searches. Idempotent: deleting again deletes nothing and says so.';

-- ---------------------------------------------------------------------------------------------------
-- Addresses
-- ---------------------------------------------------------------------------------------------------

-- The caller's addresses. Soft-deleted rows are excluded, which is what `addresses_user` is indexed on.
create or replace function app_private.buyer_addresses(p_user_id uuid)
returns table (
  id uuid,
  label text,
  purpose text,
  recipient_name text,
  phone_e164 text,
  country_code text,
  governorate text,
  city text,
  district text,
  street_address text,
  building text,
  apartment text,
  postal_code text,
  landmark text,
  is_default_shipping boolean,
  is_default_billing boolean,
  created_at timestamptz,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select a.id, a.label, a.purpose, a.recipient_name, a.phone_e164, a.country_code::text,
         a.governorate, a.city, a.district, a.street_address, a.building, a.apartment,
         a.postal_code, a.landmark, a.is_default_shipping, a.is_default_billing,
         a.created_at, a.updated_at
    from public.addresses a
   where a.user_id = p_user_id
     and a.deleted_at is null
   order by a.is_default_shipping desc, a.is_default_billing desc, a.created_at desc, a.id desc;
$$;

comment on function app_private.buyer_addresses(uuid) is
  'One account''s addresses, defaults first. Soft-deleted rows are excluded, which is the same predicate the addresses_user index is built on. The stored geography point is deliberately not returned: no approved surface renders it.';

-- Creates an address.
--
-- The D17 shipping-country rule is 0005's trigger and stays there; what happens here is that its
-- `restrict_violation` becomes a named outcome. Setting a default clears the previous one in the same
-- transaction, because the unique partial indexes of 0005 admit no other outcome.
create or replace function app_private.buyer_address_create(
  p_user_id uuid,
  p_label text,
  p_purpose text,
  p_recipient_name text,
  p_phone_e164 text,
  p_country_code text,
  p_governorate text,
  p_city text,
  p_district text,
  p_street_address text,
  p_building text,
  p_apartment text,
  p_postal_code text,
  p_landmark text,
  p_is_default_shipping boolean default false,
  p_is_default_billing boolean default false
) returns table (outcome text, id uuid)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  new_id uuid;
  wants_shipping boolean := coalesce(p_is_default_shipping, false);
  wants_billing boolean := coalesce(p_is_default_billing, false);
begin
  if p_user_id is null then
    raise exception 'buyer_address_create requires an account' using errcode = '22023';
  end if;
  if not exists (select 1 from public.countries c where c.code = upper(btrim(coalesce(p_country_code, '')))) then
    return query select 'invalid_country'::text, null::uuid;
    return;
  end if;

  -- At most one default of each kind per account (0005's unique partial indexes).
  if wants_shipping then
    update public.addresses a set is_default_shipping = false
     where a.user_id = p_user_id and a.is_default_shipping;
  end if;
  if wants_billing then
    update public.addresses a set is_default_billing = false
     where a.user_id = p_user_id and a.is_default_billing;
  end if;

  begin
    insert into public.addresses (
      user_id, label, purpose, recipient_name, phone_e164, country_code, governorate, city,
      district, street_address, building, apartment, postal_code, landmark,
      is_default_shipping, is_default_billing
    ) values (
      p_user_id, nullif(btrim(coalesce(p_label, '')), ''), p_purpose, btrim(p_recipient_name), p_phone_e164,
      upper(btrim(p_country_code))::char(2), btrim(p_governorate), btrim(p_city),
      nullif(btrim(coalesce(p_district, '')), ''), btrim(p_street_address),
      nullif(btrim(coalesce(p_building, '')), ''), nullif(btrim(coalesce(p_apartment, '')), ''),
      nullif(btrim(coalesce(p_postal_code, '')), ''), nullif(btrim(coalesce(p_landmark, '')), ''),
      wants_shipping, wants_billing
    )
    returning addresses.id into new_id;
  exception
    when restrict_violation then
      -- D17: an address used for shipping must sit in a marketplace-enabled country.
      return query select 'country_not_enabled'::text, null::uuid;
      return;
  end;

  return query select 'created'::text, new_id;
end;
$$;

comment on function app_private.buyer_address_create(uuid, text, text, text, text, text, text, text, text, text, text, text, text, text, boolean, boolean) is
  'Creates one address for one account, trimming the free-text parts and leaving every rule where the schema already put it: the CHECK constraints refuse a malformed row, and 0005''s D17 trigger refuses a shipping address in a country that is not marketplace-enabled, which is reported here as a named outcome rather than a raw error. Marking a new address as a default clears the previous one, because 0005''s unique partial indexes admit at most one of each.';

create or replace function app_private.buyer_address_update(
  p_user_id uuid,
  p_id uuid,
  p_label text,
  p_purpose text,
  p_recipient_name text,
  p_phone_e164 text,
  p_country_code text,
  p_governorate text,
  p_city text,
  p_district text,
  p_street_address text,
  p_building text,
  p_apartment text,
  p_postal_code text,
  p_landmark text,
  p_is_default_shipping boolean default false,
  p_is_default_billing boolean default false
) returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  updated integer;
  wants_shipping boolean := coalesce(p_is_default_shipping, false);
  wants_billing boolean := coalesce(p_is_default_billing, false);
begin
  if p_user_id is null or p_id is null then
    raise exception 'buyer_address_update requires an account and an address' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.addresses a where a.id = p_id and a.user_id = p_user_id and a.deleted_at is null
  ) then
    return 'not_found';
  end if;
  if not exists (select 1 from public.countries c where c.code = upper(btrim(coalesce(p_country_code, '')))) then
    return 'invalid_country';
  end if;

  if wants_shipping then
    update public.addresses a set is_default_shipping = false
     where a.user_id = p_user_id and a.is_default_shipping and a.id <> p_id;
  end if;
  if wants_billing then
    update public.addresses a set is_default_billing = false
     where a.user_id = p_user_id and a.is_default_billing and a.id <> p_id;
  end if;

  begin
    update public.addresses a
       set label = nullif(btrim(coalesce(p_label, '')), ''),
           purpose = p_purpose,
           recipient_name = btrim(p_recipient_name),
           phone_e164 = p_phone_e164,
           country_code = upper(btrim(p_country_code))::char(2),
           governorate = btrim(p_governorate),
           city = btrim(p_city),
           district = nullif(btrim(coalesce(p_district, '')), ''),
           street_address = btrim(p_street_address),
           building = nullif(btrim(coalesce(p_building, '')), ''),
           apartment = nullif(btrim(coalesce(p_apartment, '')), ''),
           postal_code = nullif(btrim(coalesce(p_postal_code, '')), ''),
           landmark = nullif(btrim(coalesce(p_landmark, '')), ''),
           is_default_shipping = wants_shipping,
           is_default_billing = wants_billing
     where a.id = p_id and a.user_id = p_user_id and a.deleted_at is null;
    get diagnostics updated = row_count;
  exception
    when restrict_violation then
      return 'country_not_enabled';
  end;

  return case when updated = 1 then 'updated' else 'not_found' end;
end;
$$;

comment on function app_private.buyer_address_update(uuid, uuid, text, text, text, text, text, text, text, text, text, text, text, text, text, boolean, boolean) is
  'Updates one of one account''s addresses, scoped to that account in the statement so somebody else''s address is reported as not found. The same schema rules apply as on create, including D17; the previous default of a kind is cleared only when this address is becoming that default.';

-- Removes an address.
--
-- A soft delete, because `addresses.deleted_at` exists and `addresses_defaults_not_deleted` forbids a
-- deleted row from being a default — so the flags are cleared in the same statement. Orders and
-- shipping are Phase 8 and nothing references an address yet, but the column is the schema's own answer
-- to what removal means here, and a hard delete would be a different answer.
create or replace function app_private.buyer_address_delete(
  p_user_id uuid,
  p_id uuid
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  removed integer;
begin
  update public.addresses a
     set deleted_at = now(),
         is_default_shipping = false,
         is_default_billing = false
   where a.id = p_id and a.user_id = p_user_id and a.deleted_at is null;
  get diagnostics removed = row_count;
  return removed = 1;
end;
$$;

comment on function app_private.buyer_address_delete(uuid, uuid) is
  'Soft-deletes one of one account''s addresses and clears its default flags in the same statement, which addresses_defaults_not_deleted requires. Idempotent: an already-removed address matches nothing and the call says so.';

-- ---------------------------------------------------------------------------------------------------
-- Profile
-- ---------------------------------------------------------------------------------------------------

-- The caller's own profile, as the account itself may see it.
--
-- Wider than `app_private.user_identity` (0052) on purpose and for one reason: that reader answers "who
-- is this, minimally, for any signed-in surface", while this one answers "what does this person see on
-- their own profile page". It is still narrow — no avatar path, because no approved surface renders one
-- yet, and no `deleted_at`, because a deleted profile returns no row at all.
create or replace function app_private.buyer_profile(p_user_id uuid)
returns table (
  id uuid,
  display_name text,
  full_name text,
  phone_e164 text,
  locale_code text,
  timezone text,
  status text,
  email_verified_at timestamptz,
  phone_verified_at timestamptz,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select p.id, p.display_name, p.full_name, p.phone_e164, p.locale_code, p.timezone, p.status,
         p.email_verified_at, p.phone_verified_at, p.created_at
    from public.profiles p
   where p.id = p_user_id
     and p.deleted_at is null;
$$;

comment on function app_private.buyer_profile(uuid) is
  'One account''s own profile. Returns no row for a deleted profile, matching app_private.user_identity, so a deleted account cannot keep reading itself with a live token. The phone number and the two verification timestamps are returned as data the person already knows about themselves; none of them is writable through this migration.';

-- Updates the four profile fields a person owns.
create or replace function app_private.buyer_profile_update(
  p_user_id uuid,
  p_display_name text,
  p_full_name text,
  p_locale_code text,
  p_timezone text
) returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  updated integer;
  locale text := nullif(btrim(coalesce(p_locale_code, '')), '');
  zone text := nullif(btrim(coalesce(p_timezone, '')), '');
begin
  if p_user_id is null then
    raise exception 'buyer_profile_update requires an account' using errcode = '22023';
  end if;
  if locale is not null and not exists (select 1 from public.locales l where l.code = locale) then
    return 'invalid_locale';
  end if;
  if zone is not null and not exists (select 1 from pg_catalog.pg_timezone_names t where t.name = zone) then
    return 'invalid_timezone';
  end if;

  update public.profiles p
     set display_name = nullif(btrim(coalesce(p_display_name, '')), ''),
         full_name = nullif(btrim(coalesce(p_full_name, '')), ''),
         locale_code = locale,
         timezone = coalesce(zone, p.timezone)
   where p.id = p_user_id
     and p.deleted_at is null;
  get diagnostics updated = row_count;
  return case when updated = 1 then 'updated' else 'not_found' end;
end;
$$;

comment on function app_private.buyer_profile_update(uuid, text, text, text, text) is
  'Updates the four profile fields a person owns: display name, full name, locale and timezone. It cannot write phone_e164, email_verified_at or phone_verified_at — those belong to the verified-contact flow and the auth.users sync trigger — and it cannot write status or deleted_at, so no account can change what it is allowed to do through its own profile. An unknown locale or timezone is a named outcome rather than a constraint error.';

-- ---------------------------------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------------------------------

create or replace function app_private.buyer_settings(p_user_id uuid)
returns table (
  notify_email boolean,
  notify_sms boolean,
  notify_whatsapp boolean,
  notify_in_app boolean,
  marketing_opt_in boolean,
  digit_style text,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select s.notify_email, s.notify_sms, s.notify_whatsapp, s.notify_in_app, s.marketing_opt_in,
         s.digit_style, s.updated_at
    from public.user_settings s
   where s.user_id = p_user_id;
$$;

comment on function app_private.buyer_settings(uuid) is
  'One account''s settings. `preferences` is deliberately absent: it is a free-form object with no approved keys, and returning it would expose a shape no surface has agreed on.';

-- Writes the six settings `user_settings` defines, and inserts the row if the sync trigger never did.
create or replace function app_private.buyer_settings_update(
  p_user_id uuid,
  p_notify_email boolean,
  p_notify_sms boolean,
  p_notify_whatsapp boolean,
  p_notify_in_app boolean,
  p_marketing_opt_in boolean,
  p_digit_style text
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  style text := nullif(btrim(coalesce(p_digit_style, '')), '');
begin
  if p_user_id is null then
    raise exception 'buyer_settings_update requires an account' using errcode = '22023';
  end if;
  if not exists (select 1 from auth.users u where u.id = p_user_id) then
    return false;
  end if;

  insert into public.user_settings (
    user_id, notify_email, notify_sms, notify_whatsapp, notify_in_app, marketing_opt_in, digit_style
  ) values (
    p_user_id, coalesce(p_notify_email, true), coalesce(p_notify_sms, false),
    coalesce(p_notify_whatsapp, false), coalesce(p_notify_in_app, true),
    coalesce(p_marketing_opt_in, false), style
  )
  on conflict (user_id) do update
     set notify_email = excluded.notify_email,
         notify_sms = excluded.notify_sms,
         notify_whatsapp = excluded.notify_whatsapp,
         notify_in_app = excluded.notify_in_app,
         marketing_opt_in = excluded.marketing_opt_in,
         digit_style = excluded.digit_style;
  return true;
end;
$$;

comment on function app_private.buyer_settings_update(uuid, boolean, boolean, boolean, boolean, boolean, text) is
  'Writes the five notification switches and the digit style, which is every setting user_settings defines apart from the free-form preferences object this surface does not expose. Idempotent: writing the same values again changes nothing anybody can observe. The insert branch exists because the row is created by the auth.users sync trigger, and a settings page should not fail for an account that somehow has none.';

-- ---------------------------------------------------------------------------------------------------
-- Country reference
-- ---------------------------------------------------------------------------------------------------

-- The countries an address form offers, with the flag D17's trigger actually tests.
--
-- Not filtered to marketplace-enabled countries: `addresses.purpose` admits 'billing', which the D17
-- trigger does not restrict, so filtering here would remove a choice the schema allows. The flag is
-- returned instead, and the surface that offers a shipping address uses it.
create or replace function app_private.reference_countries()
returns table (
  code text,
  name_en text,
  name_ar text,
  phone_code text,
  is_marketplace_enabled boolean
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select c.code::text, c.name_en, c.name_ar, c.phone_code, c.is_marketplace_enabled
    from public.countries c
   order by c.sort_order, c.name_en, c.code;
$$;

comment on function app_private.reference_countries() is
  'The country reference an address form needs: code, both names, the dialling code and whether the country is marketplace-enabled. Public reference data, taking no account and disclosing nothing about anybody.';

-- ---------------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------------
revoke all on function app_private.buyer_favorites(uuid, integer, timestamptz, uuid) from public;
revoke all on function app_private.buyer_favorite_add(uuid, uuid) from public;
revoke all on function app_private.buyer_favorite_remove(uuid, uuid) from public;
revoke all on function app_private.buyer_saved_searches(uuid, integer, timestamptz, uuid) from public;
revoke all on function app_private.buyer_saved_search_create(uuid, text, jsonb, boolean) from public;
revoke all on function app_private.buyer_saved_search_update(uuid, uuid, text, jsonb, boolean) from public;
revoke all on function app_private.buyer_saved_search_delete(uuid, uuid) from public;
revoke all on function app_private.buyer_addresses(uuid) from public;
revoke all on function app_private.buyer_address_create(uuid, text, text, text, text, text, text, text, text, text, text, text, text, text, boolean, boolean) from public;
revoke all on function app_private.buyer_address_update(uuid, uuid, text, text, text, text, text, text, text, text, text, text, text, text, text, boolean, boolean) from public;
revoke all on function app_private.buyer_address_delete(uuid, uuid) from public;
revoke all on function app_private.buyer_profile(uuid) from public;
revoke all on function app_private.buyer_profile_update(uuid, text, text, text, text) from public;
revoke all on function app_private.buyer_settings(uuid) from public;
revoke all on function app_private.buyer_settings_update(uuid, boolean, boolean, boolean, boolean, boolean, text) from public;
revoke all on function app_private.reference_countries() from public;

-- The API role alone. `authenticated` keeps exactly what 0005 and 0013 gave it and gains nothing here:
-- a function that takes the account as a parameter must never be callable by something that could pass
-- somebody else's.
grant execute on function app_private.buyer_favorites(uuid, integer, timestamptz, uuid) to app_system;
grant execute on function app_private.buyer_favorite_add(uuid, uuid) to app_system;
grant execute on function app_private.buyer_favorite_remove(uuid, uuid) to app_system;
grant execute on function app_private.buyer_saved_searches(uuid, integer, timestamptz, uuid) to app_system;
grant execute on function app_private.buyer_saved_search_create(uuid, text, jsonb, boolean) to app_system;
grant execute on function app_private.buyer_saved_search_update(uuid, uuid, text, jsonb, boolean) to app_system;
grant execute on function app_private.buyer_saved_search_delete(uuid, uuid) to app_system;
grant execute on function app_private.buyer_addresses(uuid) to app_system;
grant execute on function app_private.buyer_address_create(uuid, text, text, text, text, text, text, text, text, text, text, text, text, text, boolean, boolean) to app_system;
grant execute on function app_private.buyer_address_update(uuid, uuid, text, text, text, text, text, text, text, text, text, text, text, text, text, boolean, boolean) to app_system;
grant execute on function app_private.buyer_address_delete(uuid, uuid) to app_system;
grant execute on function app_private.buyer_profile(uuid) to app_system;
grant execute on function app_private.buyer_profile_update(uuid, text, text, text, text) to app_system;
grant execute on function app_private.buyer_settings(uuid) to app_system;
grant execute on function app_private.buyer_settings_update(uuid, boolean, boolean, boolean, boolean, boolean, text) to app_system;
grant execute on function app_private.reference_countries() to app_system;

-- ---------------------------------------------------------------------------------------------------
-- The security contract still holds
-- ---------------------------------------------------------------------------------------------------
do $$
begin
  perform app_private.assert_security_contract();
end;
$$;
