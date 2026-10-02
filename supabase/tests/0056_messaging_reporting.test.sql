-- pgTAP — migration 0056: reporting a message or a conversation from inside it.
--
-- The whole of what 0056 adds is authorization, so that is what most of this file is about: who may
-- report what, and the fact that "not yours" and "not there" are one answer. The rest holds 0027's
-- behaviour to account through the wrapper — one open report per reporter and subject, the same id on a
-- repeat, the outbox event — and proves that filing a report changes nothing else at all: not the
-- message, not the conversation, not the membership, not the mute state, not the read markers, and
-- certainly not a moderation action.
--
-- Deterministic: fixed uuids, no wall-clock dependence, message ids captured as they are created because
-- `now()` is constant inside a transaction. Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(48);

-- Fixtures ------------------------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('70000000-0000-4000-8000-000000000001', 'reporter@test.invalid'),
  ('70000000-0000-4000-8000-000000000002', 'other@test.invalid'),
  ('70000000-0000-4000-8000-000000000003', 'stranger@test.invalid'),
  ('70000000-0000-4000-8000-000000000004', 'departed@test.invalid');

insert into public.conversations (id, subject_type, created_by) values
  ('eb000000-0000-4000-8000-000000000001', 'direct', '70000000-0000-4000-8000-000000000001'),
  -- A conversation the reporter is not in at all. Its existence must be undetectable to them.
  ('eb000000-0000-4000-8000-000000000002', 'direct', '70000000-0000-4000-8000-000000000003');

insert into public.conversation_participants (conversation_id, user_id, role) values
  ('eb000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000001', 'buyer'),
  ('eb000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000002', 'seller'),
  ('eb000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000004', 'member'),
  ('eb000000-0000-4000-8000-000000000002', '70000000-0000-4000-8000-000000000003', 'buyer'),
  ('eb000000-0000-4000-8000-000000000002', '70000000-0000-4000-8000-000000000002', 'seller');

create temporary table ids (name text primary key, id uuid not null);

insert into ids (name, id)
select 'mine', message_id from app_private.messaging_send_message(
  '70000000-0000-4000-8000-000000000002'::uuid,
  'eb000000-0000-4000-8000-000000000001'::uuid,
  'Something worth reporting.');

insert into ids (name, id)
select 'theirs', message_id from app_private.messaging_send_message(
  '70000000-0000-4000-8000-000000000003'::uuid,
  'eb000000-0000-4000-8000-000000000002'::uuid,
  'A message in a conversation the reporter is not in.');

-- The state that must survive reporting untouched, recorded before anything is filed.
create temporary table before_reporting as
select
  (select count(*)::int from public.messages) as messages,
  (select count(*)::int from public.conversations where closed_at is not null) as closed,
  (select count(*)::int from public.conversation_participants where left_at is not null) as departed,
  (select count(*)::int from public.conversation_participants where is_muted) as muted,
  (select membership_version from public.conversations where id = 'eb000000-0000-4000-8000-000000000001') as version,
  (select app_private.messaging_unread_count('70000000-0000-4000-8000-000000000001'::uuid)) as unread,
  (select count(*)::int from public.moderation_actions) as moderation;

-- ---------------------------------------------------------------------------------------------------
-- Reporting what the caller can read
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.messaging_file_report(
     '70000000-0000-4000-8000-000000000001'::uuid, 'message',
     (select id from ids where name = 'mine'), 'harassment')),
  'filed',
  'a participant reports a message in their own conversation'
);

insert into ids (name, id)
select 'report_message', report_id from app_private.messaging_file_report(
  '70000000-0000-4000-8000-000000000001'::uuid, 'message',
  (select id from ids where name = 'mine'), 'harassment');

select results_eq(
  $$select subject_type, subject_id::text, reason_code, status, details
      from public.reports where id = (select id from ids where name = 'report_message')$$,
  $$values ('message', (select id::text from ids where name = 'mine'), 'harassment', 'open', null::text)$$,
  'and the report names the message, carries the reason given, and opens with no details'
);

