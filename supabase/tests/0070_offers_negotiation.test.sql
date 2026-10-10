-- pgTAP — migration 0070: offers, negotiation and acceptance.
--
-- Eight things are being held to account.
--
-- **The transitions are 0015's, and no others exist.** Every legal move is driven, and every illegal one is
-- attempted: a decision on an offer that is already accepted, rejected, withdrawn, countered or expired
-- answers `conflict` and changes nothing. No function assigns `expired`, asserted on the sources as well as
-- by driving them.
--
-- **Ownership is the statement's.** A buyer cannot accept or reject; a seller cannot create, counter or
-- withdraw; neither can reach the other party's offer, and another seller's offer is not refused but never
-- matched — indistinguishable from one that does not exist.
--
-- **A counter cannot cross anything.** The listing, seller and currency of the replacement are copied from
-- the locked parent, so a parent belonging to another listing, another seller or another buyer cannot be
-- used at all; `offers_one_open_per_buyer` still holds afterwards, and the chain is recorded.
--
-- **Acceptance is one write.** `status`, `responded_at`, `accepted_at`, `accepted_terms` and
-- `payment_due_at` land together; `accepted_at` and `payment_due_at` come from one timestamp; and 0015's
-- own constraints — `offers_accepted_has_time`, `offers_accepted_is_snapshotted` — are satisfied by that
-- single statement rather than by a sequence.
--
-- **`payment_due_at = accepted_at + finance.payment_due_hours`, exactly.** Proven at the seeded 48, proven
-- again after the setting is changed to another value, and proven not to be
-- `offers.default_expiry_hours` by setting the two to different numbers and checking which one moved.
--
-- **A missing or unusable setting writes nothing.** Absent, wrong type, zero and negative each answer
-- `payment_policy_missing` and leave the offer pending. There is no 48 anywhere in the function's source.
--
-- **Expiry stays 0032's.** A lapsed offer is not actionable by anybody; an accepted offer whose
-- `expires_at` has passed is not re-expired by `expire_due_offers`; and a `countered` parent is not swept
-- either, because the sweeper only ever looked at `pending`.
--
-- **Repetition and races.** Two accepts, accept then reject, accept then withdraw, counter then accept on
-- the parent, and duplicates of each: the first wins, the rest are `conflict`, and the row is unchanged.
--
-- Deterministic: fixed uuids, no wall-clock dependence beyond the intervals it sets itself. Everything runs
-- in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(160);

-- ---------------------------------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('c0000000-0000-4000-8000-00000000000a', 'off-buyer-a@test.invalid'),
  ('c0000000-0000-4000-8000-00000000000b', 'off-buyer-b@test.invalid'),
  ('c0000000-0000-4000-8000-00000000000c', 'off-buyer-blocked@test.invalid'),
  ('c0000000-0000-4000-8000-000000000011', 'off-seller-one@test.invalid'),
  ('c0000000-0000-4000-8000-000000000012', 'off-seller-two@test.invalid');

insert into public.profiles (id, display_name) values
  ('c0000000-0000-4000-8000-00000000000a', 'Buyer A'),
  ('c0000000-0000-4000-8000-00000000000b', 'Buyer B'),
  ('c0000000-0000-4000-8000-00000000000c', 'Blocked Buyer')
on conflict (id) do update set display_name = excluded.display_name;

insert into public.seller_profiles
  (user_id, slug, display_name, country_code, status, verification_status, verified_at)
values
  ('c0000000-0000-4000-8000-000000000011', 'off-shop-one', 'Offer Shop One', 'EG', 'active',
   'verified', now() - interval '10 days'),
  ('c0000000-0000-4000-8000-000000000012', 'off-shop-two', 'Offer Shop Two', 'EG', 'active',
   'verified', now() - interval '10 days');

insert into public.categories (id, parent_id, slug, is_active, sort_order) values
  ('c0000000-0000-4000-8000-0000000000c1', null, 'offer-goods', true, 91);
insert into public.category_translations (category_id, locale_code, name) values
  ('c0000000-0000-4000-8000-0000000000c1', 'en', 'Offer goods'),
  ('c0000000-0000-4000-8000-0000000000c1', 'ar', 'سلع العروض');

create or replace function pg_temp.listing(p_id uuid, p_slug text, p_status text, p_seller uuid)
returns void language plpgsql as $$
begin
  insert into public.listings (
    id, seller_user_id, listing_type_code, category_id, slug, title, description, content_language,
    currency_code, price_minor, is_negotiable, status, country_code, city, created_at, approved_at
  ) values (
    p_id, p_seller, 'product', 'c0000000-0000-4000-8000-0000000000c1', p_slug,
    'An offerable listing', 'A description long enough to satisfy the length rule.', 'en',
    'EGP', 500000, true, p_status, 'EG', 'Cairo', now() - interval '1 hour',
    case when p_status in ('approved', 'active', 'sold', 'expired', 'archived')
      then now() - interval '1 hour' else null end
  );
end;
$$;

select pg_temp.listing('c0000000-0000-4000-8000-0000000000f1', 'off-live-one', 'active',
  'c0000000-0000-4000-8000-000000000011');
select pg_temp.listing('c0000000-0000-4000-8000-0000000000f2', 'off-live-two', 'active',
  'c0000000-0000-4000-8000-000000000012');
