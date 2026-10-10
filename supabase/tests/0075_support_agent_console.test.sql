-- pgTAP — migration 0075: the support agent console.
--
-- Nine things are being held to account.
--
-- **The support schema is untouched.** Five tables, their columns, their seven policies, their five
-- triggers and the permission catalogue are all asserted to be exactly what 0028, 0031 and 0033 left, so
-- this increment is provably additive: functions and nothing else. No permission was created.
--
-- **Authorization is 0033's two keys and 0003's own rule.** Every reader and every writer is driven at
-- `aal2` and at `aal1`, as a support agent, an admin, a super admin, a moderator, a buyer, a seller, a
-- revoked agent and an expired agent. The permission keys appear as literals in exactly two predicates,
-- and no function reads a JWT — `has_permission()` and `is_aal2()` appear in none of them, because
-- `app_system` carries no claims.
--
-- **Queue membership is `assigned_to` and nothing else.** An unassigned ticket is in the shared queue; the
-- moment one agent claims it, it leaves the queue **and becomes invisible to every other agent** — read,
-- conversation, notes, attachment and all four writes. That is 0028's own policy predicate, driven from
-- both sides.
--
-- **The transitions are 0028's writers', not this migration's.** Claiming moves `open` to `pending_agent`
-- and nothing else; a reply moves the ticket to `pending_requester` and stamps the first response; a reply
-- on a resolved ticket moves nothing; `resolved` and `closed` are the only statuses this surface can pass,
-- a resolved ticket may still be closed, and a closed one refuses everything.
--
-- **An unassigned ticket cannot be worked on.** All three writers that call
-- `can_access_support_ticket` are proven to refuse a queued ticket, which is why claiming exists.
--
-- **Releasing is the writer's null branch.** It returns a ticket to the queue, changes no status, and only
-- the agent who holds it can do it.
--
-- **Internal notes are staff-only, still.** They are written and read here, and the requester's own 0074
-- readers are driven again on the same ticket to prove none of them returns a note, a note count, an
-- assignee or an agent identifier.
--
-- **No other agent's identity is disclosed.** No result type on this surface carries `assigned_to`,
-- `author_user_id` or `membership_version`, asserted on the result types themselves.
--
-- **No new event and no notification.** The event trail is 0028's triggers' and writers'; no function here
-- writes an event, enqueues an outbox message or creates a notification, and none reads
-- `support_ticket_events` at all.
--
-- Deterministic: fixed uuids, and every ordering assertion ages its rows explicitly rather than relying on
-- `now()`, which is transaction-stable. Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(180);

-- ---------------------------------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('d5000000-0000-4000-8000-00000000000a', 'sl-requester-a@test.invalid'),
  ('d5000000-0000-4000-8000-00000000000b', 'sl-requester-b@test.invalid'),
  ('d5000000-0000-4000-8000-0000000000d1', 'sl-agent-one@test.invalid'),
  ('d5000000-0000-4000-8000-0000000000d2', 'sl-agent-two@test.invalid'),
  ('d5000000-0000-4000-8000-0000000000d3', 'sl-admin@test.invalid'),
  ('d5000000-0000-4000-8000-0000000000d4', 'sl-super@test.invalid'),
  ('d5000000-0000-4000-8000-0000000000d5', 'sl-moderator@test.invalid'),
  ('d5000000-0000-4000-8000-0000000000d6', 'sl-revoked-agent@test.invalid'),
  ('d5000000-0000-4000-8000-0000000000d7', 'sl-expired-agent@test.invalid'),
  ('d5000000-0000-4000-8000-0000000000d8', 'sl-seller@test.invalid');

insert into public.profiles (id, display_name) values
  ('d5000000-0000-4000-8000-00000000000a', 'Requester A'),
  ('d5000000-0000-4000-8000-00000000000b', 'Requester B')
on conflict (id) do update set display_name = excluded.display_name;

-- `granted_at` is explicit and in the past: `user_roles_expiry_after_grant` compares the two.
insert into public.user_roles (user_id, role_key, granted_at) values
  ('d5000000-0000-4000-8000-0000000000d1', 'support_agent', now() - interval '1 day'),
  ('d5000000-0000-4000-8000-0000000000d2', 'support_agent', now() - interval '1 day'),
  ('d5000000-0000-4000-8000-0000000000d3', 'admin', now() - interval '1 day'),
  ('d5000000-0000-4000-8000-0000000000d4', 'super_admin', now() - interval '1 day'),
  ('d5000000-0000-4000-8000-0000000000d5', 'moderator', now() - interval '1 day'),
  ('d5000000-0000-4000-8000-0000000000d8', 'seller', now() - interval '1 day');

insert into public.user_roles (user_id, role_key, granted_at, revoked_at) values
  ('d5000000-0000-4000-8000-0000000000d6', 'support_agent', now() - interval '2 days', now() - interval '1 hour');
insert into public.user_roles (user_id, role_key, granted_at, expires_at) values
  ('d5000000-0000-4000-8000-0000000000d7', 'support_agent', now() - interval '2 days', now() - interval '1 hour');

-- Shorthands -----------------------------------------------------------------------------------------
create or replace function pg_temp.agent_one() returns uuid
language sql immutable as $$ select 'd5000000-0000-4000-8000-0000000000d1'::uuid; $$;
create or replace function pg_temp.agent_two() returns uuid
language sql immutable as $$ select 'd5000000-0000-4000-8000-0000000000d2'::uuid; $$;
create or replace function pg_temp.requester() returns uuid
language sql immutable as $$ select 'd5000000-0000-4000-8000-00000000000a'::uuid; $$;

create or replace function pg_temp.ticket_status(p_id uuid) returns text
language sql as $$ select t.status from public.support_tickets t where t.id = p_id; $$;

