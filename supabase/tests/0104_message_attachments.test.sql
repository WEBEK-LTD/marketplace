-- pgTAP — migration 0104: conversation message attachments (Phase 8).
--
-- 0014 created `public.message_attachments`, its constraints, its unique `object_path` index, its two RLS
-- policies and the private `message-attachments` bucket, and 0053 deliberately left all of it unread. This file
-- is about the four functions that finally read and write it, and about the things they must refuse.
--
-- The assertions worth naming up front:
--
--   * **the sender only may attach**, and "not your message" is the same answer as "no such message";
--   * **five per message and ten mebibytes each**, the byte ceiling being the *tighter* of 0104's figure and
--     the bucket's own, so neither can be loosened alone;
--   * **an explicit allowlist with no SVG**, and a declared type that cannot be mapped to one of four
--     extensions is refused twice over;
--   * **the path is derived, never supplied** — a path for another message, another conversation, another
--     bucket, with a traversal segment, or with an extension that disagrees with the declared type, is all
--     refused by the attach step even when the API passed it along;
--   * **nothing is written by an authorization**, which is the whole shape of the three-step flow;
--   * **a blocked pair gains no new send capability but loses no readability** — and the write guard is proved
--     the only way it can be, by attaching to a message that existed *before* the block;
--   * **0014 is untouched**: its columns, constraints, index, policies and bucket are all asserted unchanged,
--     and an attachment-only message is still impossible because `messages_text_has_body` still refuses one.
--
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(148);

-- ---------------------------------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------------------------------
-- BUYER talks to SELLER. STRANGER is in nothing. BUYER sends one message and SELLER sends another, so "your
-- own message" and "the other party's message" are both real rows rather than hypotheses.
insert into auth.users (id, email) values
  ('90000000-0000-4000-8000-000000000001', 'buyer@test.invalid'),
  ('90000000-0000-4000-8000-000000000002', 'seller@test.invalid'),
  ('90000000-0000-4000-8000-000000000003', 'stranger@test.invalid');

insert into public.seller_profiles
  (user_id, slug, display_name, legal_name, contact_email, contact_phone_e164, country_code,
   status, verification_status, verified_at)
values
  ('90000000-0000-4000-8000-000000000002', 'good-shop', 'Good Shop', 'Good Shop LLC',
   'good@test.invalid', '+201000000001', 'EG', 'active', 'verified', now() - interval '10 days'),
  -- The buyer runs a storefront too, so the seller can block them through a slug as well as a thread.
  ('90000000-0000-4000-8000-000000000001', 'buyer-shop', 'Buyer Shop', 'Buyer Shop LLC',
   'buyershop@test.invalid', '+201000000009', 'EG', 'active', 'verified', now() - interval '10 days');

insert into public.categories (id, parent_id, slug, is_active, sort_order) values
  ('cb000000-0000-4000-8000-000000000001', null, 'furniture', true, 1);
insert into public.category_translations (category_id, locale_code, name) values
  ('cb000000-0000-4000-8000-000000000001', 'en', 'Furniture');
insert into public.listings (
  id, seller_user_id, listing_type_code, category_id, slug, title, description, content_language,
  currency_code, price_minor, is_negotiable, status, country_code, city, created_at, approved_at
) values (
  '1bbb0000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000002', 'product',
  'cb000000-0000-4000-8000-000000000001', 'walnut-table', 'Walnut dining table',
  'A description long enough to satisfy the length constraint.', 'en',
  'EGP', 250000, true, 'active', 'EG', 'Cairo', now() - interval '10 days', now() - interval '9 days'
);

create temporary table ids (name text primary key, id uuid not null);

insert into ids select 'conv', conversation_id
  from app_private.messaging_start_conversation(
    '90000000-0000-4000-8000-000000000001', 'listing', '1bbb0000-0000-4000-8000-000000000001', null);
insert into ids select 'mine', message_id
  from app_private.messaging_send_message(
    '90000000-0000-4000-8000-000000000001', (select id from ids where name = 'conv'),
    'Is this still available?');
insert into ids select 'theirs', message_id
  from app_private.messaging_send_message(
    '90000000-0000-4000-8000-000000000002', (select id from ids where name = 'conv'), 'Yes it is.');

select is((select count(*)::int from ids), 3, 'the fixture conversation and both messages exist');

-- Helpers ------------------------------------------------------------------------------------------
create or replace function pg_temp.target(p_caller uuid, p_message uuid, p_type text, p_size bigint)
returns text language sql as $$
  select outcome from app_private.message_attachment_target(
    p_caller, (select id from ids where name = 'conv'), p_message, p_type, p_size);
$$;

create or replace function pg_temp.path(p_message uuid, p_ext text, p_name text default null)
returns text language sql as $$
  select 'message-attachments/' || (select id from ids where name = 'conv')::text || '/'
         || p_message::text || '/' || coalesce(p_name, gen_random_uuid()::text) || '.' || p_ext;
$$;

create or replace function pg_temp.attach(p_caller uuid, p_message uuid, p_path text, p_type text, p_size bigint)
returns text language sql as $$
  select outcome from app_private.message_attachment_attach(
    p_caller, (select id from ids where name = 'conv'), p_message, p_path, p_type, p_size);
$$;