select pg_temp.listing('c0000000-0000-4000-8000-0000000000f3', 'off-draft', 'draft',
  'c0000000-0000-4000-8000-000000000011');

insert into public.user_blocks (blocker_id, blocked_id) values
  ('c0000000-0000-4000-8000-000000000011', 'c0000000-0000-4000-8000-00000000000c');

-- Shorthands -----------------------------------------------------------------------------------------
create or replace function pg_temp.status_of(p_id uuid) returns text
language sql as $$ select o.status from public.offers o where o.id = p_id; $$;

create or replace function pg_temp.make(p_buyer uuid, p_listing uuid, p_amount bigint) returns uuid
language sql as $$
  select offer_id from app_private.offer_create(p_buyer, p_listing, p_amount, 1, 'A note');
$$;

-- ---------------------------------------------------------------------------------------------------
-- 1. The migration's shape
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('offers_for_buyer', 'offers_for_seller', 'offer_create', 'offer_counter',
                        'offer_reject', 'offer_withdraw', 'offer_accept')),
  7, '0070 defines exactly seven functions');

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and (p.proname like 'offer\_%' or p.proname like 'offers\_for\_%')
      and (not p.prosecdef
           or not exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) cfg
                           where cfg = 'search_path=pg_catalog, public'))),
  0, 'all of them are SECURITY DEFINER with the pinned search_path');

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and (p.proname like 'offer\_%' or p.proname like 'offers\_for\_%')
      and (has_function_privilege('public', p.oid, 'execute')
           or has_function_privilege('authenticated', p.oid, 'execute')
           or has_function_privilege('app_worker', p.oid, 'execute'))),
  0, 'neither PUBLIC, authenticated nor app_worker may execute any of them');

-- All seven when 0070 closed. **None since 0110**: OD-A4 removed the buyer↔seller offer entirely, and
-- 0110 closed the path by revoking `app_system`'s execute rather than by dropping anything — so every
-- behavioural proof in this file still runs, directly as the owner, while the API can no longer reach a
-- single one of these functions. The assertion is inverted rather than removed, because "the API cannot
-- call these" is now the property worth holding.
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and (p.proname like 'offer\_%' or p.proname like 'offers\_for\_%')
      and has_function_privilege('app_system', p.oid, 'execute')),
  0, 'and since 0110 app_system may execute none of them either: the offer path is closed (OD-A4)');

-- 0015's model is untouched.
select is(
  (select count(*)::int from pg_policy p where p.polrelid = 'public.offers'::regclass),
  3, 'offers still carries exactly 0015''s three policies');
select is(
  (select count(*)::int from pg_trigger t
    where t.tgrelid = 'public.offers'::regclass and not t.tgisinternal),
  2, 'and exactly 0015''s two triggers');
select has_index('public', 'offers', 'offers_one_open_per_buyer', '0015''s one-open index is still there');
select has_index('public', 'offers', 'offers_expiring', 'and its pending-only expiry index');

-- No function in this migration writes `expired`.
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and (p.proname like 'offer\_%' or p.proname like 'offers\_for\_%')
      and p.prosrc like '%''expired''%' and p.prosrc like '%status =%''expired''%'),
  0, 'no function in 0070 assigns the expired status: 0032''s sweeper owns it');

-- And none of them hard-codes the payment window.
select ok(
  (select p.prosrc not like '%48%' from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'offer_accept'),
  'the acceptance writer contains no hard-coded duration');
select ok(
  (select p.prosrc like '%finance.payment_due_hours%'
      and p.prosrc not like '%offers.default_expiry_hours%'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'offer_accept'),
  'it reads finance.payment_due_hours and never the negotiation window');

-- ---------------------------------------------------------------------------------------------------
-- 2. The setting this migration seeds
-- ---------------------------------------------------------------------------------------------------
select is(
  (select value from public.site_settings where key = 'finance.payment_due_hours'),
  '48'::jsonb, 'finance.payment_due_hours is seeded at the approved 48');
select is(
  (select value_type from public.site_settings where key = 'finance.payment_due_hours'),
  'number', 'as a number');
select is(
  (select is_public from public.site_settings where key = 'finance.payment_due_hours'),
  false, 'and it is not public');
select is(
  (select value from public.site_settings where key = 'offers.default_expiry_hours'),
  '48'::jsonb, 'and 0033''s negotiation window is untouched');

-- ---------------------------------------------------------------------------------------------------
-- 3. Opening an offer
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.offer_create(
     'c0000000-0000-4000-8000-00000000000a', 'c0000000-0000-4000-8000-0000000000f1', 400000, 2, 'Please')),
  'created', 'a buyer opens an offer on a live listing');

select is(
  (select count(*)::int from public.offers o
    where o.buyer_user_id = 'c0000000-0000-4000-8000-00000000000a'),
  1, 'and exactly one row exists');
select is(
  (select o.status from public.offers o where o.buyer_user_id = 'c0000000-0000-4000-8000-00000000000a'),
  'pending', 'it is pending');
select is(
  (select o.seller_user_id from public.offers o
    where o.buyer_user_id = 'c0000000-0000-4000-8000-00000000000a'),
  'c0000000-0000-4000-8000-000000000011'::uuid,
  'the seller came from the listing, not from the caller');
