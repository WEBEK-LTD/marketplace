-- pgTAP — migration 0103: user blocking (Phase 8).
--
-- `public.user_blocks` and `public.is_blocked_between` have existed since 0005, and six closed increments
-- consult the predicate. Nothing could write the table. So the central claim of this file is not that a row
-- can be inserted — it is that **inserting that row actually stops things**, proved for each of the six
-- enforcement paths by running the action twice: once before the block, which must succeed, and once after,
-- which must refuse. A refusal asserted on its own proves nothing, because every one of these actions has
-- other reasons to refuse and a mis-built fixture refuses for one of them. The before-and-after pair is what
-- makes the block the cause.
--
-- The sixth path gets the same treatment at the lowest level available: a real `insert into public.messages`,
-- so `tg_messages_block_rule` is proved by the trigger firing rather than by a function choosing to ask.
--
-- The rest of the file is about what blocking must **not** do. It must not mutate a conversation, a message,
-- an offer or a service request; it must not hide the blocked seller's catalogue listings; it must not write
-- an audit row, an outbox event or a security event, because each of those is a record of who blocked whom
-- and a staff surface already reads two of them; and it must not have added a permission key, a staff reader,
-- a reverse lookup or a scheduled job.
--
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(147);

-- ---------------------------------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------------------------------
-- BUYER blocks people. SELLER runs `good-shop` and is the one blocked. STRANGER is in nothing. SUSPENDED
-- runs a storefront that is not publicly visible. SECOND and THIRD exist so the list has three rows to
-- page through. NAMELESS has no profile row at all, which is the case the list's left join must survive.
insert into auth.users (id, email) values
  ('60000000-0000-4000-8000-000000000001', 'buyer@test.invalid'),
  ('60000000-0000-4000-8000-000000000002', 'seller@test.invalid'),
  ('60000000-0000-4000-8000-000000000003', 'stranger@test.invalid'),
  ('60000000-0000-4000-8000-000000000004', 'suspended@test.invalid'),
  ('60000000-0000-4000-8000-000000000005', 'second@test.invalid'),
  ('60000000-0000-4000-8000-000000000006', 'third@test.invalid'),
  ('60000000-0000-4000-8000-000000000007', 'nameless@test.invalid');

-- 0004 creates a profile row with every account, so a display name is set rather than inserted, and the one
-- account that must have no profile at all has its row removed.
update public.profiles set display_name = 'Sally Seller' where id = '60000000-0000-4000-8000-000000000002';
update public.profiles set display_name = 'Second Person' where id = '60000000-0000-4000-8000-000000000005';
update public.profiles set display_name = null where id = '60000000-0000-4000-8000-000000000006';
delete from public.profiles where id = '60000000-0000-4000-8000-000000000007';

insert into public.seller_profiles
  (user_id, slug, display_name, legal_name, contact_email, contact_phone_e164, country_code,
   status, suspended_at, verification_status, verified_at)
values
  ('60000000-0000-4000-8000-000000000002', 'good-shop', 'Good Shop', 'Good Shop LLC',
   'good@test.invalid', '+201000000001', 'EG', 'active', null, 'verified', now() - interval '10 days'),
  ('60000000-0000-4000-8000-000000000004', 'gone-shop', 'Gone Shop', 'Gone Shop LLC',
   'gone@test.invalid', '+201000000004', 'EG', 'suspended', now() - interval '1 day',
   'verified', now() - interval '10 days'),
  ('60000000-0000-4000-8000-000000000005', 'second-shop', 'Second Shop', 'Second Shop LLC',
   'second@test.invalid', '+201000000005', 'EG', 'active', null, 'verified', now() - interval '10 days'),
  -- The blocker runs a storefront too, which is what makes the reverse direction testable.
  ('60000000-0000-4000-8000-000000000001', 'buyer-shop', 'Buyer Shop', 'Buyer Shop LLC',
   'buyershop@test.invalid', '+201000000009', 'EG', 'active', null, 'verified', now() - interval '10 days');

insert into public.categories (id, parent_id, slug, is_active, sort_order) values
  ('c6000000-0000-4000-8000-000000000001', null, 'furniture', true, 1);
insert into public.category_translations (category_id, locale_code, name) values
  ('c6000000-0000-4000-8000-000000000001', 'en', 'Furniture');

create or replace function pg_temp.listing(
  p_id uuid, p_slug text, p_seller uuid, p_title text, p_type text
) returns void language plpgsql as $$
begin
  insert into public.listings (
    id, seller_user_id, listing_type_code, category_id, slug, title, description, content_language,
    currency_code, price_minor, is_negotiable, status, country_code, city, created_at, approved_at
  ) values (
    p_id, p_seller, p_type, 'c6000000-0000-4000-8000-000000000001', p_slug, p_title,
    'A description long enough to satisfy the length constraint.', 'en',
    'EGP', 250000, true, 'active', 'EG', 'Cairo', now() - interval '10 days', now() - interval '9 days'
  );
end;
$$;

select pg_temp.listing('16660000-0000-4000-8000-000000000001', 'walnut-table',
  '60000000-0000-4000-8000-000000000002', 'Walnut dining table', 'product');
select pg_temp.listing('16660000-0000-4000-8000-000000000002', 'oak-bench',
  '60000000-0000-4000-8000-000000000002', 'Oak bench', 'product');
select pg_temp.listing('16660000-0000-4000-8000-000000000003', 'logo-design',
  '60000000-0000-4000-8000-000000000002', 'Logo design', 'service');

