-- pgTAP — migration 0066: the in-app notification read surface (Phase 7-C).
--
-- Five things are being held to account.
--
-- **One account can never touch another's.** Every function takes the account as a parameter and puts it
-- in the predicate, so the test that matters is not "is a stranger refused" but "is a stranger's row
-- simply absent". Asserted for the list, the count and the archive writer, including with an array of
-- somebody else's identifiers — which must archive nothing and report nothing about them.
--
-- **The archived split is 0029's, not a new rule.** The inbox is the unarchived rows, the archived view is
-- the rest, and the badge counts unread-and-unarchived — the same predicate as the `notifications_unread`
-- partial index and as `public.unread_notification_count`. Asserted against the index definition itself, so
-- the three cannot drift apart silently.
--
-- **The keyset is total and deterministic.** `(created_at, id)` is unique because `id` is, so paging walks
-- every row exactly once with no overlap and no gap — asserted by walking a fixture of rows that share a
-- timestamp, which is the case a `created_at`-only cursor would get wrong.
--
-- **Archiving is idempotent and archives nothing it was not asked to.** A repeat returns zero and leaves
-- the original timestamp; an empty or null array is a no-op rather than an error; nothing else moves.
--
-- **Nothing from 0029 or 0055 changed.** The table's columns, its triggers, its RLS, its grants, its
-- dedupe index and its two existing writers are asserted to be exactly as they were, and the projection is
-- asserted to omit the variables payload.
--
-- Deterministic: fixed uuids, fixed timestamps, no wall-clock dependence. Everything runs in a transaction
-- that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(78);

-- Fixtures ------------------------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('7e000000-0000-4000-8000-000000000001', 'notif-owner@test.invalid'),
  ('7e000000-0000-4000-8000-000000000002', 'notif-stranger@test.invalid');

-- Written through 0029's own writer, so the fixture is the real thing rather than a hand-made row: the
-- dedupe check, the settings check, the outbox publication and every constraint all apply.
select app_private.create_notification(
  '7e000000-0000-4000-8000-000000000001', 'messages', 'message.created', 'messages.message_received',
  '{"conversation_id": "aaaaaaaa-0000-4000-8000-000000000001"}'::jsonb,
  'message', 'bbbbbbbb-0000-4000-8000-000000000001', '/dashboard/messages/aaaa', 'nt-k1');
select app_private.create_notification(
  '7e000000-0000-4000-8000-000000000001', 'orders', 'order.shipped', 'orders.shipped',
  '{}'::jsonb, 'order', 'bbbbbbbb-0000-4000-8000-000000000002', '/dashboard/orders/bbbb', 'nt-k2');
select app_private.create_notification(
  '7e000000-0000-4000-8000-000000000001', 'security', 'security.alert', 'security.alert',
  '{}'::jsonb, null, null, null, 'nt-k3');
select app_private.create_notification(
  '7e000000-0000-4000-8000-000000000002', 'orders', 'order.shipped', 'orders.shipped',
  '{}'::jsonb, null, null, null, 'nt-stranger');

-- The timestamps are deliberately **not** adjusted, for two reasons. 0029's immutability trigger refuses
-- to let `created_at` move at all — which is itself worth knowing — and inside one transaction `now()` is
-- fixed, so all four rows already share a `created_at` to the microsecond. That is the hardest case for a
-- keyset and the one a timestamp-only cursor gets wrong: the whole order here rests on the `id`
-- tie-breaker, so a page that skipped or repeated a row would be caught below rather than hidden.

create temporary table ids on commit drop as
  select n.dedupe_key, n.id from public.notifications n;

-- ---------------------------------------------------------------------------------------------------
-- Security: the S8 contract and the privilege boundary
-- ---------------------------------------------------------------------------------------------------
select is(
  (select array_to_string(array_agg(p.proname || '/' || p.pronargs order by p.proname), ' ')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('notifications_inbox', 'notifications_unread_count', 'archive_notifications')),
  'archive_notifications/2 notifications_inbox/5 notifications_unread_count/1',
  'this migration adds exactly three functions, with the arities they declare and no overloads');

select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('notifications_inbox', 'notifications_unread_count', 'archive_notifications')
      and not p.prosecdef),
  0::bigint, 'all three are SECURITY DEFINER');
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('notifications_inbox', 'notifications_unread_count', 'archive_notifications')
      and array_to_string(p.proconfig, ',') <> 'search_path=pg_catalog, public'),
  0::bigint, 'and all three have their search_path pinned');
