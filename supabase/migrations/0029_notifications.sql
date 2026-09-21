-- 0029 — Notifications (v5.2 Notifications module; UB6, C10, C21).
--
-- The specification gives this module four tables and three of them already exist: `email_templates`,
-- `email_outbox` and `whatsapp_outbox` were built in 0008. This migration adds the fourth,
-- `public.notifications`, and the server-side write paths that make the module the only writer of all
-- four, exactly as the specification requires — other modules emit outbox events and Notifications
-- handles them.
--
-- Creation state and delivery state are deliberately different things, held in different tables:
--
--   * `notifications` is the in-app fact. It is created inside the business transaction, carries what
--     to show and what it is about, and then moves only through `published_at`, `read_at` and
--     `archived_at`. Nothing else about it ever changes.
--   * `email_outbox` is the email fact, with its own queued/sending/sent/failed lifecycle and its own
--     retries. A notification that also went out by email points at that row; the two are linked, never
--     merged, so an email retry can never look like a second notification.
--
-- Nothing here bypasses the outbox. Publication to Realtime is an `enqueue_outbox_event()` call in the
-- same transaction as the row it announces, and the email copy goes through 0008's
-- `app_private.queue_email()` rather than touching `email_outbox` directly. Delivery itself stays where
-- it already is: the per-user private topic `user:<id>` that 0014 defined, whose join check already
-- answers true only for that user. No second Realtime mechanism is created here, and the payload stays
-- what the approved Realtime table allows for that topic — the notification id and the minimum display
-- fields, never the variables.
--
-- Channels in V1 are in-app and email; WhatsApp stays OTP-only (C21) and this migration never queues
-- one. The user's existing `user_settings` flags decide what is produced: `notify_in_app` gates the
-- notification row, `notify_email` gates the email copy, and `marketing_opt_in` gates a marketing
-- notification entirely. No new preferences table is introduced, because the specification does not ask
-- for one.
--
-- Forging is impossible by construction rather than by checking. No role holds INSERT on
-- `notifications`; creation happens only through a SECURITY DEFINER function granted to `app_system`
-- and `app_worker`. A user holds UPDATE on exactly two columns — `read_at` and `archived_at` — through
-- a column-level grant, and a trigger refuses a change to anything else, so neither the recipient, the
-- sender identity, the event type nor the origin can be rewritten even if a grant were widened later.
--
-- `notifications` deliberately carries no audit trigger. The established pattern in this schema audits
-- configuration and decisions — settings, policies, moderation, recovery — and not per-user event rows:
-- `listing_events`, `promotion_events`, `messages` and `support_messages` are all unaudited for the same
-- reason. A row per notification per user would flood `audit.audit_logs` without recording a decision.
-- What is auditable here is already audited elsewhere: the business event that caused the notification.
--
-- UB6's approved rule (a membership change bumps the version and writes its outbox event in the same
-- transaction) is already implemented in 0014 and 0028 and is untouched. The notification *mechanism*
-- that UB6 leaves OPEN until Phase 5 is a client-delivery decision and is not decided here.

