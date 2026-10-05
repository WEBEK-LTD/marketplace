-- pgTAP — migration 0074: support, the requester side.
--
-- Eight things are being held to account.
--
-- **The support schema is untouched.** Five tables, their columns, their seven policies, their five triggers
-- and the permission catalogue are all asserted to be exactly what 0028, 0031 and 0033 left, so this
-- increment is provably additive: functions and nothing else.
--
-- **The transitions are 0028's writers', not this migration's.** A new ticket is observed at
-- `pending_agent` because `open_support_ticket` posts the first message itself; a requester's reply moves
-- `pending_requester` to `pending_agent`; a reply on a `resolved` ticket is accepted and moves nothing; a
-- reply to a `closed` ticket is refused. Nothing here writes a status except through those writers, and the
-- closing wrapper is proven to carry `'closed'` as a literal with no status parameter at all.
--
-- **`resolved` is unreachable from this surface.** The closing wrapper has three arguments, none of them a
-- status, and the word `resolved` appears in none of the nine functions' bodies.
--
-- **Isolation is the statement's.** Buyer B cannot read, reply to, close, attach to or link an attachment
-- of Buyer A's ticket, and in every case the answer is the neutral one — the same answer a ticket that does
-- not exist produces.
--
-- **Internal notes never come back.** A note is written on the ticket by the assigned agent and then every
-- requester reader is driven again: `support_internal_notes` appears in no function's source, and no reader
-- returns its body, its author or a count of it.
--
-- **Nothing agent-only comes back either.** No reader's result type carries `assigned_to`, `assigned_at`,
-- `priority`, `first_response_at`, `membership_version` or an author account identifier, asserted on the
-- result types themselves rather than on one sample row.
--
-- **Attachments are unforgeable.** The path is composed server-side; another ticket's message, an agent's
-- message, a foreign prefix, a traversal, a nested path, a wrong extension, a type the bucket forbids and a
-- size beyond the bucket's limit are each refused; the same path cannot be recorded twice; and reading one
-- back requires the attachment, its message's ticket and the ticket in the route to agree.
--
-- **No notification and no second audit trail.** No notification row is created by anything here, the only
-- outbox events are 0028's own three, and the event history is 0028's triggers' — including the fact,
-- reported rather than corrected, that a status change records no actor.
--
-- Deterministic: fixed uuids, and every ordering assertion ages its rows explicitly rather than relying on
-- `now()`, which is transaction-stable. Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(163);

-- ---------------------------------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('d4000000-0000-4000-8000-00000000000a', 'sk-requester-a@test.invalid'),
  ('d4000000-0000-4000-8000-00000000000b', 'sk-requester-b@test.invalid'),
  ('d4000000-0000-4000-8000-0000000000d1', 'sk-agent@test.invalid');

insert into public.profiles (id, display_name) values
  ('d4000000-0000-4000-8000-00000000000a', 'Requester A'),
  ('d4000000-0000-4000-8000-00000000000b', 'Requester B'),
  ('d4000000-0000-4000-8000-0000000000d1', 'Support Agent')
on conflict (id) do update set display_name = excluded.display_name;

-- Shorthands -----------------------------------------------------------------------------------------
create or replace function pg_temp.ticket_status(p_id uuid) returns text
language sql as $$ select t.status from public.support_tickets t where t.id = p_id; $$;

create or replace function pg_temp.open_for(p_user uuid, p_subject text) returns uuid
language sql as $$
  select ticket_id from app_private.support_ticket_open_for_requester(
    p_user, p_subject, 'account', 'A body long enough to be a real sentence.');
$$;

-- The nine function names, in one place, so the privilege and source assertions cannot drift from the
-- migration by naming a different set than the behaviour tests drive.
create or replace function pg_temp.surface() returns text[]
language sql immutable as $$
  select array[
    'support_tickets_for_requester',
    'support_ticket_for_requester',
    'support_ticket_messages_for_requester',
    'support_ticket_open_for_requester',
    'support_message_post_for_requester',
    'support_ticket_close_for_requester',
    'support_attachment_target_for_requester',
    'support_attachment_attach_for_requester',
    'support_attachment_for_requester'
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
  'support_tickets still has eighteen columns: no column was added for this surface');
select is((select count(*)::int from information_schema.columns
            where table_schema = 'public' and table_name = 'support_messages'), 6,
  'support_messages still has six');
select is((select count(*)::int from information_schema.columns
            where table_schema = 'public' and table_name = 'support_attachments'), 7,
  'support_attachments still has seven');
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

select is((select count(*)::int from public.permissions), 85,
  'the permission catalogue is unchanged: this surface adds no permission');
select is(
  (select count(*)::int from public.permissions where module = 'support'), 2,
  'and support still has exactly its two keys');

select ok(
  (select count(*) = 0 from public.site_settings where key like 'support%'),
  'and no support setting was seeded — no rate limit, no retention and no threshold is invented here');

-- ---------------------------------------------------------------------------------------------------
-- 2. The nine functions, and who may execute them
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = any (pg_temp.surface())),
  9, '0074 defines exactly nine functions');

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
  9, 'app_system may execute all nine');

-- 0028's own five writers are untouched, including the two this surface must never call.
select has_function('app_private', 'open_support_ticket',
  array['uuid', 'text', 'text', 'text', 'uuid', 'text'], '0028''s open_support_ticket is unchanged');
select has_function('app_private', 'post_support_message', array['uuid', 'uuid', 'text'],
  'and post_support_message');
select has_function('app_private', 'close_support_ticket', array['uuid', 'text', 'uuid'],
  'and close_support_ticket');
