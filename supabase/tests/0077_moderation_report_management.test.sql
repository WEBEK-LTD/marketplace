-- pgTAP — migration 0077: listing moderation and report management (Phase 7-N).
--
-- What these assertions hold to account is mostly what the thirteen functions **delegate** and what they
-- **refuse**:
--
--   * **five keys, five capabilities.** Every reader and both writers are driven by a colleague who holds
--     the wrong key, by staff at `aal1`, by a revoked role and by an expired one — and each answers with
--     nothing or with `not_found`, never with a row and never with an error that says why.
--   * **the transitions are 0027's writers', not this migration's.** Reports take `triaged`, `actioned`,
--     `dismissed` and `duplicate` and nothing else — `open` is refused, because no writer in this
--     repository accepts it. Listings take the writer's five actions, each landing on the status its own
--     `case` names.
--   * **every refusal 0027 raises is returned as an outcome.** No such report, the caller's own report,
--     one already closed, a close with no reason, a duplicate with no original, a duplicate pointing at
--     itself — and for listings: no such listing, the caller's own listing, an action that would move
--     nothing, and one the listing cannot take because it has no price or was never approved. Each is
--     produced by actually provoking it, not by asserting a branch exists.
--   * **the trails are written once.** Both moderation tables and the outbox event are checked by count
--     against the number of decisions made, so a duplicate write anywhere above would show up here.
--   * **no account identifier crosses.** Asserted on the result types themselves: not one of the thirteen
--     returns `reporter_user_id`, `assigned_to`, `resolved_by`, `moderator_user_id` or `seller_user_id`.
--   * **7-M is untouched.** The reporter's own readers are driven again on the same reports to prove they
--     still return eight columns and none of the moderation state this increment now reads.
--
-- Deterministic: fixed uuids, and every ordering assertion ages its rows explicitly rather than relying on
-- `now()`, which is transaction-stable. Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(209);

-- ---------------------------------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('f7000000-0000-4000-8000-000000000001', 'n-moderator-one@test.invalid'),
  ('f7000000-0000-4000-8000-000000000002', 'n-moderator-two@test.invalid'),
  ('f7000000-0000-4000-8000-000000000003', 'n-admin@test.invalid'),
  ('f7000000-0000-4000-8000-000000000004', 'n-support-agent@test.invalid'),
  ('f7000000-0000-4000-8000-000000000005', 'n-revoked-moderator@test.invalid'),
  ('f7000000-0000-4000-8000-000000000006', 'n-expired-moderator@test.invalid'),
  ('f7000000-0000-4000-8000-000000000007', 'n-buyer@test.invalid'),
  ('f7000000-0000-4000-8000-000000000008', 'n-seller@test.invalid'),
  ('f7000000-0000-4000-8000-000000000009', 'n-reporter@test.invalid');

insert into public.user_roles (user_id, role_key, granted_at) values
  ('f7000000-0000-4000-8000-000000000001', 'moderator', now() - interval '1 day'),
  ('f7000000-0000-4000-8000-000000000002', 'moderator', now() - interval '1 day'),
  ('f7000000-0000-4000-8000-000000000003', 'admin', now() - interval '1 day'),
  ('f7000000-0000-4000-8000-000000000004', 'support_agent', now() - interval '1 day'),
  ('f7000000-0000-4000-8000-000000000007', 'buyer', now() - interval '1 day'),
  ('f7000000-0000-4000-8000-000000000008', 'seller', now() - interval '1 day');

insert into public.user_roles (user_id, role_key, granted_at, revoked_at) values
  ('f7000000-0000-4000-8000-000000000005', 'moderator', now() - interval '2 days', now() - interval '1 hour');
insert into public.user_roles (user_id, role_key, granted_at, expires_at) values
  ('f7000000-0000-4000-8000-000000000006', 'moderator', now() - interval '2 days', now() - interval '1 hour');

insert into public.seller_profiles
  (user_id, slug, display_name, legal_name, contact_email, contact_phone_e164, country_code,
   status, verification_status, verified_at)
values
  ('f7000000-0000-4000-8000-000000000008', 'n-shop', 'Canary Shop', 'Canary Shop LLC',
   'shop@test.invalid', '+201000000077', 'EG', 'active', 'verified', now() - interval '10 days'),
  -- The first moderator sells too, which is the only way "moderating your own listing" is reachable.
  ('f7000000-0000-4000-8000-000000000001', 'n-mod-shop', 'Moderator Shop', 'Moderator Shop LLC',
   'modshop@test.invalid', '+201000000078', 'EG', 'active', 'verified', now() - interval '10 days');

insert into public.categories (id, parent_id, slug, is_active, sort_order) values
  ('c7000000-0000-4000-8000-000000000001', null, 'moderation-fixture', true, 1);
insert into public.category_translations (category_id, locale_code, name) values
  ('c7000000-0000-4000-8000-000000000001', 'en', 'Fixture'),
  ('c7000000-0000-4000-8000-000000000001', 'ar', 'عينة');

create or replace function pg_temp.listing(
  p_id uuid, p_slug text, p_status text, p_seller uuid, p_price bigint, p_created timestamptz
) returns void language plpgsql as $$
begin
  insert into public.listings (
    id, seller_user_id, listing_type_code, category_id, slug, title, description, content_language,
    currency_code, price_minor, is_negotiable, status, country_code, city, created_at,
    approved_at, sold_at, archived_at, deleted_at
  ) values (
    p_id, p_seller, 'product', 'c7000000-0000-4000-8000-000000000001', p_slug,
    'Canary ' || p_slug, 'A description long enough to satisfy the length rule.', 'en',
    'EGP', p_price, false, p_status, 'EG', 'Cairo', p_created,
    -- `approved_at` survives every later state a listing reaches, which is what lets a suspended listing
    -- be reinstated to active at all: `listings_approved_has_time` requires it.
    case when p_status in ('approved','active','sold','expired','archived','suspended') then p_created end,
    case when p_status = 'sold' then p_created end,
    case when p_status = 'archived' then p_created end,
    case when p_status = 'deleted' then p_created end
  );
end;
$$;

-- Three awaiting review, aged so the queue's order is a fact rather than a coin flip.
select pg_temp.listing('77770000-0000-4000-8000-000000000001', 'waiting-one', 'pending_review',
  'f7000000-0000-4000-8000-000000000008', 150000, now() - interval '3 days');
select pg_temp.listing('77770000-0000-4000-8000-000000000002', 'waiting-two', 'pending_review',
  'f7000000-0000-4000-8000-000000000008', 150000, now() - interval '2 days');
select pg_temp.listing('77770000-0000-4000-8000-000000000003', 'waiting-three', 'pending_review',
  'f7000000-0000-4000-8000-000000000008', 150000, now() - interval '1 day');
-- One with no price at all, which cannot become approved or active.
select pg_temp.listing('77770000-0000-4000-8000-000000000004', 'priceless', 'pending_review',
  'f7000000-0000-4000-8000-000000000008', null, now() - interval '4 days');
