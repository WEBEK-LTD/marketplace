-- pgTAP — migration 0106: pagination probe-row correction and the reader limit contract.
--
-- This API answers "is there another page?" without a count: it asks for `limit + 1` rows and treats the extra
-- row as the answer. Nine readers clamped `p_limit` at **exactly** the contract's public maximum, so at the
-- maximum page size the probe row was removed by the clamp and `nextCursor` came back null on a page that had
-- more behind it. Sixty rows, asking for fifty-one, fifty came back, and `50 > 50` is false.
--
-- What this file proves:
--
--   * **the probe row survives** — each of the nine, asked for its maximum + 1, returns maximum + 1 rows. This
--     is the assertion whose absence let the defect ship, and it is the first one here;
--   * **a full page is still full** — asked for exactly the maximum, each returns the maximum, so the fix did
--     not turn a page of fifty into a page of fifty-one;
--   * **the ceiling still bounds an untrusted parameter** — asked for a hundred thousand, each returns
--     maximum + 1 and not the table;
--   * **no default page size moved** (owner decision 5) — each reader called with a null limit returns exactly
--     the number it returned before this migration, asserted per reader rather than in general;
--   * **cursor semantics are unchanged** (owner decision 6) — three readers with three different cursor shapes
--     are walked from the first page to the last at the maximum page size, and the walk must visit every row
--     exactly once. Before 0106 that walk stopped after one page. This is the test that would have caught it;
--   * **ordering is unchanged** — a page of maximum + 1 rows begins with the same rows, in the same order, as a
--     page of the maximum, so the extra row is purely extra;
--   * **the three exempt readers are untouched** (owner decision 3) — `seller_orders`, `seller_reviews` and
--     `seller_promotions` still clamp at fifty and still behave exactly as they did, because they are driven by
--     a service that sends no probe row at all;
--   * **nothing else moved** — `proconfig`, grants, the twelve contract checkers and 0105's whitespace contract
--     are all asserted unchanged.
--
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(133);

-- ---------------------------------------------------------------------------------------------------
-- The inventory, as data
-- ---------------------------------------------------------------------------------------------------
-- The nine readers and the ceiling each must now hold. Every assertion below is driven from this one table, so
-- a reader cannot be silently dropped from the suite.
create temporary table scope (reader text primary key, public_max integer not null, default_size integer not null);
insert into scope (reader, public_max, default_size) values
  ('messaging_inbox',                  50, 20),
  ('messaging_conversation_messages', 100, 50),
  ('notifications_inbox',              50, 20),
  ('buyer_favorites',                  50, 20),
  ('buyer_saved_searches',             50, 20),
  ('buyer_blocks',                     50, 20),
  ('seller_listings',                  50, 20),
  ('seller_services',                  50, 20),
  ('listing_analytics_page',          100, 25);

select is((select count(*)::int from scope), 9, 'nine readers are in scope');

-- ---------------------------------------------------------------------------------------------------
-- 1. The ceiling in the catalogue is the public maximum plus one
-- ---------------------------------------------------------------------------------------------------
create or replace function pg_temp.ceiling_of(p_reader text) returns integer language sql stable as $$
  select ((regexp_match(p.prosrc, 'least\(greatest\(coalesce\(p_limit[^)]*\),\s*1\),\s*([0-9]+)\)'))[1])::integer
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app_private' and p.proname = p_reader;
$$;

select is(pg_temp.ceiling_of(s.reader), s.public_max + 1,
  format('%s clamps at %s, which is its public maximum plus one', s.reader, s.public_max + 1))
  from scope s;

-- The claim that matters in a year: no reader anywhere clamps at a published maximum except the three the
-- owner exempted. A tenth reader written with the old shape fails this.
select set_eq(
  $$select p.proname::text
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app_private'
       and ((regexp_match(p.prosrc, 'least\(greatest\(coalesce\(p_limit[^)]*\),\s*1\),\s*([0-9]+)\)'))[1])::integer
           in (48, 50, 96, 100)$$,
  $$values ('seller_orders'), ('seller_reviews'), ('seller_promotions')$$,
  'the only readers left clamping at a published maximum are the three owner decision 3 exempts');