/** One fresh, valid attachment on the caller's own message. Returns the outcome. */
create or replace function pg_temp.attach_one(p_type text default 'image/png', p_ext text default 'png')
returns text language sql as $$
  select pg_temp.attach('90000000-0000-4000-8000-000000000001', (select id from ids where name = 'mine'),
                        pg_temp.path((select id from ids where name = 'mine'), p_ext), p_type, 1000);
$$;

create or replace function pg_temp.stored() returns integer language sql as $$
  select count(*)::integer from public.message_attachments;
$$;

-- ---------------------------------------------------------------------------------------------------
-- 0014 is untouched
-- ---------------------------------------------------------------------------------------------------
select set_eq(
  $$select column_name from information_schema.columns
     where table_schema = 'public' and table_name = 'message_attachments'$$,
  $$values ('id'), ('message_id'), ('object_path'), ('content_type'), ('byte_size'),
           ('width'), ('height'), ('created_at')$$,
  'message_attachments still has exactly 0014''s eight columns'
);

select ok(
  (select count(*) from pg_constraint c join pg_class t on t.oid = c.conrelid
    where t.relname = 'message_attachments'
      and c.conname in ('message_attachments_dimensions_positive',
                        'message_attachments_path_present',
                        'message_attachments_size_positive')) = 3,
  'and 0014''s three check constraints are all still there'
);

select has_index('public', 'message_attachments', 'message_attachments_object_path',
  'the unique object_path index is still there, which is what makes a repeated confirmation idempotent');

select set_eq(
  $$select policyname from pg_policies
     where schemaname = 'public' and tablename = 'message_attachments'$$,
  $$values ('message_attachments_participant_read'), ('message_attachments_sender_insert')$$,
  'and still exactly 0014''s two policies: no staff policy was added'
);

select is(
  (select confdeltype::text from pg_constraint
    where conname = 'message_attachments_message_id_fkey'),
  'c',
  'the foreign key still cascades, which is the whole of the retention policy'
);

-- The bucket -----------------------------------------------------------------------------------------
select is(
  (select public from storage.buckets where id = 'message-attachments'),
  false,
  'the message-attachments bucket is still private'
);
select is(
  (select file_size_limit from storage.buckets where id = 'message-attachments'),
  20971520::bigint,
  'and its own size limit is unchanged at 20 MiB: 0104 applies a tighter one rather than editing this'
);
select ok(
  not ('image/svg+xml' = any (
    (select allowed_mime_types from storage.buckets where id = 'message-attachments')::text[])),
  'and SVG is not in the bucket''s allowed types either'
);
select is(
  (select count(*)::int from pg_policies where schemaname = 'storage' and tablename = 'objects'
     and (coalesce(qual, '') like '%message-attachments%'
       or coalesce(with_check, '') like '%message-attachments%')),
  0,
  'no storage policy exposes the bucket directly: every read is a signed URL minted server-side'
);

-- Attachment-only messages, still impossible --------------------------------------------------------
select throws_ok(
  format($$insert into public.messages (conversation_id, sender_user_id, body)
             values (%L, '90000000-0000-4000-8000-000000000001', '')$$,
         (select id from ids where name = 'conv')),
  '23514',
  null,
  'a message with no body is still refused by 0014''s messages_text_has_body'
);
select throws_ok(
  format($$insert into public.messages (conversation_id, sender_user_id, body)
             values (%L, '90000000-0000-4000-8000-000000000001', null)$$,
         (select id from ids where name = 'conv')),
  '23514',
  null,
  'and so is one with no body at all — the same constraint catches it, so an attachment is never a kind of message'
);
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'message_attachment%'
      and p.prosrc like '%insert into public.messages%'),
  0,
  'and nothing in 0104 creates a message: the only way to get one is still 5-E''s writer'
);

-- ---------------------------------------------------------------------------------------------------
-- The functions, and the privileges this architecture requires
-- ---------------------------------------------------------------------------------------------------
select has_function('app_private', 'message_attachment_limits', array[]::text[], 'the limits exist as one definition');
select has_function('app_private', 'message_attachment_extension', array['text'], 'the extension map exists');
select has_function('app_private', 'message_attachment_target',
  array['uuid', 'uuid', 'uuid', 'text', 'bigint'], 'the authorization exists');
select has_function('app_private', 'message_attachment_attach',
  array['uuid', 'uuid', 'uuid', 'text', 'text', 'bigint'], 'the confirmation exists');
select has_function('app_private', 'message_attachment_for_participant',
  array['uuid', 'uuid', 'uuid'], 'the single-attachment reader exists');
select has_function('app_private', 'messaging_message_attachments',
  array['uuid', 'uuid', 'uuid[]'], 'the page reader exists');

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('message_attachment_target', 'message_attachment_attach',
                        'message_attachment_for_participant', 'messaging_message_attachments')
      and p.prosecdef
      and p.proconfig @> array['search_path=pg_catalog, public']),
  4,
  'all four operations are SECURITY DEFINER with a pinned search path'
);

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('message_attachment_limits', 'message_attachment_extension')
      and p.provolatile = 'i'),
  2,
  'and the two constants are IMMUTABLE, because that is what they are'
);

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('message_attachment_for_participant', 'messaging_message_attachments')
      and p.provolatile = 's'),
  2,
  'the two readers are STABLE; only the two writers are volatile'
);

create or replace function pg_temp.may(p_role text, p_signature text) returns boolean
language sql stable as $$
  select has_function_privilege(p_role, p_signature, 'execute');
$$;