-- v5.2 sends fixed-price services through the cart, so only a custom one reaches request → quote.
insert into public.listing_service_details (listing_id, pricing_model, delivery_days, requires_brief)
values ('16660000-0000-4000-8000-000000000003', 'custom', null, true);

-- A conversation, an offer and a service request, all created **before** any block exists. Each is the "it
-- worked a moment ago" half of a before-and-after pair below.
create temporary table made (name text primary key, id uuid);

insert into made select 'conversation', conversation_id
  from app_private.messaging_start_conversation(
    '60000000-0000-4000-8000-000000000001', 'listing', '16660000-0000-4000-8000-000000000001', null);
insert into made select 'offer', offer_id
  from app_private.offer_create(
    '60000000-0000-4000-8000-000000000001', '16660000-0000-4000-8000-000000000001', 200000, 1, null);
insert into made select 'request', request_id
  from app_private.service_request_create(
    '60000000-0000-4000-8000-000000000001', '16660000-0000-4000-8000-000000000003', 'A logo please',
    'A brief long enough to satisfy whatever length constraint exists on it.', null, null);

select isnt((select id from made where name = 'conversation'), null, 'the fixture conversation exists');
select isnt((select id from made where name = 'offer'), null, 'the fixture offer exists');
select isnt((select id from made where name = 'request'), null, 'the fixture service request exists');

-- A message sent before the block, so the "existing conversation stays readable" claim has something to read.
insert into public.messages (conversation_id, sender_user_id, body)
values ((select id from made where name = 'conversation'),
        '60000000-0000-4000-8000-000000000001', 'Is this still available?');

-- ---------------------------------------------------------------------------------------------------
-- The functions exist, with the privileges this architecture requires
-- ---------------------------------------------------------------------------------------------------
select has_function('app_private', 'block_target', array['uuid', 'uuid', 'text'],
  'the resolver exists');
select has_function('app_private', 'buyer_block_add', array['uuid', 'uuid', 'text', 'text'],
  'the writer exists');
select has_function('app_private', 'buyer_block_remove', array['uuid', 'uuid'],
  'the remover exists');
select has_function('app_private', 'buyer_blocks', array['uuid', 'integer', 'timestamptz', 'uuid'],
  'the list exists');

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('block_target', 'buyer_block_add', 'buyer_block_remove', 'buyer_blocks')
      and p.prosecdef),
  4,
  'all four run as SECURITY DEFINER, because app_system holds no table privilege'
);

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('block_target', 'buyer_block_add', 'buyer_block_remove', 'buyer_blocks')
      and p.proconfig @> array['search_path=pg_catalog, public']),
  4,
  'and all four pin search_path, so a shadowing schema cannot redirect them'
);

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('block_target', 'buyer_blocks')
      and p.provolatile = 's'),
  2,
  'the resolver and the list are STABLE; only the two writers are volatile'
);

-- Execution ---------------------------------------------------------------------------------------
create or replace function pg_temp.may(p_role text, p_signature text) returns boolean
language sql stable as $$
  select has_function_privilege(p_role, p_signature, 'execute');
$$;

select ok(pg_temp.may('app_system', 'app_private.buyer_block_add(uuid,uuid,text,text)'),
  'app_system may create a block');
select ok(pg_temp.may('app_system', 'app_private.buyer_block_remove(uuid,uuid)'),
  'app_system may remove one');
select ok(pg_temp.may('app_system', 'app_private.buyer_blocks(uuid,integer,timestamptz,uuid)'),
  'app_system may read the list');
select ok(pg_temp.may('app_system', 'app_private.block_target(uuid,uuid,text)'),
  'app_system may resolve a handle');

select ok(not pg_temp.may('app_worker', 'app_private.buyer_block_add(uuid,uuid,text,text)'),
  'the worker may not create a block: no schedule and no event decides who may contact whom');
select ok(not pg_temp.may('app_worker', 'app_private.buyer_block_remove(uuid,uuid)'),
  'and may not remove one, which is the direction that would matter most');
select ok(not pg_temp.may('app_worker', 'app_private.buyer_blocks(uuid,integer,timestamptz,uuid)'),
  'and may not read anybody''s list');
select ok(not pg_temp.may('app_worker', 'app_private.block_target(uuid,uuid,text)'),
  'and may not turn a slug into an account');

select ok(not pg_temp.may('authenticated', 'app_private.buyer_block_add(uuid,uuid,text,text)'),
  'a signed-in browser role reaches none of this directly');
select ok(not pg_temp.may('anon', 'app_private.buyer_blocks(uuid,integer,timestamptz,uuid)'),
  'and anon reaches none of it either');
select ok(not pg_temp.may('public', 'app_private.buyer_block_add(uuid,uuid,text,text)'),
  'and nothing is left granted to public');

-- ---------------------------------------------------------------------------------------------------
-- 0005 is untouched
-- ---------------------------------------------------------------------------------------------------
-- This migration adds a writer. It must not have quietly reshaped the table the writer writes, because six
-- other increments depend on that shape.
select set_eq(
  $$select column_name from information_schema.columns
     where table_schema = 'public' and table_name = 'user_blocks'$$,
  $$values ('blocker_id'), ('blocked_id'), ('reason'), ('created_at')$$,
  'user_blocks still has exactly 0005''s four columns'
);

select hasnt_column('public', 'user_blocks', 'id',
  'and still no surrogate key, which is why the unblock reference is minted at the API edge');

select col_is_pk('public', 'user_blocks', array['blocker_id', 'blocked_id'],
  'the primary key is still the pair');