-- `dispute_messages_for_staff` keeps its generous headroom (owner decision 2).
select is(pg_temp.ceiling_of('dispute_messages_for_staff'), 201,
  'dispute_messages_for_staff keeps 201 against a maximum of 50, untouched');

-- Thirty-seven readers clamp only the floor and never had the defect. A ceiling is not required; a ceiling
-- equal to a published maximum is. That distinction is the whole scope of this increment.
select cmp_ok(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and pg_get_function_identity_arguments(p.oid) like '%p_limit%'
      and p.prosrc !~ 'least\(greatest\(coalesce\(p_limit'),
  '>=', 30, 'many readers impose no ceiling at all, and none of them is reported as a problem');

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and pg_get_function_identity_arguments(p.oid) like '%p_limit%'
      and p.prosrc like '%least(%' and p.prosrc !~ 'least\(greatest\(coalesce\(p_limit'),
  0, 'and no reader bounds p_limit by some other idiom this increment would have missed');

-- ---------------------------------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------------------------------
-- One seller, one buyer, one admin for the analytics permission. Then enough rows that every reader has more
-- than its maximum + 1: the defect is invisible below that line, which is exactly why it survived.
insert into auth.users (id, email) values
  ('06000000-0000-4000-8000-000000000001', 'pg-seller@test.invalid'),
  ('06000000-0000-4000-8000-000000000002', 'pg-buyer@test.invalid'),
  ('06000000-0000-4000-8000-000000000003', 'pg-admin@test.invalid');

insert into public.user_roles (user_id, role_key) values ('06000000-0000-4000-8000-000000000003', 'admin');

insert into public.seller_profiles
  (user_id, slug, display_name, legal_name, contact_email, contact_phone_e164, country_code,
   status, verification_status, verified_at)
values
  ('06000000-0000-4000-8000-000000000001', 'pg-shop', 'Pager Shop', 'Pager Shop LLC',
   'pg@test.invalid', '+201000000061', 'EG', 'active', 'verified', now() - interval '30 days');

insert into public.categories (id, parent_id, slug, is_active, sort_order) values
  ('06100000-0000-4000-8000-000000000001', null, 'pg-cat', true, 61);
insert into public.category_translations (category_id, locale_code, name) values
  ('06100000-0000-4000-8000-000000000001', 'en', 'Pager Category');