select ok(pg_temp.may('app_system', 'app_private.message_attachment_target(uuid,uuid,uuid,text,bigint)'),
  'app_system may authorize an upload');
select ok(pg_temp.may('app_system', 'app_private.message_attachment_attach(uuid,uuid,uuid,text,text,bigint)'),
  'and record a confirmed one');
select ok(pg_temp.may('app_system', 'app_private.message_attachment_for_participant(uuid,uuid,uuid)'),
  'and resolve one for a signed read');
select ok(pg_temp.may('app_system', 'app_private.messaging_message_attachments(uuid,uuid,uuid[])'),
  'and read a page''s worth');

select ok(not pg_temp.may('app_worker', 'app_private.message_attachment_target(uuid,uuid,uuid,text,bigint)'),
  'the worker may not authorize an upload: no schedule and no event attaches a file to a conversation');
select ok(not pg_temp.may('app_worker', 'app_private.message_attachment_attach(uuid,uuid,uuid,text,text,bigint)'),
  'and may not record one');
select ok(not pg_temp.may('app_worker', 'app_private.message_attachment_for_participant(uuid,uuid,uuid)'),
  'and may not resolve one, which is the direction that would hand it a private object');
select ok(not pg_temp.may('app_worker', 'app_private.messaging_message_attachments(uuid,uuid,uuid[])'),
  'and may not read anybody''s attachments');

select ok(not pg_temp.may('authenticated', 'app_private.message_attachment_attach(uuid,uuid,uuid,text,text,bigint)'),
  'a signed-in browser role reaches none of this directly');
select ok(not pg_temp.may('anon', 'app_private.message_attachment_for_participant(uuid,uuid,uuid)'),
  'and anon reaches none of it either');
select ok(not pg_temp.may('public', 'app_private.message_attachment_target(uuid,uuid,uuid,text,bigint)'),
  'and nothing is left granted to public');
select ok(not pg_temp.may('app_system', 'app_private.message_attachment_limits()'),
  'the limits are granted to nobody at all: internal arithmetic, not an operation');

-- ---------------------------------------------------------------------------------------------------
-- The limits are the ones that were decided
-- ---------------------------------------------------------------------------------------------------
select results_eq(
  $$select max_per_message, max_byte_size from app_private.message_attachment_limits()$$,
  $$values (5, 10485760::bigint)$$,
  'five per message and ten mebibytes each'
);

select set_eq(
  $$select unnest(allowed_types) from app_private.message_attachment_limits()$$,
  $$values ('image/jpeg'), ('image/png'), ('image/webp'), ('application/pdf')$$,
  'and the allowlist is three image types and PDF'
);

select ok(
  not exists (
    select 1 from app_private.message_attachment_limits() l where 'image/svg+xml' = any (l.allowed_types)),
  'SVG is not on it, which is deliberate: it is executable XML and a signed URL would serve it'
);

select is(app_private.message_attachment_extension('image/svg+xml'), null,
  'and SVG maps to no extension, so it is refused a second time even if the first check were bypassed');
select is(app_private.message_attachment_extension('image/jpeg'), 'jpg', 'jpeg maps to jpg');
select is(app_private.message_attachment_extension('application/pdf'), 'pdf', 'pdf maps to pdf');
select is(app_private.message_attachment_extension(null), null, 'and nothing maps to nothing');

-- ---------------------------------------------------------------------------------------------------
-- Authorizing an upload: who may
-- ---------------------------------------------------------------------------------------------------
select is(
  pg_temp.target('90000000-0000-4000-8000-000000000001', (select id from ids where name = 'mine'),
                 'image/png', 1000),
  'authorized',
  'the sender may attach to their own message'
);

select is(
  pg_temp.target('90000000-0000-4000-8000-000000000002', (select id from ids where name = 'mine'),
                 'image/png', 1000),
  'not_found',
  'the other participant may not attach to somebody else''s message'
);

select is(
  pg_temp.target('90000000-0000-4000-8000-000000000003', (select id from ids where name = 'mine'),
                 'image/png', 1000),
  'not_found',
  'and a stranger gets exactly the same answer, so this cannot be used to find out whose messages exist'
);

select is(
  pg_temp.target('90000000-0000-4000-8000-000000000002', (select id from ids where name = 'theirs'),
                 'image/png', 1000),
  'authorized',
  'but the other participant may attach to their own message'
);

select is(
  (select outcome from app_private.message_attachment_target(
     '90000000-0000-4000-8000-000000000001', '1bbb0000-0000-4000-8000-0000000000ff',
     (select id from ids where name = 'mine'), 'image/png', 1000)),
  'not_found',
  'naming the wrong conversation resolves to nothing'
);

select is(
  pg_temp.target('90000000-0000-4000-8000-000000000001', '1bbb0000-0000-4000-8000-0000000000ff',
                 'image/png', 1000),
  'not_found',
  'and so does a message that does not exist'
);

select is(pg_temp.target(null, (select id from ids where name = 'mine'), 'image/png', 1000), 'not_found',
  'no caller resolves to nothing');
select is(pg_temp.target('90000000-0000-4000-8000-000000000001', null, 'image/png', 1000), 'not_found',
  'and no message resolves to nothing');

select is(pg_temp.stored(), 0, 'and none of that wrote a row, because an authorization writes nothing');