create or replace function pg_temp.open_ticket(p_user uuid, p_subject text) returns uuid
language sql as $$
  select ticket_id from app_private.support_ticket_open_for_requester(
    p_user, p_subject, 'payouts', 'A body long enough to be a real sentence.');
$$;

/** The thirteen function names, in one place, so the privilege and source assertions cannot drift. */
create or replace function pg_temp.surface() returns text[]
language sql immutable as $$
  select array[
    'support_staff_can_read',
    'support_staff_can_manage',
    'support_queue_for_agent',
    'support_tickets_assigned_to_agent',
    'support_ticket_for_agent',
    'support_ticket_messages_for_agent',
    'support_ticket_notes_for_agent',
    'support_attachment_for_agent',
    'support_ticket_claim_for_agent',
    'support_ticket_release_for_agent',
    'support_message_post_for_agent',
    'support_note_add_for_agent',
    'support_ticket_close_for_agent'
  ]::text[];
$$;

-- ---------------------------------------------------------------------------------------------------
-- 1. The support schema is exactly what 0028 left
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::int from information_schema.tables
    where table_schema = 'public' and table_name like 'support\_%'),
  5, 'there are still exactly five support tables');

select is((select count(*)::int from information_schema.columns
            where table_schema = 'public' and table_name = 'support_tickets'), 18,
  'support_tickets still has eighteen columns: no column was added for the console');
select is((select count(*)::int from information_schema.columns
            where table_schema = 'public' and table_name = 'support_internal_notes'), 5,
  'support_internal_notes still has five');
select is((select count(*)::int from information_schema.columns
            where table_schema = 'public' and table_name = 'support_ticket_events'), 7,
  'support_ticket_events still has seven');

select is(
  (select string_agg(p.polname, ',' order by p.polname) from pg_policy p
    where p.polrelid in (
      'public.support_tickets'::regclass, 'public.support_messages'::regclass,
      'public.support_attachments'::regclass, 'public.support_internal_notes'::regclass,
      'public.support_ticket_events'::regclass)),
  'support_attachments_read,support_internal_notes_staff_read,support_messages_read,'
    || 'support_ticket_events_read,support_tickets_agent_read,support_tickets_agent_update,'
    || 'support_tickets_requester_read',
  'and 0028''s seven policies across the five tables, unaltered and with nothing added');

select is(
  (select count(*)::int from pg_trigger t
    where t.tgrelid = 'public.support_tickets'::regclass and not t.tgisinternal),
  5, 'support_tickets still carries 0028''s five triggers');

-- Narrowed for the reason given in 0074's suite: the claim is "this console adds no permission", and the
-- support module's own key set says that without depending on how many keys the rest of the platform has.
select set_eq(
  $$select key from public.permissions where module = 'support'$$,
  $$values ('support.ticket.manage'), ('support.ticket.read')$$,
  'the support module still holds 0028''s two keys: the console adds no permission');
select is(
  (select string_agg(key, ',' order by key) from public.permissions where module = 'support'),
  'support.ticket.manage,support.ticket.read',
  'and support still has exactly its two keys');
select is(
  (select string_agg(distinct role_key, ',' order by role_key) from public.role_permissions
    where permission_key like 'support.ticket.%'),
  'admin,super_admin,support_agent',
  'held by exactly the three roles 0033 grants them to, unchanged');
select ok(
  (select bool_and(r.requires_mfa) from public.roles r
    where r.key in ('admin', 'super_admin', 'support_agent')),
  'all three require mfa, so none of them holds anything at aal1');

-- ---------------------------------------------------------------------------------------------------
-- 2. The thirteen functions, and who may execute them
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = any (pg_temp.surface())),
  13, '0075 defines exactly thirteen functions');

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = any (pg_temp.surface())
      and (not p.prosecdef
           or not exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) cfg
                           where cfg = 'search_path=pg_catalog, public'))),
  0, 'every one of them is SECURITY DEFINER with the pinned search_path');

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = any (pg_temp.surface())
      and (has_function_privilege('public', p.oid, 'execute')
           or has_function_privilege('authenticated', p.oid, 'execute')
           or has_function_privilege('anon', p.oid, 'execute')
           or has_function_privilege('app_worker', p.oid, 'execute'))),
  0, 'neither PUBLIC, anon, authenticated nor app_worker may execute any of them');

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = any (pg_temp.surface())
      and has_function_privilege('app_system', p.oid, 'execute')),
  13, 'app_system may execute all thirteen');

-- 0028's own five writers are untouched, and 0074's nine requester functions still exist.
select has_function('app_private', 'assign_support_ticket', array['uuid', 'uuid'],
  '0028''s assign_support_ticket is unchanged');
select has_function('app_private', 'close_support_ticket', array['uuid', 'text', 'uuid'],
  'and close_support_ticket');
select has_function('app_private', 'add_support_internal_note', array['uuid', 'uuid', 'text'],
  'and add_support_internal_note');
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like '%\_for\_requester'),
  9, 'and 0074''s nine requester functions are all still there');

-- ---------------------------------------------------------------------------------------------------
-- 3. What the console's functions never mention, and never return
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = any (pg_temp.surface())
      and pg_get_function_result(p.oid) ~ '\massigned_to\M'),
  0, 'no result type returns assigned_to: who else holds a ticket is not disclosed');

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = any (pg_temp.surface())
      and pg_get_function_result(p.oid) ~ '\mauthor_user_id\M'),
  0, 'and none returns an author account identifier');

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = any (pg_temp.surface())
      and pg_get_function_result(p.oid) ~ '\mmembership_version\M'),
  0, 'and none returns the Realtime membership version');

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = any (pg_temp.surface())
      and p.prosrc ~ '\msupport_ticket_events\M'),
  0, 'no function reads or writes the event trail: its assignment rows carry account identifiers');

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = any (pg_temp.surface())
      and (p.prosrc ~ '\mhas_permission\M' or p.prosrc ~ '\mis_aal2\M'
           or p.prosrc ~ '\mcurrent_user_id\M')),
  0, 'and none reads a JWT: app_system carries no claims, so the account and the level are parameters');

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = any (pg_temp.surface())
      and (p.prosrc ~* 'insert into public\.support_'
           or p.prosrc ~ '\menqueue_outbox_event\M'
           or p.prosrc ~ '\mcreate_notification\M')),
  0, 'nothing here inserts into a support table, enqueues an event or creates a notification');

