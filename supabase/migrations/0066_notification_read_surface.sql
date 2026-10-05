-- 0066 — The in-app notification read surface (Phase 7-C).
--
-- Three functions, and deliberately only three. 0029 built `public.notifications`, its immutability and
-- no-delete triggers, its RLS, its dedupe index, its only writer (`create_notification`), its publication
-- marker and its read writer (`mark_notifications_read`). 0055 added the one domain that produces
-- notifications today. **Nothing in either is modified here.** What this migration adds is the two reads
-- the surface needs and the one write that was missing.
--
-- **Why new readers when 0029 already has one.** `public.unread_notification_count(uuid)` resolves the
-- caller from `public.current_user_id()`, which reads the JWT `sub` claim. The API connects as
-- `app_system`, which carries no claims, so that function answers zero for every account when called from
-- this architecture — correctly, since it was written for a caller with a session. The API resolves the
-- caller from their own access token and passes the account in, exactly as every reader since 0053 does
-- (`messaging_inbox`, `messaging_unread_count`, `seller_orders`). The 0029 function keeps its grant to
-- `authenticated` and is untouched; these are its `app_system` counterparts, not its replacements.
--
-- **The archived contract is read off the existing schema, not decided here.** Three things in 0029 say
-- the same thing:
--
--   * `notifications_unread` is indexed `where read_at is null and archived_at is null`;
--   * `public.unread_notification_count` counts with that same predicate;
--   * `mark_notifications_read` updates only rows where `archived_at is null`.
--
-- So: the inbox is the unarchived notifications, the archived view is the rest, and the badge counts the
-- unread ones that have not been archived. Archiving is therefore how a row leaves both the inbox and the
-- badge — which is what the table's own comment says: "Deleting a notification is not how a user clears
-- their inbox; archiving is." No new rule is introduced and none is inferred.
--
-- **Ownership is enforced in the statement, not by a check the caller could skip.** Every function here
-- takes the account as its first parameter and puts `user_id = p_user_id` in the predicate itself, so an
-- identifier belonging to somebody else simply matches no rows. There is no branch that decides whether
-- to apply the scope, because there is nothing to decide: a row that is not the caller's is not in the
-- result set. That is the same shape `mark_notifications_read` has had since 0029, and it is why a stray
-- id in an array is harmless rather than dangerous.
--
-- **The projection is narrow on purpose.** The readers return the metadata the surface renders and no
-- more. `variables` is deliberately absent: it is the substitution payload for a template, there is no
-- in-app template renderer in this project, and sending a display payload nobody can render would be
-- shipping data for no reason. `template_key` is absent for the same reason — `public.email_templates`
-- holds no rows, so there is nothing to resolve it against. `origin`, `actor_user_id`, `is_marketing`,
-- `dedupe_key`, `email_outbox_id` and `published_at` are absent because the surface has no use for them
-- and one of them — the staff actor — is a disclosure nobody has approved.
--
-- No new table, no new column, no new constraint, no new index, no change to any existing function, and
-- no new notification category, event type or subject type. Requirement 11 is satisfied by addition of
-- nothing: the vocabularies are 0029's and this file does not restate them.