select has_function('app_private', 'assign_support_ticket', array['uuid', 'uuid'],
  'and assign_support_ticket, which belongs to the console');
select has_function('app_private', 'add_support_internal_note', array['uuid', 'uuid', 'text'],
  'and add_support_internal_note, which belongs to the console');

-- ---------------------------------------------------------------------------------------------------
-- 3. What the nine functions never mention, and never return
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = any (pg_temp.surface())
      and p.prosrc ~ '\msupport_internal_notes\M'),
  0, 'no function on this surface mentions support_internal_notes at all');

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = any (pg_temp.surface())
      and (p.prosrc ~ '\massigned_to\M' or p.prosrc ~ '\massigned_at\M'
           or p.prosrc ~ '\mmembership_version\M' or p.prosrc ~ '\mfirst_response_at\M')),
  0, 'and none mentions the assignment columns, the membership version or the first-response time');

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = any (pg_temp.surface())
      and pg_get_function_result(p.oid) ~ '\mpriority\M'),
  0, 'no result type carries priority: a requester neither sets nor reads the platform''s triage');

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = any (pg_temp.surface())
      and pg_get_function_result(p.oid) ~ '\mauthor_user_id\M'),
  0, 'and none returns an author account identifier');

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = any (pg_temp.surface())
      and pg_get_function_arguments(p.oid) ~ '\mpriority\M'),
  0, 'and no function takes a priority either, so 0028''s normal default always stands');

-- The object path travels in exactly two places: the target that issues it and the reader the API signs.
select is(
  (select string_agg(p.proname, ',' order by p.proname) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = any (pg_temp.surface())
      and pg_get_function_result(p.oid) ~ '\mobject_path\M'),
  'support_attachment_for_requester,support_attachment_target_for_requester',
  'only the upload target and the attachment reader return an object path');

-- The three wrappers write through 0028 and write nothing themselves.
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = any (pg_temp.surface())
      and p.prosrc ~* 'insert into public\.support_tickets'),
  0, 'nothing here inserts a ticket: open_support_ticket does');
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = any (pg_temp.surface())
      and p.prosrc ~* 'insert into public\.support_messages'),
  0, 'and nothing inserts a message: post_support_message does');
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = any (pg_temp.surface())
      and p.prosrc ~* 'insert into public\.support_ticket_events'),
  0, 'and nothing writes an event: 0028''s triggers and writers do');
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = any (pg_temp.surface())
      and (p.prosrc ~ '\menqueue_outbox_event\M' or p.prosrc ~ '\mcreate_notification\M')),
  0, 'and none enqueues an event or creates a notification of its own');

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'support_ticket_close_for_requester'
      and pg_get_function_arguments(p.oid) = 'p_user_id uuid, p_ticket_id uuid'),
  1, 'the closing wrapper takes a user and a ticket, and no status');

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = any (pg_temp.surface())
      and p.prosrc ~ '\mresolved\M'),
  0, 'and the word resolved appears in no function body: it is the agent outcome, not a requester''s');

select ok(
  (select p.prosrc like '%''closed''%' from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'support_ticket_close_for_requester'),
  'the status it passes is the literal closed');

-- ---------------------------------------------------------------------------------------------------
-- 4. Opening a ticket
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.support_ticket_open_for_requester(
     'd4000000-0000-4000-8000-00000000000a', 'My payout has not arrived', 'payouts',
     'It has been eight days since the payout was marked sent.')),
  'created', 'a signed-in requester can open a ticket');

create temporary table sk_first as
  select * from app_private.support_ticket_open_for_requester(
    'd4000000-0000-4000-8000-00000000000a', 'A question about my account', 'account',
    'I cannot change the email address on my account.');

select ok((select ticket_id is not null from sk_first), 'it returns the ticket it created');
select ok((select message_id is not null from sk_first), 'and the first message''s identifier');
select is((select status from sk_first), 'pending_agent',
  'and the ticket is observed at pending_agent: open_support_ticket posts the first message itself');
select matches((select reference from sk_first), '^SP-[0-9]{2}-[0-9]{6,}$',
  'and it carries D12''s support reference, generated by 0028''s trigger');

select is(
  (select message_count from public.support_tickets t where t.id = (select ticket_id from sk_first)),
  1, 'the ticket has exactly one message');
select is(
  (select author_role from public.support_messages m where m.id = (select message_id from sk_first)),
  'requester', 'which is a requester message, with the role decided by the writer from the ticket');
select is(
  (select priority from public.support_tickets t where t.id = (select ticket_id from sk_first)),
  'normal', 'and the priority is 0028''s default, because nothing passed one');
select ok(
  (select assigned_to is null and assigned_at is null from public.support_tickets t
    where t.id = (select ticket_id from sk_first)),
  'and no agent is assigned: a requester cannot assign, and nothing here does');
select ok(
  (select order_id is null from public.support_tickets t where t.id = (select ticket_id from sk_first)),
  'and no order is attached, because the wrapper exposes no order parameter');

-- Validation, each against the constraint that governs it.
select is(
  (select outcome from app_private.support_ticket_open_for_requester(
     'd4000000-0000-4000-8000-00000000000a', '', 'account', 'A body long enough to be a sentence.')),
  'invalid', 'an empty subject is refused');
select is(
  (select outcome from app_private.support_ticket_open_for_requester(
     'd4000000-0000-4000-8000-00000000000a', '   ', 'account', 'A body long enough to be a sentence.')),
  'invalid', 'and a subject of only spaces, because the constraint trims');
select is(
  (select outcome from app_private.support_ticket_open_for_requester(
     'd4000000-0000-4000-8000-00000000000a', repeat('x', 201), 'account',
     'A body long enough to be a sentence.')),
  'invalid', 'and a subject beyond 200 characters');