-- The permission keys are literals, in exactly the two predicates.
select is(
  (select string_agg(p.proname, ',' order by p.proname) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = any (pg_temp.surface())
      and p.prosrc like '%support.ticket.read%'),
  'support_staff_can_read', 'the read key is a literal in exactly one function');
select is(
  (select string_agg(p.proname, ',' order by p.proname) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = any (pg_temp.surface())
      and p.prosrc like '%support.ticket.manage%'),
  'support_staff_can_manage', 'and the manage key in exactly one');
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = any (pg_temp.surface())
      and pg_get_function_arguments(p.oid) ~ '\mp_permission\M'),
  0, 'and no function takes a permission as a parameter');

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = any (pg_temp.surface())
      and pg_get_function_arguments(p.oid) ~ '\mp_role\M'),
  0, 'and no function takes a role name: nothing here authorizes by role');

-- Only one function returns an object path, and it is the one the API signs from.
select is(
  (select string_agg(p.proname, ',' order by p.proname) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = any (pg_temp.surface())
      and pg_get_function_result(p.oid) ~ '\mobject_path\M'),
  'support_attachment_for_agent', 'only the attachment reader returns an object path');

-- The closing wrapper is the only one with a status parameter, and its two values are literals.
select is(
  (select string_agg(p.proname, ',' order by p.proname) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = any (pg_temp.surface())
      and pg_get_function_arguments(p.oid) ~ '\mp_status\M'),
  'support_ticket_close_for_agent', 'exactly one function takes a status');
select ok(
  (select p.prosrc like '%''resolved'', ''closed''%' from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'support_ticket_close_for_agent'),
  'and it admits only the writer''s own two values, as literals');

-- ---------------------------------------------------------------------------------------------------
-- 4. The two predicates, against every kind of caller
-- ---------------------------------------------------------------------------------------------------
select ok(app_private.support_staff_can_read(pg_temp.agent_one(), true),
  'a support agent at aal2 holds the read key');
select ok(app_private.support_staff_can_manage(pg_temp.agent_one(), true), 'and the manage key');
select ok(not app_private.support_staff_can_read(pg_temp.agent_one(), false),
  'the same agent at aal1 holds neither — 0003''s requires_mfa rule');
select ok(not app_private.support_staff_can_manage(pg_temp.agent_one(), false), 'nor manage at aal1');
select ok(not app_private.support_staff_can_read(pg_temp.agent_one(), null),
  'and an unknown assurance level is not a strong one');

select ok(app_private.support_staff_can_read('d5000000-0000-4000-8000-0000000000d3', true),
  'an admin holds the read key');
select ok(app_private.support_staff_can_manage('d5000000-0000-4000-8000-0000000000d3', true),
  'and manage');
select ok(app_private.support_staff_can_read('d5000000-0000-4000-8000-0000000000d4', true),
  'a super admin holds the read key');
select ok(not app_private.support_staff_can_read('d5000000-0000-4000-8000-0000000000d5', true),
  'a moderator holds neither, at any level');
select ok(not app_private.support_staff_can_manage('d5000000-0000-4000-8000-0000000000d5', true),
  'nor manage');
select ok(not app_private.support_staff_can_read('d5000000-0000-4000-8000-0000000000d8', true),
  'a seller holds neither');
select ok(not app_private.support_staff_can_read(pg_temp.requester(), true),
  'and neither does a requester with no role at all');
select ok(not app_private.support_staff_can_read('d5000000-0000-4000-8000-0000000000d6', true),
  'a revoked agent holds nothing');
select ok(not app_private.support_staff_can_read('d5000000-0000-4000-8000-0000000000d7', true),
  'and an expired grant holds nothing');
select ok(not app_private.support_staff_can_read(null, true), 'and no account holds nothing');

-- ---------------------------------------------------------------------------------------------------
-- 5. The shared queue
-- ---------------------------------------------------------------------------------------------------
create temporary table sl_queue as
  select pg_temp.open_ticket(pg_temp.requester(), 'Oldest queued') as oldest,
         pg_temp.open_ticket(pg_temp.requester(), 'Middle queued') as middle,
         pg_temp.open_ticket('d5000000-0000-4000-8000-00000000000b', 'Newest queued') as newest;

update public.support_tickets set created_at = now() - interval '3 days'
  where id = (select oldest from sl_queue);
update public.support_tickets set created_at = now() - interval '2 days'
  where id = (select middle from sl_queue);
update public.support_tickets set created_at = now() - interval '1 day'
  where id = (select newest from sl_queue);

select is(
  (select count(*)::int from app_private.support_queue_for_agent(pg_temp.agent_one(), true, 51)),
  3, 'all three unassigned tickets are in the shared queue');

select is(
  (select string_agg(q.subject, ',') from (
     select subject from app_private.support_queue_for_agent(pg_temp.agent_one(), true, 51)) q),
  'Oldest queued,Middle queued,Newest queued',
  'the queue is oldest first — the only deterministic order the schema supports');

select is(
  (select count(*)::int from app_private.support_queue_for_agent(pg_temp.agent_one(), true, 2)),
  2, 'the limit is honoured');

select is(
  (select subject from app_private.support_queue_for_agent(
     pg_temp.agent_one(), true, 1, now() - interval '2 days', (select middle from sl_queue))),
  'Newest queued', 'and a cursor continues strictly after the row it names, never repeating it');