select set_eq(
  $$select policyname from pg_policies where schemaname = 'public' and tablename = 'user_blocks'$$,
  $$values ('user_blocks_self_all')$$,
  'and still exactly one policy: no staff policy and no reverse-lookup policy was added'
);

select ok(
  (select count(*) from pg_constraint c join pg_class t on t.oid = c.conrelid
    where t.relname = 'user_blocks' and c.conname in ('user_blocks_not_self', 'user_blocks_reason_length')) = 2,
  'and 0005''s self-block and reason-length constraints are both still there'
);

-- The predicate itself -----------------------------------------------------------------------------
select ok(public.is_blocked_between(
    '60000000-0000-4000-8000-000000000003', '60000000-0000-4000-8000-000000000002') = false,
  'nobody is blocked yet, so the predicate is false for every pair the tests use');

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'is_blocked_between'),
  1,
  'there is still exactly one is_blocked_between, not a second one added alongside it'
);

-- All six enforcers still call it. If one stopped, the refusal tests below could pass against a block that
-- no longer protects anything.
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('messaging_start_conversation', 'offer_create', 'offer_counter',
                        'service_request_create', 'service_quote_create', 'tg_messages_block_rule')
      and p.prosrc like '%is_blocked_between%'),
  6,
  'and all six closed enforcers still consult it'
);

-- ---------------------------------------------------------------------------------------------------
-- Resolving a handle
-- ---------------------------------------------------------------------------------------------------
-- A person is named by a conversation or by a seller slug. Never by an account identifier, which is why
-- there is no third arm here to test.
select is(app_private.block_target('60000000-0000-4000-8000-000000000001', null, null), null,
  'no handle resolves to nobody');

select is(
  app_private.block_target('60000000-0000-4000-8000-000000000001',
    (select id from made where name = 'conversation'), 'good-shop'),
  null,
  'two handles in one call resolve to nobody: that is a malformed request, not a precedence puzzle'
);

select is(app_private.block_target(null, null, 'good-shop'), null,
  'and no caller resolves to nobody');

-- The slug arm ------------------------------------------------------------------------------------
select is(
  app_private.block_target('60000000-0000-4000-8000-000000000001', null, 'good-shop'),
  '60000000-0000-4000-8000-000000000002'::uuid,
  'a public storefront slug resolves to its owner'
);

select is(
  app_private.block_target('60000000-0000-4000-8000-000000000001', null, E'  good-shop\t'),
  '60000000-0000-4000-8000-000000000002'::uuid,
  'and surrounding whitespace is trimmed, tabs included'
);

select is(app_private.block_target('60000000-0000-4000-8000-000000000001', null, 'no-such-shop'), null,
  'an unknown slug resolves to nobody');

select is(app_private.block_target('60000000-0000-4000-8000-000000000001', null, 'gone-shop'), null,
  'and so does a storefront that is not publicly visible, so this is not an oracle over suspensions');

select is(app_private.block_target('60000000-0000-4000-8000-000000000001', null, '   '), null,
  'a blank slug is no handle at all rather than a slug to look up');

select is(app_private.block_target('60000000-0000-4000-8000-000000000001', null, E'\t\r\n'), null,
  'and neither is one made only of tabs and newlines');

select is(app_private.block_target('60000000-0000-4000-8000-000000000002', null, 'good-shop'), null,
  'nobody blocks themselves through their own slug');

-- The conversation arm ----------------------------------------------------------------------------
select is(
  app_private.block_target('60000000-0000-4000-8000-000000000001',
    (select id from made where name = 'conversation'), null),
  '60000000-0000-4000-8000-000000000002'::uuid,
  'a conversation resolves to the other participant'
);

select is(
  app_private.block_target('60000000-0000-4000-8000-000000000002',
    (select id from made where name = 'conversation'), null),
  '60000000-0000-4000-8000-000000000001'::uuid,
  'and resolves the other way round for the other participant'
);

select is(
  app_private.block_target('60000000-0000-4000-8000-000000000003',
    (select id from made where name = 'conversation'), null),
  null,
  'somebody who is not in the conversation resolves to nobody, so this is not an oracle over threads'
);

select is(
  app_private.block_target('60000000-0000-4000-8000-000000000001',
    '16660000-0000-4000-8000-00000000ffff', null),
  null,
  'and a conversation that does not exist answers exactly the same way'
);

savepoint resolution;

update public.conversation_participants set left_at = now()
 where conversation_id = (select id from made where name = 'conversation')
   and user_id = '60000000-0000-4000-8000-000000000001';

select is(
  app_private.block_target('60000000-0000-4000-8000-000000000001',
    (select id from made where name = 'conversation'), null),
  null,
  'somebody who has left the conversation can no longer name the other side through it'
);
select is(
  app_private.block_target('60000000-0000-4000-8000-000000000002',
    (select id from made where name = 'conversation'), null),
  null,
  'and the one still in it resolves to nobody, because the other side is gone'
);

rollback to savepoint resolution;

savepoint support_present;

insert into public.conversation_participants (conversation_id, user_id, role)
values ((select id from made where name = 'conversation'), '60000000-0000-4000-8000-000000000003', 'support');

select is(
  app_private.block_target('60000000-0000-4000-8000-000000000001',
    (select id from made where name = 'conversation'), null),
  '60000000-0000-4000-8000-000000000002'::uuid,
  'support joining a thread does not change who blocking it means'
);
select is(
  app_private.block_target('60000000-0000-4000-8000-000000000002',
    (select id from made where name = 'conversation'), null),
  '60000000-0000-4000-8000-000000000001'::uuid,
  'and support is never the person resolved, so nobody blocks support through a thread'
);