select is(
  (select outcome from app_private.support_ticket_open_for_requester(
     'd4000000-0000-4000-8000-00000000000a', 'A subject', 'account', '')),
  'invalid', 'an empty body is refused');
select is(
  (select outcome from app_private.support_ticket_open_for_requester(
     'd4000000-0000-4000-8000-00000000000a', 'A subject', 'account', repeat('y', 8001))),
  'invalid', 'and a body beyond 8000 characters');
select is(
  (select outcome from app_private.support_ticket_open_for_requester(
     'd4000000-0000-4000-8000-00000000000a', 'A subject', 'billing',
     'A body long enough to be a sentence.')),
  'invalid', 'a category outside 0028''s eight is refused: no ninth value is creatable here');
select is(
  (select outcome from app_private.support_ticket_open_for_requester(
     'd4000000-0000-4000-8000-00000000000a', 'A subject', null,
     'A body long enough to be a sentence.')),
  'invalid', 'and so is no category at all');
select is(
  (select outcome from app_private.support_ticket_open_for_requester(
     null, 'A subject', 'account', 'A body long enough to be a sentence.')),
  'invalid', 'and an unauthenticated caller creates nothing');

-- All eight categories are reachable, and exactly those eight.
select is(
  (select count(*)::int from unnest(array['account', 'orders', 'payments', 'payouts', 'listings',
                                          'verification', 'technical', 'other']) as c(k)
    where (select outcome from app_private.support_ticket_open_for_requester(
             'd4000000-0000-4000-8000-00000000000b', 'One per category', c.k,
             'A body long enough to be a sentence.')) = 'created'),
  8, 'every one of the eight existing categories can be used');

select is(
  (select count(*)::int from public.support_tickets t
    where t.requester_user_id = 'd4000000-0000-4000-8000-00000000000b'),
  8, 'and Requester B now holds exactly those eight tickets');

-- ---------------------------------------------------------------------------------------------------
-- 5. The ticket list
-- ---------------------------------------------------------------------------------------------------
-- Three tickets with distinct, explicit creation times, because now() does not move inside a transaction.
create temporary table sk_list as
  select pg_temp.open_for('d4000000-0000-4000-8000-00000000000a', 'Oldest of three') as oldest,
         pg_temp.open_for('d4000000-0000-4000-8000-00000000000a', 'Middle of three') as middle,
         pg_temp.open_for('d4000000-0000-4000-8000-00000000000a', 'Newest of three') as newest;

update public.support_tickets set created_at = now() - interval '3 days'
  where id = (select oldest from sk_list);
update public.support_tickets set created_at = now() - interval '2 days'
  where id = (select middle from sk_list);
update public.support_tickets set created_at = now() - interval '1 day'
  where id = (select newest from sk_list);

select is(
  (select string_agg(s.subject, ',') from (
     select subject from app_private.support_tickets_for_requester(
       'd4000000-0000-4000-8000-00000000000a', 3,
       now() - interval '12 hours', '00000000-0000-4000-8000-000000000000')) s),
  'Newest of three,Middle of three,Oldest of three',
  'the list is newest first');

select is(
  (select count(*)::int from app_private.support_tickets_for_requester(
     'd4000000-0000-4000-8000-00000000000a', 2,
     now() - interval '12 hours', '00000000-0000-4000-8000-000000000000')),
  2, 'the limit is honoured');

select is(
  (select subject from app_private.support_tickets_for_requester(
     'd4000000-0000-4000-8000-00000000000a', 1,
     now() - interval '2 days', (select middle from sk_list))),
  'Oldest of three', 'and a cursor continues strictly after the row it names, never repeating it');

-- Enough tickets to reach the clamp, inserted directly: the reader is what is under test, not the writer.
insert into public.support_tickets (requester_user_id, subject, category)
select 'd4000000-0000-4000-8000-00000000000b', format('Bulk ticket %s', g), 'other'
  from generate_series(1, 44) as g;

select is(
  (select count(*)::int from public.support_tickets t
    where t.requester_user_id = 'd4000000-0000-4000-8000-00000000000b'),
  52, 'Requester B now holds fifty-two tickets');

select is(
  (select count(*)::int from app_private.support_tickets_for_requester(
     'd4000000-0000-4000-8000-00000000000b', 500)),
  51, 'and a page is clamped at 51 however large a caller asks for');

select is(
  (select count(*)::int from app_private.support_tickets_for_requester(
     'd4000000-0000-4000-8000-00000000000b', 0)),
  1, 'and a limit of zero is raised to one rather than returning everything');

select is(
  (select count(*)::int from app_private.support_tickets_for_requester(
     'd4000000-0000-4000-8000-0000000000d1')),
  0, 'an account with no tickets of its own gets an empty list, not somebody else''s');

select is(
  (select count(*)::int from app_private.support_tickets_for_requester(null)),
  0, 'and so does no account at all');

select ok(
  (select count(*) = 0 from app_private.support_tickets_for_requester(
     'd4000000-0000-4000-8000-00000000000b') l
    join public.support_tickets t on t.id = l.id
   where t.requester_user_id <> 'd4000000-0000-4000-8000-00000000000b'),
  'and every row of a list belongs to the account that asked for it');

-- ---------------------------------------------------------------------------------------------------
-- 6. One ticket
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.support_ticket_for_requester(
     'd4000000-0000-4000-8000-00000000000a', (select ticket_id from sk_first))),
  'found', 'a requester reads their own ticket');
select is(
  (select subject from app_private.support_ticket_for_requester(
     'd4000000-0000-4000-8000-00000000000a', (select ticket_id from sk_first))),
  'A question about my account', 'with the subject they wrote');