select is(
  (select count(*)::int from app_private.support_queue_for_agent(pg_temp.agent_one(), true, 500)),
  3, 'a page size beyond the clamp returns only what the queue has');

select is(
  (select count(*)::int from app_private.support_queue_for_agent(pg_temp.agent_one(), false, 51)),
  0, 'the queue is empty at aal1');
select is(
  (select count(*)::int from app_private.support_queue_for_agent('d5000000-0000-4000-8000-0000000000d5', true, 51)),
  0, 'and empty for a moderator');
select is(
  (select count(*)::int from app_private.support_queue_for_agent(pg_temp.requester(), true, 51)),
  0, 'and empty for the requester who raised the tickets');
select is(
  (select count(*)::int from app_private.support_queue_for_agent(null, true, 51)),
  0, 'and empty for no account');

select is(
  (select requester_name from app_private.support_queue_for_agent(pg_temp.agent_one(), true, 51) q
    where q.subject = 'Oldest queued'),
  'Requester A', 'a queue row names the requester by display name');
select is(
  (select priority from app_private.support_queue_for_agent(pg_temp.agent_one(), true, 51) q
    where q.subject = 'Oldest queued'),
  'normal', 'and carries the priority 0028 defaults it to, as a fact rather than an ordering');

-- A ticket in a status the queue index does not cover is not in the queue, even unassigned.
update public.support_tickets set status = 'pending_requester' where id = (select newest from sl_queue);
select is(
  (select count(*)::int from app_private.support_queue_for_agent(pg_temp.agent_one(), true, 51)),
  2, 'an unassigned ticket outside open|pending_agent is not in the queue');
update public.support_tickets set status = 'pending_agent' where id = (select newest from sl_queue);

-- ---------------------------------------------------------------------------------------------------
-- 6. Claiming, and what it does to everybody else
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.support_ticket_claim_for_agent(
     pg_temp.agent_one(), true, (select oldest from sl_queue))),
  'assigned', 'an agent claims a queued ticket');
select is(pg_temp.ticket_status((select oldest from sl_queue)), 'pending_agent',
  'and the writer''s own case leaves it at pending_agent');
select is(
  (select is_mine from app_private.support_ticket_for_agent(
     pg_temp.agent_one(), true, (select oldest from sl_queue))),
  true, 'the ticket is now theirs');

select is(
  (select count(*)::int from app_private.support_queue_for_agent(pg_temp.agent_one(), true, 51)),
  2, 'a claimed ticket leaves the shared queue');
select is(
  (select count(*)::int from app_private.support_tickets_assigned_to_agent(pg_temp.agent_one(), true, 51)),
  1, 'and appears in the claiming agent''s own list');
select is(
  (select count(*)::int from app_private.support_tickets_assigned_to_agent(pg_temp.agent_two(), true, 51)),
  0, 'and in nobody else''s');

-- Every surface, from the other agent's side. All of them are the same neutral answer.
select is(
  (select outcome from app_private.support_ticket_for_agent(
     pg_temp.agent_two(), true, (select oldest from sl_queue))),
  'not_found', 'another agent cannot read a claimed ticket');
select is(
  (select count(*)::int from app_private.support_ticket_messages_for_agent(
     pg_temp.agent_two(), true, (select oldest from sl_queue))),
  0, 'nor its conversation');
select is(
  (select count(*)::int from app_private.support_ticket_notes_for_agent(
     pg_temp.agent_two(), true, (select oldest from sl_queue))),
  0, 'nor its internal notes');
select is(
  (select outcome from app_private.support_ticket_claim_for_agent(
     pg_temp.agent_two(), true, (select oldest from sl_queue))),
  'not_found', 'nor claim it away');
select is(
  (select outcome from app_private.support_ticket_release_for_agent(
     pg_temp.agent_two(), true, (select oldest from sl_queue))),
  'not_found', 'nor release it');
select is(
  (select outcome from app_private.support_message_post_for_agent(
     pg_temp.agent_two(), true, (select oldest from sl_queue), 'Let me in')),
  'not_found', 'nor reply on it');
select is(
  (select outcome from app_private.support_note_add_for_agent(
     pg_temp.agent_two(), true, (select oldest from sl_queue), 'A note of mine')),
  'not_found', 'nor write a note on it');
select is(
  (select outcome from app_private.support_ticket_close_for_agent(
     pg_temp.agent_two(), true, (select oldest from sl_queue), 'closed')),
  'not_found', 'nor close it');
select is(
  (select count(*)::int from public.support_internal_notes n
    where n.author_user_id = pg_temp.agent_two()),
  0, 'and none of those attempts wrote anything');

-- Claiming again by the same agent is 0028's own C10 no-op rather than a second write.
select is(
  (select outcome from app_private.support_ticket_claim_for_agent(
     pg_temp.agent_one(), true, (select oldest from sl_queue))),
  'assigned', 'the same agent claiming again is accepted');
select is(
  (select count(*)::int from public.support_ticket_events e
    where e.support_ticket_id = (select oldest from sl_queue) and e.event_type = 'assigned'),
  1, 'and records exactly one assignment event, not two');

select is(
  (select outcome from app_private.support_ticket_claim_for_agent(
     pg_temp.agent_one(), false, (select middle from sl_queue))),
  'not_found', 'claiming at aal1 is refused');
select is(
  (select outcome from app_private.support_ticket_claim_for_agent(
     'd5000000-0000-4000-8000-0000000000d5', true, (select middle from sl_queue))),
  'not_found', 'and by a moderator');
select is(
  (select outcome from app_private.support_ticket_claim_for_agent(
     pg_temp.requester(), true, (select middle from sl_queue))),
  'not_found', 'and by the requester');
select ok(
  (select assigned_to is null from public.support_tickets t where t.id = (select middle from sl_queue)),
  'and the ticket is still unassigned after all three');

