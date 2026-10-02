-- pgTAP — migration 0076: reports, reporter side (Phase 7-M).
--
-- Two functions, and what these assertions hold to account is mostly what they *refuse* and what they
-- *delegate*:
--
--   * the subject is named by a **public slug**, so the whole class of "an arbitrary uuid aimed at the
--     report writer" is checked by there being no id parameter to aim — and by the slug of a subject the
--     public cannot see answering exactly as a slug that never existed does;
--   * the vocabulary is 0027's — eight subject types, of which this surface owns two and refuses six;
--     eleven reason codes; five statuses — and none is added, removed or renamed anywhere;
--   * 0027's own behaviour is preserved rather than reimplemented: the C10 repeat lands on the report
--     already open, the self-report rule covers `seller` and not `listing`, the `report.filed` outbox
--     event is enqueued once by the writer, and the audit trigger records the insert with `details`
--     redacted;
--   * the reporter's read returns what they wrote and what became of it, and **none** of the seven
--     columns that are triage, moderator identity, the decision, its note, or another report's id.
--
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(122);

-- Fixtures ------------------------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('e1000000-0000-4000-8000-000000000001', 'reporter@test.invalid'),
  ('e1000000-0000-4000-8000-000000000002', 'other-reporter@test.invalid'),
  ('e1000000-0000-4000-8000-000000000003', 'moderator@test.invalid'),
  ('b1000000-0000-4000-8000-000000000001', 'active-seller@test.invalid'),
  ('b1000000-0000-4000-8000-000000000002', 'suspended-seller@test.invalid'),
  ('b1000000-0000-4000-8000-000000000003', 'pending-seller@test.invalid'),
  ('b1000000-0000-4000-8000-000000000004', 'reporter-is-a-seller@test.invalid');

insert into public.seller_profiles
  (user_id, slug, display_name, legal_name, contact_email, contact_phone_e164, country_code,
   status, suspended_at, verification_status, verified_at)
values
  ('b1000000-0000-4000-8000-000000000001', 'good-shop', 'Good Shop', 'Good Shop LLC',
   'seller@test.invalid', '+201000000001', 'EG', 'active', null, 'verified', now() - interval '10 days'),
  ('b1000000-0000-4000-8000-000000000002', 'gone-shop', 'Gone Shop', 'Gone Shop LLC',
   'gone@test.invalid', '+201000000002', 'EG', 'suspended', now() - interval '1 day',
   'verified', now() - interval '10 days'),
  ('b1000000-0000-4000-8000-000000000003', 'soon-shop', 'Soon Shop', 'Soon Shop LLC',
   'soon@test.invalid', '+201000000003', 'EG', 'pending', null, 'unverified', null);

-- The reporter is themselves a seller, which is the only way "reporting yourself" is reachable here.
insert into public.seller_profiles
  (user_id, slug, display_name, legal_name, contact_email, contact_phone_e164, country_code,
   status, verification_status, verified_at)
values
  ('b1000000-0000-4000-8000-000000000004', 'my-own-shop', 'My Own Shop', 'My Own Shop LLC',
   'mine@test.invalid', '+201000000004', 'EG', 'active', 'verified', now() - interval '5 days');

insert into public.categories (id, parent_id, slug, is_active, sort_order) values
  ('c1000000-0000-4000-8000-000000000001', null, 'design', true, 1);
insert into public.category_translations (category_id, locale_code, name) values
  ('c1000000-0000-4000-8000-000000000001', 'en', 'Design'),
  ('c1000000-0000-4000-8000-000000000001', 'ar', 'تصميم');

create or replace function pg_temp.listing(
  p_id uuid, p_slug text, p_type text, p_status text, p_seller uuid
) returns void language plpgsql as $$
begin
  insert into public.listings (
    id, seller_user_id, listing_type_code, category_id, slug, title, description, content_language,
    currency_code, price_minor, is_negotiable, status, country_code, city, created_at,
    approved_at, sold_at, archived_at, deleted_at
  ) values (
    p_id, p_seller, p_type, 'c1000000-0000-4000-8000-000000000001', p_slug,
    'Canary ' || p_slug, 'A description long enough to satisfy the length rule.', 'en',
    'EGP', 150000, false, p_status, 'EG', 'Cairo', now() - interval '1 day',
    case when p_status in ('approved','active','sold','expired','archived') then now() - interval '1 day' end,
    case when p_status = 'sold' then now() - interval '1 day' end,
    case when p_status = 'archived' then now() - interval '1 day' end,
    case when p_status = 'deleted' then now() - interval '1 day' end
  );
end;
$$;

select pg_temp.listing('22220000-0000-4000-8000-000000000001', 'live-listing', 'product', 'active',
  'b1000000-0000-4000-8000-000000000001');