select is(
  (select o.currency_code::text from public.offers o
    where o.buyer_user_id = 'c0000000-0000-4000-8000-00000000000a'),
  'EGP', 'and so did the currency');
select is(
  (select o.quantity from public.offers o
    where o.buyer_user_id = 'c0000000-0000-4000-8000-00000000000a'),
  2, 'the quantity is the one asked for');
select ok(
  (select o.expires_at > now() and o.expires_at <= now() + interval '48 hours' + interval '1 minute'
     from public.offers o where o.buyer_user_id = 'c0000000-0000-4000-8000-00000000000a'),
  'the negotiation window is 0015''s trigger applying offers.default_expiry_hours');
select is(
  (select o.responded_at from public.offers o
    where o.buyer_user_id = 'c0000000-0000-4000-8000-00000000000a'),
  null, 'a pending offer has no response time, which 0015''s constraint requires');
select is(
  (select o.accepted_at from public.offers o
    where o.buyer_user_id = 'c0000000-0000-4000-8000-00000000000a'),
  null, 'and no acceptance time');
select is(
  (select o.payment_due_at from public.offers o
    where o.buyer_user_id = 'c0000000-0000-4000-8000-00000000000a'),
  null, 'and no payment deadline: that is acceptance''s to set');

select is(
  (select outcome from app_private.offer_create(
     'c0000000-0000-4000-8000-00000000000a', 'c0000000-0000-4000-8000-0000000000f1', 410000, 1, null)),
  'exists', 'a second live offer on the same listing is refused, by 0015''s own index');
select is(
  (select outcome from app_private.offer_create(
     'c0000000-0000-4000-8000-00000000000a', 'c0000000-0000-4000-8000-0000000000f3', 400000, 1, null)),
  'not_available', 'a draft listing cannot be offered on');
select is(
  (select outcome from app_private.offer_create(
     'c0000000-0000-4000-8000-00000000000a', 'c0000000-0000-4000-8000-0000000000ff', 400000, 1, null)),
  'not_found', 'nor can a listing that does not exist');
select is(
  (select outcome from app_private.offer_create(
     'c0000000-0000-4000-8000-000000000011', 'c0000000-0000-4000-8000-0000000000f1', 400000, 1, null)),
  'own_listing', 'a seller cannot offer on their own listing');
select is(
  (select outcome from app_private.offer_create(
     'c0000000-0000-4000-8000-00000000000c', 'c0000000-0000-4000-8000-0000000000f1', 400000, 1, null)),
  'blocked', 'a blocked pair cannot open an offer, exactly as 0015''s insert policy says');
select is(
  (select outcome from app_private.offer_create(
     null, 'c0000000-0000-4000-8000-0000000000f1', 400000, 1, null)),
  'not_found', 'and no account cannot');

select is(
  (select outcome from app_private.offer_create(
     'c0000000-0000-4000-8000-00000000000b', 'c0000000-0000-4000-8000-0000000000f1', 0, 1, null)),
  'invalid', 'a zero amount is refused');
select is(
  (select outcome from app_private.offer_create(
     'c0000000-0000-4000-8000-00000000000b', 'c0000000-0000-4000-8000-0000000000f1', -5, 1, null)),
  'invalid', 'a negative amount is refused');
select is(
  (select outcome from app_private.offer_create(
     'c0000000-0000-4000-8000-00000000000b', 'c0000000-0000-4000-8000-0000000000f1', 400000, 0, null)),
  'invalid', 'a zero quantity is refused');
select is(
  (select outcome from app_private.offer_create(
     'c0000000-0000-4000-8000-00000000000b', 'c0000000-0000-4000-8000-0000000000f1', 400000, 1,
     repeat('x', 2001))),
  'invalid', 'and a note longer than 0015''s column allows');
select is(
  (select count(*)::int from public.offers o
    where o.buyer_user_id = 'c0000000-0000-4000-8000-00000000000b'),
  0, 'none of those four wrote anything');

-- A blank note becomes null rather than an empty string.
select is(
  (select outcome from app_private.offer_create(
     'c0000000-0000-4000-8000-00000000000b', 'c0000000-0000-4000-8000-0000000000f2', 300000, 1, '   ')),
  'created', 'a second buyer opens an offer on the other seller''s listing');
select is(
  (select o.message from public.offers o
    where o.buyer_user_id = 'c0000000-0000-4000-8000-00000000000b'),
  null, 'a blank note is stored as nothing at all');

-- ---------------------------------------------------------------------------------------------------
-- 4. Ownership isolation on every write
-- ---------------------------------------------------------------------------------------------------
create or replace function pg_temp.offer_a() returns uuid language sql as $$
  select o.id from public.offers o where o.buyer_user_id = 'c0000000-0000-4000-8000-00000000000a';
$$;
create or replace function pg_temp.offer_b() returns uuid language sql as $$
  select o.id from public.offers o where o.buyer_user_id = 'c0000000-0000-4000-8000-00000000000b';
$$;

select is(
  (select outcome from app_private.offer_accept('c0000000-0000-4000-8000-00000000000a', pg_temp.offer_a())),
  'not_found', 'the buyer cannot accept their own offer');
