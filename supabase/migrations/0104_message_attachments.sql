-- 0104 — Conversation message attachments: the four functions for `public.message_attachments`, which 0014
-- created and 0053 deliberately left unread.
--
-- 0014 created the table with its primary key, its three check constraints, its unique `object_path` index and
-- its two RLS policies, and 0014's migration also provisioned the private `message-attachments` bucket with a
-- size limit and an allowed MIME list. The messaging contract then wrote the deferral down in so many words:
--
--   > **There is no attachment field.** 0014 has a `message_attachments` table and 0053 deliberately does not
--   > read it; these contracts deliberately cannot describe it. Attachments are a later increment and adding
--   > the shape now would be the first half of building them.
--
-- This is that later increment. **Nothing in 0014 is modified** — not the table, not a constraint, not the
-- unique index, not either policy, and not the bucket.
--
-- ---------------------------------------------------------------------------------------------------
-- THE SHAPE OF THE FLOW, AND WHY IT HAS THREE STEPS
-- ---------------------------------------------------------------------------------------------------
--
-- A message exists first, then an upload is authorized against it, then the uploaded object is confirmed and
-- the row is written. Three steps rather than one, and the reason is the middle one: **the row must not exist
-- because an upload was *allowed*, only because an object *arrived*.** A row written at authorization time is
-- a row that may point at nothing — a client that asked and then closed its laptop leaves a message showing an
-- attachment that cannot be downloaded, and no amount of retrying fixes it because the row already exists.
-- This is 7-?'s `support_attachment_*` sequence applied to a conversation, and it is applied rather than
-- reinvented: `..._target` authorizes, `..._attach` records, and the object's existence is checked between
-- them by the API against the storage provider.
--
-- ---------------------------------------------------------------------------------------------------
-- THE OWNER DECISIONS THIS MIGRATION ENFORCES
-- ---------------------------------------------------------------------------------------------------
--
-- **1. The sender only.** 0014's `message_attachments_sender_insert` policy says the attacher must be the
-- message's sender; both functions below carry `m.sender_user_id = p_user_id` in the same predicate that finds
-- the message, so a message belonging to somebody else is **never matched** rather than refused — which is
-- what makes "not yours" and "does not exist" the same answer. The other participant may *read* an
-- attachment, which is 0014's `message_attachments_participant_read` policy, and the reader below follows it.
--
-- **2. Five per message, ten mebibytes each — technical safety limits, not business rules.** 0014 set neither,
-- and neither is added to the table: a constraint would be a change to 0014. They are enforced here, where a
-- limit that is a safety measure belongs, and the byte limit is the **tighter of this increment's figure and
-- the bucket's own**, so neither can be loosened by changing only one of them. The bucket is 20 MiB and is
-- left alone; 0104 asks for 10.
--
-- **3. An explicit server-side allowlist, and no SVG.** The bucket's `allowed_mime_types` is the outer
-- authority and is read at call time rather than copied, exactly as the support path does it — but this
-- migration also names its own list, and a type must satisfy **both**. SVG is not in either, and the reason it
-- is called out rather than merely omitted is that an SVG is a script container: it is XML the browser will
-- execute, so serving one from a signed URL on any origin is a stored-XSS primitive. A content type that
-- cannot be mapped to one of four extensions is refused, so a browser cannot smuggle a type past the list by
-- naming something the list happens to contain while uploading something else — the stored filename always
-- agrees with the declared type.
--
-- **4. The row is written only after the object is confirmed, and the database derives the path.** A browser
-- never supplies a path. `message_attachment_target` composes one — `message-attachments/<conversation>/<message>/<uuid>.<ext>`
-- — and `message_attachment_attach` re-derives the prefix and matches the tail against a pattern, so a path
-- outside the message's own namespace is refused even though the API believed it. The uniqueness of
-- `object_path` is 0014's own index, so a confirmation that arrives twice records the file once and the
-- second attempt is refused by the database rather than by a lookup that could race it.
--
-- **5. There are no attachment-only messages.** 0014's `messages_text_has_body` requires a body of 1–5000
-- characters and is **not** modified. A message therefore always has text, and an attachment is something
-- added to a message rather than a kind of message — which also means nothing here can create a message, and
-- the only way to get one is 5-E's `messaging_send_message`, with every rule it already applies.
--
-- **6. A ten-minute signed read.** The lifetime is not here: it belongs to the storage adapter, which signs
-- for a number of seconds the caller may name. This migration's reader returns the bucket and the object path
-- and nothing else, which is the same division 7-G chose — the database says *which* object, the adapter says
-- *for how long*.
--
-- **7. A blocked pair gains nothing, and loses nothing already said.** Both writers consult
-- `public.is_blocked_between` against every other live participant and answer `blocked`. **That check is not
-- redundant, and the first draft of this migration was wrong to think so.** The reasoning that failed was:
-- attaching requires a message, `tg_messages_block_rule` refuses the insert that would create one, therefore
-- 0103 already covers this path. It does not — a message that *already exists* needs no insert, so after a
-- block the blocked party could still attach a **new** file to an old message of their own, and the other
-- person would watch a new file appear in a thread they had blocked. Verified by execution before the check
-- existed: `message_attachment_target` answered `authorized` for a pre-block message of a now-blocked seller.
-- A new attachment is new content delivered to somebody who blocked you, whatever row it hangs from.
--
-- The **readers** deliberately have no such check. Attachments on messages that already exist stay readable to
-- both participants, which is 0103's own rule that historical conversations remain readable; blocking takes
-- away the next thing sent, not the record of the last one.
--
-- **8. An attachment lives as long as its message.** 0014's foreign key is `on delete cascade` and that is the
-- whole retention policy: no sweeper, no scheduled job, no separate lifetime. Nothing is added to the
-- scheduled-job contract.
--
-- **9. Catch-up is not a separate path.** 5-F polls the same read endpoint a page load uses, so the sibling
-- reader below serves both and no authorization semantics change: it re-applies the participant test itself
-- rather than trusting that its caller already did.
--
-- ---------------------------------------------------------------------------------------------------
-- WHAT IS NOT HERE
-- ---------------------------------------------------------------------------------------------------
--
-- No change to `public.message_attachments`, `public.messages`, `tg_messages_block_rule`,
-- `messaging_send_message`, `messaging_conversation_messages`, `messaging_inbox` or the
-- `message-attachments` bucket. No attachment-only message. No moderation of attachments and no staff
-- attachment console: a staff reader would need a permission key, and none is added. No virus or content
-- scanning — there is none anywhere in this platform, and a private bucket plus a short signed URL limits
-- exposure to the two participants but is not a substitute for scanning; that is recorded, not implied. No
-- thumbnailing, transcoding or derived rendition. No image-dimension derivation: 0014's `width` and `height`
-- stay null, because nothing in this repository inspects an image and guessing would be worse than null. No
-- public media origin. No new permission key. No scheduled job. Nothing financial: no payment, payout,
-- settlement, refund, seller-balance, provider or financial-setting table or function is read or written here.