select is(
  (select outcome from app_private.support_ticket_for_requester(
     'd4000000-0000-4000-8000-00000000000b', (select ticket_id from sk_first))),
  'not_found', 'another account reading it is refused');
select is(
  (select outcome from app_private.support_ticket_for_requester(
     'd4000000-0000-4000-8000-00000000000b', '11111111-1111-4111-8111-111111111111')),
  'not_found', 'and a ticket that does not exist is the same answer, so guessing reveals nothing');
select is(
  (select outcome from app_private.support_ticket_for_requester(
     null, (select ticket_id from sk_first))),
  'not_found', 'and so is asking without an account');
select ok(
  (select id is null and subject is null and status is null
     from app_private.support_ticket_for_requester(
       'd4000000-0000-4000-8000-00000000000b', (select ticket_id from sk_first))),
  'a refusal carries no field of the ticket at all');

-- ---------------------------------------------------------------------------------------------------
-- 7. The conversation
-- ---------------------------------------------------------------------------------------------------
-- An agent replies, which requires the ticket to be assigned to them — 0028's own rule, driven here so the
-- reader can be tested against a two-sided conversation. Assignment itself belongs to the console.
select is(
  app_private.assign_support_ticket((select ticket_id from sk_first),
                                    'd4000000-0000-4000-8000-0000000000d1'),
  (select ticket_id from sk_first), 'a ticket can be assigned to an agent by 0028''s own writer');

select ok(
  app_private.post_support_message((select ticket_id from sk_first),
    'd4000000-0000-4000-8000-0000000000d1', 'Could you confirm the address on the account?') is not null,
  'and that agent can reply');

select is(pg_temp.ticket_status((select ticket_id from sk_first)), 'pending_requester',
  'which leaves the ticket waiting on the requester — the writer''s own move, not this surface''s');

select is(
  (select count(*)::int from app_private.support_ticket_messages_for_requester(
     'd4000000-0000-4000-8000-00000000000a', (select ticket_id from sk_first))),
  2, 'the requester sees both messages');

-- Both messages were written in this transaction and `now()` does not move inside one, so they share a
-- timestamp and the identifier decides which comes first. Asserting a fixed order here would be asserting a
-- coin flip; reading order is proven below, on the rows whose times are explicit and distinct.
select is(
  (select string_agg(m.author_role, ',' order by m.author_role) from (
     select author_role from app_private.support_ticket_messages_for_requester(
       'd4000000-0000-4000-8000-00000000000a', (select ticket_id from sk_first))) m),
  'agent,requester', 'one of each side, and no third kind of author');

select is(
  (select count(*) filter (where m.is_own_message)::int from (
     select is_own_message from app_private.support_ticket_messages_for_requester(
       'd4000000-0000-4000-8000-00000000000a', (select ticket_id from sk_first))) m),
  1, 'and exactly one of them is the caller''s own, answered by the reader rather than by the caller');

select is(
  (select count(*)::int from app_private.support_ticket_messages_for_requester(
     'd4000000-0000-4000-8000-00000000000b', (select ticket_id from sk_first))),
  0, 'another account reading the conversation gets nothing');
select is(
  (select count(*)::int from app_private.support_ticket_messages_for_requester(
     'd4000000-0000-4000-8000-0000000000d1', (select ticket_id from sk_first))),
  0, 'and so does the assigned agent: this reader is the requester''s, and the console has its own');
select is(
  (select count(*)::int from app_private.support_ticket_messages_for_requester(
     'd4000000-0000-4000-8000-00000000000a', '11111111-1111-4111-8111-111111111111')),
  0, 'and a ticket that does not exist is the same empty answer');
select is(
  (select count(*)::int from app_private.support_ticket_messages_for_requester(
     null, (select ticket_id from sk_first))),
  0, 'and so is no account');

-- Paging, over messages inserted with explicit times: support_messages refuses UPDATE, so the times are
-- given at insert rather than adjusted afterwards.
insert into public.support_messages (support_ticket_id, author_user_id, author_role, body, created_at)
values
  ((select ticket_id from sk_first), 'd4000000-0000-4000-8000-00000000000a', 'requester',
   'The third message', now() + interval '1 minute'),
  ((select ticket_id from sk_first), 'd4000000-0000-4000-8000-00000000000a', 'requester',
   'The fourth message', now() + interval '2 minutes');

select is(
  (select count(*)::int from app_private.support_ticket_messages_for_requester(
     'd4000000-0000-4000-8000-00000000000a', (select ticket_id from sk_first))),
  4, 'the conversation now has four messages');

select is(
  (select string_agg(m.body, ',') from (
     select body from app_private.support_ticket_messages_for_requester(
       'd4000000-0000-4000-8000-00000000000a', (select ticket_id from sk_first), 2)) m),
  'The third message,The fourth message',
  'a first page of two is the newest two, returned in reading order');

select is(
  (select count(*)::int from app_private.support_ticket_messages_for_requester(
     'd4000000-0000-4000-8000-00000000000a', (select ticket_id from sk_first), 2,
     now() + interval '1 minute',
     (select id from public.support_messages where body = 'The third message'))),
  2, 'and the page before it holds the other two');

select ok(
  (select count(*) = 0 from app_private.support_ticket_messages_for_requester(
     'd4000000-0000-4000-8000-00000000000a', (select ticket_id from sk_first), 2,
     now() + interval '1 minute',
     (select id from public.support_messages where body = 'The third message')) p
   where p.body in ('The third message', 'The fourth message')),
  'so no message is served twice: the cursor is strict');