select is(
  (select outcome from app_private.offer_reject('c0000000-0000-4000-8000-00000000000a', pg_temp.offer_a())),
  'not_found', 'nor reject it');
select is(
  (select outcome from app_private.offer_withdraw('c0000000-0000-4000-8000-000000000011', pg_temp.offer_a())),
  'not_found', 'the seller cannot withdraw the buyer''s offer');
select is(
  (select outcome from app_private.offer_counter(
     'c0000000-0000-4000-8000-000000000011', pg_temp.offer_a(), 420000, 1, null)),
  'not_found', 'nor counter it: only the buyer may bring an offer row into existence');
select is(
  (select outcome from app_private.offer_accept('c0000000-0000-4000-8000-000000000012', pg_temp.offer_a())),
  'not_found', 'another seller cannot accept an offer made to somebody else''s storefront');
select is(
  (select outcome from app_private.offer_reject('c0000000-0000-4000-8000-000000000012', pg_temp.offer_a())),
  'not_found', 'nor reject it');
select is(
  (select outcome from app_private.offer_withdraw('c0000000-0000-4000-8000-00000000000b', pg_temp.offer_a())),
  'not_found', 'another buyer cannot withdraw it');
select is(
  (select outcome from app_private.offer_counter(
     'c0000000-0000-4000-8000-00000000000b', pg_temp.offer_a(), 420000, 1, null)),
  'not_found', 'nor counter it — indistinguishable from an offer that does not exist');
select is(pg_temp.status_of(pg_temp.offer_a()), 'pending',
  'and after all eight cross-party attempts the offer is untouched');

-- ---------------------------------------------------------------------------------------------------
-- 5. The reads are scoped too
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::int from app_private.offers_for_buyer('c0000000-0000-4000-8000-00000000000a', 20, null, null)),
  1, 'a buyer sees their own offer');
select is(
  (select count(*)::int from app_private.offers_for_buyer('c0000000-0000-4000-8000-000000000011', 20, null, null)),
  0, 'the seller sees nothing on the buyer''s list');
select is(
  (select count(*)::int from app_private.offers_for_seller('c0000000-0000-4000-8000-000000000011', 20, null, null)),
  1, 'and their own received offer on the seller''s list');
select is(
  (select count(*)::int from app_private.offers_for_seller('c0000000-0000-4000-8000-000000000012', 20, null, null)),
  1, 'each seller sees only the offers made to their own storefront');
select is(
  (select count(*)::int from app_private.offers_for_seller('c0000000-0000-4000-8000-00000000000a', 20, null, null)),
  0, 'a buyer sees nothing on the seller''s list');
select is(
  (select count(*)::int from app_private.offers_for_buyer(null, 20, null, null)),
  0, 'and no account sees nothing');

select is(
  (select listing_slug from app_private.offers_for_buyer('c0000000-0000-4000-8000-00000000000a', 20, null, null)),
  'off-live-one', 'the buyer''s row names the listing');
select is(
  (select seller_display_name from app_private.offers_for_buyer('c0000000-0000-4000-8000-00000000000a', 20, null, null)),
  'Offer Shop One', 'and the storefront');
select is(
  (select buyer_display_name from app_private.offers_for_seller('c0000000-0000-4000-8000-000000000011', 20, null, null)),
  'Buyer A', 'the seller''s row names the buyer by display name');
select is(
  (select currency_minor_unit from app_private.offers_for_buyer('c0000000-0000-4000-8000-00000000000a', 20, null, null)),
  2::smallint, 'money travels with its authoritative decimal places');
select is(
  (select is_lapsed from app_private.offers_for_buyer('c0000000-0000-4000-8000-00000000000a', 20, null, null)),
  false, 'a live offer is not lapsed');

-- Neither read returns an account identifier.
select is(
  (select count(*)::int from unnest(
     (select p.proargnames from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'app_private' and p.proname = 'offers_for_seller')) name
    where name in ('buyer_user_id', 'seller_user_id', 'user_id')),
  0, 'the seller''s list returns no account identifier');
select is(
  (select count(*)::int from unnest(
     (select p.proargnames from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'app_private' and p.proname = 'offers_for_buyer')) name
    where name in ('buyer_user_id', 'seller_user_id', 'user_id')),
  0, 'and neither does the buyer''s');

-- Paging.
select is(
  (select count(*)::int from app_private.offers_for_buyer('c0000000-0000-4000-8000-00000000000a', 0, null, null)),
  1, 'a zero limit is clamped up to one');
select is(
  (select count(*)::int from app_private.offers_for_buyer('c0000000-0000-4000-8000-00000000000a', 500, null, null)),
  1, 'and an oversized one is clamped down');
select is(
  (select count(*)::int from app_private.offers_for_buyer(
     'c0000000-0000-4000-8000-00000000000a', 20,
     (select o.created_at from public.offers o where o.id = pg_temp.offer_a()), pg_temp.offer_a())),
  0, 'the page after the last row is empty');

-- ---------------------------------------------------------------------------------------------------
-- 6. Countering
-- ---------------------------------------------------------------------------------------------------
-- The one replacement of offer A. Not filtered by status: it must keep naming the same row after the
-- row has been accepted, or the assertions about the acceptance would silently test nothing.
create or replace function pg_temp.child() returns uuid language sql as $$
  select o.id from public.offers o where o.parent_offer_id = pg_temp.offer_a();