-- ---------------------------------------------------------------------------------------------------
-- The limits, named once
-- ---------------------------------------------------------------------------------------------------
-- Written as a function rather than inlined three times so the three callers cannot drift apart, and so a
-- later change is one edit. `immutable` because it is a constant; granted to nobody, because it is internal
-- arithmetic rather than an operation.
create or replace function app_private.message_attachment_limits()
returns table (max_per_message integer, max_byte_size bigint, allowed_types text[])
language sql
immutable
as $$
  select 5::integer,
         10485760::bigint,                                    -- 10 MiB, owner decision 2
         array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']::text[];
$$;
comment on function app_private.message_attachment_limits() is
  'The technical safety limits for conversation attachments (0104): five per message, ten mebibytes each, and the explicit server-side type allowlist. SVG is absent deliberately — it is executable XML and serving one from a signed URL would be a stored-XSS primitive. The bucket''s own limits are read separately and the tighter of the two applies.';

-- ---------------------------------------------------------------------------------------------------
-- The extension a content type implies
-- ---------------------------------------------------------------------------------------------------
-- One mapping, so the stored filename can never disagree with the declared type, and so the pattern the
-- attach step matches is derived from the same place the target step wrote.
create or replace function app_private.message_attachment_extension(p_content_type text)
returns text
language sql
immutable
as $$
  select case p_content_type
    when 'image/jpeg' then 'jpg'
    when 'image/png' then 'png'
    when 'image/webp' then 'webp'
    when 'application/pdf' then 'pdf'
  end;