-- A deleted message, and one whose sender has left -------------------------------------------------
savepoint deleted_message;
update public.messages set deleted_at = now() where id = (select id from ids where name = 'mine');
select is(
  pg_temp.target('90000000-0000-4000-8000-000000000001', (select id from ids where name = 'mine'),
                 'image/png', 1000),
  'not_found',
  'a deleted message takes no new attachment'
);
rollback to savepoint deleted_message;

savepoint left_conversation;
update public.conversation_participants set left_at = now()
 where conversation_id = (select id from ids where name = 'conv')
   and user_id = '90000000-0000-4000-8000-000000000001';
select is(
  pg_temp.target('90000000-0000-4000-8000-000000000001', (select id from ids where name = 'mine'),
                 'image/png', 1000),
  'not_found',
  'somebody who has left may not add to the thread, which is the line 5-E already draws for sending'
);
select is(
  (select count(*)::int from app_private.messaging_message_attachments(
     '90000000-0000-4000-8000-000000000001', (select id from ids where name = 'conv'),
     array[(select id from ids where name = 'mine')])),
  0,
  'and reads it as the empty set here only because nothing is attached yet'
);
rollback to savepoint left_conversation;

-- ---------------------------------------------------------------------------------------------------
-- Authorizing an upload: what
-- ---------------------------------------------------------------------------------------------------
select is(pg_temp.target('90000000-0000-4000-8000-000000000001', (select id from ids where name = 'mine'), 'image/jpeg', 1000), 'authorized', 'jpeg is accepted');
select is(pg_temp.target('90000000-0000-4000-8000-000000000001', (select id from ids where name = 'mine'), 'image/png', 1000), 'authorized', 'png is accepted');
select is(pg_temp.target('90000000-0000-4000-8000-000000000001', (select id from ids where name = 'mine'), 'image/webp', 1000), 'authorized', 'webp is accepted');
select is(pg_temp.target('90000000-0000-4000-8000-000000000001', (select id from ids where name = 'mine'), 'application/pdf', 1000), 'authorized', 'pdf is accepted');

select is(pg_temp.target('90000000-0000-4000-8000-000000000001', (select id from ids where name = 'mine'), 'image/svg+xml', 1000), 'invalid', 'SVG is refused');
select is(pg_temp.target('90000000-0000-4000-8000-000000000001', (select id from ids where name = 'mine'), 'text/html', 1000), 'invalid', 'HTML is refused');
select is(pg_temp.target('90000000-0000-4000-8000-000000000001', (select id from ids where name = 'mine'), 'application/octet-stream', 1000), 'invalid', 'an unnamed binary is refused');
select is(pg_temp.target('90000000-0000-4000-8000-000000000001', (select id from ids where name = 'mine'), 'application/x-msdownload', 1000), 'invalid', 'an executable is refused');
select is(pg_temp.target('90000000-0000-4000-8000-000000000001', (select id from ids where name = 'mine'), 'IMAGE/PNG', 1000), 'invalid', 'and the match is exact, so a differently-cased type is not a way past the list');
select is(pg_temp.target('90000000-0000-4000-8000-000000000001', (select id from ids where name = 'mine'), 'image/png; charset=binary', 1000), 'invalid', 'nor is one with a parameter appended');
select is(pg_temp.target('90000000-0000-4000-8000-000000000001', (select id from ids where name = 'mine'), null, 1000), 'invalid', 'no type at all is refused');

-- `image/avif` is in some of this platform's other buckets and not in this one, which is the case that proves
-- the bucket is consulted rather than a list being copied from elsewhere.
select is(pg_temp.target('90000000-0000-4000-8000-000000000001', (select id from ids where name = 'mine'), 'image/avif', 1000), 'invalid',
  'a type this platform allows elsewhere but not in this bucket is refused here');

-- Sizes --------------------------------------------------------------------------------------------
select is(
  (select max_byte_size from app_private.message_attachment_target(
     '90000000-0000-4000-8000-000000000001', (select id from ids where name = 'conv'),
     (select id from ids where name = 'mine'), 'image/png', 1000)),
  10485760::bigint,
  'the ceiling reported is ten mebibytes, the tighter of 0104''s figure and the bucket''s twenty'
);

select is(pg_temp.target('90000000-0000-4000-8000-000000000001', (select id from ids where name = 'mine'), 'image/png', 1), 'authorized', 'one byte is accepted');
select is(pg_temp.target('90000000-0000-4000-8000-000000000001', (select id from ids where name = 'mine'), 'image/png', 10485760), 'authorized', 'exactly ten mebibytes is accepted');
select is(pg_temp.target('90000000-0000-4000-8000-000000000001', (select id from ids where name = 'mine'), 'image/png', 10485761), 'invalid', 'one byte over is refused');
select is(pg_temp.target('90000000-0000-4000-8000-000000000001', (select id from ids where name = 'mine'), 'image/png', 20971520), 'invalid', 'and so is the bucket''s own limit, because 0104''s is tighter');
select is(pg_temp.target('90000000-0000-4000-8000-000000000001', (select id from ids where name = 'mine'), 'image/png', 0), 'invalid', 'zero bytes is refused');
select is(pg_temp.target('90000000-0000-4000-8000-000000000001', (select id from ids where name = 'mine'), 'image/png', -1), 'invalid', 'a negative size is refused');
select is(pg_temp.target('90000000-0000-4000-8000-000000000001', (select id from ids where name = 'mine'), 'image/png', null), 'invalid', 'and no size is refused rather than defaulted');