select is(
  (select outcome from app_private.support_ticket_claim_for_agent(
     pg_temp.agent_one(), true, '11111111-1111-4111-8111-111111111111')),
  'not_found', 'a ticket that does not exist is the same answer');

-- ---------------------------------------------------------------------------------------------------
-- 7. An unassigned ticket cannot be worked on
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.support_message_post_for_agent(
     pg_temp.agent_one(), true, (select middle from sl_queue), 'Replying to a queued ticket')),
  'not_found', 'a queued ticket cannot be replied to: 0028''s can_access rule, so claiming comes first');
select is(
  (select outcome from app_private.support_note_add_for_agent(
     pg_temp.agent_one(), true, (select middle from sl_queue), 'A note on a queued ticket')),
  'not_found', 'nor can a note be written on it');
select is(
  (select outcome from app_private.support_ticket_close_for_agent(
     pg_temp.agent_one(), true, (select middle from sl_queue), 'resolved')),
  'not_found', 'nor can it be resolved');
select is(
  (select outcome from app_private.support_ticket_release_for_agent(
     pg_temp.agent_one(), true, (select middle from sl_queue))),
  'not_found', 'and releasing something nobody holds is refused rather than silently accepted');
select is(
  (select message_count from public.support_tickets t where t.id = (select middle from sl_queue)),
  1, 'the queued ticket still has only its own first message');

-- But it is readable, because it is in the queue.
select is(
  (select outcome from app_private.support_ticket_for_agent(
     pg_temp.agent_one(), true, (select middle from sl_queue))),
  'found', 'a queued ticket is readable by any agent');
select is(
  (select is_assigned from app_private.support_ticket_for_agent(
     pg_temp.agent_one(), true, (select middle from sl_queue))),
  false, 'and says it is held by nobody');
select is(
  (select count(*)::int from app_private.support_ticket_messages_for_agent(
     pg_temp.agent_one(), true, (select middle from sl_queue))),
  1, 'and its conversation is readable too');

-- ---------------------------------------------------------------------------------------------------
-- 8. Releasing
-- ---------------------------------------------------------------------------------------------------
create temporary table sl_release as
  select pg_temp.open_ticket(pg_temp.requester(), 'To be released') as id;

select is(
  (select outcome from app_private.support_ticket_claim_for_agent(
     pg_temp.agent_one(), true, (select id from sl_release))),
  'assigned', 'an agent claims a ticket');
select is(
  (select outcome from app_private.support_ticket_release_for_agent(
     pg_temp.agent_one(), true, (select id from sl_release))),
  'released', 'and can release it again');
select ok(
  (select assigned_to is null and assigned_at is null from public.support_tickets t
    where t.id = (select id from sl_release)),
  'which clears the assignee and its stamp');
select is(pg_temp.ticket_status((select id from sl_release)), 'pending_agent',
  'and changes no status: the writer''s null branch moves the assignee alone');
select is(
  (select count(*)::int from app_private.support_queue_for_agent(pg_temp.agent_one(), true, 51) q
    where q.id = (select id from sl_release)),
  1, 'so the ticket is back in the shared queue');
select is(
  (select count(*)::int from public.support_ticket_events e
    where e.support_ticket_id = (select id from sl_release) and e.event_type = 'unassigned'),
  1, 'and 0028''s unassigned event was written once');
select is(
  (select outcome from app_private.support_ticket_release_for_agent(
     pg_temp.agent_one(), false, (select id from sl_release))),
  'not_found', 'releasing at aal1 is refused');

-- ---------------------------------------------------------------------------------------------------
-- 9. Replying
-- ---------------------------------------------------------------------------------------------------
create temporary table sl_work as
  select pg_temp.open_ticket(pg_temp.requester(), 'The worked ticket') as id;

select ok(
  (select outcome from app_private.support_ticket_claim_for_agent(
     pg_temp.agent_one(), true, (select id from sl_work))) = 'assigned',
  'an agent claims the ticket they are about to work');

select is(
  (select outcome from app_private.support_message_post_for_agent(
     pg_temp.agent_one(), true, (select id from sl_work), 'Could you confirm the address?')),
  'posted', 'and replies on it');
select is(pg_temp.ticket_status((select id from sl_work)), 'pending_requester',
  'which leaves the ticket waiting on the requester — the writer''s own case');
select ok(
  (select first_response_at is not null from public.support_tickets t where t.id = (select id from sl_work)),
  'and stamps the first response, which the writer does and this surface does not');

create temporary table sl_agent_message as
  select * from app_private.support_message_post_for_agent(
    pg_temp.agent_one(), true, (select id from sl_work), 'One more thing.');

select is(
  (select author_role from public.support_messages m where m.id = (select message_id from sl_agent_message)),
  'agent', 'the author role is the writer''s, worked out from the ticket rather than passed in');
select is((select status from sl_agent_message), 'pending_requester',
  'and the status is read back rather than assumed');

select is(
  (select outcome from app_private.support_message_post_for_agent(
     pg_temp.agent_one(), true, (select id from sl_work), '   ')),
  'invalid', 'an empty body is refused');
select is(
  (select outcome from app_private.support_message_post_for_agent(
     pg_temp.agent_one(), true, (select id from sl_work), repeat('z', 8001))),
  'invalid', 'and one beyond 8000 characters');
select is(
  (select outcome from app_private.support_message_post_for_agent(
     pg_temp.agent_one(), false, (select id from sl_work), 'At aal1')),
  'not_found', 'and a reply at aal1');

-- The requester answers, which moves it back. Both sides are the same two writers.
select is(
  (select status from app_private.support_message_post_for_requester(
     pg_temp.requester(), (select id from sl_work), 'Yes, that is the address.')),
  'pending_agent', 'the requester''s reply moves it back to pending_agent');