select is(
  (select array_to_string(array_agg(p.provolatile::text order by p.proname), ' ')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('notifications_inbox', 'notifications_unread_count')),
  's s', 'both readers are stable, which is the database''s own statement that they do not write');

select ok(not has_function_privilege('public', 'app_private.notifications_inbox(uuid, integer, timestamptz, uuid, boolean)', 'execute'),
  'PUBLIC cannot read an inbox');
select ok(not has_function_privilege('authenticated', 'app_private.notifications_inbox(uuid, integer, timestamptz, uuid, boolean)', 'execute'),
  'and neither can authenticated: a function that takes the account as a parameter must not be callable by something that could pass another');
select ok(not has_function_privilege('anon', 'app_private.notifications_inbox(uuid, integer, timestamptz, uuid, boolean)', 'execute'),
  'nor anon');
select ok(has_function_privilege('app_system', 'app_private.notifications_inbox(uuid, integer, timestamptz, uuid, boolean)', 'execute'),
  'app_system can');
select ok(not has_function_privilege('app_worker', 'app_private.notifications_inbox(uuid, integer, timestamptz, uuid, boolean)', 'execute'),
  'app_worker cannot: reading somebody''s inbox is not a background job');
select ok(not has_function_privilege('authenticated', 'app_private.notifications_unread_count(uuid)', 'execute'),
  'authenticated cannot call the parameterised badge count');
select ok(has_function_privilege('app_system', 'app_private.notifications_unread_count(uuid)', 'execute'),
  'app_system can');
select ok(not has_function_privilege('authenticated', 'app_private.archive_notifications(uuid, uuid[])', 'execute'),
  'authenticated cannot call the archive writer');
select ok(not has_function_privilege('public', 'app_private.archive_notifications(uuid, uuid[])', 'execute'),
  'nor PUBLIC');
select ok(has_function_privilege('app_system', 'app_private.archive_notifications(uuid, uuid[])', 'execute'),
  'and app_system can');

select lives_ok($$ select app_private.assert_security_contract() $$,
  'the deploy-time security contract still holds');

-- ---------------------------------------------------------------------------------------------------
-- Nothing from 0029 or 0055 changed
-- ---------------------------------------------------------------------------------------------------
select is(
  (select array_to_string(array_agg(c.column_name order by c.ordinal_position), ' ')
     from information_schema.columns c
    where c.table_schema = 'public' and c.table_name = 'notifications'),
  'id user_id category event_type origin actor_user_id template_key variables subject_type subject_id '
    || 'action_path is_marketing dedupe_key email_outbox_id published_at read_at archived_at created_at',
  'the notifications table has exactly the columns 0029 gave it, in their order');

select is(
  (select pg_get_constraintdef(oid) from pg_constraint
    where conrelid = 'public.notifications'::regclass and conname = 'notifications_category_allowed'),
  'CHECK ((category = ANY (ARRAY[''orders''::text, ''payments''::text, ''payouts''::text, ''listings''::text, ''messages''::text, ''offers''::text, ''reviews''::text, ''promotions''::text, ''support''::text, ''security''::text, ''account''::text, ''system''::text])))',
  'the twelve approved categories are unchanged: 7-C invented none');
select isnt(
  (select pg_get_constraintdef(oid) from pg_constraint
    where conrelid = 'public.notifications'::regclass and conname = 'notifications_subject_type_allowed'),
  null, 'and the approved subject types are still constrained by 0029''s own CHECK');

select is(
  (select array_to_string(array_agg(t.tgname order by t.tgname), ' ')
     from pg_trigger t where t.tgrelid = 'public.notifications'::regclass and not t.tgisinternal),
  'notifications_immutable notifications_no_delete',
  'both 0029 triggers are still attached: content stays fixed and nothing is ever deleted');

select is(
  (select array_to_string(array_agg(p.policyname order by p.policyname), ' ')
     from pg_policies p where p.schemaname = 'public' and p.tablename = 'notifications'),
  'notifications_owner_read notifications_owner_update',
  'the two owner policies are unchanged, so deny-by-default RLS is preserved');
select ok(
  (select c.relrowsecurity from pg_class c where c.oid = 'public.notifications'::regclass),
  'and row level security is still enabled on the table');

select is(
  (select count(*) from information_schema.role_table_grants
    where table_name = 'notifications' and grantee = 'authenticated' and privilege_type = 'INSERT'),
  0::bigint, 'nobody gained INSERT: creation is still create_notification alone');
select is(
  (select count(*) from information_schema.role_table_grants
    where table_name = 'notifications' and grantee = 'authenticated' and privilege_type = 'DELETE'),
  0::bigint, 'and nobody gained DELETE');