$$;
comment on function app_private.message_attachment_extension(text) is
  'The one extension each permitted content type implies (0104). Null for anything else, which is how a type outside the allowlist is refused a second time even if it somehow passed the first.';

-- ---------------------------------------------------------------------------------------------------
-- Authorizing an upload
-- ---------------------------------------------------------------------------------------------------
-- Outcomes: `authorized` with a bucket, a derived object path and the byte ceiling; `blocked` when either party
-- has blocked the other; `conflict` when the message already holds five; `invalid` for a type or size this
-- platform will not take; `not_found` for a message that is not the caller's own, in a conversation they are
-- not in, or that does not exist — one answer for all three, so this cannot be used to find out whose messages
-- exist.
--
-- It writes nothing. An authorization that is never used leaves no trace, which is the whole point of
-- decision 4.
create or replace function app_private.message_attachment_target(
  p_user_id uuid,
  p_conversation_id uuid,
  p_message_id uuid,
  p_content_type text,
  p_byte_size bigint
) returns table (outcome text, bucket_id text, object_path text, max_byte_size bigint)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_bucket text := 'message-attachments';
  v_found boolean;
  v_bucket_limit bigint;
  v_bucket_types text[];
  v_limits record;
  v_ceiling bigint;
  v_extension text;
  v_count integer;