-- ---------------------------------------------------------------------------------------------------
-- 10. Internal notes
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.support_note_add_for_agent(
     pg_temp.agent_one(), true, (select id from sl_work), 'Two failed payout attempts on file.')),
  'added', 'the assigned agent writes an internal note');
select is(
  (select note_count from app_private.support_note_add_for_agent(
     pg_temp.agent_one(), true, (select id from sl_work), 'A second note.')),
  2, 'and the count comes back from the table');

select is(
  (select count(*)::int from app_private.support_ticket_notes_for_agent(
     pg_temp.agent_one(), true, (select id from sl_work), 51)),
  2, 'both notes are readable by that agent');
select is(
  (select bool_and(is_own_note)::text from app_private.support_ticket_notes_for_agent(
     pg_temp.agent_one(), true, (select id from sl_work), 51)),
  'true', 'each says it is the caller''s own');
select is(
  (select count(*)::int from app_private.support_ticket_notes_for_agent(
     pg_temp.agent_one(), false, (select id from sl_work), 51)),
  0, 'and none is readable at aal1');
select is(
  (select count(*)::int from app_private.support_ticket_notes_for_agent(
     'd5000000-0000-4000-8000-0000000000d5', true, (select id from sl_work), 51)),
  0, 'nor by a moderator');
select is(
  (select count(*)::int from app_private.support_ticket_notes_for_agent(
     pg_temp.requester(), true, (select id from sl_work), 51)),
  0, 'nor by the requester whose ticket it is');

select is(
  (select outcome from app_private.support_note_add_for_agent(
     pg_temp.agent_one(), true, (select id from sl_work), '  ')),
  'invalid', 'an empty note is refused');
select is(
  (select outcome from app_private.support_note_add_for_agent(
     pg_temp.agent_one(), true, (select id from sl_work), repeat('n', 8001))),
  'invalid', 'and one beyond 8000 characters');
select is(
  (select outcome from app_private.support_note_add_for_agent(
     pg_temp.agent_one(), false, (select id from sl_work), 'At aal1')),
  'not_found', 'and a note at aal1');
select is(
  (select count(*)::int from public.support_ticket_events e
    where e.support_ticket_id = (select id from sl_work) and e.event_type = 'note_added'),
  2, '0028''s note_added event was written once per note, by the writer');

-- The regression that matters most: none of 0074's requester readers can see any of this.
select is(
  (select message_count from app_private.support_ticket_for_requester(
     pg_temp.requester(), (select id from sl_work))),
  4, 'the requester''s own ticket reader counts messages and no notes');
select ok(
  (select count(*) = 0 from app_private.support_ticket_messages_for_requester(
     pg_temp.requester(), (select id from sl_work), 51) m
    where m.body like '%failed payout attempts%' or m.body like '%second note%'),
  'and no note text appears anywhere in what the requester can read');
select is(
  (select count(*)::int from app_private.support_ticket_messages_for_requester(
     pg_temp.requester(), (select id from sl_work), 51)),
  4, 'the requester''s conversation is its four messages and nothing else');
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like '%\_for\_requester'
      and p.prosrc ~ '\msupport_internal_notes\M'),
  0, 'and no requester function mentions the notes table at all');
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like '%\_for\_requester'
      and (pg_get_function_result(p.oid) ~ '\massigned_to\M'
           or pg_get_function_result(p.oid) ~ '\mis_mine\M'
           or pg_get_function_result(p.oid) ~ '\mpriority\M')),
  0, 'and no requester function returns an assignee, a holder or the platform''s triage');

-- ---------------------------------------------------------------------------------------------------
-- 11. The conversation, from the agent's side
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::int from app_private.support_ticket_messages_for_agent(
     pg_temp.agent_one(), true, (select id from sl_work), 51)),
  4, 'the agent sees the same four messages');
select is(
  (select string_agg(m.author_role, ',' order by m.author_role) from (
     select author_role from app_private.support_ticket_messages_for_agent(
       pg_temp.agent_one(), true, (select id from sl_work), 51)) m),
  'agent,agent,requester,requester', 'two from each side');
select is(
  (select count(*) filter (where m.is_own_message)::int from (
     select is_own_message from app_private.support_ticket_messages_for_agent(
       pg_temp.agent_one(), true, (select id from sl_work), 51)) m),
  2, 'and the agent''s own two are marked as theirs — the opposite of the requester''s view');
select is(
  (select count(*) filter (where m.is_own_message)::int from (
     select is_own_message from app_private.support_ticket_messages_for_requester(
       pg_temp.requester(), (select id from sl_work), 51)) m),
  2, 'while the requester''s own two are marked as theirs on their own reader');

-- Paging, over messages inserted with explicit times: support_messages refuses UPDATE.
insert into public.support_messages (support_ticket_id, author_user_id, author_role, body, created_at)
values
  ((select id from sl_work), pg_temp.agent_one(), 'agent', 'The fifth message', now() + interval '1 minute'),
  ((select id from sl_work), pg_temp.agent_one(), 'agent', 'The sixth message', now() + interval '2 minutes');

select is(
  (select string_agg(m.body, ',') from (
     select body from app_private.support_ticket_messages_for_agent(
       pg_temp.agent_one(), true, (select id from sl_work), 2)) m),
  'The fifth message,The sixth message',
  'a first page of two is the newest two, returned in reading order');
select is(
  (select count(*)::int from app_private.support_ticket_messages_for_agent(
     pg_temp.agent_one(), true, (select id from sl_work), 2,
     now() + interval '1 minute',
     (select id from public.support_messages where body = 'The fifth message'))),
  2, 'and the page before it holds two more');
select is(
  (select count(*)::int from app_private.support_ticket_messages_for_agent(
     pg_temp.agent_one(), false, (select id from sl_work), 51)),
  0, 'the conversation is empty at aal1');
select is(
  (select count(*)::int from app_private.support_ticket_messages_for_agent(
     pg_temp.agent_one(), true, '11111111-1111-4111-8111-111111111111', 51)),
  0, 'and for a ticket that does not exist');