-- ---------------------------------------------------------------------------------------------------
-- The inbox, and the archived view
-- ---------------------------------------------------------------------------------------------------
-- One function with a flag rather than two nearly identical ones: the order, the keyset and the
-- projection are the same list read two ways, and two copies of them would be two places for the order to
-- drift. The flag is a boolean, so it cannot name a third state.
--
-- The order is `created_at desc, id desc`. `created_at` is `not null`, so unlike the messaging inbox there
-- is no undated tail to place, and the pair is total: `id` is unique, so no two rows tie. That is what
-- makes the keyset deterministic — a page boundary falls in exactly one place, and the same position
-- always yields the same next page.
--
-- The limit is clamped here as well as in the API. The API's bound is the contract; this one is the
-- guarantee, because a reader that can be asked for a million rows is a reader that will be.
create or replace function app_private.notifications_inbox(
  p_user_id uuid,
  p_limit integer default 20,
  p_cursor_created_at timestamptz default null,
  p_cursor_id uuid default null,
  p_archived boolean default false
) returns table (
  id uuid,
  category text,
  event_type text,
  subject_type text,
  subject_id uuid,
  action_path text,
  created_at timestamptz,
  read_at timestamptz,
  archived_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    n.id,
    n.category,
    n.event_type,
    n.subject_type,
    n.subject_id,
    n.action_path,
    n.created_at,
    n.read_at,
    n.archived_at
    from public.notifications n
   where n.user_id = p_user_id
     and (case when coalesce(p_archived, false) then n.archived_at is not null else n.archived_at is null end)
     -- The keyset. Both halves of the cursor must be present for it to mean a position; a half-supplied
     -- cursor reads as no cursor at all rather than as an arbitrary one.
     and (
       p_cursor_created_at is null
       or p_cursor_id is null
       or (n.created_at, n.id) < (p_cursor_created_at, p_cursor_id)
     )
   order by n.created_at desc, n.id desc
   limit least(greatest(coalesce(p_limit, 20), 1), 50)
$$;

comment on function app_private.notifications_inbox(uuid, integer, timestamptz, uuid, boolean) is
  'One page of a user''s own notifications, newest first, ordered by (created_at, id) so the keyset is total and deterministic. p_archived false lists the unarchived inbox and true lists the archived view, which is the split 0029''s own index and unread count already draw. Scoped to p_user_id in the predicate, so another account''s rows are not in the result set. Returns metadata only: never the variables payload, the template key, the staff actor or the email link.';

-- ---------------------------------------------------------------------------------------------------
-- The unread badge
-- ---------------------------------------------------------------------------------------------------
-- The same predicate as `public.unread_notification_count` and as the `notifications_unread` partial
-- index, so the badge, the index and the inbox filter agree by construction rather than by coincidence.
create or replace function app_private.notifications_unread_count(p_user_id uuid) returns bigint
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select count(*)::bigint
    from public.notifications n
   where n.user_id = p_user_id
     and n.read_at is null
     and n.archived_at is null;
$$;

comment on function app_private.notifications_unread_count(uuid) is
  'The badge count for one account: unread and not archived, which is exactly the predicate of 0029''s notifications_unread index and of public.unread_notification_count. The app_system counterpart of that function, which resolves its caller from a JWT claim this architecture does not present.';

-- ---------------------------------------------------------------------------------------------------
-- Archiving
-- ---------------------------------------------------------------------------------------------------
-- The one write that was missing. Shaped to match `mark_notifications_read` exactly, because they are the
-- same kind of operation on the same table and a reader should be able to check one by reading the other:
-- the account is a parameter and appears in the predicate, the `archived_at is null` guard is what makes a
-- repeat harmless, and the return value is the number of rows that actually moved.
--
-- **Idempotent, and observably so.** Archiving a row that is already archived matches nothing, so the
-- second call returns zero and the original `archived_at` stands. A caller cannot use a repeat to change
-- when something was archived, and the API reports success either way — the desired state is reached.
--
-- **The identifiers are required.** `mark_notifications_read` accepts null to mean "all of them", which is
-- what a "mark everything read" action needs. Archiving has no such action and this function accepts no
-- such argument: a call that names nothing archives nothing rather than emptying an inbox. An array
-- containing an id that is not the caller's is harmless for the reason above — it matches no row — so
-- there is no need to refuse it, and refusing it would report on another account's rows.
create or replace function app_private.archive_notifications(
  p_user_id uuid,
  p_notification_ids uuid[]
) returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  archived integer;
begin
  if p_user_id is null then
    raise exception 'a user id is required' using errcode = '22023';
  end if;
  if p_notification_ids is null or cardinality(p_notification_ids) = 0 then
    -- Not an error: naming nothing is a request that archives nothing, and the caller's desired state
    -- (these zero notifications archived) already holds.
    return 0;
  end if;

  update public.notifications n
     set archived_at = now()
   where n.user_id = p_user_id
     and n.archived_at is null
     and n.id = any (p_notification_ids);
  get diagnostics archived = row_count;
  return archived;
end;
$$;

comment on function app_private.archive_notifications(uuid, uuid[]) is
  'Archives named notifications belonging to one account, scoped to that account in the statement so an id belonging to somebody else matches nothing. Idempotent: an already-archived row matches nothing, so a repeat returns zero and never moves archived_at. Requires at least one id — unlike mark_notifications_read it has no "all of them" form, because no approved action needs one. Archiving is how a row leaves both the inbox and the unread badge; nothing is ever deleted.';

-- ---------------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------------
revoke all on function app_private.notifications_inbox(uuid, integer, timestamptz, uuid, boolean) from public;
revoke all on function app_private.notifications_unread_count(uuid) from public;
revoke all on function app_private.archive_notifications(uuid, uuid[]) from public;

-- The API role alone. `authenticated` keeps exactly what 0029 gave it — SELECT under the owner policy,
-- UPDATE on `read_at` and `archived_at`, and execute on 0029's own two helpers — and gains nothing here:
-- under owner Decision 1 (Option B) a browser reaches none of this directly, and a function that took the
-- account as a parameter must never be callable by something that could pass somebody else's.
grant execute on function app_private.notifications_inbox(uuid, integer, timestamptz, uuid, boolean) to app_system;
grant execute on function app_private.notifications_unread_count(uuid) to app_system;
grant execute on function app_private.archive_notifications(uuid, uuid[]) to app_system;

-- ---------------------------------------------------------------------------------------------------
-- The security contract still holds
-- ---------------------------------------------------------------------------------------------------
do $$
begin
  perform app_private.assert_security_contract();
end;
$$;