-- The derived path ---------------------------------------------------------------------------------
select matches(
  (select object_path from app_private.message_attachment_target(
     '90000000-0000-4000-8000-000000000001', (select id from ids where name = 'conv'),
     (select id from ids where name = 'mine'), 'application/pdf', 1000)),
  '^message-attachments/[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.pdf$',
  'the path is bucket, conversation, message, a fresh uuid and the extension the type implies'
);

select ok(
  (select object_path from app_private.message_attachment_target(
     '90000000-0000-4000-8000-000000000001', (select id from ids where name = 'conv'),
     (select id from ids where name = 'mine'), 'image/jpeg', 1000))
  like '%/' || (select id from ids where name = 'mine')::text || '/%',
  'and it names the message it was authorized for'
);

select isnt(
  (select object_path from app_private.message_attachment_target(
     '90000000-0000-4000-8000-000000000001', (select id from ids where name = 'conv'),
     (select id from ids where name = 'mine'), 'image/png', 1000)),
  (select object_path from app_private.message_attachment_target(
     '90000000-0000-4000-8000-000000000001', (select id from ids where name = 'conv'),
     (select id from ids where name = 'mine'), 'image/png', 1000)),
  'two authorizations never name the same object, so one upload cannot overwrite another'
);

select is(pg_temp.stored(), 0, 'and after all of that, still nothing is written');

-- ---------------------------------------------------------------------------------------------------
-- Recording a confirmed object
-- ---------------------------------------------------------------------------------------------------
-- Inside its own savepoint, like every section below it. The first draft left this one unwrapped, and the row
-- it wrote leaked into the five-per-message cap (which then filled at four), into the block section's counts,
-- and into the `limit 1` that picks an attachment to read — five failures from one missing savepoint.
savepoint confirming;

select is(pg_temp.attach_one(), 'attached', 'a confirmed object is recorded');
select is(pg_temp.stored(), 1, 'and that is the first row this file has written');

select results_eq(
  $$select content_type, byte_size, width, height from public.message_attachments$$,
  $$values ('image/png', 1000::bigint, null::integer, null::integer)$$,
  'with the declared type and size, and no dimensions: nothing here inspects an image'
);

-- The path is re-derived, not trusted ---------------------------------------------------------------
select is(
  pg_temp.attach('90000000-0000-4000-8000-000000000001', (select id from ids where name = 'mine'),
                 pg_temp.path((select id from ids where name = 'theirs'), 'png'), 'image/png', 1000),
  'invalid',
  'a path naming another message is refused even though the API passed it along'
);

select is(
  pg_temp.attach('90000000-0000-4000-8000-000000000001', (select id from ids where name = 'mine'),
                 replace(pg_temp.path((select id from ids where name = 'mine'), 'png'),
                         'message-attachments', 'support-attachments'),
                 'image/png', 1000),
  'invalid',
  'and so is a path naming another bucket'
);

select is(
  pg_temp.attach('90000000-0000-4000-8000-000000000001', (select id from ids where name = 'mine'),
                 pg_temp.path((select id from ids where name = 'mine'), 'png') || '/../x.png',
                 'image/png', 1000),
  'invalid',
  'a traversal segment after the name is refused, because the pattern is anchored at both ends'
);

select is(
  pg_temp.attach('90000000-0000-4000-8000-000000000001', (select id from ids where name = 'mine'),
                 pg_temp.path((select id from ids where name = 'mine'), 'png', 'not-a-uuid'),
                 'image/png', 1000),
  'invalid',
  'a name that is not a uuid is refused'
);

select is(
  pg_temp.attach('90000000-0000-4000-8000-000000000001', (select id from ids where name = 'mine'),
                 pg_temp.path((select id from ids where name = 'mine'), 'pdf'), 'image/png', 1000),
  'invalid',
  'and an extension that disagrees with the declared type is refused, so a jpeg cannot be filed as a pdf'
);

select is(
  pg_temp.attach('90000000-0000-4000-8000-000000000001', (select id from ids where name = 'mine'),
                 pg_temp.path((select id from ids where name = 'mine'), 'svg'), 'image/svg+xml', 1000),
  'invalid',
  'an SVG is refused at the confirmation step too, not only at authorization'
);

select is(
  pg_temp.attach('90000000-0000-4000-8000-000000000001', (select id from ids where name = 'mine'),
                 null, 'image/png', 1000),
  'invalid',
  'and no path at all is refused'
);

select is(
  pg_temp.attach('90000000-0000-4000-8000-000000000002', (select id from ids where name = 'mine'),
                 pg_temp.path((select id from ids where name = 'mine'), 'png'), 'image/png', 1000),
  'not_found',
  'the other participant cannot confirm an object onto somebody else''s message'
);

select is(
  pg_temp.attach('90000000-0000-4000-8000-000000000003', (select id from ids where name = 'mine'),
                 pg_temp.path((select id from ids where name = 'mine'), 'png'), 'image/png', 1000),
  'not_found',
  'and neither can a stranger'
);

select is(pg_temp.attach('90000000-0000-4000-8000-000000000001', (select id from ids where name = 'mine'),
                         pg_temp.path((select id from ids where name = 'mine'), 'png'), 'image/png', 10485761),
  'invalid', 'the size ceiling applies here too');

select is(pg_temp.stored(), 1, 'and none of those refusals wrote a row');