$$;

select is(
  (select outcome from app_private.offer_counter(
     'c0000000-0000-4000-8000-00000000000a', pg_temp.offer_a(), 430000, 3, 'Meet me here')),
  'countered', 'the buyer replaces their own live offer');

select is(pg_temp.status_of(pg_temp.offer_a()), 'countered', 'the parent is countered');
select ok(
  (select o.responded_at is not null from public.offers o where o.id = pg_temp.offer_a()),
  'and carries the response time 0015''s constraint requires');
select isnt(pg_temp.child(), null, 'a replacement exists');
select is(
  (select o.parent_offer_id from public.offers o where o.id = pg_temp.child()),
  pg_temp.offer_a(), 'and it points at the row it replaced');
select is(
  (select o.listing_id from public.offers o where o.id = pg_temp.child()),
  'c0000000-0000-4000-8000-0000000000f1'::uuid,
  'the listing came from the parent, not from the caller');
select is(
  (select o.seller_user_id from public.offers o where o.id = pg_temp.child()),
  'c0000000-0000-4000-8000-000000000011'::uuid, 'and so did the seller');
select is(
  (select o.currency_code::text from public.offers o where o.id = pg_temp.child()),
  'EGP', 'and the currency');
select is(
  (select o.amount_minor from public.offers o where o.id = pg_temp.child()),
  430000::bigint, 'the new amount is the one asked for');
select is(
  (select o.quantity from public.offers o where o.id = pg_temp.child()),
  3, 'and the new quantity');
select is(
  (select count(*)::int from public.offers o
    where o.listing_id = 'c0000000-0000-4000-8000-0000000000f1'
      and o.buyer_user_id = 'c0000000-0000-4000-8000-00000000000a' and o.status = 'pending'),
  1, 'exactly one live offer per buyer per listing still holds');

-- A parent that is no longer live.
select is(
  (select outcome from app_private.offer_counter(
     'c0000000-0000-4000-8000-00000000000a', pg_temp.offer_a(), 440000, 1, null)),
  'conflict', 'a countered parent cannot be countered again');
select is(
  (select status from app_private.offer_counter(
     'c0000000-0000-4000-8000-00000000000a', pg_temp.offer_a(), 440000, 1, null)),
  'countered', 'and the conflict reports the status it actually holds');
select is(
  (select count(*)::int from public.offers o where o.parent_offer_id = pg_temp.offer_a()),
  1, 'no second replacement was created');

-- Cross-party and cross-listing parents.
select is(
  (select outcome from app_private.offer_counter(
     'c0000000-0000-4000-8000-00000000000a', pg_temp.offer_b(), 440000, 1, null)),
  'not_found', 'another buyer''s offer cannot be used as a parent');
select is(
  (select outcome from app_private.offer_counter(
     'c0000000-0000-4000-8000-00000000000a', 'c0000000-0000-4000-8000-0000000000ff', 440000, 1, null)),
  'not_found', 'nor can an offer that does not exist');
select is(
  (select outcome from app_private.offer_counter(
     'c0000000-0000-4000-8000-00000000000a', null, 440000, 1, null)),
  'not_found', 'nor no offer at all');
select is(
  (select outcome from app_private.offer_counter(
     'c0000000-0000-4000-8000-00000000000a', pg_temp.child(), 0, 1, null)),
  'invalid', 'a zero amount is refused before anything is written');
select is(
  (select outcome from app_private.offer_counter(
     'c0000000-0000-4000-8000-00000000000a', pg_temp.child(), 440000, 0, null)),
  'invalid', 'and a zero quantity');
select is(pg_temp.status_of(pg_temp.child()), 'pending',
  'the live replacement survived every one of those attempts');

-- The function has no parameter for anything it copies from the parent.
select ok(
  (select pg_get_function_arguments(p.oid) not like '%listing%'
      and pg_get_function_arguments(p.oid) not like '%seller%'
      and pg_get_function_arguments(p.oid) not like '%currency%'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'offer_counter'),
  'no parameter of the counter names a listing, a seller or a currency');

-- ---------------------------------------------------------------------------------------------------
-- 7. Rejecting and withdrawing
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.offer_reject(
     'c0000000-0000-4000-8000-000000000012', pg_temp.offer_b())),
  'rejected', 'the seller declines an offer made to their storefront');
select is(pg_temp.status_of(pg_temp.offer_b()), 'rejected', 'the row says so');
select ok(
  (select o.responded_at is not null from public.offers o where o.id = pg_temp.offer_b()),
  'and records when');
select is(
  (select o.accepted_at from public.offers o where o.id = pg_temp.offer_b()),
  null, 'a rejection sets no acceptance time');
select is(
  (select o.payment_due_at from public.offers o where o.id = pg_temp.offer_b()),
  null, 'and no payment deadline');

select is(
  (select outcome from app_private.offer_reject(
     'c0000000-0000-4000-8000-000000000012', pg_temp.offer_b())),
  'conflict', 'rejecting it again is a conflict, not a second write');
select is(
  (select outcome from app_private.offer_accept(
     'c0000000-0000-4000-8000-000000000012', pg_temp.offer_b())),
  'conflict', 'and a rejected offer cannot then be accepted');