-- Live, suspended and rejected, for the actions that act on those.
select pg_temp.listing('77770000-0000-4000-8000-000000000005', 'already-live', 'active',
  'f7000000-0000-4000-8000-000000000008', 150000, now() - interval '5 days');
select pg_temp.listing('77770000-0000-4000-8000-000000000006', 'already-suspended', 'suspended',
  'f7000000-0000-4000-8000-000000000008', 150000, now() - interval '6 days');
-- A listing the first moderator owns, which the writer refuses them.
select pg_temp.listing('77770000-0000-4000-8000-000000000007', 'moderators-own', 'pending_review',
  'f7000000-0000-4000-8000-000000000001', 150000, now() - interval '7 days');

-- Shorthands -----------------------------------------------------------------------------------------
create or replace function pg_temp.mod_one() returns uuid
language sql immutable as $$ select 'f7000000-0000-4000-8000-000000000001'::uuid; $$;
create or replace function pg_temp.mod_two() returns uuid
language sql immutable as $$ select 'f7000000-0000-4000-8000-000000000002'::uuid; $$;
create or replace function pg_temp.reporter() returns uuid
language sql immutable as $$ select 'f7000000-0000-4000-8000-000000000009'::uuid; $$;
create or replace function pg_temp.agent() returns uuid
language sql immutable as $$ select 'f7000000-0000-4000-8000-000000000004'::uuid; $$;

create or replace function pg_temp.resolve(
  p_user uuid, p_aal2 boolean, p_report uuid, p_status text,
  p_note text default 'A canary reason.', p_dup uuid default null
) returns text language sql as $$
  select outcome from app_private.moderation_report_resolve_for_staff(
    p_user, p_aal2, p_report, p_status, p_note, p_dup);
$$;

create or replace function pg_temp.moderate(
  p_user uuid, p_aal2 boolean, p_listing uuid, p_action text,
  p_reason text default 'A canary reason.', p_report uuid default null
) returns text language sql as $$
  select outcome from app_private.moderation_listing_moderate_for_staff(
    p_user, p_aal2, p_listing, p_action, p_reason, p_report);
$$;

create or replace function pg_temp.moderate_status(
  p_user uuid, p_aal2 boolean, p_listing uuid, p_action text, p_reason text default 'A canary reason.'
) returns text language sql as $$
  select status from app_private.moderation_listing_moderate_for_staff(
    p_user, p_aal2, p_listing, p_action, p_reason, null);
$$;

create or replace function pg_temp.listing_status(p_id uuid) returns text
language sql as $$ select l.status from public.listings l where l.id = p_id; $$;

create or replace function pg_temp.file(p_type text, p_id uuid, p_reason text default 'spam') returns uuid
language sql as $$
  select app_private.file_report(pg_temp.reporter(), p_type, p_id, p_reason, 'Canary report details.');
$$;

-- Reports: one about each resolvable subject, one about a message (which the repository cannot resolve),
-- and one the first moderator filed themselves.
select pg_temp.file('listing', '77770000-0000-4000-8000-000000000005');
select pg_temp.file('seller', 'f7000000-0000-4000-8000-000000000008', 'harassment');
select pg_temp.file('message', 'a7000000-0000-4000-8000-0000000000aa', 'harassment');

create or replace function pg_temp.report_of(p_type text, p_id uuid) returns uuid
language sql as $$
  select r.id from public.reports r
   where r.reporter_user_id = pg_temp.reporter() and r.subject_type = p_type and r.subject_id = p_id;
$$;

insert into public.reports (reporter_user_id, subject_type, subject_id, reason_code, details)
values (pg_temp.mod_one(), 'listing', '77770000-0000-4000-8000-000000000006', 'spam', 'My own report.');

create or replace function pg_temp.own_report() returns uuid
language sql as $$
  select r.id from public.reports r where r.reporter_user_id = pg_temp.mod_one();
$$;

-- 1. Shape and privileges ---------------------------------------------------------------------------
select has_function('app_private', 'moderation_can_read_reports', array['uuid', 'boolean'], 'read predicate');
select has_function('app_private', 'moderation_can_manage_reports', array['uuid', 'boolean'], 'manage predicate');
select has_function('app_private', 'moderation_can_read_actions', array['uuid', 'boolean'], 'action predicate');
select has_function('app_private', 'moderation_can_read_catalog', array['uuid', 'boolean'], 'catalog predicate');
select has_function('app_private', 'moderation_can_moderate_listings', array['uuid', 'boolean'], 'moderate predicate');
select has_function('app_private', 'moderation_report_queue',
  array['uuid', 'boolean', 'integer', 'text', 'timestamptz', 'uuid'], 'the report queue');
select has_function('app_private', 'moderation_report_for_staff',
  array['uuid', 'boolean', 'uuid'], 'one report');
select has_function('app_private', 'moderation_actions_for_subject',
  array['uuid', 'boolean', 'text', 'uuid', 'integer'], 'the generic trail by subject');
select has_function('app_private', 'moderation_actions_for_report',
  array['uuid', 'boolean', 'uuid', 'integer'], 'the generic trail by report');
select has_function('app_private', 'listing_moderation_history',
  array['uuid', 'boolean', 'uuid', 'integer'], 'the listing trail');
select has_function('app_private', 'moderation_listing_queue',
  array['uuid', 'boolean', 'integer', 'timestamptz', 'uuid'], 'the listing queue');
select has_function('app_private', 'moderation_listing_for_staff',
  array['uuid', 'boolean', 'uuid'], 'one listing');
select has_function('app_private', 'moderation_report_resolve_for_staff',
  array['uuid', 'boolean', 'uuid', 'text', 'text', 'uuid'], 'resolving a report');
select has_function('app_private', 'moderation_listing_moderate_for_staff',
  array['uuid', 'boolean', 'uuid', 'text', 'text', 'uuid'], 'moderating a listing');

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'moderation\_%' and not p.prosecdef),
  0, 'every new moderation function is security definer');
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and (p.proname like 'moderation\_%' or p.proname = 'listing_moderation_history')
      and p.proconfig::text <> '{"search_path=pg_catalog, public"}'),
  0, 'and pins its search_path');
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('moderation_report_resolve_for_staff', 'moderation_listing_moderate_for_staff')
      and p.provolatile <> 'v'),
  0, 'the two writers are volatile, because they write');
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('moderation_report_queue', 'moderation_report_for_staff',
                        'moderation_actions_for_subject', 'listing_moderation_history',
                        'moderation_listing_queue', 'moderation_listing_for_staff')
      and p.provolatile <> 's'),
  0, 'and the six readers are stable');

create or replace function pg_temp.new_functions() returns setof text language sql as $$
  select p.oid::regprocedure::text
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app_private'
     and (p.proname like 'moderation\_can\_%' or p.proname like 'moderation\_report\_%'
          or p.proname like 'moderation\_listing\_%' or p.proname like 'moderation\_actions\_%'
          or p.proname = 'listing_moderation_history');