rollback to savepoint support_present;

savepoint three_party;

insert into public.conversation_participants (conversation_id, user_id, role)
values ((select id from made where name = 'conversation'), '60000000-0000-4000-8000-000000000005', 'member');

select is(
  app_private.block_target('60000000-0000-4000-8000-000000000001',
    (select id from made where name = 'conversation'), null),
  null,
  'a thread with two other live participants resolves to nobody rather than guessing which one was meant'
);

rollback to savepoint three_party;

-- ---------------------------------------------------------------------------------------------------
-- Creating a block
-- ---------------------------------------------------------------------------------------------------
select throws_ok(
  $$select app_private.buyer_block_add(null, null, 'good-shop', null)$$,
  '22023',
  'buyer_block_add requires an account',
  'a call with no account raises rather than refusing quietly, because that is a caller defect'
);

select is(app_private.buyer_block_add('60000000-0000-4000-8000-000000000001', null, 'nope', null),
  'not_found', 'an unknown slug answers not_found');
select is(app_private.buyer_block_add('60000000-0000-4000-8000-000000000001', null, 'gone-shop', null),
  'not_found', 'and an invisible storefront answers the same, telling the two apart for nobody');
select is(app_private.buyer_block_add('60000000-0000-4000-8000-000000000002', null, 'good-shop', null),
  'not_found', 'and so does blocking yourself');
select is(app_private.buyer_block_add('60000000-0000-4000-8000-000000000003',
    (select id from made where name = 'conversation'), null, null),
  'not_found', 'and so does naming a conversation you are not in');
select is(app_private.buyer_block_add('60000000-0000-4000-8000-000000000001', null, null, 'why'),
  'not_found', 'and so does sending a reason with no handle');

select is(
  (select count(*)::int from public.user_blocks),
  0,
  'none of those wrote a row'
);

-- The real thing ----------------------------------------------------------------------------------
select is(
  app_private.buyer_block_add('60000000-0000-4000-8000-000000000001', null, 'good-shop', '  harassing me  '),
  'blocked',
  'blocking by slug answers blocked'
);

select results_eq(
  $$select blocker_id::text, blocked_id::text, reason from public.user_blocks$$,
  $$values ('60000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000002', 'harassing me')$$,
  'and wrote exactly one row, the right way round, with the reason trimmed'
);

select is(
  app_private.buyer_block_add('60000000-0000-4000-8000-000000000001', null, 'good-shop', 'still harassing me'),
  'exists',
  'blocking the same person again answers exists rather than failing'
);

-- The reason is told apart from the insert by `xmax`, not by a clock: every statement in this file shares
-- one transaction and therefore one `now()`, which is precisely the case a timestamp comparison cannot see.
select is(
  (select reason from public.user_blocks where blocker_id = '60000000-0000-4000-8000-000000000001'),
  'still harassing me',
  'and the repeat refreshes the reason, because the reason describes why the block stands now'
);

select is(
  app_private.buyer_block_add('60000000-0000-4000-8000-000000000001',
    (select id from made where name = 'conversation'), null, null),
  'exists',
  'reaching the same person through the conversation instead finds the same block'
);

select is(
  (select reason from public.user_blocks where blocker_id = '60000000-0000-4000-8000-000000000001'),
  null,
  'and a repeat with no reason clears it, rather than leaving a stale one standing'
);

select is(
  (select count(*)::int from public.user_blocks),
  1,
  'after four calls naming the same person there is still exactly one row'
);

-- 0005's bound, reached through the writer ---------------------------------------------------------
savepoint reason_bound;
select is(
  app_private.buyer_block_add('60000000-0000-4000-8000-000000000001', null, 'good-shop', repeat('x', 500)),
  'exists',
  'a reason of exactly 500 characters is accepted, which is 0005''s bound'
);
select throws_ok(
  format($$select app_private.buyer_block_add('60000000-0000-4000-8000-000000000001', null, 'good-shop', %L)$$,
         repeat('x', 501)),
  '23514',
  null,
  'and 501 characters is refused by 0005''s own constraint rather than by a bound re-invented here'
);
rollback to savepoint reason_bound;

-- ---------------------------------------------------------------------------------------------------
-- The six enforcement paths
-- ---------------------------------------------------------------------------------------------------
-- Each is run twice. The first run is inside a savepoint that is rolled back, so the second run meets the
-- same state plus the block and nothing else. Without the first run, a refusal could be the fixture's fault.
create or replace function pg_temp.block_exists() returns boolean language sql stable as $$
  select public.is_blocked_between(
    '60000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000002');
$$;

select ok(pg_temp.block_exists(), 'the block is in place for everything below');

select ok(
  public.is_blocked_between(
    '60000000-0000-4000-8000-000000000002', '60000000-0000-4000-8000-000000000001'),
  'and 0005''s predicate reports it in both directions, which is where the symmetry comes from'
);

-- 1. Starting a direct conversation ---------------------------------------------------------------
savepoint before_1;
update public.user_blocks set blocker_id = blocker_id where false;  -- no-op, keeps the savepoint honest
delete from public.user_blocks;
select is(
  (select outcome from app_private.messaging_start_conversation(
     '60000000-0000-4000-8000-000000000001', 'direct', null, 'good-shop')),
  'created',
  'without the block, a direct conversation can be started'
);
rollback to savepoint before_1;

select is(
  (select outcome from app_private.messaging_start_conversation(
     '60000000-0000-4000-8000-000000000001', 'direct', null, 'good-shop')),
  'blocked',
  'with it, messaging_start_conversation refuses the direct entry point'
);

