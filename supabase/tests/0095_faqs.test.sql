-- 0095 — The help centre: the named public reader and the authoring functions.
--
-- What is proven here, in order: the two permission predicates apply 0003's requires_mfa rule; the topic mapping
-- answers from `pages.page_key` and **always returns exactly one row**, which is what keeps an unmapped topic
-- visible in the console rather than silently dropped; the public reader returns only published entries of the
-- topic asked for, in the operator's order, worded with the D7 fallback, and nothing at all for a topic nobody
-- has published under; the staff readers show every entry including the unpublished ones and report whether a
-- public page shows each topic; the keyset page is stable and total; every writer refuses a caller without the
-- manage key with 42501; a new entry is unpublished and a save can neither publish one nor reorder the help
-- centre; a reorder is scoped to its own topic; and the things this increment must NOT do hold — nothing reads a
-- banner, a promotion, a media row, `seo_metadata` or anything financial, and no schema object of 0030 changed.

-- Deterministic: fixed uuids, explicit states, and every assertion inside a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(190);

-- ---------------------------------------------------------------------------------------------------
-- Shape
-- ---------------------------------------------------------------------------------------------------
select has_function('app_private', 'faq_can_read', array['uuid', 'boolean'], 'the read predicate exists');
select has_function('app_private', 'faq_can_manage', array['uuid', 'boolean'], 'the manage predicate exists');
select has_function('app_private', 'faq_topic_mapping', array['text'], 'the topic mapping exists');
select has_function('app_private', 'public_faqs', array['text', 'text'], 'the public reader exists');
select has_function('app_private', 'faq_topics_for_staff', array['uuid', 'boolean'], 'the topic list exists');
select has_function('app_private', 'faqs_for_staff',
  array['uuid', 'boolean', 'text', 'text', 'integer', 'uuid', 'integer'], 'the staff list exists');
select has_function('app_private', 'faq_for_staff', array['uuid', 'boolean', 'uuid'], 'the staff detail exists');
select has_function('app_private', 'faq_save_for_staff',
  array['uuid', 'boolean', 'uuid', 'text', 'text', 'text', 'text', 'text', 'integer'],
  'the save writer exists');
select has_function('app_private', 'faq_state_for_staff', array['uuid', 'boolean', 'uuid', 'boolean'],
  'the state writer exists');
select has_function('app_private', 'faqs_reorder_for_staff', array['uuid', 'boolean', 'text', 'uuid[]'],
  'the reorder writer exists');
select has_function('app_private', 'faq_delete_for_staff', array['uuid', 'boolean', 'uuid'],
  'the delete writer exists');

select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and (p.proname like 'faq%' or p.proname like 'public_faqs%')
      and p.prosecdef),
  11, 'all eleven are security definer');

select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and (p.proname like 'faq%' or p.proname like 'public_faqs%')
      and p.proconfig @> array['search_path=pg_catalog, public']),
  11, 'all eleven pin search_path to pg_catalog, public');

select is((select count(*)::int from public.audit_attribution_problems()), 0,
  '0095 adds no audit attribution problem');

select matches(pg_get_function_result(p.oid), 'can_manage boolean',
  'the staff detail reports the manage capability')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and p.proname = 'faq_for_staff';

-- Owner decision 5: the console has to be able to show which topics no public address shows.
select matches(pg_get_function_result(p.oid), 'is_mapped boolean',
  'the staff detail reports whether a public page shows the topic')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and p.proname = 'faq_for_staff';
select matches(pg_get_function_result(p.oid), 'is_mapped boolean', 'and so does the staff list')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and p.proname = 'faqs_for_staff';
select matches(pg_get_function_result(p.oid), 'page_slug text',
  'with the mapped page''s slug, so a caller can check its own route map')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and p.proname = 'faqs_for_staff';

-- The public reader hands out the words and nothing about the arrangement.
select hasnt_function('app_private', 'faq_structured_data', 'no structured-data function was added');

