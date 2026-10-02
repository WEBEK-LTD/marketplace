-- 0070 — Offers: negotiation and acceptance (Phase 7-H).
--
-- ---------------------------------------------------------------------------------------------------
-- What the survey found, and what it decided for this migration
-- ---------------------------------------------------------------------------------------------------
-- **No offer table, column, constraint, index, trigger or policy is created or changed here.** 0015 owns
-- the model; 0032 owns the expiry sweeper; 0033 owns the settings. All three are read, none is rewritten.
-- One `site_settings` row is inserted — see "The payment window" below — and that is the only data this
-- migration adds.
--
-- ---------------------------------------------------------------------------------------------------
-- The state machine, read off 0015 rather than assumed
-- ---------------------------------------------------------------------------------------------------
-- 0015 names six statuses. Which of them are *live* is not a matter of opinion: four independent facts in
-- the schema say the same thing, and they are the whole basis for the transitions below.
--
--   1. `offers_responded_when_decided` — `(status in ('pending')) = (responded_at is null)`. So `pending`
--      is the one status without a response, and **every** other status is a recorded response, including
--      `countered`.
--   2. `offers_expiring` is `on (expires_at) where status = 'pending'`, and `app_private.expire_due_offers`
--      (0032) sweeps `status = 'pending'` only. Nothing else is ever waiting for a clock.
--   3. `register_currency_dependency('offers.currency_code', …, $$status in ('pending','accepted')$$)` —
--      a currency is held in use by a `pending` or an `accepted` offer and by no other.
--   4. `offers_one_open_per_buyer` is unique on `(listing_id, buyer_user_id) where status = 'pending'` —
--      at most one live offer per buyer per listing.
--
-- So `pending` is the only actionable status, `accepted` is the obligation, and `rejected`, `withdrawn`,
-- `countered` and `expired` are terminal. The transitions implemented here are exactly:
--
--     (none) → pending      a buyer opens an offer
--     pending → accepted    the seller accepts. The obligation transition; see below
--     pending → rejected    the seller declines
--     pending → withdrawn   the buyer takes their own offer back
--     pending → countered   the buyer replaces it, and the replacement is a new `pending` row whose
--                           `parent_offer_id` is the row just closed
--     pending → expired     **0032's sweeper, and nothing here.** No function in this migration assigns
--                           `expired`; the word appears in none of them
--
-- **Nothing in this migration writes a transition out of a terminal status**, and no function takes a
-- status as a parameter, so no caller can ask for one.
--
-- ---------------------------------------------------------------------------------------------------
-- Who brings an offer into existence, and therefore what a counter is
-- ---------------------------------------------------------------------------------------------------
-- 0015's `offers_buyer_insert` policy is the repository's only statement about who may create an offer
-- row, and it is unambiguous: `with check (buyer_user_id = public.current_user_id() …)`. **Only the buyer
-- inserts.** There is also no column recording who made an offer — no `created_by`, no `offered_by` — so
-- a row inserted by a seller would be indistinguishable from the buyer's own in every list that reads
-- this table.
--
-- A counter is therefore the buyer's: they replace their own live offer with a new one, the row they
-- replace becomes `countered`, and `parent_offer_id` chains the two. That is what `offers_not_own_parent`
-- guards, and it is what keeps `offers_one_open_per_buyer` satisfiable — the parent leaves `pending` in
-- the same statement the child enters it.
--
-- **The consequence, reported rather than worked around:** a seller-initiated counter-price is not
-- expressible in this schema, so `countered → accepted`, `countered → rejected`, `countered → withdrawn`
-- and `countered → expired` are unreachable — a `countered` row has been superseded by its child, and the
-- child is the live offer. Making a seller's counter a row of its own would need a new column and an
-- owner decision; inventing either here is exactly what this increment was told not to do.
--
-- ---------------------------------------------------------------------------------------------------
-- The payment window — the one row this migration seeds, and why
-- ---------------------------------------------------------------------------------------------------
-- D25 is APPROVED in v5.2 with its **default value pending**, and 0033 seeded only the *negotiation*
-- window (`offers.default_expiry_hours` = 48, which `tg_offers_rule` reads on insert). The payment window
-- after acceptance is a different duration with a different meaning, and the key the approved policy names
-- — `finance.payment_due_hours` — **does not exist in this repository**: no migration creates it and
-- `public.site_setting('finance.payment_due_hours')` returns null today.
--
-- So this migration seeds it, at the approved value of 48, shared by offers and service quotes. It is
-- guarded with `on conflict (key) do nothing`, and its `category` is `marketplace` to match the two
-- `finance.*` rows 0021 and 0023 already seeded.
--
-- **`offers.default_expiry_hours` is not reused for it and is not touched.** The two windows answer
-- different questions — how long a buyer's offer stands, and how long the buyer then has to pay — and a
-- single key would tie them together forever. `tg_offers_rule` keeps reading the first and nothing here
-- reads it.
--
-- **There is no fallback to 48 in any function below.** `offer_accept` reads the setting, and if it is
-- missing, not a number, or not positive it answers `payment_policy_missing`, writes nothing at all, and
-- the API reports an integrity failure. A hard-coded 48 in a function would be a second copy of an
-- admin-configurable policy, which is how the console's value and the platform's behaviour drift apart.
--
-- ---------------------------------------------------------------------------------------------------
-- Why these functions are needed
-- ---------------------------------------------------------------------------------------------------
-- 0015's policies resolve the caller through `app_private.jwt_claims()` and the API connects as
-- `app_system`, which carries no claims — the same structural fact behind 0066, 0067, 0068 and 0069. Each
-- function below therefore takes the account as a parameter and applies 0015's own ownership predicate to
-- it: a buyer's function matches `buyer_user_id`, a seller's matches `seller_user_id`, and neither has a
-- branch that decides whether to scope the statement, because the scope *is* the statement.
--
-- **Every write locks its row before it reads it** (`select … for update`), so two reviewers of the same
-- offer serialize: the first wins and the second sees the status the first left behind. The UPDATE is
-- additionally guarded by `status = 'pending'`, so a decision that lost the race writes nothing.
--
-- **A lapsed offer is nobody's to act on.** `expires_at` is a fact on the row and 0032's sweeper is only
-- the thing that records it, so every write below refuses an offer whose window has passed with outcome
-- `expired` — and **writes nothing**, leaving the status for the sweeper that owns it.
--
-- **Not here, deliberately.** No order, checkout, reservation, payment, ledger, payout or provider call:
-- acceptance records the obligation fields 0015 defined and stops. No notification and no outbox event:
-- the repository defines no offer notification event type, template key or writer, and the only offer
-- event that exists anywhere is 0032's own `offer.expired` outbox row — inventing a second would be
-- inventing user-facing semantics. No audit trigger is added: 0015 gave `offers` none, and that is 0015's
-- design. `offer_messages` is untouched: no approved route or scope item covers a per-offer thread.