select is(
  (select count(*)::int from app_private.support_ticket_messages_for_requester(
     'd4000000-0000-4000-8000-00000000000a', (select ticket_id from sk_first), 900)),
  4, 'and a page size beyond the clamp still returns only what the ticket has');

-- ---------------------------------------------------------------------------------------------------
-- 8. Internal notes never reach the requester
-- ---------------------------------------------------------------------------------------------------
select ok(
  app_private.add_support_internal_note((select ticket_id from sk_first),
    'd4000000-0000-4000-8000-0000000000d1', 'The account shows two failed payout attempts.') is not null,
  'the assigned agent can write an internal note');

select is(
  (select count(*)::int from public.support_internal_notes n
    where n.support_ticket_id = (select ticket_id from sk_first)),
  1, 'and the note exists on the ticket');

select is(
  (select count(*)::int from app_private.support_ticket_messages_for_requester(
     'd4000000-0000-4000-8000-00000000000a', (select ticket_id from sk_first))),
  4, 'the requester''s conversation is still four messages: a note is not one of them');

select ok(
  (select count(*) = 0 from app_private.support_ticket_messages_for_requester(
     'd4000000-0000-4000-8000-00000000000a', (select ticket_id from sk_first)) m
    where m.body like '%failed payout attempts%'),
  'and its text appears nowhere in what the requester can read');

-- Two of the four messages above were inserted directly as paging fixtures, so the stored counter is the
-- number the writers posted. What matters here is that the note moved it by nothing at all.
select is(
  (select message_count from app_private.support_ticket_for_requester(
     'd4000000-0000-4000-8000-00000000000a', (select ticket_id from sk_first))),
  2, 'nor is it counted: 0028''s counter counts messages, and a note is not one');

select throws_ok(format($$
  select app_private.add_support_internal_note(%L, %L, 'Let me write a staff note')
$$, (select ticket_id from sk_first), 'd4000000-0000-4000-8000-00000000000a'),
  '42501', null, 'and a requester cannot write one even on their own ticket: 0028 refuses it');

-- ---------------------------------------------------------------------------------------------------
-- 9. Replying
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.support_message_post_for_requester(
     'd4000000-0000-4000-8000-00000000000a', (select ticket_id from sk_first), 'Yes, that is the address.')),
  'posted', 'a requester replies to their own ticket');

select is(pg_temp.ticket_status((select ticket_id from sk_first)), 'pending_agent',
  'and the ticket moves back to pending_agent: post_support_message''s own case');

select is(
  (select status from app_private.support_message_post_for_requester(
     'd4000000-0000-4000-8000-00000000000a', (select ticket_id from sk_first), 'One more thought.')),
  'pending_agent', 'which the wrapper reports back by reading the row rather than assuming it');

-- Two statements on purpose: a row a function inserts inside a statement is not visible to that same
-- statement's snapshot, so the write and the assertion are separated.
create temporary table sk_reply as
  select * from app_private.support_message_post_for_requester(
    'd4000000-0000-4000-8000-00000000000a', (select ticket_id from sk_first), 'And another.');

select is(
  (select author_role from public.support_messages m where m.id = (select message_id from sk_reply)),
  'requester', 'the role is the writer''s, worked out from the ticket rather than passed in');

select is(
  (select outcome from app_private.support_message_post_for_requester(
     'd4000000-0000-4000-8000-00000000000b', (select ticket_id from sk_first), 'Let me in')),
  'not_found', 'another account cannot reply to it, and is told only that there is nothing there');

select is(
  (select count(*)::int from public.support_messages m
    where m.support_ticket_id = (select ticket_id from sk_first)
      and m.author_user_id = 'd4000000-0000-4000-8000-00000000000b'),
  0, 'and no message of theirs was written');

select is(
  (select outcome from app_private.support_message_post_for_requester(
     'd4000000-0000-4000-8000-00000000000a', '11111111-1111-4111-8111-111111111111', 'Hello?')),
  'not_found', 'a ticket that does not exist is the same answer');

select is(
  (select outcome from app_private.support_message_post_for_requester(
     'd4000000-0000-4000-8000-00000000000a', (select ticket_id from sk_first), '   ')),
  'invalid', 'an empty body is refused');
select is(
  (select outcome from app_private.support_message_post_for_requester(
     'd4000000-0000-4000-8000-00000000000a', (select ticket_id from sk_first), repeat('z', 8001))),
  'invalid', 'and one beyond 8000 characters');

-- A resolved ticket: the writer accepts the message and preserves the status. Reported, not worked around.
create temporary table sk_resolved as
  select pg_temp.open_for('d4000000-0000-4000-8000-00000000000a', 'To be resolved by an agent') as id;

select is(
  app_private.close_support_ticket((select id from sk_resolved), 'resolved',
                                   'd4000000-0000-4000-8000-00000000000a'),
  'resolved', 'the writer will record resolved for anyone who may act on the ticket');
select is(pg_temp.ticket_status((select id from sk_resolved)), 'resolved',
  'so the ticket is resolved');
select is(
  (select outcome from app_private.support_message_post_for_requester(
     'd4000000-0000-4000-8000-00000000000a', (select id from sk_resolved), 'It happened again.')),
  'posted', 'a requester message on a resolved ticket is accepted');
select is(pg_temp.ticket_status((select id from sk_resolved)), 'resolved',
  'and leaves the status exactly where it was: the writer preserves resolved, and nothing here reopens it');

-- ---------------------------------------------------------------------------------------------------
-- 10. Closing one's own ticket
-- ---------------------------------------------------------------------------------------------------
create temporary table sk_closing as
  select pg_temp.open_for('d4000000-0000-4000-8000-00000000000a', 'To be closed by its requester') as id;