$$;

select is((select count(*)::int from pg_temp.new_functions()), 14, 'fourteen functions and no fifteenth');
select is(
  (select count(*)::int from pg_temp.new_functions() f where has_function_privilege('public', f, 'execute')),
  0, 'public may execute none of them');
select is(
  (select count(*)::int from pg_temp.new_functions() f
    where not has_function_privilege('app_system', f, 'execute')),
  0, 'app_system may execute all of them');
select is(
  (select count(*)::int from pg_temp.new_functions() f
    where has_function_privilege('authenticated', f, 'execute')
       or has_function_privilege('anon', f, 'execute')),
  0, 'and no database session role may execute any of them');

-- No account identifier is in any result type. Named individually so a future change deletes an assertion.
select is(
  (select count(*)::int from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     join unnest(p.proargnames, p.proargmodes) as a(attname, mode) on true
    where n.nspname = 'app_private' and a.mode = 't'
      and (p.proname like 'moderation\_%' or p.proname = 'listing_moderation_history')
      and a.attname = any (array['reporter_user_id', 'assigned_to', 'assigned_at', 'resolved_by',
                                 'moderator_user_id', 'seller_user_id', 'changed_by'])),
  0, 'not one result type carries an account identifier');

-- 2. Nothing about 0027 or 0011 changed -------------------------------------------------------------
select is(
  (select string_agg(column_name, ',' order by column_name)
     from information_schema.columns where table_schema = 'public' and table_name = 'reports'),
  'assigned_at,assigned_to,created_at,details,duplicate_of_report_id,id,priority,reason_code,' ||
  'reporter_user_id,resolution,resolution_note,resolved_at,resolved_by,status,subject_id,subject_type,updated_at',
  'the reports table has exactly the columns 0027 gave it');
select is(
  (select string_agg(column_name, ',' order by column_name)
     from information_schema.columns
    where table_schema = 'public' and table_name = 'moderation_actions'),
  'action,created_at,expires_at,id,moderator_user_id,notes,reason,report_id,reverses_action_id,subject_id,subject_type',
  'and moderation_actions has exactly its own');
select is(
  (select string_agg(column_name, ',' order by column_name)
     from information_schema.columns
    where table_schema = 'public' and table_name = 'listing_moderation_actions'),
  'action,created_at,from_status,id,listing_id,moderation_action_id,moderator_user_id,reason,report_id,to_status',
  'and listing_moderation_actions has exactly its own');

select is(
  (select count(*)::int from pg_policy p join pg_class c on c.oid = p.polrelid where c.relname = 'reports'),
  3, 'the reports policies are still 0027''s three');
select is(
  (select count(*)::int from pg_policy p join pg_class c on c.oid = p.polrelid
    where c.relname in ('moderation_actions', 'listing_moderation_actions')),
  3, 'and the two action tables still have their three');
select ok(
  (select pg_get_constraintdef(oid) like '%from_status <> to_status%'
     from pg_constraint where conname = 'listing_moderation_actions_status_moved'),
  'the status-moved constraint is unchanged, which is what refuses a repeat');
select ok(
  (select pg_get_constraintdef(oid) like '%''approve''%''reject''%''suspend''%''reinstate''%''request_changes''%'
     from pg_constraint where conname = 'listing_moderation_actions_action_allowed'),
  'and the five listing actions are unchanged');

select has_function('app_private', 'resolve_report', array['uuid', 'text', 'uuid', 'text', 'uuid'],
  '0027''s resolve_report is still here, with its own signature');
select has_function('app_private', 'moderate_listing', array['uuid', 'text', 'uuid', 'text', 'uuid'],
  'and moderate_listing');
select has_function('app_private', 'record_moderation_action',
  array['text', 'uuid', 'text', 'uuid', 'text', 'uuid', 'text', 'timestamptz', 'uuid'],
  'and record_moderation_action');

-- 3. The five predicates -----------------------------------------------------------------------------
select ok(app_private.moderation_can_read_reports(pg_temp.mod_one(), true), 'a moderator at aal2 may read reports');
select ok(not app_private.moderation_can_read_reports(pg_temp.mod_one(), false),
  'and at aal1 holds nothing, because the role requires mfa');
select ok(not app_private.moderation_can_read_reports(pg_temp.mod_one(), null),
  'a null assurance level is not a strong one');
select ok(app_private.moderation_can_read_reports('f7000000-0000-4000-8000-000000000003', true),
  'an admin holds it too');
select ok(not app_private.moderation_can_read_reports(pg_temp.agent(), true),
  'a support agent does not');
select ok(not app_private.moderation_can_read_reports('f7000000-0000-4000-8000-000000000007', true),
  'nor a buyer');
select ok(not app_private.moderation_can_read_reports('f7000000-0000-4000-8000-000000000008', true),
  'nor a seller');
select ok(not app_private.moderation_can_read_reports('f7000000-0000-4000-8000-000000000005', true),
  'nor somebody whose role was revoked');
select ok(not app_private.moderation_can_read_reports('f7000000-0000-4000-8000-000000000006', true),
  'nor somebody whose role expired');
select ok(not app_private.moderation_can_read_reports(null, true), 'nor nobody');

select ok(app_private.moderation_can_manage_reports(pg_temp.mod_one(), true), 'a moderator may manage reports');
select ok(not app_private.moderation_can_manage_reports(pg_temp.agent(), true), 'a support agent may not');
select ok(app_private.moderation_can_read_actions(pg_temp.mod_one(), true), 'a moderator may read actions');
select ok(not app_private.moderation_can_read_actions(pg_temp.agent(), true), 'a support agent may not');
select ok(app_private.moderation_can_read_catalog(pg_temp.mod_one(), true), 'a moderator may read the catalogue');
select ok(app_private.moderation_can_moderate_listings(pg_temp.mod_one(), true), 'and may moderate a listing');
select ok(not app_private.moderation_can_moderate_listings(pg_temp.agent(), true),
  'a support agent may not moderate a listing');
select ok(not app_private.moderation_can_moderate_listings(pg_temp.mod_one(), false),
  'and neither may a moderator at aal1');

-- The keys are literals in the source, so no caller can name another.
select ok(
  (select bool_and(prosrc like '%''moderation.report.read''%') from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'moderation_can_read_reports'),
  'the read predicate pins its key as a literal');
select ok(
  (select bool_and(prosrc like '%''catalog.listing.moderate''%') from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'moderation_can_moderate_listings'),
  'and the moderate predicate pins its own');