begin
  if p_user_id is null or p_conversation_id is null or p_message_id is null then
    return query select 'not_found'::text, null::text, null::text, null::bigint;
    return;
  end if;

  -- Owner decision 1, in the predicate that finds the row rather than in a branch after it: the message must
  -- be this caller's own, in this conversation, and they must still be a live participant of it. Somebody who
  -- has left may read the thread (5-D's decision) but may not add to it, which is the same line 5-E draws for
  -- sending.
  select true into v_found
    from public.messages m
    join public.conversation_participants p
      on p.conversation_id = m.conversation_id
     and p.user_id = p_user_id
     and p.left_at is null
   where m.id = p_message_id
     and m.conversation_id = p_conversation_id
     and m.sender_user_id = p_user_id
     and m.deleted_at is null;

  if v_found is not true then
    return query select 'not_found'::text, null::text, null::text, null::bigint;
    return;
  end if;

  -- Owner decision 7. A new attachment on an existing message is new content reaching the other party, and
  -- `tg_messages_block_rule` cannot see it because no message is being inserted. 0005's predicate is
  -- symmetric, so this refuses both the blocker and the blocked.
  if exists (
    select 1 from public.conversation_participants p
     where p.conversation_id = p_conversation_id
       and p.user_id <> p_user_id
       and p.left_at is null
       and public.is_blocked_between(p_user_id, p.user_id)
  ) then
    return query select 'blocked'::text, null::text, null::text, null::bigint;
    return;
  end if;

  -- The bucket is the outer authority on what may be stored in it, read at call time rather than copied, so a
  -- later tightening of the bucket takes effect here without this function being touched.
  select b.file_size_limit, b.allowed_mime_types into v_bucket_limit, v_bucket_types
    from storage.buckets b
   where b.id = v_bucket;

  if v_bucket_limit is null or v_bucket_types is null then
    -- Authorizing an upload into a bucket whose rules cannot be read would be authorizing an unbounded one.
    return query select 'invalid'::text, null::text, null::text, null::bigint;
    return;
  end if;

  select * into v_limits from app_private.message_attachment_limits();
  -- The tighter of the two, so neither can be loosened alone.
  v_ceiling := least(v_bucket_limit, v_limits.max_byte_size);

  -- Both lists must admit it. Owner decision 3.
  if p_content_type is null
     or not (p_content_type = any (v_bucket_types))
     or not (p_content_type = any (v_limits.allowed_types)) then
    return query select 'invalid'::text, null::text, null::text, null::bigint;
    return;
  end if;
  if p_byte_size is null or p_byte_size <= 0 or p_byte_size > v_ceiling then
    return query select 'invalid'::text, null::text, null::text, null::bigint;
    return;
  end if;

  v_extension := app_private.message_attachment_extension(p_content_type);
  if v_extension is null then
    return query select 'invalid'::text, null::text, null::text, null::bigint;
    return;
  end if;

  -- Owner decision 2's count, checked here so a client is told before it uploads rather than after.
  select count(*)::integer into v_count
    from public.message_attachments a
   where a.message_id = p_message_id;

  if v_count >= v_limits.max_per_message then
    return query select 'conflict'::text, null::text, null::text, null::bigint;
    return;
  end if;

  -- The namespace is derived, never supplied. The conversation is in the path as well as the message because
  -- it makes the prefix independently checkable against the request that asked for it.
  return query select
    'authorized'::text,
    v_bucket,
    v_bucket || '/' || p_conversation_id::text || '/' || p_message_id::text || '/'
      || gen_random_uuid()::text || '.' || v_extension,
    v_ceiling;
end;
$$;
comment on function app_private.message_attachment_target(uuid, uuid, uuid, text, bigint) is
  'Authorizes one attachment upload against the caller''s own message and derives its object path. Writes nothing: a row exists only once the object is confirmed. Refuses a blocked pair, because a new attachment on an existing message is new content the block trigger cannot see. The byte ceiling is the tighter of 0104''s limit and the bucket''s, and a content type must satisfy both allowlists.';

-- ---------------------------------------------------------------------------------------------------
-- Recording a confirmed object
-- ---------------------------------------------------------------------------------------------------
-- Called only after the API has asked the storage provider whether the object is actually there. Every check
-- the target step made is made again, because an authorization is not a token and the two calls are separate
-- requests: the message may have been deleted, the fifth attachment may have landed in between, and the path
-- the API hands back must still belong to this message.
create or replace function app_private.message_attachment_attach(
  p_user_id uuid,
  p_conversation_id uuid,
  p_message_id uuid,
  p_object_path text,
  p_content_type text,
  p_byte_size bigint
) returns table (outcome text, attachment_id uuid, attachment_count integer)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_bucket text := 'message-attachments';
  v_found boolean;
  v_bucket_limit bigint;
  v_bucket_types text[];
  v_limits record;
  v_ceiling bigint;
  v_expected_prefix text;
  v_tail text;
  v_count integer;
  v_attachment_id uuid;
begin
  if p_user_id is null or p_conversation_id is null or p_message_id is null then
    return query select 'not_found'::text, null::uuid, null::integer;
    return;
  end if;

  -- The same predicate as the target step, plus a lock on the message so two confirmations from a retrying
  -- client serialize and the second sees the first one's row rather than racing the count.
  select true into v_found
    from public.messages m
    join public.conversation_participants p
      on p.conversation_id = m.conversation_id
     and p.user_id = p_user_id
     and p.left_at is null
   where m.id = p_message_id
     and m.conversation_id = p_conversation_id
     and m.sender_user_id = p_user_id
     and m.deleted_at is null
   for update of m;

  if v_found is not true then
    return query select 'not_found'::text, null::uuid, null::integer;
    return;
  end if;

  -- Checked again here and not only in the target step, because the two are separate requests and a block can
  -- land between them — which is exactly when it matters most.
  if exists (
    select 1 from public.conversation_participants p
     where p.conversation_id = p_conversation_id
       and p.user_id <> p_user_id
       and p.left_at is null
       and public.is_blocked_between(p_user_id, p.user_id)
  ) then
    return query select 'blocked'::text, null::uuid, null::integer;
    return;
  end if;

  select b.file_size_limit, b.allowed_mime_types into v_bucket_limit, v_bucket_types
    from storage.buckets b
   where b.id = v_bucket;

  if v_bucket_limit is null or v_bucket_types is null then
    return query select 'invalid'::text, null::uuid, null::integer;
    return;
  end if;

  select * into v_limits from app_private.message_attachment_limits();
  v_ceiling := least(v_bucket_limit, v_limits.max_byte_size);

  if p_content_type is null
     or not (p_content_type = any (v_bucket_types))
     or not (p_content_type = any (v_limits.allowed_types)) then
    return query select 'invalid'::text, null::uuid, null::integer;
    return;
  end if;
  if p_byte_size is null or p_byte_size <= 0 or p_byte_size > v_ceiling then
    return query select 'invalid'::text, null::uuid, null::integer;
    return;
  end if;

  -- The path is re-derived and matched rather than trusted. A path for another message, another conversation,
  -- another bucket or with a traversal segment in it fails here even though the API passed it along.
  v_expected_prefix := v_bucket || '/' || p_conversation_id::text || '/' || p_message_id::text || '/';
  if p_object_path is null or left(p_object_path, length(v_expected_prefix)) <> v_expected_prefix then
    return query select 'invalid'::text, null::uuid, null::integer;
    return;
  end if;

  -- One uuid and one of four extensions, anchored at both ends: nothing else can follow the prefix. The
  -- extension must also be the one this content type implies, so a jpeg cannot be filed as a pdf.
  v_tail := substr(p_object_path, length(v_expected_prefix) + 1);
  if v_tail !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|pdf)$'
     or v_tail !~ ('\.' || app_private.message_attachment_extension(p_content_type) || '$') then
    return query select 'invalid'::text, null::uuid, null::integer;
    return;
  end if;

  select count(*)::integer into v_count
    from public.message_attachments a
   where a.message_id = p_message_id;

  if v_count >= v_limits.max_per_message then
    return query select 'conflict'::text, null::uuid, null::integer;
    return;
  end if;

  begin
    insert into public.message_attachments (message_id, object_path, content_type, byte_size)
    values (p_message_id, p_object_path, p_content_type, p_byte_size)
    returning id into v_attachment_id;
  exception
    -- 0014's unique `object_path` index is what makes a repeated confirmation record the file once; the other
    -- three are its check and key constraints, answering as a refusal rather than as a 500.
    when unique_violation or check_violation or foreign_key_violation or restrict_violation then
      return query select 'invalid'::text, null::uuid, null::integer;
      return;
  end;

  return query select 'attached'::text,
                      v_attachment_id,
                      (select count(*)::integer from public.message_attachments a
                        where a.message_id = p_message_id);