select is(
  (select outcome from app_private.support_ticket_close_for_requester(
     'd4000000-0000-4000-8000-00000000000b', (select id from sk_closing))),
  'not_found', 'another account cannot close somebody else''s ticket');
select is(pg_temp.ticket_status((select id from sk_closing)), 'pending_agent',
  'and it is left exactly as it was');

select is(
  (select outcome from app_private.support_ticket_close_for_requester(
     'd4000000-0000-4000-8000-00000000000a', (select id from sk_closing))),
  'closed', 'the requester closes their own ticket');
select is(
  (select status from app_private.support_ticket_close_for_requester(
     'd4000000-0000-4000-8000-00000000000a', pg_temp.open_for(
       'd4000000-0000-4000-8000-00000000000a', 'Another to close'))),
  'closed', 'and the status it reports is the writer''s return value');
select is(pg_temp.ticket_status((select id from sk_closing)), 'closed', 'the ticket is closed');
select ok(
  (select closed_at is not null from public.support_tickets t where t.id = (select id from sk_closing)),
  'with the closing time recorded, which the table''s own constraint requires');
select ok(
  (select resolved_at is null from public.support_tickets t where t.id = (select id from sk_closing)),
  'and no resolution time: a requester''s closure is not an agent''s resolution');

select is(
  (select outcome from app_private.support_ticket_close_for_requester(
     'd4000000-0000-4000-8000-00000000000a', (select id from sk_closing))),
  'conflict', 'closing it again is a conflict rather than a second write');

select is(
  (select outcome from app_private.support_message_post_for_requester(
     'd4000000-0000-4000-8000-00000000000a', (select id from sk_closing), 'One more thing')),
  'conflict', 'and a closed ticket takes no further message');

select is(
  (select count(*)::int from public.support_ticket_events e
    where e.support_ticket_id = (select id from sk_closing) and e.event_type = 'status_changed'
      and e.to_value = 'closed'),
  1, 'the transition is in 0028''s event trail exactly once');

select ok(
  (select actor_user_id is null from public.support_ticket_events e
    where e.support_ticket_id = (select id from sk_closing) and e.event_type = 'status_changed'
      and e.to_value = 'closed'),
  'and it records no actor — 0028''s trigger writes none, and no second trail is invented here');

-- ---------------------------------------------------------------------------------------------------
-- 11. Attachments: authorizing an upload
-- ---------------------------------------------------------------------------------------------------
create temporary table sk_attach as
  select ticket_id, message_id from app_private.support_ticket_open_for_requester(
    'd4000000-0000-4000-8000-00000000000a', 'With a screenshot', 'technical',
    'The checkout page shows an error, screenshot attached.');

create temporary table sk_target as
  select * from app_private.support_attachment_target_for_requester(
    'd4000000-0000-4000-8000-00000000000a', (select ticket_id from sk_attach),
    (select message_id from sk_attach), 'image/png', 4096);

select is((select outcome from sk_target), 'authorized', 'a requester may attach to their own message');
select is((select bucket_id from sk_target), 'support-attachments',
  'the bucket is 0012''s private support bucket');
select ok(
  (select not public from storage.buckets b where b.id = 'support-attachments'),
  'which is private, and this surface does not change that');
select is((select max_byte_size from sk_target),
  (select file_size_limit from storage.buckets where id = 'support-attachments'),
  'and the size ceiling is the bucket''s own, read rather than restated');
select matches((select object_path from sk_target),
  format('^support-attachments/%s/%s/[0-9a-f-]{36}\.png$',
         (select ticket_id from sk_attach), (select message_id from sk_attach)),
  'the path is composed from the ticket, the message and a fresh random name');
select isnt(
  (select object_path from app_private.support_attachment_target_for_requester(
     'd4000000-0000-4000-8000-00000000000a', (select ticket_id from sk_attach),
     (select message_id from sk_attach), 'image/png', 4096)),
  (select object_path from sk_target), 'and two authorizations never name the same object');

select is(
  (select outcome from app_private.support_attachment_target_for_requester(
     'd4000000-0000-4000-8000-00000000000b', (select ticket_id from sk_attach),
     (select message_id from sk_attach), 'image/png', 4096)),
  'not_found', 'another account gets no target for it');
select is(
  (select outcome from app_private.support_attachment_target_for_requester(
     'd4000000-0000-4000-8000-0000000000d1', (select ticket_id from sk_attach),
     (select message_id from sk_attach), 'image/png', 4096)),
  'not_found', 'and neither does an agent: this is the requester''s path');
select is(
  (select outcome from app_private.support_attachment_target_for_requester(
     'd4000000-0000-4000-8000-00000000000a', (select ticket_id from sk_attach),
     (select message_id from sk_first), 'image/png', 4096)),
  'not_found', 'a message from a different ticket is refused, even though both are the caller''s');
select is(
  (select outcome from app_private.support_attachment_target_for_requester(
     'd4000000-0000-4000-8000-00000000000a', (select ticket_id from sk_first),
     (select id from public.support_messages where body like 'Could you confirm%'), 'image/png', 4096)),
  'not_found', 'and so is the agent''s own message on the caller''s ticket');
select is(
  (select outcome from app_private.support_attachment_target_for_requester(
     'd4000000-0000-4000-8000-00000000000a', (select ticket_id from sk_attach),
     (select message_id from sk_attach), 'image/gif', 4096)),
  'invalid', 'a type the bucket does not allow is refused');
select is(
  (select outcome from app_private.support_attachment_target_for_requester(
     'd4000000-0000-4000-8000-00000000000a', (select ticket_id from sk_attach),
     (select message_id from sk_attach), 'image/png',
     (select file_size_limit + 1 from storage.buckets where id = 'support-attachments'))),
  'invalid', 'and so is a file beyond the bucket''s limit');