-- 2. Starting a conversation about another listing ------------------------------------------------
savepoint before_2;
delete from public.user_blocks;
select is(
  (select outcome from app_private.messaging_start_conversation(
     '60000000-0000-4000-8000-000000000001', 'listing', '16660000-0000-4000-8000-000000000002', null)),
  'created',
  'without the block, a second listing thread can be started'
);
rollback to savepoint before_2;

select is(
  (select outcome from app_private.messaging_start_conversation(
     '60000000-0000-4000-8000-000000000001', 'listing', '16660000-0000-4000-8000-000000000002', null)),
  'blocked',
  'with it, the listing entry point refuses too, so the block is not specific to one subject type'
);

-- 3. Creating an offer ----------------------------------------------------------------------------
-- The fixture offer is still pending, so a second one needs its own listing.
savepoint before_3;
delete from public.user_blocks;
select is(
  (select outcome from app_private.offer_create(
     '60000000-0000-4000-8000-000000000001', '16660000-0000-4000-8000-000000000002', 200000, 1, null)),
  'created',
  'without the block, an offer can be made'
);
rollback to savepoint before_3;

select is(
  (select outcome from app_private.offer_create(
     '60000000-0000-4000-8000-000000000001', '16660000-0000-4000-8000-000000000002', 200000, 1, null)),
  'blocked',
  'with it, offer_create refuses'
);

-- 4. Countering an offer that was made before the block -------------------------------------------
savepoint before_4;
delete from public.user_blocks;
select is(
  (select outcome from app_private.offer_counter(
     '60000000-0000-4000-8000-000000000001', (select id from made where name = 'offer'), 210000, 1, null)),
  'countered',
  'without the block, the offer made earlier can be countered'
);
rollback to savepoint before_4;

select is(
  (select outcome from app_private.offer_counter(
     '60000000-0000-4000-8000-000000000001', (select id from made where name = 'offer'), 210000, 1, null)),
  'blocked',
  'with it, offer_counter refuses: a negotiation already under way cannot be continued'
);

-- 5. Creating a service request -------------------------------------------------------------------
savepoint before_5;
delete from public.user_blocks;
select is(
  (select outcome from app_private.service_request_create(
     '60000000-0000-4000-8000-000000000001', '16660000-0000-4000-8000-000000000003', 'Another logo',
     'A brief long enough to satisfy whatever length constraint exists on it.', null, null)),
  'created',
  'without the block, a service request can be opened'
);
rollback to savepoint before_5;

select is(
  (select outcome from app_private.service_request_create(
     '60000000-0000-4000-8000-000000000001', '16660000-0000-4000-8000-000000000003', 'Another logo',
     'A brief long enough to satisfy whatever length constraint exists on it.', null, null)),
  'blocked',
  'with it, service_request_create refuses'
);

-- 6. Quoting a request that was opened before the block -------------------------------------------
-- This one runs from the *seller's* side, so it also shows that the blocked person is stopped rather than
-- only the person who pressed Block.
savepoint before_6;
delete from public.user_blocks;
select is(
  (select outcome from app_private.service_quote_create(
     '60000000-0000-4000-8000-000000000002', (select id from made where name = 'request'),
     300000, 7::smallint, 2::smallint, 'Two concepts and two revisions.', 14::smallint)),
  'created',
  'without the block, the seller can quote the request'
);
rollback to savepoint before_6;

select is(
  (select outcome from app_private.service_quote_create(
     '60000000-0000-4000-8000-000000000002', (select id from made where name = 'request'),
     300000, 7::smallint, 2::smallint, 'Two concepts and two revisions.', 14::smallint)),
  'blocked',
  'with it, service_quote_create refuses the blocked seller, not just the person who blocked them'
);

-- 7. The trigger, proved by a real insert ---------------------------------------------------------
savepoint before_7;
delete from public.user_blocks;
select lives_ok(
  format($$insert into public.messages (conversation_id, sender_user_id, body)
             values (%L, '60000000-0000-4000-8000-000000000001', 'without a block this lands')$$,
         (select id from made where name = 'conversation')),
  'without the block, a message into the existing conversation is inserted'
);
rollback to savepoint before_7;

select throws_ok(
  format($$insert into public.messages (conversation_id, sender_user_id, body)
             values (%L, '60000000-0000-4000-8000-000000000001', 'with a block this must not land')$$,
         (select id from made where name = 'conversation')),
  '42501',
  'the conversation is blocked between these users',
  'with it, tg_messages_block_rule refuses a direct insert into public.messages'
);

select throws_ok(
  format($$insert into public.messages (conversation_id, sender_user_id, body)
             values (%L, '60000000-0000-4000-8000-000000000002', 'and neither does this')$$,
         (select id from made where name = 'conversation')),
  '42501',
  'the conversation is blocked between these users',
  'and refuses the blocked person''s message too, at the lowest level either of them can reach'
);

-- 8. And through the writer a browser actually reaches ------------------------------------------------
-- `messaging_send_message` does not consult the predicate itself; it inserts, and the trigger stops it. That
-- is the arrangement worth pinning, because it is what makes the refusal impossible to forget to ask for.
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'messaging_send_message'
      and p.prosrc like '%is_blocked_between%'),
  0,
  'messaging_send_message has no block check of its own'
);

-- It is refused anyway, and 0054 turns the trigger's `insufficient_privilege` into an outcome rather than
-- letting it reach the caller as an exception. So the trigger is the authority and the function is the
-- translator, which is the arrangement that cannot be bypassed by forgetting to ask.
savepoint before_8;
delete from public.user_blocks;
select is(
  (select outcome from app_private.messaging_send_message(
     '60000000-0000-4000-8000-000000000001', (select id from made where name = 'conversation'),
     'without a block this sends')),
  'sent',
  'without the block, the message writer sends'
);
rollback to savepoint before_8;