end;
$$;
comment on function app_private.message_attachment_attach(uuid, uuid, uuid, text, text, bigint) is
  'Records one confirmed attachment on the caller''s own message. Re-derives the object path and re-checks every limit and the block predicate, because an authorization is not a token and the two calls are separate requests. 0014''s unique object_path index makes a repeated confirmation record the file once.';

-- ---------------------------------------------------------------------------------------------------
-- Reading one attachment, to sign a download for it
-- ---------------------------------------------------------------------------------------------------
-- Either participant, which is 0014's `message_attachments_participant_read` policy. **No `left_at` test and
-- no block test**: 5-D decided a participant who has left may still read the thread, and 0103 decided that
-- historical conversations stay readable after a block. An attachment on a message somebody can already read
-- is part of that message.
--
-- The path comes out of the row, never from the request, so a signed read is always for the one object this
-- row points at.
create or replace function app_private.message_attachment_for_participant(
  p_user_id uuid,
  p_conversation_id uuid,
  p_attachment_id uuid
) returns table (outcome text, bucket_id text, object_path text, content_type text)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_path text;
  v_content_type text;
begin
  if p_user_id is null or p_conversation_id is null or p_attachment_id is null then
    return query select 'not_found'::text, null::text, null::text, null::text;
    return;
  end if;

  select a.object_path, a.content_type into v_path, v_content_type
    from public.message_attachments a
    join public.messages m on m.id = a.message_id
    join public.conversation_participants p
      on p.conversation_id = m.conversation_id
     and p.user_id = p_user_id
   where a.id = p_attachment_id
     and m.conversation_id = p_conversation_id;

  if v_path is null then
    return query select 'not_found'::text, null::text, null::text, null::text;
    return;
  end if;

  return query select 'authorized'::text, 'message-attachments'::text, v_path, v_content_type;