select is(
  (select reporter_user_id from public.reports
    where id = (select id from ids where name = 'report_message')),
  '70000000-0000-4000-8000-000000000001'::uuid,
  'the reporter is the caller and nobody else'
);

select is(
  (select outcome from app_private.messaging_file_report(
     '70000000-0000-4000-8000-000000000001'::uuid, 'conversation',
     'eb000000-0000-4000-8000-000000000001'::uuid, 'spam')),
  'filed',
  'and reports the whole conversation'
);

insert into ids (name, id)
select 'report_conversation', report_id from app_private.messaging_file_report(
  '70000000-0000-4000-8000-000000000001'::uuid, 'conversation',
  'eb000000-0000-4000-8000-000000000001'::uuid, 'spam');

select results_eq(
  $$select subject_type, subject_id::text, reason_code
      from public.reports where id = (select id from ids where name = 'report_conversation')$$,
  $$values ('conversation', 'eb000000-0000-4000-8000-000000000001', 'spam')$$,
  'which names the conversation'
);

select isnt(
  (select id from ids where name = 'report_message'),
  (select id from ids where name = 'report_conversation'),
  'the two are separate reports: a message and its conversation are different subjects'
);

select is(
  (select count(*)::int from public.outbox_events e
    where e.aggregate_type = 'report' and e.event_type = 'report.filed'),
  2,
  '0027 announced each one through the outbox, once'
);

select is(
  (select outcome from app_private.messaging_file_report(
     '70000000-0000-4000-8000-000000000004'::uuid, 'conversation',
     'eb000000-0000-4000-8000-000000000001'::uuid, 'harassment')),
  'filed',
  'a participant who has not left may report it'
);

-- Somebody who has left keeps the access 0053 gives them, so they keep the ability to report.
select is(
  (select outcome from app_private.messaging_leave_conversation(
     '70000000-0000-4000-8000-000000000004'::uuid,
     'eb000000-0000-4000-8000-000000000001'::uuid)),
  'left',
  'and after they leave'
);

select is(
  (select outcome from app_private.messaging_file_report(
     '70000000-0000-4000-8000-000000000004'::uuid, 'message',
     (select id from ids where name = 'mine'), 'harassment')),
  'filed',
  'they can still report what was said while they were there'
);

-- ---------------------------------------------------------------------------------------------------
-- What the caller cannot read, they cannot report
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.messaging_file_report(
     '70000000-0000-4000-8000-000000000001'::uuid, 'message',
     (select id from ids where name = 'theirs'), 'harassment')),
  'not_found',
  'a message in a conversation the caller is not in cannot be reported'
);

select is(
  (select outcome from app_private.messaging_file_report(
     '70000000-0000-4000-8000-000000000001'::uuid, 'conversation',
     'eb000000-0000-4000-8000-000000000002'::uuid, 'harassment')),
  'not_found',
  'and neither can that conversation'
);

select is(
  (select outcome from app_private.messaging_file_report(
     '70000000-0000-4000-8000-000000000001'::uuid, 'message',
     '11111111-1111-4111-8111-1111111111ff'::uuid, 'harassment')),
  'not_found',
  'a message that does not exist answers exactly the same way'
);

select is(
  (select outcome from app_private.messaging_file_report(
     '70000000-0000-4000-8000-000000000001'::uuid, 'conversation',
     '11111111-1111-4111-8111-1111111111ff'::uuid, 'harassment')),
  'not_found',
  'as does a conversation that does not exist: existence is never disclosed'
);

select results_eq(
  $$select outcome, report_id::text from app_private.messaging_file_report(
      '70000000-0000-4000-8000-000000000001'::uuid, 'message',
      (select id from ids where name = 'theirs'), 'harassment')$$,
  $$select outcome, report_id::text from app_private.messaging_file_report(
      '70000000-0000-4000-8000-000000000001'::uuid, 'message',
      '11111111-1111-4111-8111-1111111111ff'::uuid, 'harassment')$$,
  'the two refusals are identical, row for row'
);

select is(
  (select count(*)::int from public.reports r
    where r.subject_id = (select id from ids where name = 'theirs')
       or r.subject_id = 'eb000000-0000-4000-8000-000000000002'),
  0,
  'and no report was filed about either of them'
);