select is(pg_temp.status_of(pg_temp.offer_b()), 'rejected', 'the row is unchanged by both attempts');

-- A fresh offer to withdraw.
select is(
  (select outcome from app_private.offer_create(
     'c0000000-0000-4000-8000-00000000000b', 'c0000000-0000-4000-8000-0000000000f1', 350000, 1, null)),
  'created', 'the second buyer opens an offer on the first listing');

-- Pinned by amount rather than by status: a helper that narrowed on status would stop naming its row the
-- moment the row moved, and the assertions after the move would quietly test nothing.
create or replace function pg_temp.offer_w() returns uuid language sql as $$
  select o.id from public.offers o
   where o.buyer_user_id = 'c0000000-0000-4000-8000-00000000000b' and o.amount_minor = 350000;
$$;

select is(
  (select outcome from app_private.offer_withdraw(
     'c0000000-0000-4000-8000-00000000000b', pg_temp.offer_w())),
  'withdrawn', 'the buyer takes it back');
select is(pg_temp.status_of(pg_temp.offer_w()), 'withdrawn', 'the row says so');
select is(
  (select outcome from app_private.offer_withdraw(
     'c0000000-0000-4000-8000-00000000000b', pg_temp.offer_w())),
  'conflict', 'withdrawing it again is a conflict');
select is(
  (select outcome from app_private.offer_accept(
     'c0000000-0000-4000-8000-000000000011', pg_temp.offer_w())),
  'conflict', 'and a withdrawn offer cannot be accepted by the seller');
select is(
  (select outcome from app_private.offer_counter(
     'c0000000-0000-4000-8000-00000000000b', pg_temp.offer_w(), 360000, 1, null)),
  'conflict', 'nor countered by the buyer');
select is(pg_temp.status_of(pg_temp.offer_w()), 'withdrawn', 'and it is still withdrawn');

-- A withdrawn offer frees the one-open slot, so the buyer can open another.
select is(
  (select outcome from app_private.offer_create(
     'c0000000-0000-4000-8000-00000000000b', 'c0000000-0000-4000-8000-0000000000f1', 370000, 1, null)),
  'created', 'withdrawing frees the one-open slot, so a new offer is possible');
select is(
  (select outcome from app_private.offer_withdraw(
     'c0000000-0000-4000-8000-00000000000b',
     (select o.id from public.offers o
       where o.buyer_user_id = 'c0000000-0000-4000-8000-00000000000b'
         and o.listing_id = 'c0000000-0000-4000-8000-0000000000f1' and o.status = 'pending'))),
  'withdrawn', 'and that one is taken back again to leave the fixtures tidy');

-- ---------------------------------------------------------------------------------------------------
-- 8. Acceptance, and the payment window
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.offer_accept(
     'c0000000-0000-4000-8000-000000000011', pg_temp.child())),
  'accepted', 'the seller accepts the live offer');

select is(pg_temp.status_of(pg_temp.child()), 'accepted', 'the row is accepted');
select ok(
  (select o.accepted_at is not null from public.offers o where o.id = pg_temp.child()),
  'the acceptance time is recorded, which 0015''s constraint requires');
select ok(
  (select o.responded_at is not null from public.offers o where o.id = pg_temp.child()),
  'and the response time');
select is(
  (select o.responded_at from public.offers o where o.id = pg_temp.child()),
  (select o.accepted_at from public.offers o where o.id = pg_temp.child()),
  'both from the same timestamp, so they cannot disagree');
select ok(
  (select o.payment_due_at is not null from public.offers o where o.id = pg_temp.child()),
  'the payment deadline is recorded');
select ok(
  (select jsonb_typeof(o.accepted_terms) = 'object' from public.offers o where o.id = pg_temp.child()),
  'and the terms are snapshotted as an object, which 0015''s constraint requires');

-- **The calculation.**
select is(
  (select o.payment_due_at - o.accepted_at from public.offers o where o.id = pg_temp.child()),
  interval '48 hours',
  'payment_due_at is exactly accepted_at plus finance.payment_due_hours');
select is(
  (select o.accepted_terms ->> 'payment_due_hours' from public.offers o where o.id = pg_temp.child()),
  '48', 'and the window that was applied is in the snapshot');
select is(
  (select o.accepted_terms ->> 'amount_minor' from public.offers o where o.id = pg_temp.child()),
  '430000', 'the snapshot carries the agreed amount, as a string');
select is(
  (select o.accepted_terms ->> 'currency_code' from public.offers o where o.id = pg_temp.child()),
  'EGP', 'its currency');
select is(
  (select (o.accepted_terms ->> 'quantity')::int from public.offers o where o.id = pg_temp.child()),
  3, 'and its quantity');
select is(
  (select o.accepted_terms ->> 'listing_id' from public.offers o where o.id = pg_temp.child()),
  'c0000000-0000-4000-8000-0000000000f1', 'and the listing it is for');
select is(
  (select count(*)::int from jsonb_object_keys(
     (select o.accepted_terms from public.offers o where o.id = pg_temp.child())) k),
  5, 'the snapshot has exactly those five keys and invents no term');

-- The deadline is *not* the negotiation window, proven by making the two differ.
select is(
  (select outcome from app_private.offer_create(
     'c0000000-0000-4000-8000-00000000000b', 'c0000000-0000-4000-8000-0000000000f1', 380000, 1, null)),
  'created', 'a fresh offer, to accept under a different payment window');