-- ---------------------------------------------------------------------------------------------------
-- What this increment must not read
-- ---------------------------------------------------------------------------------------------------
-- Read from the stored bodies rather than asserted by behaviour, because the point is that the code does not
-- mention these things at all.
select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and (p.proname like 'faq%' or p.proname like 'public_faqs%')
      and (p.prosrc ~* 'promotion' or p.prosrc ~* 'placement' or p.prosrc ~* 'wallet'
           or p.prosrc ~* 'ranking' or p.prosrc ~* 'popularity')),
  0, 'no 0095 function mentions a promotion, a placement, a wallet, a ranking or a popularity signal');

select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and (p.proname like 'faq%' or p.proname like 'public_faqs%')
      and (p.prosrc ~* 'ledger' or p.prosrc ~* 'payout' or p.prosrc ~* 'settlement'
           or p.prosrc ~* 'seller_balances' or p.prosrc ~* 'payment')),
  0, 'and none touches a financial table');

-- Owner decision 4: no structured data, and no media either — a question has no image.
select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and (p.proname like 'faq%' or p.proname like 'public_faqs%')
      and (p.prosrc ~ 'seo_metadata' or p.prosrc ~* 'cms_media' or p.prosrc ~ 'public\.banners'
           or p.prosrc ~* 'structured_data')),
  0, 'and none reads seo_metadata, a media row, a banner or any structured data');