-- The predicates join `role_permissions` on `role_key`, which is how a permission is looked up; what must
-- not appear is a role **name**, because that is what authorizing by role would look like.
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and (p.proname like 'moderation\_%' or p.proname = 'listing_moderation_history')
      -- `'seller'` and `'buyer'` are not in this list: both are *report subject types* in 0027's own
      -- vocabulary as well as role keys, and the readers name the subject type legitimately. The four
      -- below are staff role keys and nothing else, so naming one could only be authorizing by role.
      and (p.prosrc like '%''moderator''%' or p.prosrc like '%''admin''%'
           or p.prosrc like '%''super_admin''%' or p.prosrc like '%''support_agent''%')),
  0, 'and nothing in this migration names a staff role');

-- 4. The report queue --------------------------------------------------------------------------------
select is((select count(*)::int from app_private.moderation_report_queue(pg_temp.mod_one(), true, 50)),
  4, 'a moderator at aal2 reads every report');
select is((select count(*)::int from app_private.moderation_report_queue(pg_temp.mod_one(), false, 50)),
  0, 'at aal1, none');
select is((select count(*)::int from app_private.moderation_report_queue(pg_temp.agent(), true, 50)),
  0, 'a support agent reads none');
select is((select count(*)::int from app_private.moderation_report_queue(
    'f7000000-0000-4000-8000-000000000007', true, 50)),
  0, 'a buyer reads none');
select is((select count(*)::int from app_private.moderation_report_queue(
    'f7000000-0000-4000-8000-000000000005', true, 50)),
  0, 'a revoked moderator reads none');
select is((select count(*)::int from app_private.moderation_report_queue(null, true, 50)),
  0, 'and nobody reads none');

select is(
  (select q.subject_label from app_private.moderation_report_queue(pg_temp.mod_one(), true, 50) q
    where q.subject_type = 'listing' and q.reason_code = 'spam' and not q.is_own_report),
  'Canary already-live', 'a reported listing resolves to its title');
select is(
  (select q.subject_label from app_private.moderation_report_queue(pg_temp.mod_one(), true, 50) q
    where q.subject_type = 'seller'),
  'Canary Shop', 'a reported seller resolves to its display name');
select is(
  (select q.subject_label from app_private.moderation_report_queue(pg_temp.mod_one(), true, 50) q
    where q.subject_type = 'message'),
  null, 'a reported message resolves to nothing, because no staff read path exists for one');

select ok(
  (select q.is_own_report from app_private.moderation_report_queue(pg_temp.mod_one(), true, 50) q
    where q.id = pg_temp.own_report()),
  'a moderator is told which report is their own');
select ok(
  (select not q.is_own_report from app_private.moderation_report_queue(pg_temp.mod_two(), true, 50) q
    where q.id = pg_temp.own_report()),
  'and a colleague is told it is not theirs');

select is(
  (select count(*)::int from app_private.moderation_report_queue(pg_temp.mod_one(), true, 50, 'open')),
  4, 'the status filter admits the open ones');
select is(
  (select count(*)::int from app_private.moderation_report_queue(pg_temp.mod_one(), true, 50, 'actioned')),
  0, 'and excludes a status nothing holds');
select is(
  (select count(*)::int from app_private.moderation_report_queue(pg_temp.mod_one(), true, 50, 'not_a_status')),
  0, 'an unknown status matches nothing rather than building a predicate');

select is((select count(*)::int from app_private.moderation_report_queue(pg_temp.mod_one(), true, 2)),
  2, 'a limit is honoured');
select is((select count(*)::int from app_private.moderation_report_queue(pg_temp.mod_one(), true, 0)),
  1, 'a limit of nothing is one row');
select is((select count(*)::int from app_private.moderation_report_queue(pg_temp.mod_one(), true, 500)),
  4, 'and a limit past the clamp returns what there is');

select is(
  (select count(*)::int from app_private.moderation_report_queue(pg_temp.mod_one(), true, 50) q
    where q.action_count <> 0),
  0, 'no report cites a moderation action yet');

-- 5. One report ---------------------------------------------------------------------------------------
select is(
  (select d.outcome from app_private.moderation_report_for_staff(
     pg_temp.mod_one(), true, pg_temp.report_of('listing', '77770000-0000-4000-8000-000000000005'))d),
  'found', 'a moderator reads one report');
select is(
  (select d.outcome from app_private.moderation_report_for_staff(
     pg_temp.mod_one(), false, pg_temp.report_of('listing', '77770000-0000-4000-8000-000000000005'))d),
  'not_found', 'at aal1 it is not found');
select is(
  (select d.outcome from app_private.moderation_report_for_staff(
     pg_temp.agent(), true, pg_temp.report_of('listing', '77770000-0000-4000-8000-000000000005'))d),
  'not_found', 'and to a support agent it is not found — the same answer, which is the point');
select is(
  (select d.outcome from app_private.moderation_report_for_staff(
     pg_temp.mod_one(), true, 'c7000000-0000-4000-8000-00000000dead')d),
  'not_found', 'a report that does not exist is the same answer again');
select is(
  (select d.outcome from app_private.moderation_report_for_staff(pg_temp.mod_one(), true, null)d),
  'not_found', 'and no identifier');

select is(
  (select d.subject_status from app_private.moderation_report_for_staff(
     pg_temp.mod_one(), true, pg_temp.report_of('listing', '77770000-0000-4000-8000-000000000005'))d),
  'active', 'a reported listing carries its current status, which is what makes a decision current');
select is(
  (select d.details from app_private.moderation_report_for_staff(
     pg_temp.mod_one(), true, pg_temp.report_of('listing', '77770000-0000-4000-8000-000000000005'))d),
  'Canary report details.', 'and what the reporter wrote');
select ok(
  (select d.subject_is_resolvable from app_private.moderation_report_for_staff(
     pg_temp.mod_one(), true, pg_temp.report_of('listing', '77770000-0000-4000-8000-000000000005'))d),
  'a listing subject is resolvable');
select ok(
  (select d.subject_is_resolvable from app_private.moderation_report_for_staff(
     pg_temp.mod_one(), true, pg_temp.report_of('seller', 'f7000000-0000-4000-8000-000000000008'))d),
  'a seller subject is resolvable');
select ok(
  (select not d.subject_is_resolvable from app_private.moderation_report_for_staff(
     pg_temp.mod_one(), true, pg_temp.report_of('message', 'a7000000-0000-4000-8000-0000000000aa'))d),
  'a message subject is not, and the reader says so rather than rendering an empty summary');
select is(
  (select d.subject_status from app_private.moderation_report_for_staff(
     pg_temp.mod_one(), true, pg_temp.report_of('seller', 'f7000000-0000-4000-8000-000000000008'))d),
  null, 'a seller subject carries no status, because nothing here acts on a storefront');

select ok(
  (select d.is_own_report from app_private.moderation_report_for_staff(
     pg_temp.mod_one(), true, pg_temp.own_report())d),
  'the detail says when the report is the caller''s own, before they try to rule on it');
select ok(
  (select not d.resolved_by_me from app_private.moderation_report_for_staff(
     pg_temp.mod_one(), true, pg_temp.own_report())d),
  'and that nobody has ruled on it yet');