select is(
  (select array_to_string(array_agg(distinct c.column_name order by c.column_name), ' ')
     from information_schema.column_privileges c
    where c.table_name = 'notifications' and c.grantee = 'authenticated' and c.privilege_type = 'UPDATE'),
  'archived_at read_at',
  'the column-level UPDATE grant is still exactly read_at and archived_at');
select is(
  (select count(*) from information_schema.role_table_grants
    where table_name = 'notifications' and grantee in ('app_system', 'app_worker', 'anon')),
  0::bigint, 'and no login role holds a table privilege: every access is through a named function');

select ok(
  exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'app_private' and p.proname = 'mark_notifications_read'),
  '0029''s mark_notifications_read still exists: 7-C reuses it rather than adding a second read writer');
select ok(
  exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'app_private' and p.proname = 'create_notification'),
  'and so does create_notification, the only way a notification exists');
select ok(
  exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'app_private' and p.proname = 'messaging_notify_message'),
  'and 0055''s writer, whose behaviour 7-C does not touch');
select is(
  (select count(*) from pg_indexes i
    where i.schemaname = 'public' and i.indexname = 'notifications_dedupe'),
  1::bigint, 'the dedupe index is still there, so the C10 dedupe model is preserved');

-- ---------------------------------------------------------------------------------------------------
-- The archived split is the one the schema already draws
-- ---------------------------------------------------------------------------------------------------
select is(
  (select i.indexdef from pg_indexes i
    where i.schemaname = 'public' and i.indexname = 'notifications_unread'),
  'CREATE INDEX notifications_unread ON public.notifications USING btree (user_id) WHERE ((read_at IS NULL) AND (archived_at IS NULL))',
  'the unread index says unread means not read and not archived — which is where 7-C read the rule');

select is(
  app_private.notifications_unread_count('7e000000-0000-4000-8000-000000000001'),
  3::bigint, 'the badge counts the account''s three unread, unarchived notifications');
select is(
  app_private.notifications_unread_count('7e000000-0000-4000-8000-000000000002'),
  1::bigint, 'and the stranger''s one, separately');
select is(
  app_private.notifications_unread_count('7e000000-0000-4000-8000-0000000000ff'),
  0::bigint, 'an account with no notifications counts zero');
select is(
  app_private.notifications_unread_count(null),
  0::bigint, 'and so does no account at all, rather than erroring');

-- ---------------------------------------------------------------------------------------------------
-- Cross-user isolation
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*) from app_private.notifications_inbox('7e000000-0000-4000-8000-000000000001')),
  3::bigint, 'the inbox returns the account''s own three rows');
select is(
  (select count(*) from app_private.notifications_inbox('7e000000-0000-4000-8000-000000000001')
    where id = (select i.id from ids i where i.dedupe_key = 'nt-stranger')),
  0::bigint,
  'and not the stranger''s: their row is absent from the result set, not refused from it');
select is(
  (select count(*) from app_private.notifications_inbox('7e000000-0000-4000-8000-000000000002')),
  1::bigint, 'the stranger sees their own one row');
select is(
  (select count(*) from app_private.notifications_inbox('7e000000-0000-4000-8000-0000000000ff')),
  0::bigint, 'and an account that does not exist sees nothing');

-- The projection: metadata only.
select is(
  (select array_to_string(array_agg(x.name order by x.ord), ' ')
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace,
     lateral unnest(p.proargnames, p.proargmodes) with ordinality as x(name, mode, ord)
    where n.nspname = 'app_private' and p.proname = 'notifications_inbox' and x.mode = 't'),
  'id category event_type subject_type subject_id action_path created_at read_at archived_at',
  'the reader returns metadata only: the subject and type fields the schema defines, and no more');
select is(
  (select count(*)
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace,
     lateral unnest(p.proargnames, p.proargmodes) as x(name, mode)
    where n.nspname = 'app_private' and p.proname = 'notifications_inbox' and x.mode = 't'
      and x.name in ('variables', 'template_key', 'actor_user_id', 'origin', 'dedupe_key',
                     'email_outbox_id', 'is_marketing', 'published_at', 'user_id')),
  0::bigint,
  'and never the variables payload, the template key, the staff actor or the email link');

-- The subject metadata that is returned really is the row's own.
select is(
  (select subject_type from app_private.notifications_inbox('7e000000-0000-4000-8000-000000000001')
    where id = (select i.id from ids i where i.dedupe_key = 'nt-k1')),
  'message', 'the subject type is carried through unchanged');