-- The tables this increment deliberately leaves alone stay reader-less.
select has_table('public', 'banners', 'the banners table is untouched');
-- Narrowed in 0098, which gave `cms_media_references` the job of reporting every CMS row that points at one media
-- entry — and two of those six columns are `banners.media_id` and `banners.media_ar_id` (0098's owner decision 5).
-- The invariant is unchanged and is now **pinned rather than counted**: that one read-only reference reader is the
-- only function permitted to name the table, so nothing composes, serves or publishes a banner.
select is(
  (select coalesce(array_agg(p.proname::text order by p.proname), array[]::text[])
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.prosrc ~ 'public\.banners'),
  array['cms_media_references'],
  'the only function naming public.banners is 0098''s reference reader, so no banner is served');

-- ---------------------------------------------------------------------------------------------------
-- Nothing in 0030 was changed
-- ---------------------------------------------------------------------------------------------------
select has_table('public', 'faqs', 'the faqs table is untouched');
select ok(
  exists (select 1 from pg_constraint where conname = 'faqs_topic_format'),
  '0030''s free-form topic format is untouched, so no closed list was introduced (owner decision 5)');
select ok(
  exists (select 1 from pg_constraint where conname = 'faqs_question_en_length'),
  '0030''s question length is untouched');
select ok(
  exists (select 1 from pg_constraint where conname = 'faqs_answer_en_present'),
  '0030''s answer rule is untouched');
select ok(
  (select count(*) from pg_index i join pg_class c on c.oid = i.indrelid
    where c.relname = 'faqs') >= 2,
  '0030''s published index is still installed');
select col_default_is('public', 'faqs', 'is_published', 'false',
  'a new entry is unpublished by the schema''s own default (owner decision 6)');
select col_default_is('public', 'faqs', 'topic', 'general',
  'and 0030''s own default topic is untouched');
select has_function('public', 'cms_content_is_public', array['text', 'timestamptz'],
  '0030''s publication rule is untouched');

-- ---------------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------------
select ok(has_function_privilege('app_system', p.oid, 'execute'),
    format('app_system may execute %s', p.proname))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and (p.proname like 'faq%' or p.proname like 'public_faqs%')
 order by p.proname;

select ok(not has_function_privilege(r.rolname, p.oid, 'execute'),
    format('%s may not execute %s', r.rolname, p.proname))
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  cross join (values ('public'), ('anon'), ('authenticated'), ('app_worker')) as r(rolname)
 where n.nspname = 'app_private' and (p.proname like 'faq%' or p.proname like 'public_faqs%')
 order by r.rolname, p.proname;

-- ---------------------------------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------------------------------
-- An editor who holds both keys through the admin role (0033 grants both to admin and super_admin, and both
-- roles require MFA), and a signed-in person who holds neither.
insert into auth.users (id, email) values
  ('ae100000-0000-4000-8000-000000000001', 'faq-editor@example.test'),
  ('ae100000-0000-4000-8000-000000000002', 'faq-nobody@example.test');
insert into public.user_roles (user_id, role_key) values
  ('ae100000-0000-4000-8000-000000000001', 'admin');

create function pg_temp.editor() returns uuid language sql immutable as
  $f$ select 'ae100000-0000-4000-8000-000000000001'::uuid $f$;
create function pg_temp.nobody() returns uuid language sql immutable as
  $f$ select 'ae100000-0000-4000-8000-000000000002'::uuid $f$;

-- The two addresses the owner named, each carrying its topic as its `page_key` (owner decision 1); one page that
-- carries a key and is still a draft, so it maps nothing; and one published page with no key at all.
insert into public.pages (id, slug, page_key, status, published_at, template) values
  ('ae200000-0000-4000-8000-000000000001', 'faq', 'faq', 'published', '2026-05-01T10:00:00Z', 'help'),
  ('ae200000-0000-4000-8000-000000000002', 'help', 'help', 'published', '2026-05-01T10:00:00Z', 'help'),
  ('ae200000-0000-4000-8000-000000000003', 'safety', 'safety', 'draft', null, 'standard'),
  ('ae200000-0000-4000-8000-000000000004', 'about', null, 'published', '2026-05-01T10:00:00Z', 'standard');
insert into public.page_translations (page_id, locale_code, title, body) values
  ('ae200000-0000-4000-8000-000000000001', 'en', 'Questions and answers', 'The body.'),
  ('ae200000-0000-4000-8000-000000000002', 'en', 'Help', 'The body.'),
  ('ae200000-0000-4000-8000-000000000003', 'en', 'Safety', 'The body.'),
  ('ae200000-0000-4000-8000-000000000004', 'en', 'About us', 'The body.');

-- ---------------------------------------------------------------------------------------------------
-- The permission predicates
-- ---------------------------------------------------------------------------------------------------
select ok(app_private.faq_can_read(pg_temp.editor(), true), 'the editor may read at aal2');
select ok(app_private.faq_can_manage(pg_temp.editor(), true), 'the editor may manage at aal2');
-- The admin role requires MFA, so 0003's own rule withholds both keys at aal1.
select ok(not app_private.faq_can_read(pg_temp.editor(), false), 'the editor reads nothing at aal1');
select ok(not app_private.faq_can_manage(pg_temp.editor(), false), 'the editor manages nothing at aal1');
select ok(not app_private.faq_can_read(pg_temp.nobody(), true), 'a person without the role may not read');
select ok(not app_private.faq_can_manage(pg_temp.nobody(), true), 'a person without the role may not manage');
select ok(not app_private.faq_can_read(null, true), 'a null account holds nothing');
select ok(not app_private.faq_can_manage(null, true), 'a null account manages nothing');

insert into public.user_roles (user_id, role_key, revoked_at) values (pg_temp.nobody(), 'super_admin', now());
select ok(not app_private.faq_can_read(pg_temp.nobody(), true), 'a revoked role grants no read');
delete from public.user_roles where user_id = pg_temp.nobody();

-- ---------------------------------------------------------------------------------------------------
-- The topic mapping — owner decisions 1 and 5
-- ---------------------------------------------------------------------------------------------------
select ok((select is_mapped from app_private.faq_topic_mapping('faq')),
  'the faq topic is mapped, because a published page carries it as its page_key');
select is((select page_slug from app_private.faq_topic_mapping('faq')), 'faq',
  'and the mapping names that page''s slug');
select ok((select is_mapped from app_private.faq_topic_mapping('help')), 'and so is the help topic');
select ok(not (select is_mapped from app_private.faq_topic_mapping('safety')),
  'a topic whose only page is a draft is not mapped: a draft page shows nothing');
select ok(not (select is_mapped from app_private.faq_topic_mapping('general')),
  'nor is a topic no page carries');
select ok(not (select is_mapped from app_private.faq_topic_mapping(null)), 'nor a null topic');

-- The property the two staff readers depend on, asserted directly: one row, always.
select is((select count(*)::int from app_private.faq_topic_mapping('faq')), 1, 'a mapped topic answers one row');
select is((select count(*)::int from app_private.faq_topic_mapping('general')), 1,
  'and so does an unmapped one — a lateral join must never drop the entry it was asked about');
select is((select count(*)::int from app_private.faq_topic_mapping(null)), 1, 'and so does a null topic');

-- The slug is the page's own, and the application's route map is somebody else's business: a published page at an
-- address this app does not serve still maps, and the slug is what lets a caller notice.
insert into public.pages (id, slug, page_key, status, published_at) values
  ('ae200000-0000-4000-8000-000000000005', 'not-a-served-address', 'invented', 'published', '2026-05-01T10:00:00Z');
insert into public.page_translations (page_id, locale_code, title, body) values
  ('ae200000-0000-4000-8000-000000000005', 'en', 'Invented', 'The body.');
select is((select page_slug from app_private.faq_topic_mapping('invented')), 'not-a-served-address',
  'the mapping reports the slug as stored, leaving the route map to the layer that owns one');

-- ---------------------------------------------------------------------------------------------------
-- Creating entries
-- ---------------------------------------------------------------------------------------------------
select throws_ok(
  format($q$ select app_private.faq_save_for_staff(%L, true, null, 'faq', 'Q?', null, 'A.') $q$,
    pg_temp.nobody()),
  '42501', null, 'a caller without the manage key cannot save an entry');
select throws_ok(
  format($q$ select app_private.faq_save_for_staff(%L, false, null, 'faq', 'Q?', null, 'A.') $q$,
    pg_temp.editor()),
  '42501', null, 'nor the editor at aal1');

create temporary table faq_ids as
select
  app_private.faq_save_for_staff(
    pg_temp.editor(), true, null, 'faq', 'How do I buy?', 'كيف أشتري؟',
    'Open a listing and press buy.', 'افتح قائمة واضغط شراء.', 10) as buy_id,
  app_private.faq_save_for_staff(
    pg_temp.editor(), true, null, 'faq', 'How do I sell?', null,
    E'Create a seller profile.\n\nThen list an item.', null, 20) as sell_id,
  app_private.faq_save_for_staff(
    pg_temp.editor(), true, null, 'faq', 'Is it safe?', null, 'We check every seller.', null, 30) as safe_id,
  app_private.faq_save_for_staff(
    pg_temp.editor(), true, null, 'help', 'Where are my orders?', null, 'In your dashboard.', null, 10)
    as orders_id,
  -- A topic no page carries: legal, kept, and shown to nobody (owner decision 5).
  app_private.faq_save_for_staff(
    pg_temp.editor(), true, null, 'shipping', 'When does it arrive?', null, 'It depends.', null, 10)
    as shipping_id,
  -- No topic at all, so 0030's own default stands.
  app_private.faq_save_for_staff(
    pg_temp.editor(), true, null, null, 'Anything else?', null, 'Ask support.', null, 10) as general_id;

create function pg_temp.buy() returns uuid language sql stable as $f$ select buy_id from faq_ids $f$;
create function pg_temp.sell() returns uuid language sql stable as $f$ select sell_id from faq_ids $f$;
create function pg_temp.safe() returns uuid language sql stable as $f$ select safe_id from faq_ids $f$;
create function pg_temp.orders() returns uuid language sql stable as $f$ select orders_id from faq_ids $f$;
create function pg_temp.shipping() returns uuid language sql stable as $f$ select shipping_id from faq_ids $f$;
create function pg_temp.general() returns uuid language sql stable as $f$ select general_id from faq_ids $f$;

select isnt(pg_temp.buy(), null, 'the entries were created');
select is((select count(*)::int from public.faqs), 6, 'six of them');

-- Owner decision 6, from the schema's own default rather than from this writer's opinion.
select is((select count(*)::int from public.faqs where is_published), 0,
  'and not one of them is published: a new entry is created unpublished');
select is((select f.topic from public.faqs f where f.id = pg_temp.general()), 'general',
  'an entry saved with no topic takes 0030''s own default');

select throws_ok(
  format($q$ select app_private.faq_save_for_staff(%L, true, null, 'Not A Topic', 'Q?', null, 'A.') $q$,
    pg_temp.editor()),
  '23514', null, 'a topic that is not the schema''s shape is refused by its CHECK');
select throws_ok(
  format($q$ select app_private.faq_save_for_staff(%L, true, null, 'faq', '', null, 'A.') $q$,
    pg_temp.editor()),
  '23514', null, 'and so is an empty question');
select throws_ok(
  format($q$ select app_private.faq_save_for_staff(%L, true, null, 'faq', 'Q?', null, '   ') $q$,
    pg_temp.editor()),
  '23514', null, 'and so is an answer with nothing in it');
select throws_ok(
  format($q$ select app_private.faq_save_for_staff(%L, true, null, 'faq', %L, null, 'A.') $q$,
    pg_temp.editor(), repeat('x', 301)),
  '23514', null, 'and so is a question longer than the column');

select is(
  app_private.faq_save_for_staff(pg_temp.editor(), true, 'ae300000-0000-4000-8000-0000000000ff', 'faq', 'Q?'),
  null, 'saving an entry that does not exist returns null rather than creating one');

-- ---------------------------------------------------------------------------------------------------
-- The public reader — owner decisions 2 and 3
-- ---------------------------------------------------------------------------------------------------
select is((select count(*)::int from app_private.public_faqs('faq', 'en')), 0,
  'nothing is published, so the faq topic serves nothing at all (owner decision 2)');

select ok(app_private.faq_state_for_staff(pg_temp.editor(), true, pg_temp.buy(), true),
  'an entry can be published');
select ok(app_private.faq_state_for_staff(pg_temp.editor(), true, pg_temp.sell(), true), 'and another');
select ok(app_private.faq_state_for_staff(pg_temp.editor(), true, pg_temp.orders(), true), 'and one under help');
select ok(app_private.faq_state_for_staff(pg_temp.editor(), true, pg_temp.shipping(), true),
  'and one under a topic nobody mapped');

select is((select count(*)::int from app_private.public_faqs('faq', 'en')), 2,
  'the faq topic now serves its two published entries and not the unpublished third');
select is(
  (select array_agg(question order by sort_order) from app_private.public_faqs('faq', 'en')),
  array['How do I buy?', 'How do I sell?'], 'in the operator''s own order');
select is(
  (select array_agg(question order by sort_order) from app_private.public_faqs('faq', 'ar')),
  array['كيف أشتري؟', 'How do I sell?'],
  'the Arabic wording where one was written and the English where none was (D7)');
select is(
  (select answer from app_private.public_faqs('faq', 'ar') where question = 'كيف أشتري؟'),
  'افتح قائمة واضغط شراء.', 'and the Arabic answer with it');

-- Owner decision 3: the answer comes back exactly as stored, blank lines included, and nothing here interprets it.
select is(
  (select answer from app_private.public_faqs('faq', 'en') where question = 'How do I sell?'),
  E'Create a seller profile.\n\nThen list an item.',
  'an answer is served exactly as stored, blank lines and all, so the renderer can split paragraphs');

select is((select count(*)::int from app_private.public_faqs('help', 'en')), 1,
  'the help topic serves its own entry and nothing from another topic');
select is((select count(*)::int from app_private.public_faqs('general', 'en')), 0,
  'a topic with nothing published serves nothing');
select is((select count(*)::int from app_private.public_faqs('nonsense', 'en')), 0,
  'and so does a topic nobody has used');
select is((select count(*)::int from app_private.public_faqs(null, 'en')), 0,
  'a null topic serves nothing rather than everything');
select is((select count(*)::int from app_private.public_faqs('   ', 'en')), 0, 'and neither does a blank one');

-- The reader is about publication and the topic, and knows nothing about mapping: a page that shows a topic is
-- the web layer's business, and an unmapped topic still answers so a future address could show it.
select is((select count(*)::int from app_private.public_faqs('shipping', 'en')), 1,
  'an unmapped topic still answers: whether an address shows it is the caller''s question, not this reader''s');

select ok(app_private.faq_state_for_staff(pg_temp.editor(), true, pg_temp.buy(), false),
  'an entry can be unpublished again');
select is((select count(*)::int from app_private.public_faqs('faq', 'en')), 1,
  'and leaves the public page at once');
select ok(app_private.faq_state_for_staff(pg_temp.editor(), true, pg_temp.buy(), true), 'and published again');

select throws_ok(
  format($q$ select app_private.faq_state_for_staff(%L, true, %L, true) $q$, pg_temp.nobody(), pg_temp.safe()),
  '42501', null, 'a caller without the manage key cannot publish anything');
select ok(
  not app_private.faq_state_for_staff(pg_temp.editor(), true, 'ae300000-0000-4000-8000-0000000000fe', true),
  'publishing an entry that does not exist reports that nothing changed');

-- ---------------------------------------------------------------------------------------------------
-- The staff readers
-- ---------------------------------------------------------------------------------------------------
select is((select count(*)::int from app_private.faqs_for_staff(pg_temp.editor(), true)), 6,
  'the staff list shows every entry, published or not');
select is(
  (select array_agg(topic order by ordinality)
     from (select topic, row_number() over () as ordinality
             from app_private.faqs_for_staff(pg_temp.editor(), true)) ordered),
  array['faq', 'faq', 'faq', 'general', 'help', 'shipping'],
  'in help-centre order: by topic, then by the operator''s own position');
select is((select count(*)::int from app_private.faqs_for_staff(pg_temp.editor(), true, 'faq')), 3,
  'and a topic filter narrows it');
select is((select count(*)::int from app_private.faqs_for_staff(pg_temp.nobody(), true)), 0,
  'a caller without the read key sees no entry at all');
select is((select count(*)::int from app_private.faqs_for_staff(pg_temp.editor(), false)), 0,
  'and neither does the editor at aal1');

select ok(
  (select is_mapped from app_private.faqs_for_staff(pg_temp.editor(), true) where faq_id = pg_temp.buy()),
  'an entry under a mapped topic says so');
select ok(
  not (select is_mapped from app_private.faqs_for_staff(pg_temp.editor(), true)
        where faq_id = pg_temp.shipping()),
  'and one under a topic no public address shows says that (owner decision 5)');
select is(
  (select page_slug from app_private.faqs_for_staff(pg_temp.editor(), true) where faq_id = pg_temp.buy()),
  'faq', 'with the slug of the page that shows it');

-- The keyset: a page of two, then the rest, with nothing repeated and nothing skipped.
create temporary table first_page as
select faq_id, topic, sort_order from app_private.faqs_for_staff(pg_temp.editor(), true, null, null, null, null, 2);

select is((select count(*)::int from first_page), 2, 'a limit of two returns two');
select is(
  (select count(*)::int
     from app_private.faqs_for_staff(
       pg_temp.editor(), true, null,
       (select topic from first_page order by topic desc, sort_order desc limit 1),
       (select sort_order from first_page order by topic desc, sort_order desc limit 1),
       (select faq_id from first_page order by topic desc, sort_order desc limit 1),
       10)),
  4, 'and the next page holds the remaining four');
select ok(
  not exists (
    select 1
      from app_private.faqs_for_staff(
        pg_temp.editor(), true, null,
        (select topic from first_page order by topic desc, sort_order desc limit 1),
        (select sort_order from first_page order by topic desc, sort_order desc limit 1),
        (select faq_id from first_page order by topic desc, sort_order desc limit 1),
        10) later
      join first_page earlier on earlier.faq_id = later.faq_id
  ), 'with nothing repeated across the two pages');

select is((select count(*)::int from app_private.faqs_for_staff(pg_temp.editor(), true, null, null, null, null, 0)),
  1, 'a limit of zero still returns one row rather than none');

-- The topic list: owner decision 5 at a glance.
select is((select count(*)::int from app_private.faq_topics_for_staff(pg_temp.editor(), true)), 4,
  'the topic list has one row per topic in use');
select is(
  (select array_agg(topic order by ordinality)
     from (select topic, row_number() over () as ordinality
             from app_private.faq_topics_for_staff(pg_temp.editor(), true)) ordered),
  array['faq', 'help', 'general', 'shipping'], 'mapped topics first, then the rest, each set by name');
select is(
  (select entry_count from app_private.faq_topics_for_staff(pg_temp.editor(), true) where topic = 'faq'),
  3, 'with how many entries it holds');
select is(
  (select published_count from app_private.faq_topics_for_staff(pg_temp.editor(), true) where topic = 'faq'),
  2, 'and how many of those are published');
select ok(
  not (select is_mapped from app_private.faq_topics_for_staff(pg_temp.editor(), true) where topic = 'shipping'),
  'and whether any public page shows it');
select is((select count(*)::int from app_private.faq_topics_for_staff(pg_temp.nobody(), true)), 0,
  'a caller without the read key sees no topic');

select is((select topic from app_private.faq_for_staff(pg_temp.editor(), true, pg_temp.buy())), 'faq',
  'the staff detail returns the entry');
select ok((select can_manage from app_private.faq_for_staff(pg_temp.editor(), true, pg_temp.buy())),
  'and reports that this caller may change it');
select is(
  (select count(*)::int from app_private.faq_for_staff(pg_temp.editor(), true,
    'ae300000-0000-4000-8000-0000000000fd')),
  0, 'an entry that does not exist is no row');
select is((select count(*)::int from app_private.faq_for_staff(pg_temp.nobody(), true, pg_temp.buy())), 0,
  'and so is one the caller may not read, so the two look alike');

-- ---------------------------------------------------------------------------------------------------
-- Editing an entry
-- ---------------------------------------------------------------------------------------------------
select is(
  app_private.faq_save_for_staff(pg_temp.editor(), true, pg_temp.safe(), null, 'Is this site safe?'),
  pg_temp.safe(), 'an entry''s question can be edited on its own');
select is((select f.question_en from public.faqs f where f.id = pg_temp.safe()), 'Is this site safe?',
  'and the new wording is stored');
select is((select f.answer_en from public.faqs f where f.id = pg_temp.safe()), 'We check every seller.',
  'while the answer nobody sent is left alone');
select is((select f.sort_order from public.faqs f where f.id = pg_temp.safe()), 30,
  'and so is its position — the 0092 lesson: an omitted argument must not reorder anything');
select is((select f.topic from public.faqs f where f.id = pg_temp.safe()), 'faq',
  'and so is its topic');
select ok(not (select f.is_published from public.faqs f where f.id = pg_temp.safe()),
  'and a save cannot publish it');

select is(
  app_private.faq_save_for_staff(pg_temp.editor(), true, pg_temp.safe(), null, null, 'هل الموقع آمن؟'),
  pg_temp.safe(), 'an Arabic question can be added by itself');
select is((select f.question_ar from public.faqs f where f.id = pg_temp.safe()), 'هل الموقع آمن؟',
  'and is stored');
select is(
  app_private.faq_save_for_staff(pg_temp.editor(), true, pg_temp.safe(), null, null, '   '),
  pg_temp.safe(), 'and sending nothing but spaces clears it');
select is((select f.question_ar from public.faqs f where f.id = pg_temp.safe()), null,
  'which is how an Arabic wording is removed');

-- Moving an entry to another topic is an edit, and the mapping follows by itself.
select is(
  app_private.faq_save_for_staff(pg_temp.editor(), true, pg_temp.shipping(), 'help'),
  pg_temp.shipping(), 'an entry can be moved to another topic');
select ok(
  (select is_mapped from app_private.faqs_for_staff(pg_temp.editor(), true) where faq_id = pg_temp.shipping()),
  'and becomes mapped because the new topic is, with no second edit');
select is((select count(*)::int from app_private.public_faqs('help', 'en')), 2,
  'and the help page shows it at once');
select is(
  app_private.faq_save_for_staff(pg_temp.editor(), true, pg_temp.shipping(), 'shipping'),
  pg_temp.shipping(), 'and it can be moved back');

-- The mapping is the page's, so unpublishing the page unmaps every entry under its key.
update public.pages set status = 'draft', published_at = null
 where id = 'ae200000-0000-4000-8000-000000000001';
select ok(
  not (select is_mapped from app_private.faqs_for_staff(pg_temp.editor(), true) where faq_id = pg_temp.buy()),
  'unpublishing the page that shows a topic unmaps its entries, with no edit to any of them');
select is((select count(*)::int from app_private.public_faqs('faq', 'en')), 2,
  'while the entries themselves are untouched: what an address shows is the page''s question, not theirs');
update public.pages set status = 'published', published_at = '2026-05-01T10:00:00Z'
 where id = 'ae200000-0000-4000-8000-000000000001';

-- ---------------------------------------------------------------------------------------------------
-- Reordering
-- ---------------------------------------------------------------------------------------------------
select throws_ok(
  format($q$ select app_private.faqs_reorder_for_staff(%L, true, 'faq', array[%L]::uuid[]) $q$,
    pg_temp.nobody(), pg_temp.buy()),
  '42501', null, 'a caller without the manage key cannot reorder');

select is(
  app_private.faqs_reorder_for_staff(
    pg_temp.editor(), true, 'faq', array[pg_temp.safe(), pg_temp.sell(), pg_temp.buy()]),
  3, 'a reorder moves exactly the entries it named');
select is(
  (select array_agg(f.sort_order order by f.sort_order) from public.faqs f where f.topic = 'faq'),
  array[0, 10, 20], 'with positions spaced by ten so a later insertion needs no rewrite');
select is(
  (select array_agg(question order by sort_order) from app_private.public_faqs('faq', 'en')),
  array['How do I sell?', 'How do I buy?'],
  'and the public order is the one that was sent, minus what is unpublished');

-- Scoped to its own topic: an id from elsewhere moves nothing.
select is(
  app_private.faqs_reorder_for_staff(pg_temp.editor(), true, 'faq', array[pg_temp.orders()]),
  0, 'an id belonging to another topic moves nothing');
select is((select f.sort_order from public.faqs f where f.id = pg_temp.orders()), 10,
  'and that entry keeps the position it had');
select is(
  app_private.faqs_reorder_for_staff(pg_temp.editor(), true, 'faq', null),
  0, 'a null order moves nothing rather than flattening the topic');

-- ---------------------------------------------------------------------------------------------------
-- Deleting
-- ---------------------------------------------------------------------------------------------------
select throws_ok(
  format($q$ select app_private.faq_delete_for_staff(%L, true, %L) $q$, pg_temp.nobody(), pg_temp.buy()),
  '42501', null, 'a caller without the manage key cannot delete an entry');
select ok(app_private.faq_delete_for_staff(pg_temp.editor(), true, pg_temp.buy()), 'an entry can be deleted');
select ok(not app_private.faq_delete_for_staff(pg_temp.editor(), true, pg_temp.buy()),
  'and deleting it twice reports that nothing matched');
select is((select count(*)::int from app_private.public_faqs('faq', 'en')), 1,
  'and it is gone from the public page');
select is((select count(*)::int from public.faqs), 5, 'and from the table');

-- ---------------------------------------------------------------------------------------------------
-- Nothing else moved
-- ---------------------------------------------------------------------------------------------------
select is((select count(*)::int from public.audit_attribution_problems()), 0,
  'and the attribution contract still holds after every write above');
select is(app_private.assert_security_contract(), 0, 'the security contract still holds');

select * from finish();
rollback;