select is(
  (select outcome from app_private.messaging_send_message(
     '60000000-0000-4000-8000-000000000001', (select id from made where name = 'conversation'),
     'with a block this must not send')),
  'blocked',
  'and with it the writer reports blocked, having caught what the trigger raised beneath it'
);
select is(
  (select count(*)::int from public.messages
    where conversation_id = (select id from made where name = 'conversation')),
  1,
  'and wrote no message, so the refusal is a rollback and not a status'
);

-- ---------------------------------------------------------------------------------------------------
-- What blocking did not do
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::int from public.conversations where id = (select id from made where name = 'conversation')),
  1,
  'the conversation still exists: nothing was deleted'
);

select is(
  (select closed_at from public.conversations where id = (select id from made where name = 'conversation')),
  null,
  'and was not closed'
);

select is(
  (select count(*)::int from public.messages
    where conversation_id = (select id from made where name = 'conversation')),
  1,
  'the message sent before the block is still there, so the thread stays readable'
);

select is(
  (select count(*)::int from public.conversation_participants
    where conversation_id = (select id from made where name = 'conversation') and left_at is not null),
  0,
  'neither participant was made to leave'
);

select is(
  (select count(*)::int from public.conversation_participants
    where conversation_id = (select id from made where name = 'conversation') and is_muted),
  0,
  'and neither was muted'
);

-- Readable, not merely present: both sides can still open the thread and still see it in their inbox.
select is(
  (select count(*)::int from app_private.messaging_conversation_messages(
     '60000000-0000-4000-8000-000000000001', (select id from made where name = 'conversation'), 50, null)),
  1,
  'the blocker can still read the thread'
);
select is(
  (select count(*)::int from app_private.messaging_conversation_messages(
     '60000000-0000-4000-8000-000000000002', (select id from made where name = 'conversation'), 50, null)),
  1,
  'and so can the blocked person: blocking takes away the next message, not the record of the last one'
);
select ok(
  exists (select 1 from app_private.messaging_inbox('60000000-0000-4000-8000-000000000002', 20, null, null) i
           where i.conversation_id = (select id from made where name = 'conversation')),
  'and the thread is still in the blocked person''s inbox, because hiding it would be a notification'
);

select is(
  (select status from public.offers where id = (select id from made where name = 'offer')),
  'pending',
  'the offer is still pending: its state machine was not driven by a block'
);

select is(
  (select status from public.service_requests where id = (select id from made where name = 'request')),
  'open',
  'and the service request is still open'
);

-- The catalogue -----------------------------------------------------------------------------------
-- Visibility belongs to the catalogue readers. Filtering it per viewer would change a closed read surface
-- and the caching in front of it, so a blocked seller's listings stay exactly as visible as before.
select is(
  (select count(*)::int from app_private.public_listing_by_slug('walnut-table', 'en')),
  1,
  'the blocked seller''s listing is still readable by slug'
);

select ok(
  exists (select 1 from app_private.public_listings(50, null, null) l where l.slug = 'walnut-table'),
  'and still appears in the public listing feed, which takes no viewer and so cannot be filtered by one'
);

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'public\_%'
      and p.prosrc like '%is_blocked_between%'),
  0,
  'no public catalogue reader consults the block predicate at all'
);

-- Silence -----------------------------------------------------------------------------------------
-- An audit row, an outbox event or a security event would each be a durable record of who blocked whom, and
-- staff surfaces already read two of them. That is the reverse lookup, arriving by another door.
select is(
  (select count(*)::int from audit.audit_logs where table_name = 'user_blocks'),
  0,
  'blocking writes no audit row, which is what keeps it out of the staff audit console'
);

select is(
  (select count(*)::int from public.outbox_events where aggregate_type ilike '%block%'
                                                     or event_type ilike '%block%'),
  0,
  'and no outbox event, so nothing can be relayed to the blocked person'
);

select is(
  (select count(*)::int from public.security_events where event_type ilike '%block%'),
  0,
  'and no security event'
);

select is(
  (select count(*)::int from public.notifications where event_type ilike '%block%'
                                                     or template_key ilike '%block%'),
  0,
  'and no notification: the blocked person is not told'
);

-- ---------------------------------------------------------------------------------------------------
-- The caller's own list
-- ---------------------------------------------------------------------------------------------------
-- Two more blocks, so ordering and paging have something to order and page. The third person has a null
-- display name and the fourth has no profile row at all.
select is(
  app_private.buyer_block_add('60000000-0000-4000-8000-000000000001', null, 'second-shop', 'also bothering me'),
  'blocked',
  'a second person can be blocked'
);

-- THIRD and NAMELESS run no storefront, so they are reached through a conversation instead — which is the
-- other half of the point that no account identifier is ever the public handle.
insert into made select 'conv_third', conversation_id
  from app_private.messaging_start_conversation(
    '60000000-0000-4000-8000-000000000006', 'direct', null, 'buyer-shop');
insert into made select 'conv_nameless', conversation_id
  from app_private.messaging_start_conversation(
    '60000000-0000-4000-8000-000000000007', 'direct', null, 'buyer-shop');

select is(
  app_private.buyer_block_add('60000000-0000-4000-8000-000000000001',
    (select id from made where name = 'conv_third'), null, null),
  'blocked',
  'somebody with no storefront is blocked through the conversation they opened'
);
select is(
  app_private.buyer_block_add('60000000-0000-4000-8000-000000000001',
    (select id from made where name = 'conv_nameless'), null, null),
  'blocked',
  'and so is somebody with no profile row at all'
);