select is(
  (select outcome from app_private.support_attachment_target_for_requester(
     'd4000000-0000-4000-8000-00000000000a', (select ticket_id from sk_attach),
     (select message_id from sk_attach), 'image/png', 0)),
  'invalid', 'and a size of zero');
select is(
  (select outcome from app_private.support_attachment_target_for_requester(
     'd4000000-0000-4000-8000-00000000000a', (select id from sk_closing),
     (select message_id from sk_attach), 'image/png', 4096)),
  'not_found', 'a closed ticket''s own message is not the caller''s message on it either');

select is(
  (select count(*)::int from public.support_attachments), 0,
  'and nothing has been recorded yet: authorizing an upload writes nothing');

-- ---------------------------------------------------------------------------------------------------
-- 12. Attachments: recording one
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.support_attachment_attach_for_requester(
     'd4000000-0000-4000-8000-00000000000a', (select ticket_id from sk_attach),
     (select message_id from sk_attach), (select object_path from sk_target),
     'checkout.png', 'image/png', 4096)),
  'attached', 'the path the database issued can be recorded');

select is((select count(*)::int from public.support_attachments), 1, 'and one attachment now exists');
select is(
  (select content_type from public.support_attachments limit 1), 'image/png',
  'with the declared type');
select is(
  (select original_filename from public.support_attachments limit 1), 'checkout.png',
  'and the name the browser sent, which is data rather than a destination');

select is(
  (select outcome from app_private.support_attachment_attach_for_requester(
     'd4000000-0000-4000-8000-00000000000a', (select ticket_id from sk_attach),
     (select message_id from sk_attach), (select object_path from sk_target),
     'checkout.png', 'image/png', 4096)),
  'invalid', 'the same path cannot be recorded twice');

select is(
  (select outcome from app_private.support_attachment_attach_for_requester(
     'd4000000-0000-4000-8000-00000000000a', (select ticket_id from sk_attach),
     (select message_id from sk_attach),
     format('support-attachments/%s/%s/00000000-0000-4000-8000-000000000000.png',
            (select ticket_id from sk_first), (select message_id from sk_first)),
     'other.png', 'image/png', 4096)),
  'invalid', 'a path inside another ticket''s namespace is refused');

select is(
  (select outcome from app_private.support_attachment_attach_for_requester(
     'd4000000-0000-4000-8000-00000000000a', (select ticket_id from sk_attach),
     (select message_id from sk_attach),
     format('support-attachments/%s/%s/../../elsewhere/x.png',
            (select ticket_id from sk_attach), (select message_id from sk_attach)),
     'x.png', 'image/png', 4096)),
  'invalid', 'a traversal is refused');

select is(
  (select outcome from app_private.support_attachment_attach_for_requester(
     'd4000000-0000-4000-8000-00000000000a', (select ticket_id from sk_attach),
     (select message_id from sk_attach),
     format('support-attachments/%s/%s/nested/00000000-0000-4000-8000-000000000001.png',
            (select ticket_id from sk_attach), (select message_id from sk_attach)),
     'x.png', 'image/png', 4096)),
  'invalid', 'a nested path below the namespace is refused');

select is(
  (select outcome from app_private.support_attachment_attach_for_requester(
     'd4000000-0000-4000-8000-00000000000a', (select ticket_id from sk_attach),
     (select message_id from sk_attach),
     format('support-attachments/%s/%s/not-a-uuid.png',
            (select ticket_id from sk_attach), (select message_id from sk_attach)),
     'x.png', 'image/png', 4096)),
  'invalid', 'a file name that is not one this function issues is refused');

select is(
  (select outcome from app_private.support_attachment_attach_for_requester(
     'd4000000-0000-4000-8000-00000000000a', (select ticket_id from sk_attach),
     (select message_id from sk_attach),
     format('support-attachments/%s/%s/00000000-0000-4000-8000-000000000002.exe',
            (select ticket_id from sk_attach), (select message_id from sk_attach)),
     'x.exe', 'image/png', 4096)),
  'invalid', 'and so is an extension outside the four the bucket allows');

select is(
  (select outcome from app_private.support_attachment_attach_for_requester(
     'd4000000-0000-4000-8000-00000000000a', (select ticket_id from sk_attach),
     (select message_id from sk_attach),
     format('other-bucket/%s/%s/00000000-0000-4000-8000-000000000003.png',
            (select ticket_id from sk_attach), (select message_id from sk_attach)),
     'x.png', 'image/png', 4096)),
  'invalid', 'a path in another bucket entirely is refused');

select is(
  (select outcome from app_private.support_attachment_attach_for_requester(
     'd4000000-0000-4000-8000-00000000000b', (select ticket_id from sk_attach),
     (select message_id from sk_attach),
     format('support-attachments/%s/%s/00000000-0000-4000-8000-000000000004.png',
            (select ticket_id from sk_attach), (select message_id from sk_attach)),
     'x.png', 'image/png', 4096)),
  'not_found', 'and another account cannot record anything against that message');

select is((select count(*)::int from public.support_attachments), 1,
  'so exactly one attachment exists after all of those attempts');

select is(
  (select attachment_count from app_private.support_tickets_for_requester(
     'd4000000-0000-4000-8000-00000000000a', 51) l
    where l.id = (select ticket_id from sk_attach)),
  1, 'the list reports the ticket has one file');

select is(
  (select jsonb_array_length(m.attachments) from app_private.support_ticket_messages_for_requester(
     'd4000000-0000-4000-8000-00000000000a', (select ticket_id from sk_attach)) m),
  1, 'and the conversation carries it on the message it belongs to');