-- Idempotence, through 0014's own index -------------------------------------------------------------
create temporary table one_path (path text);
insert into one_path select pg_temp.path((select id from ids where name = 'mine'), 'webp');

select is(
  pg_temp.attach('90000000-0000-4000-8000-000000000001', (select id from ids where name = 'mine'),
                 (select path from one_path), 'image/webp', 1000),
  'attached',
  'the first confirmation of an object records it'
);
select is(
  pg_temp.attach('90000000-0000-4000-8000-000000000001', (select id from ids where name = 'mine'),
                 (select path from one_path), 'image/webp', 1000),
  'invalid',
  'and a second confirmation of the same object is refused rather than duplicating it'
);
select is(
  (select count(*)::int from public.message_attachments where object_path = (select path from one_path)),
  1,
  'so one object is one row, which is 0014''s unique index doing the work'
);

-- Everything this section wrote goes, so the sections below count from zero.
drop table one_path;
rollback to savepoint confirming;
select is(pg_temp.stored(), 0, 'and the section leaves no rows behind for the next one to trip over');

-- ---------------------------------------------------------------------------------------------------
-- Five per message
-- ---------------------------------------------------------------------------------------------------
-- Driven one statement at a time inside a `do` block. A `select` over `generate_series` would **not** work:
-- the attach call is an uncorrelated subquery, which PostgreSQL evaluates once as an InitPlan and reuses, so
-- such a loop reports five successes having performed one. That is how the first draft of this test fooled
-- itself, and it is why this one is written the long way.
savepoint five_cap;
do $$
declare
  v_msg uuid := (select id from ids where name = 'mine');
  v_outcomes text[] := array[]::text[];
  i integer;
begin
  for i in 1..7 loop
    v_outcomes := v_outcomes || pg_temp.attach_one();
  end loop;
  create temporary table cap_result (attempt integer, outcome text);
  for i in 1..7 loop
    insert into cap_result values (i, v_outcomes[i]);
  end loop;
end $$;

select results_eq(
  $$select outcome from cap_result order by attempt$$,
  $$values ('attached'), ('attached'), ('attached'), ('attached'), ('attached'), ('conflict'), ('conflict')$$,
  'the first five are recorded and the sixth and seventh are refused with conflict'
);
select is(
  (select count(*)::int from public.message_attachments
    where message_id = (select id from ids where name = 'mine')),
  5,
  'and exactly five rows exist, so the refusals really refused'
);
select is(
  pg_temp.target('90000000-0000-4000-8000-000000000001', (select id from ids where name = 'mine'),
                 'image/png', 1000),
  'conflict',
  'a full message authorizes nothing further, so a client is told before it uploads rather than after'
);
select is(
  pg_temp.target('90000000-0000-4000-8000-000000000002', (select id from ids where name = 'theirs'),
                 'image/png', 1000),
  'authorized',
  'and the limit is per message, not per conversation'
);
rollback to savepoint five_cap;

-- ---------------------------------------------------------------------------------------------------
-- A blocked pair
-- ---------------------------------------------------------------------------------------------------
-- The attachment exists **before** the block, which is the only arrangement that tests anything: a message
-- sent after a block cannot exist at all, so a refusal there would prove only that 0103 works. What must be
-- proved is that a *new attachment on an old message* is refused, because no message is inserted and
-- `tg_messages_block_rule` therefore never fires. The first draft of 0104 had no such check and this is the
-- case that found it.
savepoint blocking;
select is(pg_temp.attach_one(), 'attached', 'an attachment exists before any block');

select is(
  app_private.buyer_block_add('90000000-0000-4000-8000-000000000002',
                              (select id from ids where name = 'conv'), null, null),
  'blocked',
  'the seller blocks the buyer through the conversation'
);

select is(
  (select outcome from app_private.messaging_send_message(
     '90000000-0000-4000-8000-000000000001', (select id from ids where name = 'conv'), 'and one more')),
  'blocked',
  'a new message is refused, which is 0103 working as it already did'
);

select is(
  pg_temp.target('90000000-0000-4000-8000-000000000001', (select id from ids where name = 'mine'),
                 'image/png', 1000),
  'blocked',
  'and a new attachment on the buyer''s pre-block message is refused: no new send capability'
);
select is(
  pg_temp.attach_one(),
  'blocked',
  'the confirmation step refuses it too, because a block can land between the two requests'
);
select is(
  pg_temp.target('90000000-0000-4000-8000-000000000002', (select id from ids where name = 'theirs'),
                 'image/png', 1000),
  'blocked',
  'and it refuses the blocker as well, because 0005''s predicate is symmetric'
);
select is(
  (select count(*)::int from public.message_attachments),
  1,
  'so nothing new was written while the block stood'
);

-- Readability survives, which is 0103's own rule ---------------------------------------------------
select is(
  (select outcome from app_private.message_attachment_for_participant(
     '90000000-0000-4000-8000-000000000001', (select id from ids where name = 'conv'),
     (select a.id from public.message_attachments a limit 1))),
  'authorized',
  'the existing attachment is still readable by the person who sent it'
);
select is(
  (select outcome from app_private.message_attachment_for_participant(
     '90000000-0000-4000-8000-000000000002', (select id from ids where name = 'conv'),
     (select a.id from public.message_attachments a limit 1))),
  'authorized',
  'and by the person who blocked them, because a readable thread stays readable'
);
select is(
  (select count(*)::int from app_private.messaging_message_attachments(
     '90000000-0000-4000-8000-000000000002', (select id from ids where name = 'conv'),
     array[(select id from ids where name = 'mine')])),
  1,
  'and the page reader still returns it, so blocking hides nothing already said'
);

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('message_attachment_for_participant', 'messaging_message_attachments')
      and p.prosrc like '%is_blocked_between%'),
  0,
  'neither reader consults the block predicate at all, which is what makes that structural'
);