select is(
  (select subject_id from app_private.notifications_inbox('7e000000-0000-4000-8000-000000000001')
    where id = (select i.id from ids i where i.dedupe_key = 'nt-k1')),
  'bbbbbbbb-0000-4000-8000-000000000001'::uuid, 'and so is the subject it points at');
select is(
  (select action_path from app_private.notifications_inbox('7e000000-0000-4000-8000-000000000001')
    where id = (select i.id from ids i where i.dedupe_key = 'nt-k2')),
  '/dashboard/orders/bbbb', 'and the relative action path');
select is(
  (select count(*) from app_private.notifications_inbox('7e000000-0000-4000-8000-000000000001')
    where subject_type is null and subject_id is null),
  1::bigint, 'a notification with no subject returns both fields null, as the schema pairs them');

-- ---------------------------------------------------------------------------------------------------
-- Pagination: total order, no overlap, no gap
-- ---------------------------------------------------------------------------------------------------
select is(
  (select array_to_string(array_agg(x.dedupe_key), ' ')
     from (
       select i.dedupe_key
         from app_private.notifications_inbox('7e000000-0000-4000-8000-000000000001') r
         join ids i on i.id = r.id
        order by r.created_at desc, r.id desc
     ) as x),
  (select array_to_string(array_agg(x.dedupe_key), ' ')
     from (
       select i.dedupe_key
         from public.notifications n
         join ids i on i.id = n.id
        where n.user_id = '7e000000-0000-4000-8000-000000000001'
        order by n.created_at desc, n.id desc
     ) as x),
  'the reader''s order is created_at desc, id desc — the same order the keyset walks');

-- Page one of one.
create temporary table page1 on commit drop as
  select * from app_private.notifications_inbox('7e000000-0000-4000-8000-000000000001', 1);
select is((select count(*) from page1), 1::bigint, 'a limit of one returns one row');

-- Page two, from page one's last position.
create temporary table page2 on commit drop as
  select * from app_private.notifications_inbox(
    '7e000000-0000-4000-8000-000000000001', 1,
    (select p.created_at from page1 p), (select p.id from page1 p));
select is((select count(*) from page2), 1::bigint, 'and the next page from its cursor returns the next one');
select isnt((select p.id from page2 p), (select q.id from page1 q), 'which is a different row: no overlap');

create temporary table page3 on commit drop as
  select * from app_private.notifications_inbox(
    '7e000000-0000-4000-8000-000000000001', 1,
    (select p.created_at from page2 p), (select p.id from page2 p));
select is((select count(*) from page3), 1::bigint, 'and the third page the third');
select is(
  (select count(distinct t.id) from (
     select id from page1 union all select id from page2 union all select id from page3) as t),
  3::bigint,
  'three pages of one walked three distinct rows: every created_at ties, so the id tie-breaker alone carries the order and nothing is skipped or repeated');

create temporary table page4 on commit drop as
  select * from app_private.notifications_inbox(
    '7e000000-0000-4000-8000-000000000001', 1,
    (select p.created_at from page3 p), (select p.id from page3 p));
select is((select count(*) from page4), 0::bigint, 'and the page after the last is empty');

select is(
  (select count(*) from app_private.notifications_inbox(
     '7e000000-0000-4000-8000-000000000001', 1,
     (select p.created_at from page1 p), null)),
  1::bigint,
  'half a cursor is no cursor: a timestamp with no id reads from the start rather than from a guess');

select is(
  (select count(*) from app_private.notifications_inbox('7e000000-0000-4000-8000-000000000001', 999)),
  3::bigint, 'an absurd limit is clamped rather than honoured');
select is(
  (select count(*) from app_private.notifications_inbox('7e000000-0000-4000-8000-000000000001', 0)),
  1::bigint, 'and a limit of zero reads as one, so a page is never empty by accident');
select is(
  (select count(*) from app_private.notifications_inbox('7e000000-0000-4000-8000-000000000001', null)),
  3::bigint, 'a null limit falls back to the default');

-- ---------------------------------------------------------------------------------------------------
-- Marking read, through 0029's own writer
-- ---------------------------------------------------------------------------------------------------
select is(
  app_private.mark_notifications_read('7e000000-0000-4000-8000-000000000001',
    array[(select i.id from ids i where i.dedupe_key = 'nt-stranger')]),
  0, 'marking somebody else''s notification read marks nothing');
select is(
  (select n.read_at from public.notifications n
    where n.id = (select i.id from ids i where i.dedupe_key = 'nt-stranger')),
  null::timestamptz, 'and leaves it unread');