-- ---------------------------------------------------------------------------------------------------
-- Notifications
-- ---------------------------------------------------------------------------------------------------
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  category text not null,
  event_type text not null,
  origin text not null default 'system',
  actor_user_id uuid references auth.users (id) on delete set null,
  template_key text not null,
  variables jsonb not null default '{}'::jsonb,
  subject_type text,
  subject_id uuid,
  action_path text,
  is_marketing boolean not null default false,
  dedupe_key text,
  email_outbox_id uuid references public.email_outbox (id) on delete set null,
  published_at timestamptz,
  read_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  constraint notifications_category_allowed check (category in (
    'orders', 'payments', 'payouts', 'listings', 'messages', 'offers', 'reviews', 'promotions',
    'support', 'security', 'account', 'system'
  )),
  constraint notifications_event_type_format check (event_type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  constraint notifications_origin_allowed check (origin in ('system', 'staff')),
  -- A staff-originated notification always names the person; a system one never does.
  constraint notifications_staff_origin_names_the_actor check ((origin = 'staff') = (actor_user_id is not null)),
  constraint notifications_template_key_format check (template_key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),
  constraint notifications_variables_is_object check (jsonb_typeof(variables) = 'object'),
  -- The same rule 0008 puts on WhatsApp variables: a display payload never carries a secret.
  constraint notifications_variables_carry_no_secret check (
    not (variables ?| array['code', 'otp', 'password', 'token', 'secret'])
  ),
  constraint notifications_subject_is_complete check ((subject_type is null) = (subject_id is null)),
  constraint notifications_subject_type_allowed check (subject_type is null or subject_type in (
    'order', 'checkout', 'payment', 'payout', 'withdrawal', 'listing', 'conversation', 'message',
    'offer', 'service_request', 'review', 'promotion', 'support_ticket', 'dispute', 'report',
    'account_recovery', 'seller_verification'
  )),
  -- A relative path only: a notification can never send a user to another host.
  constraint notifications_action_path_is_relative check (
    action_path is null or (action_path ~ '^/[A-Za-z0-9/_\-?=&.%]*$' and action_path !~ '^//')
  ),
  constraint notifications_archived_after_creation check (archived_at is null or archived_at >= created_at),
  constraint notifications_read_after_creation check (read_at is null or read_at >= created_at)
);
comment on table public.notifications is
  'The in-app notification, and the only table in this module the user reads. It is created inside the business transaction that caused it and then moves only through published_at, read_at and archived_at; its content never changes.';
comment on column public.notifications.variables is
  'Substitution values for the template, display-only. It can never carry a code, OTP, password, token or secret, and it is never sent over Realtime — the topic payload is the id and the display fields.';
comment on column public.notifications.subject_id is
  'A reference to what the notification is about, in the table `subject_type` names. References rather than copies: the notification points at the order, it does not restate it.';
comment on column public.notifications.email_outbox_id is
  'The email copy of this notification, if one was queued. The email''s own delivery state lives in email_outbox and stays there; linking them keeps a retry from looking like a second notification.';
comment on column public.notifications.origin is
  'Whether the platform or a named staff member produced this. No role holds INSERT on this table, so neither value can be forged from a session.';

create unique index notifications_dedupe on public.notifications (dedupe_key) where dedupe_key is not null;
create index notifications_inbox on public.notifications (user_id, created_at desc);
-- The unread badge: the smallest index that answers it.
create index notifications_unread on public.notifications (user_id)
  where read_at is null and archived_at is null;
create index notifications_subject on public.notifications (subject_type, subject_id)
  where subject_type is not null;
create index notifications_unpublished on public.notifications (created_at) where published_at is null;

-- Only the three state columns ever move. Everything else is fixed at creation.
create or replace function app_private.tg_notifications_immutable() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.id <> old.id
     or new.user_id <> old.user_id
     or new.category <> old.category
     or new.event_type <> old.event_type
     or new.origin <> old.origin
     or new.actor_user_id is distinct from old.actor_user_id
     or new.template_key <> old.template_key
     or new.variables <> old.variables
     or new.subject_type is distinct from old.subject_type
     or new.subject_id is distinct from old.subject_id
     or new.action_path is distinct from old.action_path
     or new.is_marketing <> old.is_marketing
     or new.dedupe_key is distinct from old.dedupe_key
     or new.created_at <> old.created_at then
    raise exception 'a notification''s content is fixed once it is created' using errcode = 'restrict_violation';
  end if;
  -- Publication happens once; the worker cannot rewrite when it announced something.
  if old.published_at is not null and new.published_at is distinct from old.published_at then
    raise exception 'a notification is published once' using errcode = 'restrict_violation';
  end if;
  if old.email_outbox_id is not null and new.email_outbox_id is distinct from old.email_outbox_id then
    raise exception 'the email copy of a notification cannot be replaced' using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;
comment on function app_private.tg_notifications_immutable() is
  'Keeps everything but read_at, archived_at and the one-time publication and email links fixed. It holds even if the column-level grants were ever widened, so the recipient, the sender identity and the event type can never be rewritten.';

create trigger notifications_immutable before update on public.notifications
  for each row execute function app_private.tg_notifications_immutable();