-- 110 products and 110 services. Distinct `created_at` so the ordering is total and a cursor walk is exact.
do $$
declare i int;
begin
  for i in 1..110 loop
    insert into public.listings (
      id, seller_user_id, listing_type_code, category_id, slug, title, description, content_language,
      currency_code, price_minor, is_negotiable, status, country_code, city, created_at, approved_at)
    values (
      ('06200000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
      '06000000-0000-4000-8000-000000000001', 'product', '06100000-0000-4000-8000-000000000001',
      'pg-product-' || lpad(i::text, 3, '0'), 'Product ' || i,
      'A description long enough to satisfy the length constraint.', 'en',
      'EGP', 100000 + i, true, 'active', 'EG', 'Cairo',
      now() - (i || ' hours')::interval, now() - (i || ' hours')::interval);

    insert into public.listings (
      id, seller_user_id, listing_type_code, category_id, slug, title, description, content_language,
      currency_code, price_minor, is_negotiable, status, country_code, city, created_at, approved_at)
    values (
      ('06300000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
      '06000000-0000-4000-8000-000000000001', 'service', '06100000-0000-4000-8000-000000000001',
      'pg-service-' || lpad(i::text, 3, '0'), 'Service ' || i,
      'A description long enough to satisfy the length constraint.', 'en',
      'EGP', 200000 + i, true, 'active', 'EG', 'Cairo',
      now() - (i || ' hours')::interval, now() - (i || ' hours')::interval);
  end loop;
end $$;

select is((select count(*)::int from public.listings where seller_user_id = '06000000-0000-4000-8000-000000000001'),
  220, '220 listings exist, so seller_listings has far more than its maximum');

-- 60 favorites, 60 saved searches, 60 notifications, 60 blocks.
do $$
declare i int;
begin
  for i in 1..60 loop
    insert into public.favorites (user_id, listing_id, created_at)
      values ('06000000-0000-4000-8000-000000000002',
              ('06200000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
              now() - (i || ' minutes')::interval);

    insert into public.saved_searches (user_id, name, query, created_at)
      values ('06000000-0000-4000-8000-000000000002', 'Search ' || i,
              jsonb_build_object('q', 'term' || i), now() - (i || ' minutes')::interval);

    insert into public.notifications (user_id, category, event_type, template_key, created_at)
      values ('06000000-0000-4000-8000-000000000002', 'account', 'account.updated',
              'account_updated', now() - (i || ' minutes')::interval);

    insert into auth.users (id, email)
      values (('06400000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid, 'pg-blocked' || i || '@test.invalid');
    insert into public.user_blocks (blocker_id, blocked_id, created_at)
      values ('06000000-0000-4000-8000-000000000002',
              ('06400000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
              now() - (i || ' minutes')::interval);
  end loop;
end $$;

-- 60 conversations for the inbox, and 150 messages inside the first one.
create temporary table conv (n integer primary key, id uuid not null);
do $$
declare i int; v_id uuid;
begin
  for i in 1..60 loop
    select conversation_id into v_id from app_private.messaging_start_conversation(
      '06000000-0000-4000-8000-000000000002', 'listing',
      ('06200000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid, null);
    insert into conv (n, id) values (i, v_id);
  end loop;

  for i in 1..150 loop
    perform app_private.messaging_send_message(
      '06000000-0000-4000-8000-000000000002', (select id from conv where n = 1), 'Message number ' || i || '.');
  end loop;
end $$;

select is((select count(*)::int from conv), 60, '60 conversations exist for the inbox');
select is((select count(*)::int from public.messages where conversation_id = (select id from conv where n = 1)),
  150, 'and 150 messages in the first of them');

-- 110 analytics rows, one per product, all inside the default window.
insert into public.listing_analytics (listing_id, seller_user_id, day, clicks, contacts, favorites, shares, computed_at)
select l.id, l.seller_user_id, current_date, 1, 1, 1, 1, now()
  from public.listings l
 where l.listing_type_code = 'product' and l.seller_user_id = '06000000-0000-4000-8000-000000000001';

select is((select count(*)::int from public.listing_analytics), 110, '110 analytics rows exist');
select ok(app_private.listing_analytics_can_read('06000000-0000-4000-8000-000000000003', true),
  'and the admin may read them, so the analytics assertions are not vacuous');

-- ---------------------------------------------------------------------------------------------------
-- One row count per reader, by name
-- ---------------------------------------------------------------------------------------------------
-- Every reader has a different signature, so each is wrapped once here and nowhere else. A null limit is passed
-- through as null, which is how the default is exercised.
create or replace function pg_temp.rows_from(p_reader text, p_limit integer) returns integer
language plpgsql stable as $$
declare v_count integer;
begin
  case p_reader
    when 'messaging_inbox' then
      select count(*) into v_count from app_private.messaging_inbox(
        '06000000-0000-4000-8000-000000000002', p_limit, null, null);
    when 'messaging_conversation_messages' then
      select count(*) into v_count from app_private.messaging_conversation_messages(
        '06000000-0000-4000-8000-000000000002', (select id from conv where n = 1), p_limit, null);
    when 'notifications_inbox' then
      select count(*) into v_count from app_private.notifications_inbox(
        '06000000-0000-4000-8000-000000000002', p_limit, null, null, false);
    when 'buyer_favorites' then
      select count(*) into v_count from app_private.buyer_favorites(
        '06000000-0000-4000-8000-000000000002', p_limit, null, null);
    when 'buyer_saved_searches' then
      select count(*) into v_count from app_private.buyer_saved_searches(
        '06000000-0000-4000-8000-000000000002', p_limit, null, null);
    when 'buyer_blocks' then
      select count(*) into v_count from app_private.buyer_blocks(
        '06000000-0000-4000-8000-000000000002', p_limit, null, null);
    when 'seller_listings' then
      select count(*) into v_count from app_private.seller_listings(
        '06000000-0000-4000-8000-000000000001', p_limit, null, null);
    when 'seller_services' then
      select count(*) into v_count from app_private.seller_services(
        '06000000-0000-4000-8000-000000000001', p_limit, null, null);
    when 'listing_analytics_page' then
      select count(*) into v_count from app_private.listing_analytics_page(
        '06000000-0000-4000-8000-000000000003', true, null, p_limit, null, null);
    else raise exception 'pg_temp.rows_from has no case for %', p_reader;
  end case;
  return v_count;
end $$;

-- ---------------------------------------------------------------------------------------------------
-- 2. The probe row survives — the assertion whose absence let this ship
-- ---------------------------------------------------------------------------------------------------
select is(pg_temp.rows_from(s.reader, s.public_max + 1), s.public_max + 1,
  format('%s: asked for %s (the API''s probe row on a maximum page), returns %s',
         s.reader, s.public_max + 1, s.public_max + 1))
  from scope s;

-- ...which is the same as saying `hasMore` is now true. Stated in the API's own arithmetic, because that is the
-- line that was wrong: `rows.length > limit`.
select ok(pg_temp.rows_from(s.reader, s.public_max + 1) > s.public_max,
  format('%s: so hasMore = rows > %s evaluates to true, and nextCursor is not null', s.reader, s.public_max))
  from scope s;

-- ---------------------------------------------------------------------------------------------------
-- 3. A full page is still exactly full
-- ---------------------------------------------------------------------------------------------------
select is(pg_temp.rows_from(s.reader, s.public_max), s.public_max,
  format('%s: asked for exactly %s, returns exactly %s', s.reader, s.public_max, s.public_max))
  from scope s;

-- ---------------------------------------------------------------------------------------------------
-- 4. The ceiling still bounds a parameter the database does not trust
-- ---------------------------------------------------------------------------------------------------
-- Raising the ceiling by one must not turn it into no ceiling. A hundred thousand still gets maximum + 1.
select is(pg_temp.rows_from(s.reader, 100000), s.public_max + 1,
  format('%s: asked for 100000, still returns only %s', s.reader, s.public_max + 1))
  from scope s;

select is(pg_temp.rows_from(s.reader, 0), 1,
  format('%s: asked for 0, the floor of 1 still applies', s.reader))
  from scope s;

select is(pg_temp.rows_from(s.reader, -5), 1,
  format('%s: asked for a negative limit, the floor of 1 still applies', s.reader))
  from scope s;

-- ---------------------------------------------------------------------------------------------------
-- 5. No default page size moved (owner decision 5)
-- ---------------------------------------------------------------------------------------------------
-- The default is the second number inside the clamp and this migration did not touch it. Asserted per reader
-- against the figure it had before, so a change to any default fails here rather than being discovered by a
-- caller whose page quietly changed size.
select is(pg_temp.rows_from(s.reader, null), s.default_size,
  format('%s: a null limit still returns its unchanged default of %s', s.reader, s.default_size))
  from scope s;

select is(
  (select ((regexp_match(p.prosrc, 'least\(greatest\(coalesce\(p_limit\s*,\s*([0-9]+)\)'))[1])::integer
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = s.reader),
  s.default_size,
  format('%s declares that default in the clamp itself', s.reader))
  from scope s;

-- ---------------------------------------------------------------------------------------------------
-- 6. Ordering is unchanged — the extra row is purely extra
-- ---------------------------------------------------------------------------------------------------
-- A page of maximum + 1 must begin with the page of maximum, in the same order. If the fix had disturbed the
-- ordering, the probe row would be arriving in place of a real one rather than after it.
select is(
  (select string_agg(x.slug, ',' order by x.ord)
     from (select row_number() over () as ord, f.slug
             from app_private.seller_listings('06000000-0000-4000-8000-000000000001', 51, null, null) f
            limit 50) x),
  (select string_agg(y.slug, ',' order by y.ord)
     from (select row_number() over () as ord, g.slug
             from app_private.seller_listings('06000000-0000-4000-8000-000000000001', 50, null, null) g) y),
  'seller_listings: the first 50 of a 51-row page are the 50-row page, in the same order');

select is(
  (select string_agg(x.id::text, ',' order by x.ord)
     from (select row_number() over () as ord, f.id
             from app_private.buyer_saved_searches('06000000-0000-4000-8000-000000000002', 51, null, null) f
            limit 50) x),
  (select string_agg(y.id::text, ',' order by y.ord)
     from (select row_number() over () as ord, g.id
             from app_private.buyer_saved_searches('06000000-0000-4000-8000-000000000002', 50, null, null) g) y),
  'buyer_saved_searches: likewise');

-- The documented ordering still holds: newest first, with the tie-break this platform uses.
-- The window has to be computed before it can be aggregated, so each is a subquery. `lead()` is null on the
-- last row, which is why the comparison is written to tolerate it rather than to count rows.
select ok(
  (select bool_and(x.created_at >= x.next_at)
     from (select f.created_at, lead(f.created_at) over () as next_at
             from app_private.buyer_favorites('06000000-0000-4000-8000-000000000002', 51, null, null) f) x
    where x.next_at is not null),
  'buyer_favorites still returns newest first');

select ok(
  (select bool_and(x.seq < x.next_seq)
     from (select m.seq, lead(m.seq) over () as next_seq
             from app_private.messaging_conversation_messages(
               '06000000-0000-4000-8000-000000000002', (select id from conv where n = 1), 101, null) m) x
    where x.next_seq is not null),
  'messaging_conversation_messages still returns a page in ascending seq, as 5-E defined it');

-- ---------------------------------------------------------------------------------------------------
-- 7. The full cursor walk — the test that would have caught the defect
-- ---------------------------------------------------------------------------------------------------
-- Paging at the maximum size from the first page to the last must visit every row exactly once. Before 0106
-- each of these walks stopped after a single page and reported the rest as absent. Three readers with three
-- different cursor shapes: a (timestamp, uuid) pair, a (timestamp, text) pair, and a bare sequence number.

-- A (timestamp, uuid) cursor.
create or replace function pg_temp.walk_blocks() returns table (pages integer, seen integer, distinct_seen integer)
language plpgsql as $$
declare
  v_at timestamptz := null; v_id uuid := null; v_pages integer := 0; v_rows integer;
  v_all uuid[] := array[]::uuid[]; v_page uuid[];
begin
  loop
    -- Exactly what the API does: ask for one more than the client's maximum.
    select array_agg(b.blocked_user_id order by b.created_at desc, b.blocked_user_id desc)
      into v_page
      from (select * from app_private.buyer_blocks('06000000-0000-4000-8000-000000000002', 51, v_at, v_id)) b;
    v_rows := coalesce(array_length(v_page, 1), 0);
    exit when v_rows = 0;
    v_pages := v_pages + 1;
    -- The probe row is dropped by the API and never shown; the cursor comes from the last *shown* row.
    if v_rows > 50 then
      v_all := v_all || v_page[1:50];
      select b.created_at, b.blocked_user_id into v_at, v_id
        from (select * from app_private.buyer_blocks('06000000-0000-4000-8000-000000000002', 51, v_at, v_id)) b
       order by b.created_at desc, b.blocked_user_id desc offset 49 limit 1;
    else
      v_all := v_all || v_page;
      exit;
    end if;
    exit when v_pages > 10;
  end loop;
  return query select v_pages, coalesce(array_length(v_all, 1), 0),
    (select count(distinct u)::integer from unnest(v_all) u);
end $$;

select is((select w.pages from pg_temp.walk_blocks() w), 2,
  'buyer_blocks: 60 rows at a page size of 50 is two pages, not one');
select is((select w.seen from pg_temp.walk_blocks() w), 60,
  'and the walk visits all 60 rows — before 0106 it saw 50 and stopped');
select is((select w.distinct_seen from pg_temp.walk_blocks() w), 60,
  'with no row visited twice, so the cursor neither skips nor repeats');

-- A (timestamp, text) cursor.
create or replace function pg_temp.walk_listings() returns table (pages integer, seen integer, distinct_seen integer)
language plpgsql as $$
declare
  v_at timestamptz := null; v_slug text := null; v_pages integer := 0; v_rows integer;
  v_all text[] := array[]::text[]; v_page text[];
begin
  loop
    select array_agg(l.slug order by l.created_at desc, l.slug desc) into v_page
      from (select * from app_private.seller_listings('06000000-0000-4000-8000-000000000001', 51, v_at, v_slug)) l;
    v_rows := coalesce(array_length(v_page, 1), 0);
    exit when v_rows = 0;
    v_pages := v_pages + 1;
    if v_rows > 50 then
      v_all := v_all || v_page[1:50];
      select l.created_at, l.slug into v_at, v_slug
        from (select * from app_private.seller_listings('06000000-0000-4000-8000-000000000001', 51, v_at, v_slug)) l
       order by l.created_at desc, l.slug desc offset 49 limit 1;
    else
      v_all := v_all || v_page;
      exit;
    end if;
    exit when v_pages > 20;
  end loop;
  return query select v_pages, coalesce(array_length(v_all, 1), 0),
    (select count(distinct u)::integer from unnest(v_all) u);
end $$;

select is((select w.pages from pg_temp.walk_listings() w), 5,
  'seller_listings: 220 listings at a page size of 50 is five pages');
select is((select w.seen from pg_temp.walk_listings() w), 220,
  'and the walk reaches all 220 — before 0106 it reached 50');
select is((select w.distinct_seen from pg_temp.walk_listings() w), 220, 'each exactly once');

-- A bare sequence cursor, where the page is returned ascending but the cursor is its lowest seq.
create or replace function pg_temp.walk_messages() returns table (pages integer, seen integer, distinct_seen integer)
language plpgsql as $$
declare
  v_cursor bigint := null; v_pages integer := 0; v_rows integer;
  v_all bigint[] := array[]::bigint[]; v_page bigint[]; v_conv uuid := (select id from conv where n = 1);
begin
  loop
    select array_agg(m.seq order by m.seq desc) into v_page
      from (select * from app_private.messaging_conversation_messages(
              '06000000-0000-4000-8000-000000000002', v_conv, 101, v_cursor)) m;
    v_rows := coalesce(array_length(v_page, 1), 0);
    exit when v_rows = 0;
    v_pages := v_pages + 1;
    if v_rows > 100 then
      v_all := v_all || v_page[1:100];
      v_cursor := v_page[100];
    else
      v_all := v_all || v_page;
      exit;
    end if;
    exit when v_pages > 10;
  end loop;
  return query select v_pages, coalesce(array_length(v_all, 1), 0),
    (select count(distinct u)::integer from unnest(v_all) u);
end $$;

select is((select w.pages from pg_temp.walk_messages() w), 2,
  'messaging_conversation_messages: 150 messages at a page size of 100 is two pages');
select is((select w.seen from pg_temp.walk_messages() w), 150, 'and the walk reads all 150');
select is((select w.distinct_seen from pg_temp.walk_messages() w), 150, 'each exactly once');

-- ---------------------------------------------------------------------------------------------------
-- 7b. The walk is not vacuous — put the defect back and watch it fail
-- ---------------------------------------------------------------------------------------------------
-- A regression test that cannot fail is not a regression test. So the old ceiling goes back in, inside a
-- savepoint, and the same walk is re-run. The body is **not** retyped: it is read from the catalogue with
-- `pg_get_functiondef` and the one integer is replaced, so what is restored is genuinely the previous behaviour
-- and not a hand-written approximation of it.
savepoint regressed;

do $$
declare v_def text;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app_private' and p.proname = 'buyer_blocks';
  -- `pg_get_functiondef` writes the SET in a form the migration policy rejects; irrelevant here, since this
  -- never reaches a migration, but normalised anyway so the restored definition matches what 0053-0103 wrote.
  v_def := replace(v_def, 'SET search_path TO ''pg_catalog'', ''public''', 'set search_path = pg_catalog, public');
  v_def := replace(v_def, 'least(greatest(coalesce(p_limit, 20), 1), 51)', 'least(greatest(coalesce(p_limit, 20), 1), 50)');
  if position('least(greatest(coalesce(p_limit, 20), 1), 50)' in v_def) = 0 then
    raise exception 'the regression could not be staged: the clamp was not found to replace';
  end if;
  execute v_def;
end $$;

select is(pg_temp.ceiling_of('buyer_blocks'), 50, 'with the old ceiling restored, buyer_blocks clamps at 50 again');

select is((select count(*)::int from app_private.buyer_blocks('06000000-0000-4000-8000-000000000002', 51, null, null)),
  50, 'and asking for 51 returns 50: the probe row is eaten, exactly as it was before this migration');

select is((select w.pages from pg_temp.walk_blocks() w), 1,
  'so the walk now finds one page where there are two');
select is((select w.seen from pg_temp.walk_blocks() w), 50,
  'and sees 50 of the 60 rows — the ten the API could not reach. This is the defect, reproduced.');

-- The structural guard would also have caught it, which is the point of adding one.
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'buyer_blocks'
      and ((regexp_match(p.prosrc, 'least\(greatest\(coalesce\(p_limit[^)]*\),\s*1\),\s*([0-9]+)\)'))[1])::integer
          in (48, 50, 96, 100)),
  1, 'and the catalogue-level assertion of section 1 reports it as clamping at a published maximum');

rollback to savepoint regressed;

select is(pg_temp.ceiling_of('buyer_blocks'), 51, 'rolled back, the corrected ceiling is in place again');
select is((select w.seen from pg_temp.walk_blocks() w), 60, 'and the walk reaches all 60 rows once more');

-- ---------------------------------------------------------------------------------------------------
-- 8. The three exempt readers are untouched (owner decision 3)
-- ---------------------------------------------------------------------------------------------------
-- `seller-read.service.ts` sends `limit: size` and decides there is another page from `rows.length === size`.
-- No probe row is requested, so the ceiling takes nothing away, and changing it would change when `nextCursor`
-- is null on an exact-multiple boundary — a cursor-semantics change this increment may not make. Their shape is
-- asserted here so the exemption is a measured fact rather than a sentence in a comment.
select is(pg_temp.ceiling_of(r), 50, format('%s still clamps at 50, deliberately', r))
  from unnest(array['seller_orders', 'seller_reviews', 'seller_promotions']) r;

select is((select count(*)::int from app_private.seller_listings('06000000-0000-4000-8000-000000000001', 51, null, null)),
  51, 'a corrected reader asked for 51 gives 51');
select is((select count(*)::int from app_private.seller_promotions('06000000-0000-4000-8000-000000000001', 51, null, null)),
  0, 'and an exempt reader is unchanged: it still truncates at 50, here with no rows to show it');

-- ---------------------------------------------------------------------------------------------------
-- 9. Nothing else moved
-- ---------------------------------------------------------------------------------------------------
-- A replacement that dropped `search_path` would be a privilege hole opened by a pagination fix.
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname in (select reader from scope)
      and not (p.proconfig @> array['search_path=pg_catalog, public'])),
  0, 'all nine still pin search_path to pg_catalog, public');

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname in (select reader from scope) and not p.prosecdef),
  0, 'and all nine are still security definer');

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname in (select reader from scope)
      and has_function_privilege('public', p.oid, 'execute')),
  0, 'none of them is executable by public');