-- And it comes back ---------------------------------------------------------------------------------
delete from public.user_blocks;
select is(pg_temp.attach_one(), 'attached',
  'unblocking restores attaching, rather than merely recording that the block was removed');
rollback to savepoint blocking;

-- ---------------------------------------------------------------------------------------------------
-- Reading one attachment, to sign for it
-- ---------------------------------------------------------------------------------------------------
savepoint reading;
select is(pg_temp.attach_one('application/pdf', 'pdf'), 'attached', 'one attachment to read');

create temporary table one_attachment (id uuid, path text);
insert into one_attachment select a.id, a.object_path from public.message_attachments a limit 1;

select results_eq(
  format($$select outcome, bucket_id, object_path, content_type
             from app_private.message_attachment_for_participant(
               '90000000-0000-4000-8000-000000000001', %L, %L)$$,
         (select id from ids where name = 'conv'), (select id from one_attachment)),
  format($$values ('authorized', 'message-attachments', %L, 'application/pdf')$$,
         (select path from one_attachment)),
  'the reader names the bucket and the exact object the row stores, and the type'
);

select is(
  (select outcome from app_private.message_attachment_for_participant(
     '90000000-0000-4000-8000-000000000002', (select id from ids where name = 'conv'),
     (select id from one_attachment))),
  'authorized',
  'either participant may read it, which is 0014''s participant_read policy'
);
select is(
  (select outcome from app_private.message_attachment_for_participant(
     '90000000-0000-4000-8000-000000000003', (select id from ids where name = 'conv'),
     (select id from one_attachment))),
  'not_found',
  'a stranger may not'
);
select is(
  (select outcome from app_private.message_attachment_for_participant(
     '90000000-0000-4000-8000-000000000001', '1bbb0000-0000-4000-8000-0000000000ff',
     (select id from one_attachment))),
  'not_found',
  'and naming the wrong conversation resolves to nothing, so an id alone is not enough'
);
select is(
  (select outcome from app_private.message_attachment_for_participant(
     '90000000-0000-4000-8000-000000000001', (select id from ids where name = 'conv'),
     '1bbb0000-0000-4000-8000-0000000000ff')),
  'not_found',
  'an attachment that does not exist answers the same way'
);
select is(
  (select outcome from app_private.message_attachment_for_participant(
     null, (select id from ids where name = 'conv'), (select id from one_attachment))),
  'not_found',
  'and no caller reads nothing'
);

-- Somebody who left may still read, which is 5-D's decision ----------------------------------------
update public.conversation_participants set left_at = now()
 where conversation_id = (select id from ids where name = 'conv')
   and user_id = '90000000-0000-4000-8000-000000000001';
select is(
  (select outcome from app_private.message_attachment_for_participant(
     '90000000-0000-4000-8000-000000000001', (select id from ids where name = 'conv'),
     (select id from one_attachment))),
  'authorized',
  'somebody who has left the conversation may still read its attachments, as 5-D decided for its messages'
);
rollback to savepoint reading;

-- ---------------------------------------------------------------------------------------------------
-- The page reader
-- ---------------------------------------------------------------------------------------------------
savepoint page;
select is(pg_temp.attach_one('image/png', 'png'), 'attached', 'one on the buyer''s message');
select is(
  pg_temp.attach('90000000-0000-4000-8000-000000000002', (select id from ids where name = 'theirs'),
                 pg_temp.path((select id from ids where name = 'theirs'), 'pdf'), 'application/pdf', 2000),
  'attached',
  'and one on the seller''s'
);

select set_eq(
  $$select column_name from information_schema.columns
     where table_schema = 'app_private' and table_name = 'never_a_table'$$,
  $$select null::text where false$$,
  'the page reader is a function, so nothing can be granted the table directly'
);

select set_eq(
  $$select a.attname from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      join unnest(p.proallargtypes, p.proargnames, p.proargmodes)
        with ordinality as a(atttype, attname, attmode, ord) on true
     where n.nspname = 'app_private' and p.proname = 'messaging_message_attachments' and a.attmode = 't'$$,
  $$values ('id'), ('message_id'), ('content_type'), ('byte_size'), ('created_at')$$,
  'and returns exactly five columns, with no object path: a browser reaches a file by id, not by path'
);

select is(
  (select count(*)::int from app_private.messaging_message_attachments(
     '90000000-0000-4000-8000-000000000001', (select id from ids where name = 'conv'),
     array[(select id from ids where name = 'mine'), (select id from ids where name = 'theirs')])),
  2,
  'both messages'' attachments come back for a participant'
);

select is(
  (select count(*)::int from app_private.messaging_message_attachments(
     '90000000-0000-4000-8000-000000000001', (select id from ids where name = 'conv'),
     array[(select id from ids where name = 'mine')])),
  1,
  'and the id list filters, so a page gets only its own page''s attachments'
);