select is(
  (select string_agg(a.attname, ',' order by a.attname)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     join unnest(p.proargnames, p.proargmodes) as a(attname, mode) on true
    where n.nspname = 'app_private' and p.proname = 'moderation_report_for_staff' and a.mode = 't'),
  'created_at,details,duplicate_of_report_id,id,is_own_report,outcome,priority,reason_code,resolution,' ||
  'resolution_note,resolved_at,resolved_by_me,status,subject_is_resolvable,subject_label,subject_slug,' ||
  'subject_status,subject_type,updated_at',
  'the detail returns exactly the nineteen approved columns');

-- 6. Report transitions, all of them 0027's ----------------------------------------------------------
select is(pg_temp.resolve(pg_temp.mod_one(), true,
  pg_temp.report_of('message', 'a7000000-0000-4000-8000-0000000000aa'), 'triaged'),
  'resolved', 'open to triaged is accepted');
select is(
  (select r.status from public.reports r
    where r.id = pg_temp.report_of('message', 'a7000000-0000-4000-8000-0000000000aa')),
  'triaged', 'and the report is triaged');
select is(
  (select r.resolved_at from public.reports r
    where r.id = pg_temp.report_of('message', 'a7000000-0000-4000-8000-0000000000aa')),
  null, 'triage stamps no resolution time, because it is not a decision');

select is(pg_temp.resolve(pg_temp.mod_one(), true,
  pg_temp.report_of('message', 'a7000000-0000-4000-8000-0000000000aa'), 'triaged'),
  'resolved', 'triaged to triaged is accepted too, because triaged is not final');

select is(pg_temp.resolve(pg_temp.mod_one(), true,
  pg_temp.report_of('message', 'a7000000-0000-4000-8000-0000000000aa'), 'dismissed'),
  'resolved', 'triaged to dismissed is accepted');
select is(
  (select r.resolution from public.reports r
    where r.id = pg_temp.report_of('message', 'a7000000-0000-4000-8000-0000000000aa')),
  'dismissed', 'and the resolution is recorded');
select ok(
  (select r.resolved_at is not null and r.resolution_note = 'A canary reason.' from public.reports r
    where r.id = pg_temp.report_of('message', 'a7000000-0000-4000-8000-0000000000aa')),
  'with its time and its reason');

select is(pg_temp.resolve(pg_temp.mod_one(), true,
  pg_temp.report_of('message', 'a7000000-0000-4000-8000-0000000000aa'), 'actioned'),
  'already_final', 'a dismissed report takes no second decision');
select is(pg_temp.resolve(pg_temp.mod_one(), true,
  pg_temp.report_of('message', 'a7000000-0000-4000-8000-0000000000aa'), 'triaged'),
  'already_final', 'nor a return to triage');

select is(pg_temp.resolve(pg_temp.mod_one(), true,
  pg_temp.report_of('seller', 'f7000000-0000-4000-8000-000000000008'), 'open'),
  'invalid', 'open is not a status this surface can set, because no writer accepts it');
select is(pg_temp.resolve(pg_temp.mod_one(), true,
  pg_temp.report_of('seller', 'f7000000-0000-4000-8000-000000000008'), 'reopened'),
  'invalid', 'nor an invented one');
select is(pg_temp.resolve(pg_temp.mod_one(), true,
  pg_temp.report_of('seller', 'f7000000-0000-4000-8000-000000000008'), null),
  'invalid', 'nor none');
select is(
  (select r.status from public.reports r
    where r.id = pg_temp.report_of('seller', 'f7000000-0000-4000-8000-000000000008')),
  'open', 'and the report is untouched by any of them');

select is(pg_temp.resolve(pg_temp.mod_one(), true,
  pg_temp.report_of('seller', 'f7000000-0000-4000-8000-000000000008'), 'actioned', '   '),
  'invalid', 'a close with no reason is refused, which is 0027''s own rule');
select is(pg_temp.resolve(pg_temp.mod_one(), true,
  pg_temp.report_of('seller', 'f7000000-0000-4000-8000-000000000008'), 'actioned', null),
  'invalid', 'and so is one with no note at all');
select is(pg_temp.resolve(pg_temp.mod_one(), true,
  pg_temp.report_of('seller', 'f7000000-0000-4000-8000-000000000008'), 'triaged', null),
  'resolved', 'while triage needs none');

select is(pg_temp.resolve(pg_temp.mod_one(), true, pg_temp.own_report(), 'dismissed'),
  'own_report', 'nobody rules on their own report');
select is(
  (select r.status from public.reports r where r.id = pg_temp.own_report()),
  'open', 'and it is left alone');
select is(pg_temp.resolve(pg_temp.mod_two(), true, pg_temp.own_report(), 'dismissed'),
  'resolved', 'but a colleague may rule on it');
select ok(
  (select d.resolved_by_me from app_private.moderation_report_for_staff(
     pg_temp.mod_two(), true, pg_temp.own_report())d),
  'and is told the decision was theirs');
select ok(
  (select not d.resolved_by_me from app_private.moderation_report_for_staff(
     pg_temp.mod_one(), true, pg_temp.own_report())d),
  'while the other colleague is told only that it was not theirs, never whose it was');

select is(pg_temp.resolve(pg_temp.mod_one(), true, 'c7000000-0000-4000-8000-00000000dead', 'dismissed'),
  'not_found', 'a report that does not exist cannot be resolved');
select is(pg_temp.resolve(pg_temp.mod_one(), true, null, 'dismissed'),
  'not_found', 'nor none');

-- The duplicate path, and the two constraints that guard it.
select is(pg_temp.resolve(pg_temp.mod_one(), true,
  pg_temp.report_of('seller', 'f7000000-0000-4000-8000-000000000008'), 'duplicate'),
  'invalid', 'a duplicate with no original is refused');
select is(pg_temp.resolve(pg_temp.mod_one(), true,
  pg_temp.report_of('seller', 'f7000000-0000-4000-8000-000000000008'), 'duplicate', 'A reason.',
  pg_temp.report_of('seller', 'f7000000-0000-4000-8000-000000000008')),
  'invalid', 'and one pointing at itself');
select is(pg_temp.resolve(pg_temp.mod_one(), true,
  pg_temp.report_of('seller', 'f7000000-0000-4000-8000-000000000008'), 'actioned', 'A reason.',
  pg_temp.report_of('listing', '77770000-0000-4000-8000-000000000005')),
  'invalid', 'and an original named on a status that is not duplicate');
select is(pg_temp.resolve(pg_temp.mod_one(), true,
  pg_temp.report_of('seller', 'f7000000-0000-4000-8000-000000000008'), 'duplicate', 'A reason.',
  'c7000000-0000-4000-8000-00000000dead'),
  'invalid', 'and one naming an original that does not exist');