create or replace function pg_temp.offer_p() returns uuid language sql as $$
  select o.id from public.offers o
   where o.buyer_user_id = 'c0000000-0000-4000-8000-00000000000b' and o.amount_minor = 380000;
$$;

update public.site_settings set value = '6'::jsonb where key = 'finance.payment_due_hours';
update public.site_settings set value = '99'::jsonb where key = 'offers.default_expiry_hours';

select is(
  (select outcome from app_private.offer_accept(
     'c0000000-0000-4000-8000-000000000011', pg_temp.offer_p())),
  'accepted', 'the seller accepts it');
select is(
  (select o.payment_due_at - o.accepted_at from public.offers o where o.id = pg_temp.offer_p()),
  interval '6 hours',
  'the deadline followed finance.payment_due_hours to its new value');
select isnt(
  (select o.payment_due_at - o.accepted_at from public.offers o where o.id = pg_temp.offer_p()),
  interval '99 hours',
  'and not offers.default_expiry_hours, which was moved at the same time');
select is(
  (select o.accepted_terms ->> 'payment_due_hours' from public.offers o where o.id = pg_temp.offer_p()),
  '6', 'the snapshot records the window that was actually applied');

update public.site_settings set value = '48'::jsonb where key = 'finance.payment_due_hours';
update public.site_settings set value = '48'::jsonb where key = 'offers.default_expiry_hours';

-- Repetition and the other finalised transitions.
select is(
  (select outcome from app_private.offer_accept(
     'c0000000-0000-4000-8000-000000000011', pg_temp.child())),
  'conflict', 'accepting an accepted offer again is a conflict');
select is(
  (select outcome from app_private.offer_reject(
     'c0000000-0000-4000-8000-000000000011', pg_temp.child())),
  'conflict', 'an accepted offer cannot then be rejected');
select is(
  (select outcome from app_private.offer_withdraw(
     'c0000000-0000-4000-8000-00000000000a', pg_temp.child())),
  'conflict', 'nor withdrawn by the buyer');
select is(
  (select outcome from app_private.offer_counter(
     'c0000000-0000-4000-8000-00000000000a', pg_temp.child(), 450000, 1, null)),
  'conflict', 'nor countered');
select is(pg_temp.status_of(pg_temp.child()), 'accepted', 'and it is still accepted');
select is(
  (select o.payment_due_at - o.accepted_at from public.offers o where o.id = pg_temp.child()),
  interval '48 hours', 'with the deadline the first acceptance set, unchanged');
select is(
  (select count(*)::int from public.offers o where o.parent_offer_id = pg_temp.offer_a()),
  1, 'and no extra row was created by any of them');

-- ---------------------------------------------------------------------------------------------------
-- 9. A missing or unusable payment window writes nothing
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.offer_create(
     'c0000000-0000-4000-8000-00000000000a', 'c0000000-0000-4000-8000-0000000000f2', 200000, 1, null)),
  'created', 'a fresh offer to attempt acceptance against a broken setting');

create or replace function pg_temp.offer_m() returns uuid language sql as $$
  select o.id from public.offers o
   where o.buyer_user_id = 'c0000000-0000-4000-8000-00000000000a' and o.amount_minor = 200000;
$$;

delete from public.site_settings where key = 'finance.payment_due_hours';
select is(
  (select outcome from app_private.offer_accept(
     'c0000000-0000-4000-8000-000000000012', pg_temp.offer_m())),
  'payment_policy_missing', 'an absent setting is an integrity failure, never a fallback to 48');
select is(pg_temp.status_of(pg_temp.offer_m()), 'pending', 'and the offer is still pending');
select is(
  (select o.accepted_at from public.offers o where o.id = pg_temp.offer_m()),
  null, 'with no acceptance time');
select is(
  (select o.payment_due_at from public.offers o where o.id = pg_temp.offer_m()),
  null, 'and no deadline');

insert into public.site_settings (key, category, value, value_type, is_public, description_en, description_ar)
values ('finance.payment_due_hours', 'marketplace', '"48"'::jsonb, 'string', false, 'wrong type', 'نوع خاطئ');
select is(
  (select outcome from app_private.offer_accept(
     'c0000000-0000-4000-8000-000000000012', pg_temp.offer_m())),
  'payment_policy_missing', 'a setting of the wrong JSON type is refused, not coerced');
select is(pg_temp.status_of(pg_temp.offer_m()), 'pending', 'and nothing is written');

update public.site_settings set value = '0'::jsonb, value_type = 'number'
 where key = 'finance.payment_due_hours';
select is(
  (select outcome from app_private.offer_accept(
     'c0000000-0000-4000-8000-000000000012', pg_temp.offer_m())),
  'payment_policy_missing', 'a window of zero hours is refused: a deadline equal to now is not a window');
update public.site_settings set value = '-5'::jsonb where key = 'finance.payment_due_hours';
select is(
  (select outcome from app_private.offer_accept(
     'c0000000-0000-4000-8000-000000000012', pg_temp.offer_m())),
  'payment_policy_missing', 'and a negative one, which would put the deadline in the past');