select is(
  (select m.attachments -> 0 ->> 'originalFilename'
     from app_private.support_ticket_messages_for_requester(
       'd4000000-0000-4000-8000-00000000000a', (select ticket_id from sk_attach)) m),
  'checkout.png', 'with the file name a page displays');

select ok(
  (select not (m.attachments -> 0 ? 'objectPath')
     from app_private.support_ticket_messages_for_requester(
       'd4000000-0000-4000-8000-00000000000a', (select ticket_id from sk_attach)) m),
  'and without the object path, which never crosses to a browser');

-- ---------------------------------------------------------------------------------------------------
-- 13. Attachments: reading one back
-- ---------------------------------------------------------------------------------------------------
create temporary table sk_file as select id from public.support_attachments limit 1;

select is(
  (select outcome from app_private.support_attachment_for_requester(
     'd4000000-0000-4000-8000-00000000000a', (select ticket_id from sk_attach),
     (select id from sk_file))),
  'authorized', 'the requester may read their own attachment back');
select is(
  (select object_path from app_private.support_attachment_for_requester(
     'd4000000-0000-4000-8000-00000000000a', (select ticket_id from sk_attach),
     (select id from sk_file))),
  (select object_path from sk_target), 'and the path returned is the one that was recorded');
select is(
  (select outcome from app_private.support_attachment_for_requester(
     'd4000000-0000-4000-8000-00000000000b', (select ticket_id from sk_attach),
     (select id from sk_file))),
  'not_found', 'another account gets nothing');
select is(
  (select outcome from app_private.support_attachment_for_requester(
     'd4000000-0000-4000-8000-0000000000d1', (select ticket_id from sk_attach),
     (select id from sk_file))),
  'not_found', 'and so does the assigned agent, on this surface');
select is(
  (select outcome from app_private.support_attachment_for_requester(
     'd4000000-0000-4000-8000-00000000000a', (select ticket_id from sk_first),
     (select id from sk_file))),
  'not_found', 'an attachment identifier cannot be spent against another of the caller''s own tickets');
select is(
  (select outcome from app_private.support_attachment_for_requester(
     'd4000000-0000-4000-8000-00000000000a', (select ticket_id from sk_attach),
     '11111111-1111-4111-8111-111111111111')),
  'not_found', 'an attachment that does not exist is the same answer');
select ok(
  (select object_path is null and bucket_id is null
     from app_private.support_attachment_for_requester(
       'd4000000-0000-4000-8000-00000000000b', (select ticket_id from sk_attach),
       (select id from sk_file))),
  'and a refusal carries no location at all');

-- ---------------------------------------------------------------------------------------------------
-- 14. Notifications, events and the audit trail
-- ---------------------------------------------------------------------------------------------------
select is((select count(*)::int from public.notifications), 0,
  'nothing on this surface created a notification: the repository defines no support notification');

select is(
  (select count(*)::int from public.email_outbox), 0,
  'and no email was queued: 7-D owns transport and this surface adds none');

-- The three events the requester surface can cause, on the ticket it opened, replied to and closed.
select is(
  (select string_agg(distinct e.event_type, ',' order by e.event_type) from public.outbox_events e
    where e.aggregate_type = 'support_ticket'
      and e.aggregate_id = (select id::text from sk_closing)),
  'support_ticket.closed,support_ticket.message_posted,support_ticket.opened',
  'the only outbox events the requester surface causes are 0028''s own three');

-- Across the whole transaction there are two more, and both come from the console writers this test drove
-- as fixtures: `assign_support_ticket` publishes the membership change, and `close_support_ticket` with
-- `resolved` publishes that. Neither is reachable from anything 0074 defines.
select is(
  (select string_agg(distinct e.event_type, ',' order by e.event_type) from public.outbox_events e
    where e.aggregate_type = 'support_ticket'),
  'support_ticket.closed,support_ticket.membership_changed,support_ticket.message_posted,'
    || 'support_ticket.opened,support_ticket.resolved',
  'and the only others in the transaction are the two the console writers published');

select is(
  (select count(*)::int from public.support_ticket_events e
    where e.support_ticket_id = (select ticket_id from sk_first) and e.event_type = 'created'),
  1, '0028''s created event is written once per ticket');

select is(
  (select actor_user_id from public.support_ticket_events e
    where e.support_ticket_id = (select ticket_id from sk_first) and e.event_type = 'created'),
  'd4000000-0000-4000-8000-00000000000a',
  'and it names the requester, which is the writer''s own behaviour');

select is(
  (select count(*)::int from public.support_ticket_events e
    where e.support_ticket_id = (select ticket_id from sk_first) and e.event_type = 'message_posted'),
  (select message_count::int from public.support_tickets t where t.id = (select ticket_id from sk_first)),
  'there is one message_posted event per message, written by the writer and not by this surface');

select ok(
  (select count(*) > 0 from audit.audit_logs a
    where a.table_name = 'support_tickets'),
  'ticket rows are audited by 0028''s trigger');

select ok(
  (select count(*) = 0 from audit.audit_logs a where a.table_name = 'support_messages'),
  'and messages are not, exactly as 0029 records: the trail is the event stream, not a second copy');

select is(
  (select count(*)::int from public.support_ticket_events e
    where e.event_type = 'reopened'),
  0, 'no reopened event exists anywhere: nothing in the repository writes one');

select is(
  (select count(*)::int from public.support_tickets t
    where t.status = 'open' and t.subject not like 'Bulk ticket%'),
  0, 'and no ticket opened through this surface is left at open: its own first message moves it on');

rollback;