select is(
  (select count(*)::int from app_private.buyer_blocks('60000000-0000-4000-8000-000000000001', 20, null, null)),
  4,
  'the list holds all four'
);

select set_eq(
  $$select coalesce(display_name, '<none>') || '/' || coalesce(seller_slug, '<none>')
      from app_private.buyer_blocks('60000000-0000-4000-8000-000000000001', 20, null, null)$$,
  $$values ('Sally Seller/good-shop'), ('Second Person/second-shop'),
           ('<none>/<none>'), ('<none>/<none>')$$,
  'naming each person by display name and storefront slug, with both absent where neither exists'
);

select bag_eq(
  $$select reason from app_private.buyer_blocks('60000000-0000-4000-8000-000000000001', 20, null, null)$$,
  $$values (null::text), ('also bothering me'), (null::text), (null::text)$$,
  'and carries the reason, which is the blocker''s own note to themselves'
);

-- Nothing else about the person --------------------------------------------------------------------
select set_eq(
  $$select a.attname from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      join unnest(p.proallargtypes, p.proargnames, p.proargmodes)
        with ordinality as a(atttype, attname, attmode, ord) on true
     where n.nspname = 'app_private' and p.proname = 'buyer_blocks' and a.attmode = 't'$$,
  $$values ('blocked_user_id'), ('display_name'), ('seller_slug'), ('reason'), ('created_at')$$,
  'the list returns exactly five columns: no contact detail, no account status, no history'
);

-- Scope -------------------------------------------------------------------------------------------
select is(
  (select count(*)::int from app_private.buyer_blocks('60000000-0000-4000-8000-000000000002', 20, null, null)),
  0,
  'the blocked person''s own list is empty: there is no reverse lookup anywhere'
);

select is(
  (select count(*)::int from app_private.buyer_blocks('60000000-0000-4000-8000-000000000003', 20, null, null)),
  0,
  'and a stranger''s list is empty rather than everybody''s'
);

select is(
  (select count(*)::int from app_private.buyer_blocks(null, 20, null, null)),
  0,
  'and no caller reads nothing rather than reading the table'
);

-- Order and paging --------------------------------------------------------------------------------
-- Every row in this file shares one `now()`, so `created_at` ties for all four and the tiebreak is doing all
-- the work. That is the harder case, not the easier one: a cursor that only worked on distinct timestamps
-- would loop or skip here.
select is(
  (select count(distinct created_at)::int
     from app_private.buyer_blocks('60000000-0000-4000-8000-000000000001', 20, null, null)),
  1,
  'all four rows share one created_at, so paging is tested against a full tie'
);

select results_eq(
  $$select blocked_user_id::text
      from app_private.buyer_blocks('60000000-0000-4000-8000-000000000001', 20, null, null)$$,
  $$values ('60000000-0000-4000-8000-000000000007'), ('60000000-0000-4000-8000-000000000006'),
           ('60000000-0000-4000-8000-000000000005'), ('60000000-0000-4000-8000-000000000002')$$,
  'and are ordered newest first, falling back to the identifier so the order is total'
);

select is(
  (select count(*)::int from app_private.buyer_blocks('60000000-0000-4000-8000-000000000001', 2, null, null)),
  2,
  'a page size of two returns two'
);

create or replace function pg_temp.page_after(p_created timestamptz, p_id uuid)
returns table (blocked_user_id uuid) language sql stable as $$
  select b.blocked_user_id
    from app_private.buyer_blocks('60000000-0000-4000-8000-000000000001', 2, p_created, p_id) b;
$$;

select results_eq(
  $$select blocked_user_id::text from pg_temp.page_after(
      (select created_at from app_private.buyer_blocks('60000000-0000-4000-8000-000000000001', 2, null, null)
        offset 1 limit 1),
      (select blocked_user_id from app_private.buyer_blocks('60000000-0000-4000-8000-000000000001', 2, null, null)
        offset 1 limit 1))$$,
  $$values ('60000000-0000-4000-8000-000000000005'), ('60000000-0000-4000-8000-000000000002')$$,
  'and the cursor from the end of page one returns page two, with no row repeated and none skipped'
);

select is(
  (select count(*)::int from app_private.buyer_blocks(
     '60000000-0000-4000-8000-000000000001', 2,
     (select min(created_at) from public.user_blocks),
     '00000000-0000-4000-8000-000000000000')),
  0,
  'a cursor past the end returns nothing rather than wrapping round'
);

select is(
  (select count(*)::int from app_private.buyer_blocks('60000000-0000-4000-8000-000000000001', 20,
     now(), null)),
  4,
  'a half-formed cursor is ignored rather than trusted, because a partial key cannot order a tie'
);
select is(
  (select count(*)::int from app_private.buyer_blocks('60000000-0000-4000-8000-000000000001', 20,
     null, '60000000-0000-4000-8000-000000000005')),
  4,
  'and so is the other half of one'
);

select is(
  (select count(*)::int from app_private.buyer_blocks('60000000-0000-4000-8000-000000000001', 0, null, null)),
  1,
  'a page size of zero is clamped up to one'
);
select is(
  (select count(*)::int from app_private.buyer_blocks('60000000-0000-4000-8000-000000000001', -5, null, null)),
  1,
  'and so is a negative one');
select is(
  (select count(*)::int from app_private.buyer_blocks('60000000-0000-4000-8000-000000000001', null, null, null)),
  4,
  'and no page size falls back to the default rather than to everything');