-- ---------------------------------------------------------------------------------------------------
-- 12. Attachments
-- ---------------------------------------------------------------------------------------------------
create temporary table sl_file as
  select m.id as message_id,
         (select target.object_path
            from app_private.support_attachment_target_for_requester(
              pg_temp.requester(), (select id from sl_work), m.id, 'image/png', 4096) target) as path
    from public.support_messages m
   where m.support_ticket_id = (select id from sl_work)
     and m.author_role = 'requester'
   order by m.created_at, m.id
   limit 1;

select ok(
  (select outcome from app_private.support_attachment_attach_for_requester(
     pg_temp.requester(), (select id from sl_work), (select message_id from sl_file),
     (select path from sl_file), 'evidence.png', 'image/png', 4096)) = 'attached',
  'the requester attaches a file to their own message');

create temporary table sl_attachment as
  select a.id from public.support_attachments a
   where a.support_message_id = (select message_id from sl_file);

select is(
  (select outcome from app_private.support_attachment_for_agent(
     pg_temp.agent_one(), true, (select id from sl_work), (select id from sl_attachment))),
  'authorized', 'the assigned agent may read it back');
select is(
  (select object_path from app_private.support_attachment_for_agent(
     pg_temp.agent_one(), true, (select id from sl_work), (select id from sl_attachment))),
  (select path from sl_file), 'and the path returned is the one that was recorded');
select is(
  (select bucket_id from app_private.support_attachment_for_agent(
     pg_temp.agent_one(), true, (select id from sl_work), (select id from sl_attachment))),
  'support-attachments', 'from 0012''s private bucket');
select ok(
  (select not public from storage.buckets b where b.id = 'support-attachments'),
  'which is still private: the console does not change that');

select is(
  (select outcome from app_private.support_attachment_for_agent(
     pg_temp.agent_two(), true, (select id from sl_work), (select id from sl_attachment))),
  'not_found', 'an agent who does not hold the ticket may not');
select is(
  (select outcome from app_private.support_attachment_for_agent(
     pg_temp.agent_one(), false, (select id from sl_work), (select id from sl_attachment))),
  'not_found', 'nor the holder at aal1');
select is(
  (select outcome from app_private.support_attachment_for_agent(
     'd5000000-0000-4000-8000-0000000000d5', true, (select id from sl_work), (select id from sl_attachment))),
  'not_found', 'nor a moderator');
select is(
  (select outcome from app_private.support_attachment_for_agent(
     pg_temp.agent_one(), true, (select middle from sl_queue), (select id from sl_attachment))),
  'not_found', 'an attachment identifier cannot be spent against another ticket');
select is(
  (select outcome from app_private.support_attachment_for_agent(
     pg_temp.agent_one(), true, (select id from sl_work), '11111111-1111-4111-8111-111111111111')),
  'not_found', 'and one that does not exist is the same answer');
select ok(
  (select object_path is null and bucket_id is null from app_private.support_attachment_for_agent(
     pg_temp.agent_two(), true, (select id from sl_work), (select id from sl_attachment))),
  'a refusal carries no location at all');

select is(
  (select jsonb_array_length(m.attachments) from app_private.support_ticket_messages_for_agent(
     pg_temp.agent_one(), true, (select id from sl_work), 51) m
    where m.id = (select message_id from sl_file)),
  1, 'the agent''s conversation carries the file on the message it belongs to');
select ok(
  (select not (m.attachments -> 0 ? 'objectPath')
     from app_private.support_ticket_messages_for_agent(
       pg_temp.agent_one(), true, (select id from sl_work), 51) m
    where m.id = (select message_id from sl_file)),
  'and without its object path, which never crosses to a browser');
select is(
  (select attachment_count from app_private.support_tickets_assigned_to_agent(
     pg_temp.agent_one(), true, 51) l where l.id = (select id from sl_work)),
  1, 'and the agent''s own list counts it');

-- ---------------------------------------------------------------------------------------------------
-- 13. Resolving and closing
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.support_ticket_close_for_agent(
     pg_temp.agent_one(), true, (select id from sl_work), 'pending_agent')),
  'invalid', 'a status outside the writer''s two values is refused');
select is(
  (select outcome from app_private.support_ticket_close_for_agent(
     pg_temp.agent_one(), true, (select id from sl_work), 'open')),
  'invalid', 'and so is open');
select is(
  (select outcome from app_private.support_ticket_close_for_agent(
     pg_temp.agent_one(), true, (select id from sl_work), null)),
  'invalid', 'and no status at all');
select is(pg_temp.ticket_status((select id from sl_work)), 'pending_agent',
  'and none of them moved the ticket');

select is(
  (select outcome from app_private.support_ticket_close_for_agent(
     pg_temp.agent_one(), false, (select id from sl_work), 'resolved')),
  'not_found', 'resolving at aal1 is refused');

select is(
  (select status from app_private.support_ticket_close_for_agent(
     pg_temp.agent_one(), true, (select id from sl_work), 'resolved')),
  'resolved', 'the assigned agent resolves the ticket');
select ok(
  (select resolved_at is not null from public.support_tickets t where t.id = (select id from sl_work)),
  'with the resolution time recorded, which the table''s own constraint requires');
select ok(
  (select closed_at is null from public.support_tickets t where t.id = (select id from sl_work)),
  'and no closing time yet');
select is(
  (select outcome from app_private.support_ticket_close_for_agent(
     pg_temp.agent_one(), true, (select id from sl_work), 'resolved')),
  'conflict', 'resolving it again is a conflict rather than a second event');

-- A resolved ticket still takes a message, and moves nothing. The writer's own behaviour.
select is(
  (select outcome from app_private.support_message_post_for_agent(
     pg_temp.agent_one(), true, (select id from sl_work), 'One last note for you.')),
  'posted', 'an agent may still reply on a resolved ticket');