select is(pg_temp.status_of(pg_temp.offer_m()), 'pending', 'neither wrote anything');

update public.site_settings set value = '48'::jsonb where key = 'finance.payment_due_hours';
select is(
  (select outcome from app_private.offer_accept(
     'c0000000-0000-4000-8000-000000000012', pg_temp.offer_m())),
  'accepted', 'and with the setting restored the same acceptance succeeds');

-- ---------------------------------------------------------------------------------------------------
-- 10. Expiry stays 0032's
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.offer_create(
     'c0000000-0000-4000-8000-00000000000b', 'c0000000-0000-4000-8000-0000000000f2', 210000, 1, null)),
  'created', 'a fresh offer, about to be made to lapse');

create or replace function pg_temp.offer_l() returns uuid language sql as $$
  select o.id from public.offers o
   where o.buyer_user_id = 'c0000000-0000-4000-8000-00000000000b' and o.amount_minor = 210000;
$$;

update public.offers set expires_at = now() - interval '1 minute' where id = pg_temp.offer_l();

select is(
  (select is_lapsed from app_private.offers_for_buyer(
     'c0000000-0000-4000-8000-00000000000b', 20, null, null)
    where id = pg_temp.offer_l()),
  true, 'a pending offer past its window reads as lapsed');
select is(pg_temp.status_of(pg_temp.offer_l()), 'pending',
  'while its status is still pending, because 0032''s sweeper has not run');

select is(
  (select outcome from app_private.offer_accept(
     'c0000000-0000-4000-8000-000000000012', pg_temp.offer_l())),
  'expired', 'a lapsed offer cannot be accepted');
select is(
  (select outcome from app_private.offer_reject(
     'c0000000-0000-4000-8000-000000000012', pg_temp.offer_l())),
  'expired', 'nor rejected');
select is(
  (select outcome from app_private.offer_withdraw(
     'c0000000-0000-4000-8000-00000000000b', pg_temp.offer_l())),
  'expired', 'nor withdrawn');
select is(
  (select outcome from app_private.offer_counter(
     'c0000000-0000-4000-8000-00000000000b', pg_temp.offer_l(), 220000, 1, null)),
  'expired', 'nor countered');
select is(pg_temp.status_of(pg_temp.offer_l()), 'pending',
  'and none of the four wrote the status the sweeper owns');

-- 0032's sweeper, unchanged, is what records it.
select ok(app_private.expire_due_offers(500) >= 1, '0032''s sweeper closes it');
select is(pg_temp.status_of(pg_temp.offer_l()), 'expired', 'now it is expired');
select ok(
  (select o.responded_at is not null from public.offers o where o.id = pg_temp.offer_l()),
  'with the response time 0015''s constraint requires');

select is(
  (select outcome from app_private.offer_accept(
     'c0000000-0000-4000-8000-000000000012', pg_temp.offer_l())),
  'conflict', 'an expired offer cannot be accepted');
select is(
  (select outcome from app_private.offer_counter(
     'c0000000-0000-4000-8000-00000000000b', pg_temp.offer_l(), 220000, 1, null)),
  'conflict', 'nor countered');
select is(pg_temp.status_of(pg_temp.offer_l()), 'expired', 'and it stays expired');

-- An accepted offer is never re-expired, and neither is a countered one.
update public.offers set expires_at = now() - interval '1 day'
 where id in (pg_temp.child(), pg_temp.offer_a());
select is(app_private.expire_due_offers(500), 0,
  'a second sweep finds nothing: the sweeper only ever looked at pending');
select is(pg_temp.status_of(pg_temp.child()), 'accepted',
  'an accepted offer whose window has passed is not re-expired');
select ok(
  (select o.payment_due_at is not null from public.offers o where o.id = pg_temp.child()),
  'and it keeps its payment deadline');
select is(pg_temp.status_of(pg_temp.offer_a()), 'countered',
  'a countered offer whose window has passed is not expired either');

-- ---------------------------------------------------------------------------------------------------
-- 11. Nothing else happened
-- ---------------------------------------------------------------------------------------------------
-- Not one of these functions creates an order, a checkout, a reservation, a payment, a ledger entry, a
-- payout or a notification, asserted on the sources as well as on the tables.
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and (p.proname like 'offer\_%' or p.proname like 'offers\_for\_%')
      and (p.prosrc like '%public.orders%' or p.prosrc like '%public.checkouts%'
           or p.prosrc like '%reservation%' or p.prosrc like '%ledger%'
           or p.prosrc like '%payout%' or p.prosrc like '%payment_attempt%'
           or p.prosrc like '%create_notification%' or p.prosrc like '%enqueue_outbox_event%')),
  0, 'no function in 0070 reaches an order, checkout, reservation, ledger, payout, payment or event');

select is(
  (select count(*)::int from public.notifications n
    where n.subject_type = 'offer' or n.category = 'offers'),
  0, 'and this whole file produced no offer notification: none is defined in the repository');

select is(
  (select count(*)::int from public.outbox_events e
    where e.aggregate_type = 'offer' and e.event_type <> 'offer.expired'),
  0, 'and no offer event other than 0032''s own offer.expired');

select is(
  (select count(*)::int from public.offer_messages),
  0, 'offer_messages is untouched: no approved route or scope item covers a per-offer thread');

select * from finish();
rollback;