select is(
  (select outcome from app_private.messaging_file_report(
     '70000000-0000-4000-8000-000000000003'::uuid, 'message',
     (select id from ids where name = 'mine'), 'harassment')),
  'not_found',
  'a stranger to the conversation is refused in the other direction too'
);

-- ---------------------------------------------------------------------------------------------------
-- Subject types this path does not own
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.messaging_file_report(
     '70000000-0000-4000-8000-000000000001'::uuid, 'seller',
     '70000000-0000-4000-8000-000000000002'::uuid, 'harassment')),
  'invalid',
  'a seller is not reportable through the messaging path'
);

select is(
  (select outcome from app_private.messaging_file_report(
     '70000000-0000-4000-8000-000000000001'::uuid, 'user',
     '70000000-0000-4000-8000-000000000002'::uuid, 'harassment')),
  'invalid',
  'and neither is a user'
);

select is(
  (select outcome from app_private.messaging_file_report(
     '70000000-0000-4000-8000-000000000001'::uuid, 'listing',
     'eb000000-0000-4000-8000-000000000001'::uuid, 'spam')),
  'invalid',
  'nor a listing'
);

select is(
  (select outcome from app_private.messaging_file_report(
     '70000000-0000-4000-8000-000000000001'::uuid, 'message', null, 'spam')),
  'invalid',
  'and a report about nothing is invalid rather than a not-found'
);

select is(
  (select count(*)::int from public.reports r
    where r.subject_type not in ('message', 'conversation')),
  0,
  'none of those created a report of any kind'
);

-- ---------------------------------------------------------------------------------------------------
-- Deduplication — 0027's, through the wrapper
-- ---------------------------------------------------------------------------------------------------
select is(
  (select report_id from app_private.messaging_file_report(
     '70000000-0000-4000-8000-000000000001'::uuid, 'message',
     (select id from ids where name = 'mine'), 'spam')),
  (select id from ids where name = 'report_message'),
  'reporting the same message again lands on the report already open — even with a different reason'
);

select is(
  (select count(*)::int from public.reports r
    where r.reporter_user_id = '70000000-0000-4000-8000-000000000001'
      and r.subject_type = 'message'
      and r.subject_id = (select id from ids where name = 'mine')),
  1,
  'and creates no duplicate'
);

select is(
  (select report_id from app_private.messaging_file_report(
     '70000000-0000-4000-8000-000000000001'::uuid, 'conversation',
     'eb000000-0000-4000-8000-000000000001'::uuid, 'harassment')),
  (select id from ids where name = 'report_conversation'),
  'the same holds for a conversation report'
);

select is(
  (select count(*)::int from public.reports r
    where r.reporter_user_id = '70000000-0000-4000-8000-000000000001'
      and r.subject_type = 'conversation'
      and r.subject_id = 'eb000000-0000-4000-8000-000000000001'),
  1,
  'with no duplicate either'
);

select lives_ok(
  $$select app_private.messaging_file_report(
      '70000000-0000-4000-8000-000000000001'::uuid, 'message',
      (select id from ids where name = 'mine'), 'spam'),
    app_private.messaging_file_report(
      '70000000-0000-4000-8000-000000000001'::uuid, 'message',
      (select id from ids where name = 'mine'), 'spam')$$,
  'filing it over and over is idempotent rather than an error'
);

select is(
  (select count(*)::int from public.reports r
    where r.subject_id = (select id from ids where name = 'mine')
      and r.reporter_user_id = '70000000-0000-4000-8000-000000000001'),
  1,
  'however many times it runs'
);

select is(
  (select count(*)::int from public.reports r
    where r.subject_type = 'message'
      and r.subject_id = (select id from ids where name = 'mine')),
  2,
  'a different reporter files their own report about the same message: dedupe is per reporter'
);

select is(
  (select count(distinct r.reporter_user_id)::int from public.reports r
    where r.subject_type = 'message' and r.subject_id = (select id from ids where name = 'mine')),
  2,
  'and the two reports belong to the two different people'
);