end;
$$;
comment on function app_private.message_attachment_for_participant(uuid, uuid, uuid) is
  'Resolves one attachment to the object a signed read should target, for either participant of its conversation. No left_at test and no block test, because 5-D and 0103 both decided a readable thread stays readable. The path comes from the row, never from the request.';

-- ---------------------------------------------------------------------------------------------------
-- The attachments on a page of messages
-- ---------------------------------------------------------------------------------------------------
-- A sibling of `messaging_conversation_messages`, not a change to it. 5-F polls the same endpoint a page load
-- uses, so one reader serves both, and the existing reader keeps its exact shape and its exact plan.
--
-- **It re-applies the participant test itself.** The caller has already passed it to get the page, but a
-- reader that trusted its caller's claim of authorization would be a reader that could be called wrongly
-- exactly once. The message ids are a filter, not a grant: an id from another conversation contributes
-- nothing because `m.conversation_id = p_conversation_id` is in the predicate.
--
-- `object_path` is **not** returned. A path is not a secret, but it is not something a browser needs either —
-- the download is reached by attachment id, and the one place a path is read is the function above.
create or replace function app_private.messaging_message_attachments(
  p_user_id uuid,
  p_conversation_id uuid,
  p_message_ids uuid[]
) returns table (
  id uuid,
  message_id uuid,
  content_type text,
  byte_size bigint,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select a.id, a.message_id, a.content_type, a.byte_size, a.created_at
    from public.message_attachments a
    join public.messages m on m.id = a.message_id
   where m.conversation_id = p_conversation_id
     and a.message_id = any (coalesce(p_message_ids, array[]::uuid[]))
     and exists (
       select 1 from public.conversation_participants p
        where p.conversation_id = p_conversation_id
          and p.user_id = p_user_id
     )
   order by a.message_id, a.created_at, a.id;
$$;
comment on function app_private.messaging_message_attachments(uuid, uuid, uuid[]) is
  'The attachments on a named set of messages in one conversation, for a participant. A sibling of messaging_conversation_messages rather than a change to it, so one reader serves both a page load and 5-F''s poll. Re-applies the participant test itself; the message ids filter and never grant. Returns no object path.';

-- ---------------------------------------------------------------------------------------------------
-- Execution
-- ---------------------------------------------------------------------------------------------------
revoke execute on all functions in schema app_private from public;

revoke execute on function app_private.message_attachment_limits() from public, app_worker;
revoke execute on function app_private.message_attachment_extension(text) from public, app_worker;
revoke execute on function app_private.message_attachment_target(uuid, uuid, uuid, text, bigint) from public, app_worker;
revoke execute on function app_private.message_attachment_attach(uuid, uuid, uuid, text, text, bigint) from public, app_worker;
revoke execute on function app_private.message_attachment_for_participant(uuid, uuid, uuid) from public, app_worker;
revoke execute on function app_private.messaging_message_attachments(uuid, uuid, uuid[]) from public, app_worker;

-- `app_system` only. The two constant functions are granted to nobody at all: they are internal arithmetic
-- that the three operations call, and nothing outside this schema has a reason to ask what the limits are.
grant execute on function app_private.message_attachment_target(uuid, uuid, uuid, text, bigint) to app_system;
grant execute on function app_private.message_attachment_attach(uuid, uuid, uuid, text, text, bigint) to app_system;
grant execute on function app_private.message_attachment_for_participant(uuid, uuid, uuid) to app_system;
grant execute on function app_private.messaging_message_attachments(uuid, uuid, uuid[]) to app_system;

-- The contract this repository will not ship without.
select app_private.assert_security_contract();