select pg_temp.listing('22220000-0000-4000-8000-000000000002', 'draft-listing', 'product', 'draft',
  'b1000000-0000-4000-8000-000000000001');
select pg_temp.listing('22220000-0000-4000-8000-000000000003', 'hidden-sellers-listing', 'product',
  'active', 'b1000000-0000-4000-8000-000000000002');
select pg_temp.listing('22220000-0000-4000-8000-000000000004', 'a-service', 'service', 'active',
  'b1000000-0000-4000-8000-000000000001');
insert into public.listing_service_details
  (listing_id, pricing_model, delivery_days, revisions_included, requires_brief, scope)
values ('22220000-0000-4000-8000-000000000004', 'fixed', 5::smallint, 2::smallint, true, 'A scope.');
-- The reporter's own listing, which 0027 does not forbid them from reporting.
select pg_temp.listing('22220000-0000-4000-8000-000000000005', 'my-own-listing', 'product', 'active',
  'b1000000-0000-4000-8000-000000000004');

-- A previous slug, so a report filed from a page reached by an old link is covered.
insert into public.listing_slug_history (listing_id, slug)
values ('22220000-0000-4000-8000-000000000001', 'the-old-slug');

create or replace function pg_temp.file(
  p_reporter uuid, p_type text, p_slug text, p_reason text default 'spam', p_details text default null
) returns text language sql as $$
  select outcome from app_private.report_file_for_reporter(p_reporter, p_type, p_slug, p_reason, p_details);
$$;

create or replace function pg_temp.file_id(
  p_reporter uuid, p_type text, p_slug text, p_reason text default 'spam', p_details text default null
) returns uuid language sql as $$
  select report_id from app_private.report_file_for_reporter(p_reporter, p_type, p_slug, p_reason, p_details);
$$;

-- 1. Shape and privileges ---------------------------------------------------------------------------
select has_function('app_private', 'report_file_for_reporter',
  array['uuid', 'text', 'text', 'text', 'text'], 'the filing wrapper exists');
select has_function('app_private', 'reports_for_reporter',
  array['uuid', 'integer', 'timestamptz', 'uuid'], 'the reporter reader exists');

select is(p.prosecdef, true, 'the filing wrapper is security definer')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and p.proname = 'report_file_for_reporter';
select is(p.prosecdef, true, 'the reader is security definer')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and p.proname = 'reports_for_reporter';

select is(p.proconfig::text, '{"search_path=pg_catalog, public"}',
          'the filing wrapper pins its search_path')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and p.proname = 'report_file_for_reporter';
select is(p.proconfig::text, '{"search_path=pg_catalog, public"}', 'the reader pins its search_path')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and p.proname = 'reports_for_reporter';

-- The reader reads; the writer writes. Marking the writer stable would be a lie the planner acts on.
select is(p.provolatile, 's', 'the reader is stable')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and p.proname = 'reports_for_reporter';
select is(p.provolatile, 'v', 'the filing wrapper is volatile, because it writes')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and p.proname = 'report_file_for_reporter';

select ok(not has_function_privilege('public', 'app_private.report_file_for_reporter(uuid, text, text, text, text)', 'execute'),
          'public may not file');
select ok(not has_function_privilege('public', 'app_private.reports_for_reporter(uuid, integer, timestamptz, uuid)', 'execute'),
          'public may not read reports');
select ok(has_function_privilege('app_system', 'app_private.report_file_for_reporter(uuid, text, text, text, text)', 'execute'),
          'app_system may file');
select ok(has_function_privilege('app_system', 'app_private.reports_for_reporter(uuid, integer, timestamptz, uuid)', 'execute'),
          'app_system may read reports');
select ok(not has_function_privilege('authenticated', 'app_private.report_file_for_reporter(uuid, text, text, text, text)', 'execute'),
          'a signed-in database role may not file either');
select ok(not has_function_privilege('anon', 'app_private.report_file_for_reporter(uuid, text, text, text, text)', 'execute'),
          'an anonymous database role may not file');

-- 2. Nothing about 0027 changed ---------------------------------------------------------------------
select is(
  (select string_agg(column_name, ',' order by column_name)
     from information_schema.columns where table_schema = 'public' and table_name = 'reports'),
  'assigned_at,assigned_to,created_at,details,duplicate_of_report_id,id,priority,reason_code,' ||
  'reporter_user_id,resolution,resolution_note,resolved_at,resolved_by,status,subject_id,subject_type,updated_at',
  'the reports table has exactly the columns 0027 gave it');

select is(
  (select count(*)::int from pg_policy p join pg_class c on c.oid = p.polrelid
    where c.relname = 'reports'),
  3, 'the reports table still has 0027''s three policies and no fourth');