select is(pg_temp.ticket_status((select id from sl_work)), 'resolved',
  'and it stays resolved: post_support_message preserves it');
select is(
  (select outcome from app_private.support_message_post_for_requester(
     pg_temp.requester(), (select id from sl_work), 'It happened again.')),
  'posted', 'and so may the requester');
select is(pg_temp.ticket_status((select id from sl_work)), 'resolved',
  'which also moves nothing — the gap 7-K reported, unchanged here');

select is(
  (select status from app_private.support_ticket_close_for_agent(
     pg_temp.agent_one(), true, (select id from sl_work), 'closed')),
  'closed', 'a resolved ticket may then be closed');
select ok(
  (select closed_at is not null and resolved_at is not null from public.support_tickets t
    where t.id = (select id from sl_work)),
  'and carries both stamps, which is what the resolved-has-time constraint contemplates');

select is(
  (select outcome from app_private.support_ticket_close_for_agent(
     pg_temp.agent_one(), true, (select id from sl_work), 'closed')),
  'conflict', 'closing it again is a conflict');
select is(
  (select outcome from app_private.support_message_post_for_agent(
     pg_temp.agent_one(), true, (select id from sl_work), 'Too late')),
  'conflict', 'a closed ticket takes no further agent message');
select is(
  (select outcome from app_private.support_note_add_for_agent(
     pg_temp.agent_one(), true, (select id from sl_work), 'Too late for a note')),
  'conflict', 'nor a further note');
select is(
  (select outcome from app_private.support_message_post_for_requester(
     pg_temp.requester(), (select id from sl_work), 'Too late for me too')),
  'conflict', 'nor a requester message — 7-K''s behaviour, unchanged');
select is(
  (select outcome from app_private.support_ticket_claim_for_agent(
     pg_temp.agent_two(), true, (select id from sl_work))),
  'not_found', 'and a closed ticket somebody holds cannot be claimed away');

-- A closed ticket that is unassigned cannot be claimed either: there is nothing to do on it.
create temporary table sl_closed_queued as
  select pg_temp.open_ticket(pg_temp.requester(), 'Closed by its requester') as id;
select ok(
  (select outcome from app_private.support_ticket_close_for_requester(
     pg_temp.requester(), (select id from sl_closed_queued))) = 'closed',
  'a requester closes their own ticket while it is still unassigned');
select is(
  (select outcome from app_private.support_ticket_claim_for_agent(
     pg_temp.agent_one(), true, (select id from sl_closed_queued))),
  'conflict', 'and no agent can claim it afterwards');
select is(
  (select count(*)::int from app_private.support_queue_for_agent(pg_temp.agent_one(), true, 51) q
    where q.id = (select id from sl_closed_queued)),
  0, 'nor is it in the queue, because the queue is the two live statuses');

-- ---------------------------------------------------------------------------------------------------
-- 14. Requester closure is still `closed`, and there is still no reopen
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'support_ticket_close_for_requester'
      and pg_get_function_arguments(p.oid) = 'p_user_id uuid, p_ticket_id uuid'),
  1, 'the requester''s closure still takes no status');
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like '%\_for\_requester'
      and p.prosrc ~ '\mresolved\M'),
  0, 'and the word resolved still appears in no requester function');
select ok(
  (select closed_at is not null and resolved_at is null from public.support_tickets t
    where t.id = (select id from sl_closed_queued)),
  'a requester closure stamps closed_at and never resolved_at');
select is(
  (select count(*)::int from public.support_ticket_events e where e.event_type = 'reopened'),
  0, 'no reopened event exists anywhere: nothing in the repository writes one');
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.prosrc ~ '\mreopened\M'),
  0, 'and no function in app_private mentions it');

-- ---------------------------------------------------------------------------------------------------
-- 15. Events, audit and notifications
-- ---------------------------------------------------------------------------------------------------
select is((select count(*)::int from public.notifications), 0,
  'nothing on the console created a notification: the repository defines no support notification');
select is((select count(*)::int from public.email_outbox), 0,
  'and no email was queued: 7-D owns transport and the console adds none');

select is(
  (select string_agg(distinct e.event_type, ',' order by e.event_type) from public.support_ticket_events e),
  'assigned,created,message_posted,note_added,status_changed,unassigned',
  'the event trail is exactly the six types 0028''s own triggers and writers write');

select is(
  (select string_agg(distinct e.event_type, ',' order by e.event_type) from public.outbox_events e
    where e.aggregate_type = 'support_ticket'),
  'support_ticket.closed,support_ticket.membership_changed,support_ticket.message_posted,'
    || 'support_ticket.opened,support_ticket.resolved',
  'and the outbox events are 0028''s own five');

select ok(
  (select count(*) > 0 from audit.audit_logs a where a.table_name = 'support_tickets'),
  'ticket rows are audited by 0028''s trigger');
select ok(
  (select count(*) = 0 from audit.audit_logs a where a.table_name = 'support_internal_notes'),
  'and internal notes are not, exactly as 0031''s contract records');

select ok(
  (select actor_user_id is null from public.support_ticket_events e
    where e.support_ticket_id = (select id from sl_work) and e.event_type = 'status_changed'
    order by e.id desc limit 1),
  'a status change still records no actor — the existing behaviour, preserved rather than redesigned');
select ok(
  (select actor_user_id = pg_temp.agent_one() from public.support_ticket_events e
    where e.support_ticket_id = (select id from sl_work) and e.event_type = 'note_added'
    order by e.id desc limit 1),
  'while a note records its author, which is the writer''s own behaviour');
select ok(
  (select actor_user_id = pg_temp.agent_one() from public.support_ticket_events e
    where e.support_ticket_id = (select oldest from sl_queue) and e.event_type = 'assigned'),
  'and an assignment records the agent it names');

rollback;