select is(pg_temp.resolve(pg_temp.mod_one(), true,
  pg_temp.report_of('seller', 'f7000000-0000-4000-8000-000000000008'), 'duplicate', 'A reason.',
  pg_temp.report_of('listing', '77770000-0000-4000-8000-000000000005')),
  'resolved', 'a duplicate naming a real other report is accepted');
select is(
  (select r.duplicate_of_report_id from public.reports r
    where r.id = pg_temp.report_of('seller', 'f7000000-0000-4000-8000-000000000008')),
  pg_temp.report_of('listing', '77770000-0000-4000-8000-000000000005'),
  'and the original is recorded');

-- Authorization on the write, separately from every rule above.
select is(pg_temp.resolve(pg_temp.mod_one(), false,
  pg_temp.report_of('listing', '77770000-0000-4000-8000-000000000005'), 'dismissed'),
  'not_found', 'a moderator at aal1 resolves nothing');
select is(pg_temp.resolve(pg_temp.agent(), true,
  pg_temp.report_of('listing', '77770000-0000-4000-8000-000000000005'), 'dismissed'),
  'not_found', 'a support agent resolves nothing');
select is(pg_temp.resolve('f7000000-0000-4000-8000-000000000007', true,
  pg_temp.report_of('listing', '77770000-0000-4000-8000-000000000005'), 'dismissed'),
  'not_found', 'a buyer resolves nothing');
select is(pg_temp.resolve('f7000000-0000-4000-8000-000000000005', true,
  pg_temp.report_of('listing', '77770000-0000-4000-8000-000000000005'), 'dismissed'),
  'not_found', 'a revoked moderator resolves nothing');
select is(pg_temp.resolve(pg_temp.reporter(), true,
  pg_temp.report_of('listing', '77770000-0000-4000-8000-000000000005'), 'dismissed'),
  'not_found', 'and the reporter themselves resolves nothing');
select is(
  (select r.status from public.reports r
    where r.id = pg_temp.report_of('listing', '77770000-0000-4000-8000-000000000005')),
  'open', 'the report none of them could touch is still open');

-- 7. Listing moderation: the five actions ------------------------------------------------------------
select is(pg_temp.moderate(pg_temp.mod_one(), true, '77770000-0000-4000-8000-000000000001', 'approve'),
  'moderated', 'approve is accepted');
select is(pg_temp.listing_status('77770000-0000-4000-8000-000000000001'), 'approved',
  'and the listing is approved');
select ok(
  (select l.approved_at is not null from public.listings l
    where l.id = '77770000-0000-4000-8000-000000000001'),
  'and stamped');

select is(pg_temp.moderate(pg_temp.mod_one(), true, '77770000-0000-4000-8000-000000000002', 'reject'),
  'moderated', 'reject is accepted');
select is(pg_temp.listing_status('77770000-0000-4000-8000-000000000002'), 'rejected', 'and lands on rejected');

select is(pg_temp.moderate(pg_temp.mod_one(), true, '77770000-0000-4000-8000-000000000005', 'suspend'),
  'moderated', 'suspend is accepted');
select is(pg_temp.listing_status('77770000-0000-4000-8000-000000000005'), 'suspended', 'and lands on suspended');

select is(pg_temp.moderate(pg_temp.mod_one(), true, '77770000-0000-4000-8000-000000000006', 'reinstate'),
  'moderated', 'reinstate is accepted');
select is(pg_temp.listing_status('77770000-0000-4000-8000-000000000006'), 'active', 'and lands on active');

select is(pg_temp.moderate(pg_temp.mod_one(), true, '77770000-0000-4000-8000-000000000003', 'request_changes'),
  'moderated', 'request_changes is accepted');
select is(pg_temp.listing_status('77770000-0000-4000-8000-000000000003'), 'pending_review',
  'and moves the status nowhere, which is the one action allowed not to');

select is(pg_temp.moderate_status(pg_temp.mod_one(), true, '77770000-0000-4000-8000-000000000003',
  'request_changes'),
  'pending_review', 'and the status it reports back is the one the listing still holds');

select is(pg_temp.moderate(pg_temp.mod_one(), true, '77770000-0000-4000-8000-000000000001', 'remove'),
  'invalid', 'an action 0027 does not define is refused');
select is(pg_temp.moderate(pg_temp.mod_one(), true, '77770000-0000-4000-8000-000000000001', 'delete'),
  'invalid', 'and another');
select is(pg_temp.moderate(pg_temp.mod_one(), true, '77770000-0000-4000-8000-000000000001', null),
  'invalid', 'and none');

select is(pg_temp.moderate(pg_temp.mod_one(), true, '77770000-0000-4000-8000-000000000004', 'approve', '  '),
  'invalid', 'a decision with no reason is refused, which is 0027''s own rule');
select is(pg_temp.moderate(pg_temp.mod_one(), true, '77770000-0000-4000-8000-000000000004', 'approve', null),
  'invalid', 'and one with no reason at all');
select is(pg_temp.moderate(pg_temp.mod_one(), true, '77770000-0000-4000-8000-000000000004', 'approve',
  repeat('x', 501)),
  'invalid', 'and one past the reason length the table allows');
select is(pg_temp.moderate(pg_temp.mod_one(), true, '77770000-0000-4000-8000-000000000004', 'reject',
  repeat('x', 500)),
  'moderated', 'while five hundred characters is inside it');

-- 8. What the schema refuses, returned as its own outcome --------------------------------------------
select is(pg_temp.moderate(pg_temp.mod_one(), true, '77770000-0000-4000-8000-000000000001', 'approve'),
  'no_change', 'approving an approved listing is refused by the status-moved constraint');
select is(pg_temp.moderate(pg_temp.mod_one(), true, '77770000-0000-4000-8000-000000000006', 'reinstate'),
  'no_change', 'and reinstating an active one');
select is(pg_temp.moderate(pg_temp.mod_one(), true, '77770000-0000-4000-8000-000000000005', 'suspend'),
  'no_change', 'and suspending a suspended one — which is how two colleagues acting at once are ordered');
select is(pg_temp.listing_status('77770000-0000-4000-8000-000000000001'), 'approved',
  'and the listing is exactly where the first decision left it');

-- A listing with no price cannot become approved or active: `listings_live_needs_price`.
select is(pg_temp.moderate(pg_temp.mod_one(), true, '77770000-0000-4000-8000-000000000004', 'approve'),
  'not_applicable', 'a listing with no price cannot be approved');
select is(pg_temp.listing_status('77770000-0000-4000-8000-000000000004'), 'rejected',
  'and is left as it was');

select is(pg_temp.moderate(pg_temp.mod_one(), true, '77770000-0000-4000-8000-000000000002', 'reinstate'),
  'not_applicable', 'a listing that was never approved cannot be reinstated to active');
select is(pg_temp.listing_status('77770000-0000-4000-8000-000000000002'), 'rejected',
  'and is left as it was too');

select is(pg_temp.moderate(pg_temp.mod_one(), true, '77770000-0000-4000-8000-000000000007', 'approve'),
  'own_listing', 'nobody moderates their own listing');