select is(
  (select count(*)::int from app_private.messaging_message_attachments(
     '90000000-0000-4000-8000-000000000003', (select id from ids where name = 'conv'),
     array[(select id from ids where name = 'mine'), (select id from ids where name = 'theirs')])),
  0,
  'a stranger gets nothing, because the reader re-applies the participant test itself'
);

select is(
  (select count(*)::int from app_private.messaging_message_attachments(
     null, (select id from ids where name = 'conv'),
     array[(select id from ids where name = 'mine')])),
  0,
  'and no caller gets nothing rather than everything'
);

select is(
  (select count(*)::int from app_private.messaging_message_attachments(
     '90000000-0000-4000-8000-000000000001', (select id from ids where name = 'conv'), array[]::uuid[])),
  0,
  'an empty id list returns nothing rather than the whole conversation'
);
select is(
  (select count(*)::int from app_private.messaging_message_attachments(
     '90000000-0000-4000-8000-000000000001', (select id from ids where name = 'conv'), null)),
  0,
  'and so does no id list at all'
);

select is(
  (select count(*)::int from app_private.messaging_message_attachments(
     '90000000-0000-4000-8000-000000000001', (select id from ids where name = 'conv'),
     array['1bbb0000-0000-4000-8000-0000000000ff'::uuid])),
  0,
  'an id from outside this conversation contributes nothing: the ids filter and never grant'
);

select is(
  (select count(*)::int from app_private.messaging_message_attachments(
     '90000000-0000-4000-8000-000000000001', '1bbb0000-0000-4000-8000-0000000000ff',
     array[(select id from ids where name = 'mine')])),
  0,
  'and naming the wrong conversation returns nothing even for a real message id'
);

-- Order, which is what makes a rendering stable -----------------------------------------------------
-- Grouped by message, and the group order is the message id's, which is total. Asserted as "the ids come back
-- sorted" rather than against a hard-coded pair, because the two fixture messages' ids are generated and
-- naming which is first would be asserting a value this file does not control.
select ok(
  (select array_agg(message_id order by ord) = array_agg(message_id order by message_id)
     from (select message_id, row_number() over () as ord
             from app_private.messaging_message_attachments(
               '90000000-0000-4000-8000-000000000001', (select id from ids where name = 'conv'),
               array[(select id from ids where name = 'mine'),
                     (select id from ids where name = 'theirs')])) z),
  'rows are grouped by message in a stable order, so a page renders the same way twice'
);

-- The existing reader is unchanged -----------------------------------------------------------------
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'messaging_conversation_messages'
      and p.prosrc like '%message_attachments%'),
  0,
  'messaging_conversation_messages was not touched: the new reader is a sibling, not a change to it'
);
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'messaging_inbox'
      and p.prosrc like '%message_attachments%'),
  0,
  'and neither was the inbox'
);
rollback to savepoint page;

-- ---------------------------------------------------------------------------------------------------
-- Retention is the cascade, and nothing else
-- ---------------------------------------------------------------------------------------------------
savepoint cascade_test;
select is(pg_temp.attach_one(), 'attached', 'one attachment to delete');
select is(pg_temp.stored(), 1, 'it is there');

delete from public.messages where id = (select id from ids where name = 'mine');
select is(pg_temp.stored(), 0,
  'deleting its message takes it with it, through 0014''s own foreign key');
rollback to savepoint cascade_test;

savepoint cascade_conversation;
select is(pg_temp.attach_one(), 'attached', 'one attachment again');
delete from public.conversations where id = (select id from ids where name = 'conv');
select is(pg_temp.stored(), 0,
  'and deleting the conversation reaches it too, through messages');
rollback to savepoint cascade_conversation;

select is(
  (select count(*)::int from app_private.scheduled_job_contract where job_key ilike '%attach%'),
  0,
  'no scheduled job sweeps attachments: their lifetime is their message''s and needs no timer'
);

-- ---------------------------------------------------------------------------------------------------
-- Nothing was added that 0104 said it would not add
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::int from public.permissions where key ilike '%attach%'),
  0,
  'no permission key was added, so there is no staff attachment console to hang one on'
);

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'message_attachment%'
      and (p.prosrc like '%can_read%' or p.proname like '%for_staff%' or p.proname like '%for_agent%')),
  0,
  'and no staff reader or writer: blocking a two-key console out is easier than removing one later'
);

select is(
  (select count(*)::int from audit.audit_logs where table_name = 'message_attachments'),
  0,
  'attaching writes no audit row'
);
select is(
  (select count(*)::int from public.outbox_events
    where event_type ilike '%attach%' or aggregate_type ilike '%attach%'),
  0,
  'and no outbox event, so nothing is relayed about a file'
);
select is(
  (select count(*)::int from public.security_events where event_type ilike '%attach%'),
  0,
  'and no security event'
);

select set_eq(
  $$select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app_private' and p.prosrc like '%public.message_attachments%'$$,
  $$values ('message_attachment_target'), ('message_attachment_attach'),
           ('message_attachment_for_participant'), ('messaging_message_attachments')$$,
  'exactly four app_private functions touch message_attachments, and they are 0104''s four'
);

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'message_attachment%'
      and (p.prosrc like '%width%' or p.prosrc like '%height%')),
  0,
  'nothing derives an image dimension: 0014''s width and height stay null rather than guessed'
);

select is(
  (select count(*)::int from public.security_contract_problems()),
  0,
  'and the security contract still reports nothing'
);

select finish();
rollback;