-- Deleting a notification is not how a user clears their inbox; archiving is.
create or replace function app_private.tg_notifications_no_delete() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  raise exception 'notifications are archived, never deleted' using errcode = 'restrict_violation';
end;
$$;

create trigger notifications_no_delete before delete on public.notifications
  for each row execute function app_private.tg_notifications_no_delete();

-- ---------------------------------------------------------------------------------------------------
-- Reading
-- ---------------------------------------------------------------------------------------------------
create or replace function public.notification_topic(p_user_id uuid) returns text
language sql
immutable
set search_path = pg_catalog
as $$
  -- The same per-user private topic 0014 defined. There is one notification channel, not a second one.
  select format('user:%s', p_user_id);
$$;
comment on function public.notification_topic(uuid) is
  'The private topic a user''s notifications are delivered on: 0014''s per-user topic, unchanged. can_join_realtime_topic() already answers true for it only for that user.';

create or replace function public.unread_notification_count(p_user_id uuid) returns bigint
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select count(*)::bigint
    from public.notifications n
   where n.user_id = p_user_id
     and n.user_id = public.current_user_id()
     and n.read_at is null
     and n.archived_at is null;
$$;
comment on function public.unread_notification_count(uuid) is
  'The badge count, and only ever for the caller: asking about somebody else answers zero rather than erroring, so the function cannot be used to probe another inbox.';