select is(pg_temp.listing_status('77770000-0000-4000-8000-000000000007'), 'pending_review',
  'and it is left alone');
select is(pg_temp.moderate(pg_temp.mod_two(), true, '77770000-0000-4000-8000-000000000007', 'approve'),
  'moderated', 'while a colleague may moderate it');

select is(pg_temp.moderate(pg_temp.mod_one(), true, 'c7000000-0000-4000-8000-00000000dead', 'approve'),
  'not_found', 'a listing that does not exist cannot be moderated');
select is(pg_temp.moderate(pg_temp.mod_one(), true, null, 'approve'),
  'not_found', 'nor none');

select is(pg_temp.moderate(pg_temp.mod_one(), false, '77770000-0000-4000-8000-000000000003', 'approve'),
  'not_found', 'a moderator at aal1 moderates nothing');
select is(pg_temp.moderate(pg_temp.agent(), true, '77770000-0000-4000-8000-000000000003', 'approve'),
  'not_found', 'a support agent moderates nothing');
select is(pg_temp.moderate('f7000000-0000-4000-8000-000000000007', true,
  '77770000-0000-4000-8000-000000000003', 'approve'),
  'not_found', 'a buyer moderates nothing');
select is(pg_temp.moderate('f7000000-0000-4000-8000-000000000008', true,
  '77770000-0000-4000-8000-000000000003', 'approve'),
  'not_found', 'a seller moderates nothing');
select is(pg_temp.moderate('f7000000-0000-4000-8000-000000000006', true,
  '77770000-0000-4000-8000-000000000003', 'approve'),
  'not_found', 'an expired moderator moderates nothing');
select is(pg_temp.listing_status('77770000-0000-4000-8000-000000000003'), 'pending_review',
  'and the listing none of them could touch is still waiting');

-- 9. Both trails, written once by the writer ----------------------------------------------------------
-- Seven decisions have succeeded above: approve, reject, suspend, reinstate, request_changes twice,
-- a 500-character reject, and the colleague's approve of the first moderator's own listing.
select is(
  (select count(*)::int from public.listing_moderation_actions),
  (select count(*)::int from public.moderation_actions where subject_type = 'listing'),
  'one generic action per listing-shaped action, which is the writer writing both once');
select is(
  (select count(*)::int from public.outbox_events
    where aggregate_type = 'moderation' and event_type = 'moderation.action_recorded'),
  (select count(*)::int from public.moderation_actions),
  'and one event per action, which is the writer''s own event');
select is(
  (select count(distinct event_type)::int from public.outbox_events where aggregate_type = 'moderation'),
  1, 'and no second moderation event type was invented anywhere');
select ok(
  (select count(*) = 0 from public.outbox_events
    where aggregate_type = 'moderation' and payload ? 'reason'),
  'and no event carries the moderator''s reason');

select is(
  (select string_agg(distinct m.action, ',' order by m.action) from public.listing_moderation_actions m),
  'approve,reinstate,reject,request_changes,suspend',
  'the trail holds only actions the table allows');
select ok(
  (select bool_and(m.from_status <> m.to_status or m.action = 'request_changes')
     from public.listing_moderation_actions m),
  'and every row moved a status, unless it was the one action allowed not to');
select ok(
  (select count(*) > 0 from audit.audit_logs a where a.table_name = 'reports' and a.action = 'update'),
  'resolving a report is recorded by 0027''s own audit trigger');
select is(
  (select a.new_values->>'resolution_note' from audit.audit_logs a
    where a.table_name = 'reports' and a.action = 'update'
      and a.new_values->>'status' = 'dismissed' limit 1),
  '[redacted]', 'with the resolution note redacted, as that trigger''s argument asks');

-- 10. The two trail readers ---------------------------------------------------------------------------
-- One action, not two: the second approve was refused by the status-moved constraint and rolled back, so
-- a refused decision leaves no trace in the trail. That is the property, stated as a count.
select is(
  (select count(*)::int from app_private.moderation_actions_for_subject(
     pg_temp.mod_one(), true, 'listing', '77770000-0000-4000-8000-000000000001', 50)),
  1, 'the generic trail holds the one decision that succeeded, and not the refused repeat');
select is(
  (select count(*)::int from app_private.moderation_actions_for_subject(
     pg_temp.mod_one(), false, 'listing', '77770000-0000-4000-8000-000000000001', 50)),
  0, 'at aal1, none');
select is(
  (select count(*)::int from app_private.moderation_actions_for_subject(
     pg_temp.agent(), true, 'listing', '77770000-0000-4000-8000-000000000001', 50)),
  0, 'a support agent reads no action, because the key is action.read and they do not hold it');
select is(
  (select count(*)::int from app_private.moderation_actions_for_subject(
     'f7000000-0000-4000-8000-000000000008', true, 'listing', '77770000-0000-4000-8000-000000000001', 50)),
  0, 'and the seller whose listing it is reads none through this path');
select ok(
  (select bool_and(a.is_own_action) from app_private.moderation_actions_for_subject(
     pg_temp.mod_one(), true, 'listing', '77770000-0000-4000-8000-000000000001', 50) a),
  'a moderator is told which actions were their own');
select ok(
  (select bool_and(not a.is_own_action) from app_private.moderation_actions_for_subject(
     pg_temp.mod_two(), true, 'listing', '77770000-0000-4000-8000-000000000001', 50) a),
  'and a colleague only that they were not theirs');
select is(
  (select count(*)::int from app_private.moderation_actions_for_subject(
     pg_temp.mod_one(), true, 'listing', 'c7000000-0000-4000-8000-00000000dead', 50)),
  0, 'a subject with no actions reads none');
select is(
  (select count(*)::int from app_private.moderation_actions_for_subject(
     pg_temp.mod_one(), true, 'seller', '77770000-0000-4000-8000-000000000001', 50)),
  0, 'and the subject type is part of the match, so a listing id is not a seller');

select is(
  (select count(*)::int from app_private.listing_moderation_history(
     pg_temp.mod_one(), true, '77770000-0000-4000-8000-000000000001', 50)),
  1, 'the listing trail holds the same one');
select is(
  (select h.to_status from app_private.listing_moderation_history(
     pg_temp.mod_one(), true, '77770000-0000-4000-8000-000000000006', 50) h),
  'active', 'and carries the status move, which is what this table is for');
select is(
  (select count(*)::int from app_private.listing_moderation_history(
     pg_temp.agent(), true, '77770000-0000-4000-8000-000000000001', 50)),
  0, 'a support agent reads none of it');
select is(
  (select count(*)::int from app_private.listing_moderation_history(
     pg_temp.mod_one(), false, '77770000-0000-4000-8000-000000000001', 50)),
  0, 'and a moderator at aal1 reads none of it');