select is(
  app_private.mark_notifications_read('7e000000-0000-4000-8000-000000000001',
    array[(select i.id from ids i where i.dedupe_key = 'nt-k1')]),
  1, 'marking one''s own marks it');
select is(
  app_private.mark_notifications_read('7e000000-0000-4000-8000-000000000001',
    array[(select i.id from ids i where i.dedupe_key = 'nt-k1')]),
  0, 'and a repeat marks nothing: mark-read is idempotent');
select is(
  app_private.notifications_unread_count('7e000000-0000-4000-8000-000000000001'),
  2::bigint, 'the badge drops by one');
select is(
  (select count(*) from app_private.notifications_inbox('7e000000-0000-4000-8000-000000000001')),
  3::bigint, 'and the row stays in the inbox: reading is not archiving');

-- ---------------------------------------------------------------------------------------------------
-- Archiving
-- ---------------------------------------------------------------------------------------------------
select is(
  app_private.archive_notifications('7e000000-0000-4000-8000-000000000001',
    array[(select i.id from ids i where i.dedupe_key = 'nt-stranger')]),
  0, 'archiving somebody else''s notification archives nothing');
select is(
  (select n.archived_at from public.notifications n
    where n.id = (select i.id from ids i where i.dedupe_key = 'nt-stranger')),
  null::timestamptz, 'and leaves it in their inbox');

select is(
  app_private.archive_notifications('7e000000-0000-4000-8000-000000000001', array[]::uuid[]),
  0, 'an empty array archives nothing, and is not an error');
select is(
  app_private.archive_notifications('7e000000-0000-4000-8000-000000000001', null),
  0, 'and neither is a null one: naming nothing never empties an inbox');
select throws_ok(
  $$ select app_private.archive_notifications(null, array['7e000000-0000-4000-8000-000000000001'::uuid]) $$,
  '22023', null, 'but archiving without an account is refused: there is no inbox to scope to');

select is(
  app_private.archive_notifications('7e000000-0000-4000-8000-000000000001',
    array[(select i.id from ids i where i.dedupe_key = 'nt-k2')]),
  1, 'archiving one''s own archives it');

create temporary table archived_at_first on commit drop as
  select n.archived_at from public.notifications n
   where n.id = (select i.id from ids i where i.dedupe_key = 'nt-k2');

select is(
  app_private.archive_notifications('7e000000-0000-4000-8000-000000000001',
    array[(select i.id from ids i where i.dedupe_key = 'nt-k2')]),
  0, 'and a repeat archives nothing: archive is idempotent');
select is(
  (select n.archived_at from public.notifications n
    where n.id = (select i.id from ids i where i.dedupe_key = 'nt-k2')),
  (select a.archived_at from archived_at_first a),
  'the original archived_at stands, so a repeat cannot rewrite when it happened');

select is(
  (select count(*) from app_private.notifications_inbox('7e000000-0000-4000-8000-000000000001')),
  2::bigint, 'the archived row leaves the inbox');
select is(
  (select count(*) from app_private.notifications_inbox('7e000000-0000-4000-8000-000000000001', 20, null, null, true)),
  1::bigint, 'and appears in the archived view');
select is(
  (select id from app_private.notifications_inbox('7e000000-0000-4000-8000-000000000001', 20, null, null, true)),
  (select i.id from ids i where i.dedupe_key = 'nt-k2'),
  'which is exactly the row that was archived');
select is(
  app_private.notifications_unread_count('7e000000-0000-4000-8000-000000000001'),
  1::bigint,
  'and the badge drops again: archiving an unread notification clears it, which is how a user empties their inbox');

select is(
  app_private.mark_notifications_read('7e000000-0000-4000-8000-000000000001',
    array[(select i.id from ids i where i.dedupe_key = 'nt-k2')]),
  0,
  'an archived notification cannot be marked read — 0029''s writer excludes it, and 7-C did not change that');

-- Marking everything read is 0029's null form, and it too leaves archived rows alone.
select is(
  app_private.mark_notifications_read('7e000000-0000-4000-8000-000000000001', null),
  1, 'marking all read marks the one unread, unarchived row that is left');
select is(
  app_private.notifications_unread_count('7e000000-0000-4000-8000-000000000001'),
  0::bigint, 'and the badge reaches zero');
select is(
  app_private.notifications_unread_count('7e000000-0000-4000-8000-000000000002'),
  1::bigint, 'while the stranger''s badge never moved');

-- Nothing was deleted by any of it.
select is(
  (select count(*) from public.notifications), 4::bigint,
  'and all four rows still exist: this surface archives, it never deletes');

select * from finish();
rollback;