select ok(
  (select bool_and(has_function_privilege('app_system', p.oid, 'execute'))
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname in (select reader from scope)),
  'and app_system may still execute every one of them');

-- Each still carries its comment: CREATE OR REPLACE keeps the oid, so a lost comment would mean a dropped and
-- recreated function, which would also have silently reset its grants.
select ok(
  (select bool_and(obj_description(p.oid, 'pg_proc') is not null)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname in (select reader from scope)),
  'every replaced reader kept the comment it had, so none was dropped and recreated');

-- 0105 must still hold. Every body here was dumped after it applied, so its strict character set came across.
select is((select count(*)::int from app_private.whitespace_contract_problems()), 0,
  '0105''s whitespace contract is still empty');

select is((select count(*)::int from public.security_contract_problems()), 0, 'the security contract holds');
select is((select count(*)::int from public.rls_problems()), 0, 'RLS is unchanged');
select is((select count(*)::int from public.grant_problems()), 0, 'grants are unchanged');
select is((select count(*)::int from public.definer_problems()), 0, 'definer hygiene is unchanged');
select is((select count(*)::int from public.role_boundary_problems()), 0, 'role boundaries are unchanged');
select is((select count(*)::int from public.anon_privilege_problems()), 0, 'anon holds nothing new');
select is((select count(*)::int from public.append_only_problems()), 0, 'append-only tables are unchanged');
select is((select count(*)::int from public.view_security_problems()), 0, 'view security is unchanged');
select is((select count(*)::int from public.storage_bucket_problems()), 0, 'storage buckets are unchanged');
select is((select count(*)::int from public.audit_attribution_problems()), 0, 'audit attribution is unchanged');
select is((select count(*)::int from public.cron_job_problems()), 0, 'cron jobs are unchanged');

select * from finish();
rollback;