select is(
  (select count(*)::int from public.outbox_events e
    where e.aggregate_type = 'report' and e.event_type = 'report.filed'),
  (select count(*)::int from public.reports),
  'one outbox event per report, and none for a deduplicated one'
);

-- ---------------------------------------------------------------------------------------------------
-- Reporting changes nothing else
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::int from public.messages),
  (select messages from before_reporting),
  'no message was added or removed by reporting'
);

select is(
  (select count(*)::int from public.messages m
    where m.id = (select id from ids where name = 'mine')
      and m.body = 'Something worth reporting.'
      and m.deleted_at is null
      and m.edited_at is null),
  1,
  'the reported message is unchanged and still there'
);

select is(
  (select count(*)::int from app_private.messaging_conversation_messages(
     '70000000-0000-4000-8000-000000000001'::uuid,
     'eb000000-0000-4000-8000-000000000001'::uuid, 50, null)),
  1,
  'and still readable by the reporter: reporting is not hiding'
);

select is(
  (select count(*)::int from public.conversations where closed_at is not null),
  (select closed from before_reporting),
  'no conversation was closed'
);

select is(
  (select count(*)::int from public.conversation_participants where is_muted),
  (select muted from before_reporting),
  'no mute state changed'
);

select is(
  (select app_private.messaging_unread_count('70000000-0000-4000-8000-000000000001'::uuid)),
  (select unread from before_reporting),
  'no unread count changed'
);

select is(
  (select count(*)::int from public.moderation_actions),
  (select moderation from before_reporting),
  'and no moderation action was created: a report is a request for a look, not a decision'
);

select is(
  (select count(*)::int from public.reports r where r.status <> 'open'),
  0,
  'every report is open and unresolved: nothing was triaged, actioned or dismissed automatically'
);

select is(
  (select count(*)::int from public.reports r
    where r.assigned_to is not null or r.resolved_at is not null or r.resolution is not null),
  0,
  'and none is assigned or resolved'
);

select ok(
  (select count(*)::int from public.reports r where r.details is not null) = 0,
  'no report carries details: the message body is never copied into report metadata by this path'
);

-- The departed participant left during this test; that is a membership change and the version moves for
-- it, which is 0014's business. Reporting itself moved nothing.
select is(
  (select membership_version from public.conversations
    where id = 'eb000000-0000-4000-8000-000000000001'),
  (select version + 1 from before_reporting),
  'the only membership change was the departure, not any of the reports'
);

-- ---------------------------------------------------------------------------------------------------
-- The privilege model
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::int from public.security_contract_problems()),
  0,
  '0056 leaves the security contract with nothing to report'
);

select ok(
  (select p.prosecdef and p.proconfig @> array['search_path=pg_catalog, public']
     from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'app_private' and p.proname = 'messaging_file_report'),
  'the wrapper is SECURITY DEFINER with a pinned search_path'
);

select ok(
  not has_function_privilege('public', 'app_private.messaging_file_report(uuid, text, uuid, text, text)', 'execute')
  and not has_function_privilege('authenticated', 'app_private.messaging_file_report(uuid, text, uuid, text, text)', 'execute')
  and not has_function_privilege('anon', 'app_private.messaging_file_report(uuid, text, uuid, text, text)', 'execute'),
  'PUBLIC, authenticated and anon may not execute it'
);

select ok(
  has_function_privilege('app_system', 'app_private.messaging_file_report(uuid, text, uuid, text, text)', 'execute'),
  'and app_system may, which is the only application path in'
);

select ok(
  not has_table_privilege('authenticated', 'public.reports', 'insert')
  and not has_table_privilege('app_system', 'public.reports', 'insert')
  and not has_table_privilege('anon', 'public.reports', 'select'),
  'nobody gained table access to reports: creation is still 0027''s function'
);

select is(
  (select pg_get_function_identity_arguments(p.oid)
     from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'app_private' and p.proname = 'messaging_file_report'),
  'p_user_id uuid, p_subject_type text, p_subject_id uuid, p_reason_code text, p_details text',
  'and the reporter is a parameter the API fills from the session: there is no second actor field'
);

select finish();
rollback;