-- ---------------------------------------------------------------------------------------------------
-- Writing — the only path
-- ---------------------------------------------------------------------------------------------------
create or replace function app_private.create_notification(
  p_user_id uuid,
  p_category text,
  p_event_type text,
  p_template_key text,
  p_variables jsonb default '{}'::jsonb,
  p_subject_type text default null,
  p_subject_id uuid default null,
  p_action_path text default null,
  p_dedupe_key text default null,
  p_is_marketing boolean default false,
  p_origin text default 'system',
  p_actor_user_id uuid default null
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  settings public.user_settings;
  existing_id uuid;
  new_notification_id uuid;
begin
  if p_origin not in ('system', 'staff') then
    raise exception 'a notification originates from the system or from named staff, not %', p_origin
      using errcode = 'invalid_parameter_value';
  end if;
  if (p_origin = 'staff') <> (p_actor_user_id is not null) then
    raise exception 'a staff notification names its actor and a system one never does'
      using errcode = 'check_violation';
  end if;

  -- C10: the same key produces one notification however often the handler is retried.
  if p_dedupe_key is not null then
    select n.id into existing_id from public.notifications n where n.dedupe_key = p_dedupe_key;
    if existing_id is not null then
      return existing_id;
    end if;
  end if;

  select * into settings from public.user_settings s where s.user_id = p_user_id;

  -- The user's own settings decide what is produced. A missing row means the defaults 0005 set.
  if p_is_marketing and not coalesce(settings.marketing_opt_in, false) then
    return null;
  end if;
  if not coalesce(settings.notify_in_app, true) then
    return null;
  end if;

  insert into public.notifications (
    user_id, category, event_type, origin, actor_user_id, template_key, variables,
    subject_type, subject_id, action_path, is_marketing, dedupe_key
  )
  values (
    p_user_id, p_category, p_event_type, p_origin, p_actor_user_id, p_template_key,
    coalesce(p_variables, '{}'::jsonb), p_subject_type, p_subject_id, p_action_path,
    p_is_marketing, p_dedupe_key
  )
  returning id into new_notification_id;

  -- Publication goes through the outbox, in this transaction, carrying references and the minimum
  -- display fields the approved Realtime table allows for the per-user topic — never the variables.
  perform public.enqueue_outbox_event(
    'notification', new_notification_id::text, 'notification.created',
    jsonb_build_object(
      'notification_id', new_notification_id,
      'user_id', p_user_id,
      'topic', public.notification_topic(p_user_id),
      'category', p_category,
      'event_type', p_event_type,
      'template_key', p_template_key,
      'subject_type', p_subject_type,
      'subject_id', p_subject_id,
      'action_path', p_action_path
    )
  );

  return new_notification_id;
end;
$$;
comment on function app_private.create_notification(uuid, text, text, text, jsonb, text, uuid, text, text, boolean, text, uuid) is
  'The only way a notification exists. It honours the user''s own channel settings, deduplicates by key (C10), and publishes through the outbox in the same transaction so the Realtime announcement cannot outlive a rolled-back business change.';

create or replace function app_private.attach_notification_email(
  p_notification_id uuid,
  p_to_address text,
  p_subject text,
  p_body_html text,
  p_body_text text,
  p_template_key text default null,
  p_locale_code text default null
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  notification public.notifications;
  settings public.user_settings;
  email_id uuid;
begin
  select * into notification from public.notifications n where n.id = p_notification_id for update;
  if notification.id is null then
    raise exception 'notification % does not exist', p_notification_id using errcode = 'no_data_found';
  end if;
  if notification.email_outbox_id is not null then
    return notification.email_outbox_id; -- C10: already queued
  end if;

  select * into settings from public.user_settings s where s.user_id = notification.user_id;
  if not coalesce(settings.notify_email, true) then
    return null;
  end if;

  -- 0008 owns the email outbox and its dedupe key. This function never writes to it directly.
  email_id := app_private.queue_email(
    p_to_address,
    p_subject,
    p_body_html,
    p_body_text,
    notification.user_id,
    coalesce(p_template_key, notification.template_key),
    p_locale_code,
    format('notification:%s', p_notification_id)
  );

  if email_id is not null then
    update public.notifications set email_outbox_id = email_id where id = p_notification_id;
  end if;
  return email_id;
end;
$$;
comment on function app_private.attach_notification_email(uuid, text, text, text, text, text, text) is
  'Queues the email copy of a notification through 0008''s queue_email and links it. The dedupe key is derived from the notification, so a retried handler produces one email and one link, and the email''s delivery state stays in email_outbox where it belongs.';

create or replace function app_private.mark_notification_published(p_notification_id uuid) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  updated integer;
begin
  update public.notifications
     set published_at = now()
   where id = p_notification_id and published_at is null;
  get diagnostics updated = row_count;
  return updated = 1;
end;
$$;
comment on function app_private.mark_notification_published(uuid) is
  'Records that the worker published this notification to the user''s private topic. Publishing twice records once, which is what makes the relay safe to retry.';

create or replace function app_private.mark_notifications_read(
  p_user_id uuid,
  p_notification_ids uuid[] default null
) returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  marked integer;
begin
  update public.notifications n
     set read_at = now()
   where n.user_id = p_user_id
     and n.read_at is null
     and n.archived_at is null
     and (p_notification_ids is null or n.id = any (p_notification_ids));
  get diagnostics marked = row_count;
  return marked;
end;
$$;
comment on function app_private.mark_notifications_read(uuid, uuid[]) is
  'Marks one user''s notifications read, scoped to that user in the statement itself so a stray id belonging to somebody else simply matches nothing. Users can also do this themselves through the column-level UPDATE grant.';

-- ---------------------------------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------------------------------
alter table public.notifications enable row level security;

create policy notifications_owner_read on public.notifications for select to authenticated
  using (user_id = public.current_user_id());
-- Managing means marking read and archiving. The column-level grant below is what limits it to that;
-- the trigger refuses anything else even if the grant were widened.
create policy notifications_owner_update on public.notifications for update to authenticated
  using (user_id = public.current_user_id())
  with check (user_id = public.current_user_id());

-- No INSERT and no DELETE for anybody: creation is a SECURITY DEFINER function and clearing is
-- archiving. The UPDATE grant names the only two columns a user may move.
grant select on public.notifications to authenticated;
grant update (read_at, archived_at) on public.notifications to authenticated;

-- ---------------------------------------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema app_private from public;

grant execute on function
  public.notification_topic(uuid),
  public.unread_notification_count(uuid)
  to authenticated;

grant execute on function
  public.notification_topic(uuid),
  public.unread_notification_count(uuid),
  app_private.create_notification(uuid, text, text, text, jsonb, text, uuid, text, text, boolean, text, uuid),
  app_private.attach_notification_email(uuid, text, text, text, text, text, text),
  app_private.mark_notification_published(uuid),
  app_private.mark_notifications_read(uuid, uuid[])
  to app_system, app_worker;