-- ---------------------------------------------------------------------------------------------------
-- The payment window setting
-- ---------------------------------------------------------------------------------------------------
insert into public.site_settings (key, category, value, value_type, is_public, description_en, description_ar)
values
  ('finance.payment_due_hours', 'marketplace', '48'::jsonb, 'number', false,
   'How long a buyer has to pay after an offer or a service quote is accepted (D25). Shared by both.',
   'المدة المتاحة للمشتري للدفع بعد قبول العرض أو عرض السعر للخدمة (D25). مشتركة بينهما.')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------------------------------
-- The buyer's own offers
-- ---------------------------------------------------------------------------------------------------
-- `offers_party_read`, for a caller the connection cannot see, narrowed to the buyer's side so the two
-- dashboards do not show each other's rows. Keyset paging on `(created_at, id)`, newest first, over
-- 0015's own `offers_buyer` index.
--
-- `is_lapsed` is derived from `expires_at`, not stored: it is how a surface can render a `pending` offer
-- whose window has passed without this migration inventing a seventh status or writing one 0032 owns.
create or replace function app_private.offers_for_buyer(
  p_user_id uuid,
  p_limit integer default 20,
  p_cursor_created_at timestamptz default null,
  p_cursor_id uuid default null
) returns table (
  id uuid,
  listing_id uuid,
  listing_slug text,
  listing_title text,
  seller_slug text,
  seller_display_name text,
  amount_minor bigint,
  currency_code text,
  currency_minor_unit smallint,
  quantity integer,
  message text,
  status text,
  is_lapsed boolean,
  expires_at timestamptz,
  responded_at timestamptz,
  accepted_at timestamptz,
  payment_due_at timestamptz,
  parent_offer_id uuid,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select o.id,
         o.listing_id,
         l.slug,
         l.title,
         s.slug,
         s.display_name,
         o.amount_minor,
         o.currency_code::text,
         c.decimal_places,
         o.quantity,
         o.message,
         o.status,
         o.status = 'pending' and o.expires_at <= now(),
         o.expires_at,
         o.responded_at,
         o.accepted_at,
         o.payment_due_at,
         o.parent_offer_id,
         o.created_at
    from public.offers o
    join public.listings l on l.id = o.listing_id
    join public.seller_profiles s on s.user_id = o.seller_user_id
    join public.currencies c on c.code = o.currency_code
   where o.buyer_user_id = p_user_id
     and (
       p_cursor_created_at is null
       or p_cursor_id is null
       or (o.created_at, o.id) < (p_cursor_created_at, p_cursor_id)
     )
   order by o.created_at desc, o.id desc
   limit least(greatest(coalesce(p_limit, 20), 1), 51);
$$;

comment on function app_private.offers_for_buyer(uuid, integer, timestamptz, uuid) is
  'One page of the offers an account has made, newest first, over 0015''s own offers_buyer index. Scoped to buyer_user_id in the statement, so another account''s offer is never matched. is_lapsed is derived from expires_at and is not a status.';

-- ---------------------------------------------------------------------------------------------------
-- The seller's received offers
-- ---------------------------------------------------------------------------------------------------
-- The same page from the other side, over 0015's `offers_seller_queue`. A separate function rather than a
-- role parameter: each one's predicate is fixed in the statement, so there is no argument a caller could
-- supply that would show them the wrong side of a negotiation.
create or replace function app_private.offers_for_seller(
  p_user_id uuid,
  p_limit integer default 20,
  p_cursor_created_at timestamptz default null,
  p_cursor_id uuid default null
) returns table (
  id uuid,
  listing_id uuid,
  listing_slug text,
  listing_title text,
  buyer_display_name text,
  amount_minor bigint,
  currency_code text,
  currency_minor_unit smallint,
  quantity integer,
  message text,
  status text,
  is_lapsed boolean,
  expires_at timestamptz,
  responded_at timestamptz,
  accepted_at timestamptz,
  payment_due_at timestamptz,
  parent_offer_id uuid,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select o.id,
         o.listing_id,
         l.slug,
         l.title,
         -- The buyer's own display name, which the seller already has from the negotiation. No account
         -- identifier, no email and no phone number: a seller reviewing an offer needs none of them.
         p.display_name,
         o.amount_minor,
         o.currency_code::text,
         c.decimal_places,
         o.quantity,
         o.message,
         o.status,
         o.status = 'pending' and o.expires_at <= now(),
         o.expires_at,
         o.responded_at,
         o.accepted_at,
         o.payment_due_at,
         o.parent_offer_id,
         o.created_at
    from public.offers o
    join public.listings l on l.id = o.listing_id
    join public.profiles p on p.id = o.buyer_user_id
    join public.currencies c on c.code = o.currency_code
   where o.seller_user_id = p_user_id
     and (
       p_cursor_created_at is null
       or p_cursor_id is null
       or (o.created_at, o.id) < (p_cursor_created_at, p_cursor_id)
     )
   order by o.created_at desc, o.id desc
   limit least(greatest(coalesce(p_limit, 20), 1), 51);
$$;

comment on function app_private.offers_for_seller(uuid, integer, timestamptz, uuid) is
  'One page of the offers made to an account''s storefront, newest first, over 0015''s own offers_seller_queue index. Scoped to seller_user_id in the statement. Returns the buyer''s display name and no other fact about them.';

-- ---------------------------------------------------------------------------------------------------
-- Opening an offer
-- ---------------------------------------------------------------------------------------------------
-- The buyer supplies an amount, a quantity, a note and the listing. **They do not supply the seller, the
-- currency or the expiry**: the seller and the currency come out of the listing row, and `expires_at` is
-- left null so 0015's `tg_offers_rule` applies `offers.default_expiry_hours` itself. That trigger also
-- re-checks that the listing is purchasable and that the seller named is the listing's, so the checks
-- below are the ones that produce a usable answer, not the ones that make it safe.
create or replace function app_private.offer_create(
  p_buyer_id uuid,
  p_listing_id uuid,
  p_amount_minor bigint,
  p_quantity integer,
  p_message text default null
) returns table (
  outcome text,
  offer_id uuid,
  status text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_seller uuid;
  v_currency char(3);
  v_listing_status text;
  v_message text := nullif(btrim(coalesce(p_message, '')), '');
  v_offer_id uuid;
begin
  if p_buyer_id is null or p_listing_id is null then
    return query select 'not_found'::text, null::uuid, null::text;
    return;
  end if;
  if p_amount_minor is null or p_amount_minor <= 0
     or p_quantity is null or p_quantity < 1
     or (v_message is not null and length(v_message) > 2000) then
    return query select 'invalid'::text, null::uuid, null::text;
    return;
  end if;

  select l.seller_user_id, l.currency_code, l.status
    into v_seller, v_currency, v_listing_status
    from public.listings l where l.id = p_listing_id;

  if v_seller is null then
    return query select 'not_found'::text, null::uuid, null::text;
    return;
  end if;
  -- 0015's own admission test, so a listing a buyer could not buy cannot be offered on either.
  if not public.listing_status_is_purchasable(v_listing_status) then
    return query select 'not_available'::text, null::uuid, null::text;
    return;
  end if;
  -- `offers_not_self`, answered as an outcome rather than as a constraint violation.
  if v_seller = p_buyer_id then
    return query select 'own_listing'::text, null::uuid, null::text;
    return;
  end if;
  -- 0015's `offers_buyer_insert` also refuses a blocked pair; `app_system` is not bound by that policy,
  -- so the rule is applied here instead of being lost.
  if public.is_blocked_between(p_buyer_id, v_seller) then
    return query select 'blocked'::text, null::uuid, null::text;
    return;
  end if;
  -- `offers_one_open_per_buyer`: one live offer per buyer per listing. Reported so the surface can send
  -- somebody to the offer they already have instead of showing a unique-violation.
  if exists (
    select 1 from public.offers o
     where o.listing_id = p_listing_id and o.buyer_user_id = p_buyer_id and o.status = 'pending'
  ) then
    return query select 'exists'::text, null::uuid, null::text;
    return;
  end if;

  insert into public.offers (
    listing_id, currency_code, buyer_user_id, seller_user_id, amount_minor, quantity, message
  )
  values (p_listing_id, v_currency, p_buyer_id, v_seller, p_amount_minor, p_quantity, v_message)
  returning id into v_offer_id;

  return query select 'created'::text, v_offer_id, 'pending'::text;
end;
$$;

comment on function app_private.offer_create(uuid, uuid, bigint, integer, text) is
  'Opens one offer for a buyer. The seller and the currency come out of the listing row and the expiry from 0015''s own trigger, so a caller supplies none of the three. Applies 0015''s purchasable, not-self, not-blocked and one-open-per-buyer rules as outcomes rather than as constraint violations. Writes no status other than the table''s own default.';

-- ---------------------------------------------------------------------------------------------------
-- Countering — the buyer replaces their own live offer
-- ---------------------------------------------------------------------------------------------------
-- One transaction, two rows: the parent moves to `countered` and the replacement is inserted with
-- `parent_offer_id` pointing at it.
--
-- **A cross-listing or cross-seller parent is structurally impossible here**, not merely refused: the
-- listing, the seller and the currency of the new row are copied from the parent that was locked, and
-- there is no parameter for any of the three. The only thing a caller names is an offer of their own.
create or replace function app_private.offer_counter(
  p_buyer_id uuid,
  p_parent_offer_id uuid,
  p_amount_minor bigint,
  p_quantity integer,
  p_message text default null
) returns table (
  outcome text,
  offer_id uuid,
  status text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_parent public.offers;
  v_listing_status text;
  v_message text := nullif(btrim(coalesce(p_message, '')), '');
  v_now timestamptz := now();
  v_offer_id uuid;
begin
  if p_buyer_id is null or p_parent_offer_id is null then
    return query select 'not_found'::text, null::uuid, null::text;
    return;
  end if;
  if p_amount_minor is null or p_amount_minor <= 0
     or p_quantity is null or p_quantity < 1
     or (v_message is not null and length(v_message) > 2000) then
    return query select 'invalid'::text, null::uuid, null::text;
    return;
  end if;

  -- Locked and scoped in one statement: another buyer's offer is not refused, it is never matched.
  select * into v_parent
    from public.offers o
   where o.id = p_parent_offer_id and o.buyer_user_id = p_buyer_id
     for update;

  if v_parent.id is null then
    return query select 'not_found'::text, null::uuid, null::text;
    return;
  end if;
  if v_parent.status <> 'pending' then
    return query select 'conflict'::text, null::uuid, v_parent.status;
    return;
  end if;
  if v_parent.expires_at <= v_now then
    -- Lapsed. 0032's sweeper owns writing `expired`, so nothing is written here.
    return query select 'expired'::text, null::uuid, v_parent.status;
    return;
  end if;

  select l.status into v_listing_status from public.listings l where l.id = v_parent.listing_id;
  if not public.listing_status_is_purchasable(v_listing_status) then
    return query select 'not_available'::text, null::uuid, v_parent.status;
    return;
  end if;
  if public.is_blocked_between(v_parent.buyer_user_id, v_parent.seller_user_id) then
    return query select 'blocked'::text, null::uuid, v_parent.status;
    return;
  end if;

  -- The parent leaves `pending` first, so `offers_one_open_per_buyer` is satisfied when the child enters
  -- it. `offers_responded_when_decided` requires the response time, and this is that response.
  update public.offers o
     set status = 'countered', responded_at = v_now
   where o.id = v_parent.id and o.status = 'pending';

  if not found then
    -- Lost to a concurrent decision between the lock and the write.
    select o.status into v_listing_status from public.offers o where o.id = v_parent.id;
    return query select 'conflict'::text, null::uuid, v_listing_status;
    return;
  end if;

  insert into public.offers (
    listing_id, currency_code, buyer_user_id, seller_user_id, parent_offer_id,
    amount_minor, quantity, message
  )
  values (
    v_parent.listing_id, v_parent.currency_code, v_parent.buyer_user_id, v_parent.seller_user_id,
    v_parent.id, p_amount_minor, p_quantity, v_message
  )
  returning id into v_offer_id;

  return query select 'countered'::text, v_offer_id, 'pending'::text;
end;
$$;

comment on function app_private.offer_counter(uuid, uuid, bigint, integer, text) is
  'Replaces a buyer''s own live offer with a new one: the parent moves to countered and the replacement carries parent_offer_id. The listing, seller and currency are copied from the locked parent and are not parameters, so a cross-listing or cross-seller parent cannot be constructed. One transaction, so the two rows can never disagree.';

-- ---------------------------------------------------------------------------------------------------
-- The seller declines
-- ---------------------------------------------------------------------------------------------------
create or replace function app_private.offer_reject(
  p_seller_id uuid,
  p_offer_id uuid
) returns table (
  outcome text,
  status text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_offer public.offers;
  v_now timestamptz := now();
  v_status text;
begin
  if p_seller_id is null or p_offer_id is null then
    return query select 'not_found'::text, null::text;
    return;
  end if;

  select * into v_offer
    from public.offers o
   where o.id = p_offer_id and o.seller_user_id = p_seller_id
     for update;

  if v_offer.id is null then
    return query select 'not_found'::text, null::text;
    return;
  end if;
  if v_offer.status <> 'pending' then
    return query select 'conflict'::text, v_offer.status;
    return;
  end if;
  if v_offer.expires_at <= v_now then
    return query select 'expired'::text, v_offer.status;
    return;
  end if;

  update public.offers o
     set status = 'rejected', responded_at = v_now
   where o.id = v_offer.id and o.status = 'pending';

  if not found then
    select o.status into v_status from public.offers o where o.id = v_offer.id;
    return query select 'conflict'::text, v_status;
    return;
  end if;

  return query select 'rejected'::text, 'rejected'::text;
end;
$$;

comment on function app_private.offer_reject(uuid, uuid) is
  'The seller declines one live offer made to their own storefront. Scoped to seller_user_id in the statement and guarded by status = pending in the UPDATE, so a repeated or concurrent decision answers conflict rather than overwriting one.';

-- ---------------------------------------------------------------------------------------------------
-- The buyer takes their offer back
-- ---------------------------------------------------------------------------------------------------
create or replace function app_private.offer_withdraw(
  p_buyer_id uuid,
  p_offer_id uuid
) returns table (
  outcome text,
  status text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_offer public.offers;
  v_now timestamptz := now();
  v_status text;
begin
  if p_buyer_id is null or p_offer_id is null then
    return query select 'not_found'::text, null::text;
    return;
  end if;

  select * into v_offer
    from public.offers o
   where o.id = p_offer_id and o.buyer_user_id = p_buyer_id
     for update;

  if v_offer.id is null then
    return query select 'not_found'::text, null::text;
    return;
  end if;
  if v_offer.status <> 'pending' then
    return query select 'conflict'::text, v_offer.status;
    return;
  end if;
  if v_offer.expires_at <= v_now then
    return query select 'expired'::text, v_offer.status;
    return;
  end if;

  update public.offers o
     set status = 'withdrawn', responded_at = v_now
   where o.id = v_offer.id and o.status = 'pending';

  if not found then
    select o.status into v_status from public.offers o where o.id = v_offer.id;
    return query select 'conflict'::text, v_status;
    return;
  end if;

  return query select 'withdrawn'::text, 'withdrawn'::text;
end;
$$;

comment on function app_private.offer_withdraw(uuid, uuid) is
  'The buyer takes their own live offer back. Scoped to buyer_user_id in the statement; a seller cannot reach this transition and a buyer cannot reach another buyer''s offer.';

-- ---------------------------------------------------------------------------------------------------
-- Acceptance — the obligation transition
-- ---------------------------------------------------------------------------------------------------
-- **One UPDATE, four columns, one timestamp.** `status`, `responded_at`, `accepted_at`, `accepted_terms`
-- and `payment_due_at` are set together, which is what 0015's `offers_accepted_has_time` and
-- `offers_accepted_is_snapshotted` require — neither is satisfiable by a sequence of writes.
--
-- `v_now` is captured once and used for `responded_at`, `accepted_at` and the base of `payment_due_at`,
-- so the acceptance time and the payment deadline cannot disagree by a microsecond let alone a retry.
--
-- **`payment_due_at = accepted_at + finance.payment_due_hours`, and nothing else.**
-- `offers.default_expiry_hours` is not read here, no duration is hard-coded, and there is no fallback: a
-- setting that is absent, not a number or not positive answers `payment_policy_missing` and writes
-- nothing. The browser has no way to influence it — `payment_due_at` is not a parameter of this function.
--
-- **What acceptance does not do.** No order, no checkout, no reservation, no payment, no ledger entry, no
-- payout, no provider call, and no event. It records the payable obligation on the offer row; Phase 8
-- consumes it later.
create or replace function app_private.offer_accept(
  p_seller_id uuid,
  p_offer_id uuid
) returns table (
  outcome text,
  status text,
  accepted_at timestamptz,
  payment_due_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_offer public.offers;
  v_now timestamptz := now();
  v_hours integer;
  v_raw jsonb;
  v_due timestamptz;
  v_status text;
begin
  if p_seller_id is null or p_offer_id is null then
    return query select 'not_found'::text, null::text, null::timestamptz, null::timestamptz;
    return;
  end if;

  select * into v_offer
    from public.offers o
   where o.id = p_offer_id and o.seller_user_id = p_seller_id
     for update;

  if v_offer.id is null then
    return query select 'not_found'::text, null::text, null::timestamptz, null::timestamptz;
    return;
  end if;
  if v_offer.status <> 'pending' then
    return query select 'conflict'::text, v_offer.status, null::timestamptz, null::timestamptz;
    return;
  end if;
  if v_offer.expires_at <= v_now then
    return query select 'expired'::text, v_offer.status, null::timestamptz, null::timestamptz;
    return;
  end if;

  -- D25's window. Read, never assumed, and never defaulted.
  v_raw := public.site_setting('finance.payment_due_hours');
  if v_raw is null or jsonb_typeof(v_raw) <> 'number' then
    return query select 'payment_policy_missing'::text, v_offer.status, null::timestamptz, null::timestamptz;
    return;
  end if;
  v_hours := (v_raw #>> '{}')::numeric::integer;
  if v_hours is null or v_hours <= 0 then
    return query select 'payment_policy_missing'::text, v_offer.status, null::timestamptz, null::timestamptz;
    return;
  end if;

  v_due := v_now + make_interval(hours => v_hours);

  update public.offers o
     set status = 'accepted',
         responded_at = v_now,
         accepted_at = v_now,
         -- The snapshot is the offer's own authoritative fields plus the window that was applied. It
         -- restates nothing the row does not already hold and invents no term.
         accepted_terms = jsonb_build_object(
           'listing_id', v_offer.listing_id,
           'currency_code', v_offer.currency_code,
           'amount_minor', v_offer.amount_minor::text,
           'quantity', v_offer.quantity,
           'payment_due_hours', v_hours
         ),
         payment_due_at = v_due
   where o.id = v_offer.id and o.status = 'pending';

  if not found then
    select o.status into v_status from public.offers o where o.id = v_offer.id;
    return query select 'conflict'::text, v_status, null::timestamptz, null::timestamptz;
    return;
  end if;

  return query select 'accepted'::text, 'accepted'::text, v_now, v_due;
end;
$$;

comment on function app_private.offer_accept(uuid, uuid) is
  'The seller accepts one live offer, recording 0015''s obligation fields in a single UPDATE: status, responded_at, accepted_at, accepted_terms and payment_due_at together, from one transaction-consistent timestamp. payment_due_at is accepted_at plus finance.payment_due_hours, read from site_settings with no fallback — a missing or unusable setting answers payment_policy_missing and writes nothing. Creates no order, checkout, reservation, payment, ledger entry, payout or event; Phase 8 consumes the obligation later.';

-- ---------------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------------
-- The API role alone. `authenticated` gains nothing: it already has 0015's policies, which resolve the
-- caller from its own verified session, and a function that takes an account as a parameter must never be
-- callable by something that could choose it.
revoke all on function app_private.offers_for_buyer(uuid, integer, timestamptz, uuid) from public;
revoke all on function app_private.offers_for_seller(uuid, integer, timestamptz, uuid) from public;
revoke all on function app_private.offer_create(uuid, uuid, bigint, integer, text) from public;
revoke all on function app_private.offer_counter(uuid, uuid, bigint, integer, text) from public;
revoke all on function app_private.offer_reject(uuid, uuid) from public;
revoke all on function app_private.offer_withdraw(uuid, uuid) from public;
revoke all on function app_private.offer_accept(uuid, uuid) from public;

grant execute on function app_private.offers_for_buyer(uuid, integer, timestamptz, uuid) to app_system;
grant execute on function app_private.offers_for_seller(uuid, integer, timestamptz, uuid) to app_system;
grant execute on function app_private.offer_create(uuid, uuid, bigint, integer, text) to app_system;
grant execute on function app_private.offer_counter(uuid, uuid, bigint, integer, text) to app_system;
grant execute on function app_private.offer_reject(uuid, uuid) to app_system;
grant execute on function app_private.offer_withdraw(uuid, uuid) to app_system;
grant execute on function app_private.offer_accept(uuid, uuid) to app_system;

-- ---------------------------------------------------------------------------------------------------
-- The security contract still holds
-- ---------------------------------------------------------------------------------------------------
do $$
begin
  perform app_private.assert_security_contract();
end;
$$;