select ok(
  (select count(*) from app_private.buyer_blocks('60000000-0000-4000-8000-000000000001', 100000, null, null)) = 4,
  'and an enormous one is clamped to the ceiling, which is still above the four rows here');

-- ---------------------------------------------------------------------------------------------------
-- Removing a block
-- ---------------------------------------------------------------------------------------------------
select is(
  app_private.buyer_block_remove('60000000-0000-4000-8000-000000000003', '60000000-0000-4000-8000-000000000002'),
  false,
  'somebody else cannot remove this blocker''s block'
);
select is(
  (select count(*)::int from public.user_blocks
    where blocker_id = '60000000-0000-4000-8000-000000000001'
      and blocked_id = '60000000-0000-4000-8000-000000000002'),
  1,
  'and the row is still there, so a reference from another list spends on nothing'
);

select is(
  app_private.buyer_block_remove(null, '60000000-0000-4000-8000-000000000002'),
  false,
  'no caller removes nothing');
select is(
  app_private.buyer_block_remove('60000000-0000-4000-8000-000000000001', null),
  false,
  'and no target removes nothing');
select is(
  app_private.buyer_block_remove('60000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000003'),
  false,
  'and removing somebody who was never blocked answers false rather than raising');

select is(
  app_private.buyer_block_remove('60000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000002'),
  true,
  'the blocker removes their own block'
);
select is(
  app_private.buyer_block_remove('60000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000002'),
  false,
  'and removing it twice answers false the second time'
);

select is(
  (select count(*)::int from app_private.buyer_blocks('60000000-0000-4000-8000-000000000001', 20, null, null)),
  3,
  'the list is down to three, so only the one row went'
);

select ok(
  not public.is_blocked_between(
    '60000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000002'),
  'and the predicate is false again'
);

select is(
  (select outcome from app_private.messaging_start_conversation(
     '60000000-0000-4000-8000-000000000001', 'direct', null, 'good-shop')),
  'created',
  'so the direct conversation can be started again: unblocking restores, it does not merely record'
);

select lives_ok(
  format($$insert into public.messages (conversation_id, sender_user_id, body)
             values (%L, '60000000-0000-4000-8000-000000000001', 'and messages land again')$$,
         (select id from made where name = 'conversation')),
  'and a message into the old thread lands again, through the same trigger that refused it'
);

-- ---------------------------------------------------------------------------------------------------
-- A block belongs to one pair
-- ---------------------------------------------------------------------------------------------------
select ok(
  not public.is_blocked_between(
    '60000000-0000-4000-8000-000000000003', '60000000-0000-4000-8000-000000000005'),
  'blocking somebody does not block an unrelated pair'
);

select is(
  app_private.buyer_block_add('60000000-0000-4000-8000-000000000003', null, 'second-shop', null),
  'blocked',
  'and a second person may block somebody who is already blocked by someone else'
);
select is(
  (select count(*)::int from public.user_blocks where blocked_id = '60000000-0000-4000-8000-000000000005'),
  2,
  'which is a second row, because the key is the pair and not the target'
);
select is(
  (select count(*)::int from app_private.buyer_blocks('60000000-0000-4000-8000-000000000003', 20, null, null)),
  1,
  'and each blocker sees only their own row'
);

-- 0005's cascade, exercised rather than read off the catalogue: closing an account takes its blocks with it,
-- in both roles.
savepoint cascade;
delete from auth.users where id = '60000000-0000-4000-8000-000000000005';
select is(
  (select count(*)::int from public.user_blocks where blocked_id = '60000000-0000-4000-8000-000000000005'),
  0,
  'deleting the blocked account removes every block against it, through 0005''s own cascade'
);
select is(
  (select count(*)::int from app_private.buyer_blocks('60000000-0000-4000-8000-000000000003', 20, null, null)),
  0,
  'so no list is left pointing at an account that is gone'
);
rollback to savepoint cascade;

-- ---------------------------------------------------------------------------------------------------
-- Nothing was added that 0103 said it would not add
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::int from public.permissions where key ilike '%block%'),
  0,
  'no permission key was added: the table''s own policy already says who may write it'
);

select is(
  (select count(*)::int from app_private.scheduled_job_contract where job_key ilike '%block%'),
  0,
  'and no scheduled job: a block ends when its owner ends it, not on a timer'
);

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname ilike '%block%'
      and p.prosrc like '%can_read%'),
  0,
  'and no two-key staff reader, which is what a moderation console over blocks would need'
);

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname ilike '%block%' and p.proname like '%for_staff%'),
  0,
  'and no staff writer'
);

-- Named rather than counted, so a fifth function naming this table fails here with its own name in the
-- output. The resolver is in the list because it names a constraint in a comment, not because it reads the
-- table — which is itself worth pinning, since the whole point of that function is that it resolves a handle
-- and leaves the writing to somebody else.
select set_eq(
  $$select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app_private' and p.prosrc like '%user_blocks%'$$,
  $$values ('block_target'), ('buyer_block_add'), ('buyer_block_remove'), ('buyer_blocks')$$,
  'exactly four app_private functions name user_blocks, and they are the four this migration added'
);

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'block_target'
      and (p.prosrc like '%insert into public.user_blocks%'
        or p.prosrc like '%delete from public.user_blocks%')),
  0,
  'and the resolver writes nothing: it names a constraint in a comment and hands the account back'
);

select is(
  (select count(*)::int from public.security_contract_problems()),
  0,
  'and the security contract still reports nothing'
);

select finish();
rollback;