-- 11. The listing queue and one listing ---------------------------------------------------------------
select is(
  (select count(*)::int from app_private.moderation_listing_queue(pg_temp.mod_one(), true, 50)),
  1, 'the queue holds the listings still awaiting review');
select is(
  (select q.slug from app_private.moderation_listing_queue(pg_temp.mod_one(), true, 50) q),
  'waiting-three', 'and it is the one nothing has been decided about');
select is(
  (select count(*)::int from app_private.moderation_listing_queue(pg_temp.agent(), true, 50)),
  0, 'a support agent reads no queue');
select is(
  (select count(*)::int from app_private.moderation_listing_queue(pg_temp.mod_one(), false, 50)),
  0, 'and a moderator at aal1 reads none');

select is(
  (select d.outcome from app_private.moderation_listing_for_staff(
     pg_temp.mod_one(), true, '77770000-0000-4000-8000-000000000005')d),
  'found', 'a moderator reads one listing');
select is(
  (select d.status from app_private.moderation_listing_for_staff(
     pg_temp.mod_one(), true, '77770000-0000-4000-8000-000000000005')d),
  'suspended', 'with its current status');
select is(
  (select d.seller_slug from app_private.moderation_listing_for_staff(
     pg_temp.mod_one(), true, '77770000-0000-4000-8000-000000000005')d),
  'n-shop', 'and its storefront''s public slug');
select ok(
  (select d.can_moderate from app_private.moderation_listing_for_staff(
     pg_temp.mod_one(), true, '77770000-0000-4000-8000-000000000005')d),
  'and whether this caller may act, answered by the database');
select ok(
  (select d.is_own_listing from app_private.moderation_listing_for_staff(
     pg_temp.mod_one(), true, '77770000-0000-4000-8000-000000000007')d),
  'and whether it is their own, which the writer would refuse');
select is(
  (select d.outcome from app_private.moderation_listing_for_staff(
     pg_temp.agent(), true, '77770000-0000-4000-8000-000000000005')d),
  'not_found', 'a support agent reads no listing here');
select is(
  (select d.outcome from app_private.moderation_listing_for_staff(
     pg_temp.mod_one(), false, '77770000-0000-4000-8000-000000000005')d),
  'not_found', 'nor a moderator at aal1');
select is(
  (select d.outcome from app_private.moderation_listing_for_staff(
     pg_temp.mod_one(), true, 'c7000000-0000-4000-8000-00000000dead')d),
  'not_found', 'and a listing that does not exist is the same answer');

select is(
  (select count(*)::int from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     join unnest(p.proargnames, p.proargmodes) as a(attname, mode) on true
    where n.nspname = 'app_private' and p.proname = 'moderation_listing_for_staff' and a.mode = 't'
      and a.attname = any (array['seller_user_id', 'object_path', 'bucket_id'])),
  0, 'the listing detail names no seller account and no storage location');

-- 12. A report's own action count, once actions exist -------------------------------------------------
select is(
  (select count(*)::int from app_private.moderation_report_queue(pg_temp.mod_one(), true, 50, 'open')),
  1, 'one report is still open');
select is(pg_temp.moderate(pg_temp.mod_one(), true, '77770000-0000-4000-8000-000000000005', 'reinstate',
  'A canary reason.', pg_temp.report_of('listing', '77770000-0000-4000-8000-000000000005')),
  'moderated', 'a decision can cite the report that prompted it');
select is(
  (select q.action_count from app_private.moderation_report_queue(pg_temp.mod_one(), true, 50) q
    where q.id = pg_temp.report_of('listing', '77770000-0000-4000-8000-000000000005')),
  1, 'and the report then shows one action citing it');
select is(
  (select count(*)::int from app_private.moderation_actions_for_subject(
     pg_temp.mod_one(), true, 'listing', '77770000-0000-4000-8000-000000000005', 50) a
    where a.report_id = pg_temp.report_of('listing', '77770000-0000-4000-8000-000000000005')),
  1, 'and the action carries the report it cites');
select is(
  (select count(*)::int from app_private.moderation_actions_for_report(
     pg_temp.mod_one(), true, pg_temp.report_of('listing', '77770000-0000-4000-8000-000000000005'), 50)),
  1, 'and the report reader finds it from the other side');
select is(
  (select count(*)::int from app_private.moderation_actions_for_report(
     pg_temp.agent(), true, pg_temp.report_of('listing', '77770000-0000-4000-8000-000000000005'), 50)),
  0, 'which a support agent may not read either');
select is(
  (select count(*)::int from app_private.moderation_actions_for_report(
     pg_temp.mod_one(), false, pg_temp.report_of('listing', '77770000-0000-4000-8000-000000000005'), 50)),
  0, 'nor a moderator at aal1');
select is(
  (select count(*)::int from app_private.moderation_actions_for_report(
     pg_temp.mod_one(), true, 'c7000000-0000-4000-8000-00000000dead', 50)),
  0, 'and a report nothing cites reads none');

-- 13. 7-M is untouched --------------------------------------------------------------------------------
select is(
  (select string_agg(a.attname, ',' order by a.attname)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     join unnest(p.proargnames, p.proargmodes) as a(attname, mode) on true
    where n.nspname = 'app_private' and p.proname = 'reports_for_reporter' and a.mode = 't'),
  'created_at,details,id,reason_code,status,subject_label,subject_slug,subject_type',
  'the reporter''s own reader still returns exactly its eight columns');
select ok(
  (select count(*) > 0 from app_private.reports_for_reporter(pg_temp.reporter(), 50)),
  'and still answers for the reporter');
select is(
  (select count(*)::int from app_private.reports_for_reporter(pg_temp.reporter(), 50) r
    where r.id = pg_temp.own_report()),
  0, 'and never another reporter''s row, including a moderator''s');
select is(
  (select r.status from app_private.reports_for_reporter(pg_temp.reporter(), 50) r
    where r.subject_type = 'seller'),
  'duplicate', 'a reporter reads the status a moderator set, in 0027''s own vocabulary');
select ok(
  (select count(*) = 0 from app_private.reports_for_reporter(pg_temp.reporter(), 50) r
    where coalesce(r.details, '') like '%canary reason%'
       or coalesce(r.subject_label, '') like '%canary reason%'),
  'and never the moderator''s resolution note');

select has_function('app_private', 'report_file_for_reporter', array['uuid', 'text', 'text', 'text', 'text'],
  '7-M''s filing wrapper is unchanged');
select ok(
  (select count(*) = 0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'moderation\_%'
      and p.prosrc like '%report_file_for_reporter%'),
  'and nothing in this migration calls it');

-- The reporter can reach neither writer, whatever they hold.
select is(pg_temp.resolve(pg_temp.reporter(), true, pg_temp.own_report(), 'dismissed'),
  'not_found', 'a reporter resolves no report');
select is(pg_temp.moderate(pg_temp.reporter(), true, '77770000-0000-4000-8000-000000000003', 'approve'),
  'not_found', 'and moderates no listing');

select * from finish();
rollback;