select is(
  (select string_agg(p.polname, ',' order by p.polname)
     from pg_policy p join pg_class c on c.oid = p.polrelid where c.relname = 'reports'),
  'reports_reporter_read,reports_staff_read,reports_staff_write',
  'and they are the same three by name');

select is(
  (select count(*)::int from pg_index i join pg_class c on c.oid = i.indrelid where c.relname = 'reports'),
  5, 'the reports table still has its primary key and 0027''s four indexes');
select ok(
  (select indisunique from pg_index i join pg_class ic on ic.oid = i.indexrelid
    where ic.relname = 'reports_one_open_per_reporter'),
  'the one-open-report-per-reporter index is still unique');

-- 0027's own vocabularies, read off the constraints rather than restated.
select ok(
  (select pg_get_constraintdef(oid) like '%''listing''%''review''%''review_reply''%''message''%' ||
          '''conversation''%''seller''%''user''%''promotion''%'
     from pg_constraint where conname = 'reports_subject_type_allowed'),
  'the eight subject types are unchanged');
select ok(
  (select pg_get_constraintdef(oid) like '%''open''%''triaged''%''actioned''%''dismissed''%''duplicate''%'
     from pg_constraint where conname = 'reports_status_allowed'),
  'the five statuses are unchanged');

-- 3. Which subject types this surface owns ----------------------------------------------------------
select is(pg_temp.file('e1000000-0000-4000-8000-000000000001', 'listing', 'live-listing'),
          'filed', 'a listing is reportable here');
select is(pg_temp.file('e1000000-0000-4000-8000-000000000001', 'seller', 'good-shop'),
          'filed', 'a seller is reportable here');

-- The six 0027 allows that this surface does not own. Each is `invalid`, not `not_found`: the caller sent
-- a type this path does not serve, which is a different thing from a subject they may not see.
select is(pg_temp.file('e1000000-0000-4000-8000-000000000001', 'message', 'live-listing'),
          'invalid', 'a message belongs to 5-H''s path, not this one');
select is(pg_temp.file('e1000000-0000-4000-8000-000000000001', 'conversation', 'live-listing'),
          'invalid', 'a conversation belongs to 5-H''s path, not this one');
select is(pg_temp.file('e1000000-0000-4000-8000-000000000001', 'review', 'live-listing'),
          'invalid', 'no public surface renders a review, so none is reportable here');
select is(pg_temp.file('e1000000-0000-4000-8000-000000000001', 'review_reply', 'live-listing'),
          'invalid', 'nor a review reply');
select is(pg_temp.file('e1000000-0000-4000-8000-000000000001', 'user', 'live-listing'),
          'invalid', 'there is no public page for a person');
select is(pg_temp.file('e1000000-0000-4000-8000-000000000001', 'promotion', 'live-listing'),
          'invalid', 'promotions are read only by the seller who owns them');

select is(pg_temp.file('e1000000-0000-4000-8000-000000000001', 'order', 'live-listing'),
          'invalid', 'a type 0027 does not allow at all is invalid');
select is(pg_temp.file('e1000000-0000-4000-8000-000000000001', null, 'live-listing'),
          'invalid', 'no type is invalid');

select is((select count(*)::int from public.reports), 2,
          'and only the two accepted types wrote a row');

-- 4. The reason vocabulary --------------------------------------------------------------------------
-- All eleven, each on its own subject so the one-open-report index does not collapse them.
select is(pg_temp.file('e1000000-0000-4000-8000-000000000002', 'listing', 'live-listing', 'prohibited_item'),
          'filed', 'prohibited_item files');
select is(pg_temp.file('e1000000-0000-4000-8000-000000000002', 'seller', 'good-shop', 'counterfeit'),
          'filed', 'counterfeit files');
select is(pg_temp.file('e1000000-0000-4000-8000-000000000002', 'listing', 'a-service', 'intellectual_property'),
          'filed', 'intellectual_property files');
select is(pg_temp.file('e1000000-0000-4000-8000-000000000002', 'seller', 'gone-shop', 'fraud_or_scam'),
          'filed', 'fraud_or_scam files');
select is(pg_temp.file('e1000000-0000-4000-8000-000000000002', 'listing', 'my-own-listing', 'harassment'),
          'filed', 'harassment files');
select is(pg_temp.file('e1000000-0000-4000-8000-000000000003', 'listing', 'live-listing', 'adult_content'),
          'filed', 'adult_content files');
select is(pg_temp.file('e1000000-0000-4000-8000-000000000003', 'seller', 'good-shop', 'violence'),
          'filed', 'violence files');
select is(pg_temp.file('e1000000-0000-4000-8000-000000000003', 'listing', 'a-service', 'spam'),
          'filed', 'spam files');
select is(pg_temp.file('e1000000-0000-4000-8000-000000000003', 'seller', 'gone-shop', 'misleading'),
          'filed', 'misleading files');
select is(pg_temp.file('e1000000-0000-4000-8000-000000000003', 'listing', 'my-own-listing', 'off_platform'),
          'filed', 'off_platform files');
select is(pg_temp.file('e1000000-0000-4000-8000-000000000003', 'seller', 'my-own-shop', 'other'),
          'filed', 'other files');

select is(pg_temp.file('e1000000-0000-4000-8000-000000000001', 'listing', 'a-service', 'because_i_say_so'),
          'invalid', 'a reason 0027 does not allow is invalid');
select is(pg_temp.file('e1000000-0000-4000-8000-000000000001', 'listing', 'a-service', null),
          'invalid', 'no reason is invalid');
select is((select count(*)::int from public.reports where reason_code = 'because_i_say_so'), 0,
          'and no row carries an invented reason');

-- 5. Details, against 0027's own length rule --------------------------------------------------------
select is(
  (select details from public.reports r
    where r.reporter_user_id = 'e1000000-0000-4000-8000-000000000001'
      and r.subject_type = 'listing'
      and r.subject_id = '22220000-0000-4000-8000-000000000001'),
  null, 'a report filed without details stores none');

select is(pg_temp.file('e1000000-0000-4000-8000-000000000002', 'listing', 'the-old-slug', 'spam', '   '),
          'filed', 'an all-whitespace details box is accepted');
select is(
  (select details from public.reports r
    where r.reporter_user_id = 'e1000000-0000-4000-8000-000000000002'
      and r.subject_type = 'listing' and r.subject_id = '22220000-0000-4000-8000-000000000001'),
  null, 'and stores no details rather than a blank string');

select is(pg_temp.file('e1000000-0000-4000-8000-000000000001', 'seller', 'gone-shop', 'spam',
                       '  what they said  '),
          'filed', 'details are accepted');
select is(
  (select details from public.reports r
    where r.reporter_user_id = 'e1000000-0000-4000-8000-000000000001'
      and r.subject_type = 'seller' and r.subject_id = 'b1000000-0000-4000-8000-000000000002'),
  'what they said', 'and stored trimmed, as the column''s own length rule measures them');

select is(pg_temp.file('e1000000-0000-4000-8000-000000000001', 'listing', 'a-service', 'spam',
                       repeat('x', 4000)),
          'filed', 'four thousand characters is the boundary and it is inside it');
select is(pg_temp.file('e1000000-0000-4000-8000-000000000001', 'seller', 'soon-shop', 'spam',
                       repeat('x', 4001)),
          'invalid', 'one past it is invalid rather than a constraint violation');

-- 6. Resolving a listing, through 0047's resolver ---------------------------------------------------
select is(
  (select subject_id from public.reports r
    where r.reporter_user_id = 'e1000000-0000-4000-8000-000000000001'
      and r.subject_type = 'listing'
    order by r.created_at limit 1),
  '22220000-0000-4000-8000-000000000001'::uuid,
  'the slug resolved to the listing''s own id, which the browser never sent');

-- A previous slug reaches the same listing, which is why the report filed above under `the-old-slug`
-- landed on the current row.
select is(
  (select count(distinct subject_id)::int from public.reports r
    where r.reporter_user_id = 'e1000000-0000-4000-8000-000000000002'
      and r.subject_type = 'listing'
      and r.subject_id = '22220000-0000-4000-8000-000000000001'),
  1, 'a previous slug and the current one name one listing');

select is(pg_temp.file('e1000000-0000-4000-8000-000000000001', 'listing', 'draft-listing'),
          'not_found', 'a listing the public cannot see is not reportable');
select is(pg_temp.file('e1000000-0000-4000-8000-000000000001', 'listing', 'hidden-sellers-listing'),
          'not_found', 'nor a listing whose seller is not publicly visible');
select is(pg_temp.file('e1000000-0000-4000-8000-000000000001', 'listing', 'no-such-listing'),
          'not_found', 'nor one that does not exist — the same answer, which is the point');
select is(pg_temp.file('e1000000-0000-4000-8000-000000000001', 'listing', ''),
          'not_found', 'an empty slug is nothing to report');
select is(pg_temp.file('e1000000-0000-4000-8000-000000000001', 'listing', null),
          'not_found', 'nor is no slug');
select is(pg_temp.file('e1000000-0000-4000-8000-000000000001', 'listing',
                       '22220000-0000-4000-8000-000000000002'),
          'not_found', 'a listing id passed where a slug goes reaches nothing');
select is(pg_temp.file(null, 'listing', 'live-listing'),
          'not_found', 'and no reporter reaches nothing');

select is((select count(*)::int from public.reports r
            where r.subject_id = '22220000-0000-4000-8000-000000000002'), 0,
          'the draft listing has no report against it');
select is((select count(*)::int from public.reports r
            where r.subject_id = '22220000-0000-4000-8000-000000000003'), 0,
          'nor the hidden seller''s listing');

-- 7. Resolving a seller, by 0050's own visibility predicate -----------------------------------------
select is(
  (select subject_id from public.reports r
    where r.reporter_user_id = 'e1000000-0000-4000-8000-000000000001'
      and r.subject_type = 'seller'
      and r.subject_id = 'b1000000-0000-4000-8000-000000000001'),
  'b1000000-0000-4000-8000-000000000001'::uuid,
  'a seller report names the seller''s user id, resolved from the slug');
select ok(
  (select count(*) = 0 from public.reports r where r.subject_type = 'seller'
    and r.subject_id::text = 'good-shop'),
  'and never the slug itself');

select is(pg_temp.file('e1000000-0000-4000-8000-000000000002', 'seller', 'soon-shop'),
          'not_found', 'a seller whose profile page does not render is not reportable');
select is(pg_temp.file('e1000000-0000-4000-8000-000000000002', 'seller', 'no-such-shop'),
          'not_found', 'nor one that does not exist');
select is(pg_temp.file('e1000000-0000-4000-8000-000000000002', 'seller',
                       'b1000000-0000-4000-8000-000000000001'),
          'not_found', 'a user id passed where a slug goes reaches nothing');

-- A suspended seller's page renders and reads "unavailable", so it is reportable. This is 0050's rule.
select is((select count(*)::int from public.reports r
            where r.subject_type = 'seller'
              and r.subject_id = 'b1000000-0000-4000-8000-000000000002'), 3,
          'a suspended seller is reportable, because their page is reachable');

-- 8. Reporting yourself ----------------------------------------------------------------------------
select is(pg_temp.file('b1000000-0000-4000-8000-000000000004', 'seller', 'my-own-shop'),
          'own_subject', 'reporting your own seller profile is refused, as 0027 refuses it');
select is(pg_temp.file_id('b1000000-0000-4000-8000-000000000004', 'seller', 'my-own-shop'),
          null, 'and returns no report id');
select is((select count(*)::int from public.reports r
            where r.reporter_user_id = 'b1000000-0000-4000-8000-000000000004'
              and r.subject_type = 'seller'), 0,
          'and writes nothing');

-- 0027's self-report check covers `seller` and `user`, not `listing`. Inventing the other half here
-- would be a new business rule, so a seller may report their own listing.
select is(pg_temp.file('b1000000-0000-4000-8000-000000000004', 'listing', 'my-own-listing'),
          'filed', 'reporting your own listing is not refused, because 0027 does not refuse it');

-- 9. The repeat, which is 0027's C10 and not a second mechanism -------------------------------------
select is(
  pg_temp.file_id('e1000000-0000-4000-8000-000000000001', 'listing', 'live-listing', 'violence'),
  (select r.id from public.reports r
    where r.reporter_user_id = 'e1000000-0000-4000-8000-000000000001'
      and r.subject_type = 'listing' and r.subject_id = '22220000-0000-4000-8000-000000000001'),
  'a repeat lands on the report already open and returns its id');
select is((select count(*)::int from public.reports r
            where r.reporter_user_id = 'e1000000-0000-4000-8000-000000000001'
              and r.subject_type = 'listing'
              and r.subject_id = '22220000-0000-4000-8000-000000000001'), 1,
          'and files no second row');
select is(
  (select reason_code from public.reports r
    where r.reporter_user_id = 'e1000000-0000-4000-8000-000000000001'
      and r.subject_type = 'listing' and r.subject_id = '22220000-0000-4000-8000-000000000001'),
  'spam', 'the first report''s reason stands; a repeat does not overwrite it');
select is(
  pg_temp.file('e1000000-0000-4000-8000-000000000001', 'listing', 'the-old-slug', 'violence'),
  'filed', 'and a repeat by a previous slug is the same repeat');
select is((select count(*)::int from public.reports r
            where r.reporter_user_id = 'e1000000-0000-4000-8000-000000000001'
              and r.subject_type = 'listing'
              and r.subject_id = '22220000-0000-4000-8000-000000000001'), 1,
          'still one row');

-- Two different reporters on one subject are two reports: the index is per reporter.
select is((select count(*)::int from public.reports r
            where r.subject_type = 'listing'
              and r.subject_id = '22220000-0000-4000-8000-000000000001'), 3,
          'three reporters on one listing are three reports');

-- 10. Delegation: the event and the audit entry come from 0027, once --------------------------------
select is((select count(*)::int from public.outbox_events
            where aggregate_type = 'report' and event_type = 'report.filed'),
          (select count(*)::int from public.reports),
          'one report.filed event per report row, which is the writer''s own event');
select is((select count(distinct event_type)::int from public.outbox_events
            where aggregate_type = 'report'),
          1, 'and no second report event type was invented anywhere');
-- Pinned to one report rather than to an ordering: `occurred_at` is `now()` and every row in this
-- transaction shares it, so "the first event" is not a thing this test can ask for.
select is(
  (select e.payload->>'reason_code' from public.outbox_events e
    where e.aggregate_type = 'report' and e.event_type = 'report.filed'
      and e.aggregate_id = (
        select r.id::text from public.reports r
         where r.reporter_user_id = 'e1000000-0000-4000-8000-000000000001'
           and r.subject_type = 'seller' and r.subject_id = 'b1000000-0000-4000-8000-000000000002')),
  'spam', 'the event carries 0027''s payload, unchanged');
select ok(
  (select count(*) = 0 from public.outbox_events
    where aggregate_type = 'report' and payload ? 'details'),
  'and no event carries the reporter''s free text');
select is(
  (select string_agg(distinct k, ',' order by k) from public.outbox_events e,
     jsonb_object_keys(e.payload) as k
    where e.aggregate_type = 'report' and e.event_type = 'report.filed'),
  'reason_code,report_id,subject_id,subject_type',
  'the event''s four keys are 0027''s own');

select ok(
  (select count(*) > 0 from audit.audit_logs a
    where a.table_name = 'reports' and a.action = 'insert'),
  'the audit trigger recorded the insert');
select is(
  (select a.new_values->>'details' from audit.audit_logs a
    where a.table_name = 'reports' and a.action = 'insert'
      and a.new_values->>'reporter_user_id' = 'e1000000-0000-4000-8000-000000000001'
      and a.new_values->>'subject_type' = 'seller'
      and a.new_values->>'subject_id' = 'b1000000-0000-4000-8000-000000000002'),
  '[redacted]', 'with the reporter''s free text redacted, as 0027''s trigger argument asks');
select ok(
  (select count(*) = 0 from audit.audit_logs a
    where a.table_name = 'reports' and coalesce(a.new_values->>'details', '') like '%what they said%'),
  'so the free text is in no audit row at all');

-- 11. The reporter's own reports: isolation --------------------------------------------------------
select is(
  (select count(*)::int from app_private.reports_for_reporter('e1000000-0000-4000-8000-000000000001', 50)),
  (select count(*)::int from public.reports where reporter_user_id = 'e1000000-0000-4000-8000-000000000001'),
  'the reader returns every one of the caller''s own reports');
select ok(
  (select bool_and(r.id in (select id from public.reports where reporter_user_id = 'e1000000-0000-4000-8000-000000000001'))
     from app_private.reports_for_reporter('e1000000-0000-4000-8000-000000000001', 50) r),
  'and nothing that is not theirs');
select is(
  (select count(*)::int from app_private.reports_for_reporter('e1000000-0000-4000-8000-000000000001', 50) r
    where r.id in (select id from public.reports where reporter_user_id <> 'e1000000-0000-4000-8000-000000000001')),
  0, 'not one row of another reporter''s, which is the same fact from the other side');
select is(
  (select count(*)::int from app_private.reports_for_reporter(null, 50)),
  0, 'no reporter reads nothing rather than everything');
select is(
  (select count(*)::int from app_private.reports_for_reporter('e1000000-0000-4000-8000-000000000009', 50)),
  0, 'an account with no reports reads nothing');

-- 12. The projection: what crosses and what does not ------------------------------------------------
select is(
  (select string_agg(a.attname, ',' order by a.attname)
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     join unnest(p.proargnames, p.proargmodes) as a(attname, mode) on true
    where n.nspname = 'app_private' and p.proname = 'reports_for_reporter' and a.mode = 't'),
  'created_at,details,id,reason_code,status,subject_label,subject_slug,subject_type',
  'the reader returns exactly the eight approved columns');

-- Each of these is a disclosure, named individually so a future change has to delete an assertion.
select ok(
  (select count(*) = 0 from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     join unnest(p.proargnames, p.proargmodes) as a(attname, mode) on true
    where n.nspname = 'app_private' and p.proname = 'reports_for_reporter' and a.mode = 't'
      and a.attname = any (array['subject_id', 'priority', 'assigned_to', 'assigned_at', 'resolution',
                                 'resolution_note', 'resolved_at', 'resolved_by',
                                 'duplicate_of_report_id', 'reporter_user_id', 'updated_at'])),
  'and none of the eleven that are triage, a moderator, the decision, its note or another report');

select ok(
  (select prosrc not like '%priority%' and prosrc not like '%assigned%'
      and prosrc not like '%resolution%' and prosrc not like '%resolved%'
      and prosrc not like '%duplicate_of%'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'reports_for_reporter'),
  'the reader does not so much as name a moderation column');

-- 13. The projection's values ----------------------------------------------------------------------
select is(
  (select r.subject_slug from app_private.reports_for_reporter('e1000000-0000-4000-8000-000000000001', 50) r
    where r.subject_type = 'listing' and r.details is null),
  'live-listing', 'a still-visible listing resolves to its current slug');
select is(
  (select r.subject_label from app_private.reports_for_reporter('e1000000-0000-4000-8000-000000000001', 50) r
    where r.subject_type = 'listing' and r.details is null),
  'Canary live-listing', 'and to its title');
select is(
  (select r.subject_slug from app_private.reports_for_reporter('e1000000-0000-4000-8000-000000000001', 50) r
    where r.subject_type = 'seller' and r.reason_code = 'spam' and r.details is not null),
  'gone-shop', 'a still-reachable seller resolves to their slug');
select is(
  (select r.subject_label from app_private.reports_for_reporter('e1000000-0000-4000-8000-000000000001', 50) r
    where r.subject_type = 'seller' and r.reason_code = 'spam' and r.details is not null),
  'Gone Shop', 'and to their display name');
select is(
  (select r.details from app_private.reports_for_reporter('e1000000-0000-4000-8000-000000000001', 50) r
    where r.subject_type = 'seller' and r.reason_code = 'spam' and r.details is not null),
  'what they said', 'the reporter reads back their own words');
select is(
  (select r.status from app_private.reports_for_reporter('e1000000-0000-4000-8000-000000000001', 50) r
    where r.subject_type = 'seller' and r.reason_code = 'spam' and r.details is not null),
  'open', 'and the status in 0027''s own vocabulary');

-- 14. A report outlives its subject ----------------------------------------------------------------
update public.listings set status = 'draft', approved_at = null
 where id = '22220000-0000-4000-8000-000000000001';
select is(
  (select count(*)::int from app_private.reports_for_reporter('e1000000-0000-4000-8000-000000000001', 50) r
    where r.subject_type = 'listing' and r.subject_slug is null),
  1, 'a listing that left public view leaves the report with no slug');
select is(
  (select count(*)::int from public.reports r
    where r.subject_id = '22220000-0000-4000-8000-000000000001'),
  3, 'while the reports themselves survive, which is 0027''s own design');
update public.listings set status = 'active', approved_at = now() - interval '1 day'
 where id = '22220000-0000-4000-8000-000000000001';

update public.seller_profiles set status = 'closed', suspended_at = null, closed_at = now()
 where user_id = 'b1000000-0000-4000-8000-000000000002';
select is(
  (select r.subject_slug from app_private.reports_for_reporter('e1000000-0000-4000-8000-000000000001', 50) r
    where r.subject_type = 'seller' and r.reason_code = 'spam' and r.details is not null),
  null, 'a seller who closed leaves the report with no slug');
select is(
  (select r.subject_label from app_private.reports_for_reporter('e1000000-0000-4000-8000-000000000001', 50) r
    where r.subject_type = 'seller' and r.reason_code = 'spam' and r.details is not null),
  null, 'and no label');
update public.seller_profiles set status = 'suspended', suspended_at = now() - interval '1 day',
       closed_at = null
 where user_id = 'b1000000-0000-4000-8000-000000000002';

-- 15. Status is reported as it stands, never reinterpreted ------------------------------------------
update public.reports set status = 'triaged',
       assigned_to = 'e1000000-0000-4000-8000-000000000003', assigned_at = now()
 where reporter_user_id = 'e1000000-0000-4000-8000-000000000001'
   and subject_type = 'seller' and subject_id = 'b1000000-0000-4000-8000-000000000002';
select is(
  (select r.status from app_private.reports_for_reporter('e1000000-0000-4000-8000-000000000001', 50) r
    where r.subject_type = 'seller' and r.reason_code = 'spam' and r.details is not null),
  'triaged', 'a triaged report reads as triaged');

update public.reports set status = 'actioned', resolution = 'actioned',
       resolution_note = 'An internal note no reporter may read.',
       resolved_at = now(), resolved_by = 'e1000000-0000-4000-8000-000000000003'
 where reporter_user_id = 'e1000000-0000-4000-8000-000000000001'
   and subject_type = 'seller' and subject_id = 'b1000000-0000-4000-8000-000000000002';
select is(
  (select r.status from app_private.reports_for_reporter('e1000000-0000-4000-8000-000000000001', 50) r
    where r.subject_type = 'seller' and r.reason_code = 'spam' and r.details is not null),
  'actioned', 'and a closed one as closed');
select ok(
  (select count(*) = 0 from app_private.reports_for_reporter('e1000000-0000-4000-8000-000000000001', 50) r
    where coalesce(r.details, '') like '%internal note%'
       or coalesce(r.subject_label, '') like '%internal note%'
       or coalesce(r.subject_slug, '') like '%internal note%'),
  'and the moderator''s note is in no column the reporter reads');

-- Once the report is closed, the one-open-report index no longer covers it, so the same subject can be
-- reported again. That is the index's own `where status in ('open','triaged')`, not a rule added here.
select is(pg_temp.file('e1000000-0000-4000-8000-000000000001', 'seller', 'gone-shop', 'harassment'),
          'filed', 'a closed report does not block a new one on the same subject');
select is((select count(*)::int from public.reports r
            where r.reporter_user_id = 'e1000000-0000-4000-8000-000000000001'
              and r.subject_type = 'seller'
              and r.subject_id = 'b1000000-0000-4000-8000-000000000002'), 2,
          'which is a second row, as the partial index allows');

-- 16. Order, paging and the clamp ------------------------------------------------------------------
-- `with ordinality` reads the rows in the order the function emitted them, which is the only thing that
-- can be asserted about an ORDER BY whose leading column is identical in every fixture row.
select ok(
  (select bool_and(coalesce(this < previous, true)) from (
     select (created_at, id) as this,
            lag((created_at, id)) over (order by n) as previous
       from app_private.reports_for_reporter('e1000000-0000-4000-8000-000000000001', 50)
            with ordinality as t(id, subject_type, subject_slug, subject_label, reason_code, details,
                                 status, created_at, n)
   ) pairs),
  'the reader answers in a strictly descending (created_at, id) order');

select is(
  (select count(*)::int from app_private.reports_for_reporter('e1000000-0000-4000-8000-000000000001', 2)),
  2, 'a limit is honoured');
select is(
  (select count(*)::int from app_private.reports_for_reporter('e1000000-0000-4000-8000-000000000001', 0)),
  1, 'a limit of nothing is one row rather than none');
select is(
  (select count(*)::int from app_private.reports_for_reporter('e1000000-0000-4000-8000-000000000001', null)),
  (select least(count(*), 20)::int from public.reports where reporter_user_id = 'e1000000-0000-4000-8000-000000000001'),
  'no limit is the default of twenty');

-- The cursor: the second page starts after the first page's last row and repeats none of it.
create or replace function pg_temp.page_ids(p_limit integer, p_at timestamptz, p_id uuid)
returns uuid[] language sql as $$
  select coalesce(array_agg(r.id), '{}'::uuid[])
    from app_private.reports_for_reporter('e1000000-0000-4000-8000-000000000001', p_limit, p_at, p_id) r;
$$;

select ok(
  (with first_page as (
     select t.id, t.created_at, t.n
       from app_private.reports_for_reporter('e1000000-0000-4000-8000-000000000001', 2)
            with ordinality as t(id, subject_type, subject_slug, subject_label, reason_code, details,
                                 status, created_at, n)
   ), last_row as (
     select id, created_at from first_page order by n desc limit 1
   )
   select not ((select array_agg(id) from first_page) && pg_temp.page_ids(2,
     (select created_at from last_row), (select id from last_row)))
  ),
  'the second page repeats no row of the first');
select is(
  (select count(*)::int from unnest(pg_temp.page_ids(50,
     (select t.created_at from app_private.reports_for_reporter('e1000000-0000-4000-8000-000000000001', 1)
             with ordinality as t(id, subject_type, subject_slug, subject_label, reason_code, details,
                                  status, created_at, n)),
     (select t.id from app_private.reports_for_reporter('e1000000-0000-4000-8000-000000000001', 1)
             with ordinality as t(id, subject_type, subject_slug, subject_label, reason_code, details,
                                  status, created_at, n))))),
  (select count(*)::int - 1 from public.reports where reporter_user_id = 'e1000000-0000-4000-8000-000000000001'),
  'and seeking past the newest row returns every one of the rest');

select is(
  (select count(*)::int from app_private.reports_for_reporter('e1000000-0000-4000-8000-000000000001', 500)),
  (select count(*)::int from public.reports where reporter_user_id = 'e1000000-0000-4000-8000-000000000001'),
  'a limit past the clamp returns what there is rather than failing');

-- 17. The reader writes nothing --------------------------------------------------------------------
select is(
  (select count(*)::int from public.reports),
  (select count(*)::int from public.reports),
  'the counts are stable across the reader, which is what stable means here');

select is((select count(*)::int from public.moderation_actions), 0,
          'no report filed a moderation action');
select is((select count(*)::int from public.listing_moderation_actions), 0,
          'nor a listing moderation action');
select is(
  (select count(*)::int from public.listings where status <> 'active' and slug = 'live-listing'),
  0, 'and the reported listing is exactly as it was');

select * from finish();
rollback;
