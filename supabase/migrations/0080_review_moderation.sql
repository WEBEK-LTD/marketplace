-- 0080 — Review moderation, the admin side (Phase 7-P).
--
-- Six functions, no schema change, no new permission, no new status and no new writer for anything this
-- repository already writes. 0026 owns everything substantive: the reviews, the replies, the four statuses,
-- the rating view, the automatic reassessment and `moderate_review` itself.
--
-- ---------------------------------------------------------------------------------------------------
-- Why a migration is needed at all
-- ---------------------------------------------------------------------------------------------------
-- The same reason every admin increment has had one. 0026 defines the staff capability as two row-level
-- policies for the `authenticated` database role:
--
--     reviews_staff_read              has_permission('reviews.review.read')
--     reviews_staff_moderate          has_permission('reviews.review.moderate') and is_aal2()
--     review_replies_staff_read       has_permission('reviews.review.read')
--     review_replies_staff_moderate   has_permission('reviews.review.moderate') and is_aal2()
--
-- A policy for `authenticated` is a rule about a session carrying JWT claims. This application does not
-- connect that way: `app_system` is `noinherit`, holds no table privileges (0003, S8), and `withRlsContext`
-- is forbidden in production code. So each policy describes a capability authorized in the database and
-- reachable by nothing — until a named `app_private` function exists for it. The readers below are that, and
-- they add nothing those policies do not already permit: each restates 0003's own permission rule with the
-- assurance level as a parameter and the key as a **literal**.
--
-- **Read is gated at `aal2` here too.** `reviews_staff_read` does not AND `is_aal2()`, but all three roles
-- that hold `reviews.review.read` — moderator, admin, super_admin — are `requires_mfa` in 0033, so the
-- predicate's own `(not r.requires_mfa or p_is_aal2)` refuses staff at `aal1`. The same effective outcome
-- 7-G, 7-L, 7-N and 7-O reach the same way, without strengthening or weakening a policy.
--
-- ---------------------------------------------------------------------------------------------------
-- ONE CAPABILITY IS NOT IMPLEMENTED, AND THIS IS WHERE THE GAP IS RECORDED
-- ---------------------------------------------------------------------------------------------------
-- **Moderating a review *reply* has no authoritative writer.**
--
-- `public.review_replies` carries `status` — the same four values a review has — together with
-- `moderation_reason`, `moderated_at` and `moderated_by`, and `review_replies_staff_moderate` authorizes a
-- holder of `reviews.review.moderate` at `aal2` to set them. But **nothing writes them.** The only write to
-- that table anywhere in this repository is the seller's own `insert` inside 0026's `reply_to_review`;
-- `moderate_review` takes a review id and updates `public.reviews` alone. There is no
-- `moderate_review_reply`, and no function sets a reply's status.
--
-- Writing one means deciding, with no approved rule to read off:
--
--     * whether the four review statuses mean the same thing on a reply, or whether a reply is only ever
--       published or removed;
--     * whether moderating a reply requires the same key as moderating a review, or a narrower one;
--     * whether a reply may be moderated while its review stays published — the case the gap is actually
--       about — and whether doing so should record anything against the review;
--     * whether `reassess_review_publication`, which deliberately never overrides a moderator, should have
--       an equivalent for replies at all;
--     * whether removing a review should cascade to its reply, or whether the computed rule below is enough.
--
-- **The gap is narrower than it first appears**, and that is worth stating precisely rather than leaving to
-- inference. `review_replies_public_read` requires the **parent review** to be `published`:
--
--     using (status = 'published'
--            and exists (select 1 from public.reviews r
--                         where r.id = review_id and r.status = 'published'
--                           and public.is_seller_publicly_visible(r.seller_user_id)))
--
-- So hiding or removing a review **already** hides its reply, publicly, with no reply row written — the same
-- computed-visibility shape as seller status and listings. What the missing writer would add is the ability
-- to act on an abusive reply while leaving a fair review published. That is a real case; it is not the
-- common one.
--
-- So **replies are read-only on this surface**: the detail below returns a review's reply so a moderator can
-- read what was said, and no function in this migration or above it can change it. Reported for decision.
--
-- ---------------------------------------------------------------------------------------------------
-- What `moderate_review` decides, and what this migration therefore does not
-- ---------------------------------------------------------------------------------------------------
-- The wrapper at the end passes the caller's account to 0026's writer and translates its outcome. Every rule
-- is that writer's:
--
--   * **the four statuses** — `published`, `pending_moderation`, `hidden`, `removed` — and no transition
--     matrix at all. 0026 accepts any of the four from any of the four, so this migration invents none: a
--     matrix here would be a rule the database does not have. Re-recording the status a review already holds
--     is accepted too, with a new reason and a new timestamp, which is how a decision is re-affirmed;
--   * **a reason is always required**, and the writer raises without one;
--   * **nobody moderates a review they are a party to** — the writer refuses a moderator who is the buyer or
--     the seller, which is why the readers report `is_party` rather than making a console guess;
--   * **`auto_hidden_reason` is cleared** on any decision, and `published_at` moves only when publishing;
--   * **a moderator's decision is final against automation**: `reassess_review_publication` returns 0 for any
--     review whose `moderated_at` is set, so hiding a refunded order's review never overrides a human.
--
-- The wrapper adds the permission test and the assurance level, and **checks nothing a second time**.
--
-- ---------------------------------------------------------------------------------------------------
-- What these readers return, and what they do not
-- ---------------------------------------------------------------------------------------------------
--   * **No account identifier, in either direction.** A review carries `buyer_user_id`, `seller_user_id` and
--     `moderated_by`, and not one of them crosses. The seller is named by the **slug** and display name their
--     own public projection already publishes; the buyer is not named at all, because a moderation screen
--     judges what was written and does not need to know who wrote it; and a colleague who already ruled is
--     reported as `moderated_by_me` rather than named.
--   * **No order identifier.** A review is tied to an order, and the order's state matters only through
--     `review_publication_block`, which answers `order_refunded`, `payment_disputed` or nothing. That reason
--     is returned; the order it came from is not, because a moderation screen has no business reaching an
--     order from a review.
--   * **No rating arithmetic.** 0026's `seller_ratings` view is the only aggregate, it counts published
--     reviews only, and it is a view precisely so it cannot drift. Nothing here recomputes it, and nothing
--     here reports a score, a ranking or a trend.
--   * **The reply is returned, and cannot be changed.** Its body, status and moderation reason are read so a
--     moderator can see the whole exchange. There is no writer for it — see the gap above.
--   * **Nothing is redacted and nothing is invented.** A review's own title and body are what a moderator is
--     there to read.

-- ---------------------------------------------------------------------------------------------------
-- 1. The two predicates
-- ---------------------------------------------------------------------------------------------------
-- 0003's own rule with the assurance level supplied instead of read from a claim, and each key written as a
-- **literal** so that no caller anywhere can name a different one. Two functions rather than one taking a
-- key, for the reason 0078 states: a shared `holds_key(user, aal2, key)` reachable from `app_system` would be
-- a generic permission oracle, and the point of the pattern is that the key is not a value that travels.
--
-- The two keys are held by the same three roles in 0033 — moderator, admin, super_admin — and they are still
-- two predicates, because 0026's policies are two policies. A later decision that narrows either key finds
-- one place to change per capability rather than one place for both.
create or replace function app_private.review_can_read(
  p_user_id uuid,
  p_is_aal2 boolean
) returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
      from public.user_roles ur
      join public.roles r on r.key = ur.role_key
      join public.role_permissions rp on rp.role_key = r.key
     where ur.user_id = p_user_id
       and ur.revoked_at is null
       and (ur.expires_at is null or ur.expires_at > now())
       and rp.permission_key = 'reviews.review.read'
       and (not r.requires_mfa or coalesce(p_is_aal2, false))
  );
$$;

create or replace function app_private.review_can_moderate(
  p_user_id uuid,
  p_is_aal2 boolean
) returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
      from public.user_roles ur
      join public.roles r on r.key = ur.role_key
      join public.role_permissions rp on rp.role_key = r.key
     where ur.user_id = p_user_id
       and ur.revoked_at is null
       and (ur.expires_at is null or ur.expires_at > now())
       and rp.permission_key = 'reviews.review.moderate'
       and (not r.requires_mfa or coalesce(p_is_aal2, false))
  );
$$;

comment on function app_private.review_can_read(uuid, boolean) is
  'True when the account holds reviews.review.read in a session strong enough for the role that grants it — the key 0026''s own staff read policies require. Gates the review queue, one review and its reply.';
comment on function app_private.review_can_moderate(uuid, boolean) is
  'True when the account holds reviews.review.moderate in a session strong enough for the role that grants it — the key 0026''s own staff moderate policy requires, which also ANDs is_aal2(). Gates the one decision wrapper, and nothing else: moderating a review *reply* has no writer in this repository.';

-- ---------------------------------------------------------------------------------------------------
-- 2. The review queue
-- ---------------------------------------------------------------------------------------------------
-- Newest first over `(created_at, id)`, optionally narrowed to one of 0026's four statuses — compared as a
-- parameter, so an unknown value matches nothing rather than building a predicate.
--
-- **Newest first, not a work queue.** Unlike the support and recovery queues, there is no oldest-first claim
-- to make here: 0026 publishes a review immediately and `pending_moderation` is a state a moderator puts one
-- into, not one a buyer's review arrives in. A moderator narrows by status; the order is by age, and there is
-- no score, no priority and no ranking, because the schema defines none.
create or replace function app_private.review_queue_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_limit integer,
  p_status text default null,
  p_cursor_created_at timestamptz default null,
  p_cursor_id uuid default null
) returns table (
  id uuid,
  rating smallint,
  title text,
  status text,
  has_body boolean,
  auto_hidden_reason text,
  is_moderated boolean,
  moderated_by_me boolean,
  is_party boolean,
  seller_slug text,
  seller_display_name text,
  has_reply boolean,
  reply_status text,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select v.id,
         v.rating,
         v.title,
         v.status,
         -- Whether there is prose to read, so a queue row can say so without carrying four thousand
         -- characters of it. The body itself is on the detail.
         v.body is not null and btrim(v.body) <> '',
         v.auto_hidden_reason,
         v.moderated_at is not null,
         v.moderated_by is not null and v.moderated_by = p_user_id,
         -- 0026 refuses a moderator who is the buyer or the seller. Reported so a console can say so before
         -- a colleague tries, rather than after the writer refuses them.
         v.buyer_user_id = p_user_id or v.seller_user_id = p_user_id,
         s.slug,
         s.display_name,
         p.id is not null,
         p.status,
         v.created_at
    from public.reviews v
    join public.seller_profiles s on s.user_id = v.seller_user_id
    left join public.review_replies p on p.review_id = v.id
   where p_user_id is not null
     and app_private.review_can_read(p_user_id, p_is_aal2)
     and (p_status is null or v.status = p_status)
     and (
       p_cursor_created_at is null
       or p_cursor_id is null
       or (v.created_at, v.id) < (p_cursor_created_at, p_cursor_id)
     )
   order by v.created_at desc, v.id desc
   limit least(greatest(coalesce(p_limit, 20), 1), 51);
$$;

comment on function app_private.review_queue_for_staff(uuid, boolean, integer, text, timestamptz, uuid) is
  'One page of reviews for a colleague holding reviews.review.read at aal2, newest first, optionally narrowed to one of 0026''s four statuses. A row carries the rating, the title, the state and whether a reply exists — and no buyer, no seller account, no colleague moderator and no order: the storefront is named by its slug, and the reader learns only whether a decision was their own and whether they are a party to the review.';

-- ---------------------------------------------------------------------------------------------------
-- 3. One review, with its reply
-- ---------------------------------------------------------------------------------------------------
-- The whole of what a moderator is there to judge: what was written, what state it is in, why automation
-- hid it if it did, whether a human has already ruled, and what the seller said back.
--
-- `publication_block` is 0026's own `review_publication_block` — `order_refunded`, `payment_disputed` or
-- nothing. It is the reason the automatic reassessment would hide this review, reported so a moderator
-- publishing one can see they are overriding it. **The order it came from is not returned.**
create or replace function app_private.review_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_review_id uuid
) returns table (
  outcome text,
  id uuid,
  rating smallint,
  title text,
  body text,
  status text,
  auto_hidden_reason text,
  moderation_reason text,
  moderated_at timestamptz,
  moderated_by_me boolean,
  is_party boolean,
  can_moderate boolean,
  publication_block text,
  seller_slug text,
  seller_display_name text,
  seller_status text,
  reply_body text,
  reply_status text,
  reply_moderation_reason text,
  reply_created_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_user_id is null or p_review_id is null
     or not app_private.review_can_read(p_user_id, p_is_aal2) then
    return query select 'not_found'::text, null::uuid, null::smallint, null::text, null::text, null::text,
                        null::text, null::text, null::timestamptz, null::boolean, null::boolean,
                        null::boolean, null::text, null::text, null::text, null::text, null::text,
                        null::text, null::text, null::timestamptz, null::timestamptz, null::timestamptz;
    return;
  end if;

  return query
    select 'found'::text,
           v.id,
           v.rating,
           v.title,
           v.body,
           v.status,
           v.auto_hidden_reason,
           v.moderation_reason,
           v.moderated_at,
           v.moderated_by is not null and v.moderated_by = p_user_id,
           v.buyer_user_id = p_user_id or v.seller_user_id = p_user_id,
           -- The capability, not the key: whether this same session may record a decision. It is here
           -- because the read is gated on one key and the write on another, so a screen would otherwise
           -- have to guess and would offer a control the database refuses.
           app_private.review_can_moderate(p_user_id, p_is_aal2),
           public.review_publication_block(v.order_id),
           s.slug,
           s.display_name,
           s.status,
           p.body,
           p.status,
           p.moderation_reason,
           p.created_at,
           v.created_at,
           v.updated_at
      from public.reviews v
      join public.seller_profiles s on s.user_id = v.seller_user_id
      left join public.review_replies p on p.review_id = v.id
     where v.id = p_review_id;

  if not found then
    return query select 'not_found'::text, null::uuid, null::smallint, null::text, null::text, null::text,
                        null::text, null::text, null::timestamptz, null::boolean, null::boolean,
                        null::boolean, null::text, null::text, null::text, null::text, null::text,
                        null::text, null::text, null::timestamptz, null::timestamptz, null::timestamptz;
  end if;
end;
$$;

comment on function app_private.review_for_staff(uuid, boolean, uuid) is
  'One review for a colleague holding reviews.review.read at aal2, with the seller''s reply beside it. A review that does not exist and a caller without the key answer identically. It carries what was written, the state, the automatic hiding reason, any decision already recorded, and 0026''s own publication block so a moderator can see what they would be overriding — and never the buyer, the seller''s account, the colleague who ruled, or the order. The reply is read-only: no writer for a reply''s status exists in this repository.';

-- ---------------------------------------------------------------------------------------------------
-- 4. The moderation history of one review
-- ---------------------------------------------------------------------------------------------------
-- 0027's generic trail, filtered to this review. It is gated on `moderation.action.read` — which is what
-- 0027's own policy gates that table on and is **not** the review read key — so a colleague holding
-- everything else gets nothing, and the console renders no heading at all rather than an empty one.
create or replace function app_private.review_moderation_actions(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_review_id uuid,
  p_limit integer
) returns table (
  id uuid,
  action text,
  reason text,
  notes text,
  report_id uuid,
  is_own_action boolean,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select a.id,
         a.action,
         a.reason,
         a.notes,
         a.report_id,
         a.moderator_user_id = p_user_id,
         a.created_at
    from public.moderation_actions a
   where p_user_id is not null
     and p_review_id is not null
     and app_private.moderation_can_read_actions(p_user_id, p_is_aal2)
     and a.subject_type = 'review'
     and a.subject_id = p_review_id
   order by a.created_at desc, a.id desc
   limit least(greatest(coalesce(p_limit, 20), 1), 51);
$$;

comment on function app_private.review_moderation_actions(uuid, boolean, uuid, integer) is
  'The moderation actions recorded against one review, newest first, for a colleague holding moderation.action.read at aal2 — 0077''s own predicate and the key 0027''s policy gates that table on, which is not the review read key. It reuses 0027''s generic trail rather than creating a second history, and names no colleague: the reader learns only whether an action was their own.';

-- ---------------------------------------------------------------------------------------------------
-- 5. Recording a decision
-- ---------------------------------------------------------------------------------------------------
-- The permission and the assurance level are required here; **every other rule is 0026's.**
-- `moderate_review` locks the row, refuses a moderator who is a party, requires a reason, clears
-- `auto_hidden_reason`, moves `published_at` only when publishing, and enqueues `review.moderated`. Each
-- refusal is returned as an outcome rather than raised.
--
-- **No transition matrix.** 0026 accepts any of its four statuses from any of them, so none is imposed here.
-- Re-recording the status a review already holds is accepted, with a fresh reason and timestamp, because
-- that is how a decision is re-affirmed — and refusing it would be a rule this repository does not have.
create or replace function app_private.review_moderate_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_review_id uuid,
  p_status text,
  p_reason text
) returns table (
  outcome text,
  status text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_status text;
begin
  if p_user_id is null or p_review_id is null
     or not app_private.review_can_moderate(p_user_id, p_is_aal2) then
    return query select 'not_found'::text, null::text;
    return;
  end if;

  -- 0026's own four, and nothing else. Checked before the writer so an unusable status is a validation
  -- failure rather than a database error.
  if p_status is null or p_status not in ('published', 'pending_moderation', 'hidden', 'removed') then
    return query select 'invalid'::text, null::text;
    return;
  end if;
  -- A decision is always recorded with its reason. The writer raises for this; answering here keeps it a
  -- validation failure.
  if btrim(coalesce(p_reason, '')) = '' then
    return query select 'reason_required'::text, null::text;
    return;
  end if;

  begin
    v_status := app_private.moderate_review(p_review_id, p_status, p_user_id, btrim(p_reason));
  exception
    when no_data_found then
      return query select 'not_found'::text, null::text;
      return;
    when insufficient_privilege then
      -- The caller is the buyer or the seller. 0026's refusal, and it discloses nothing: the only accounts
      -- it concerns are the caller's own relationship to the review.
      return query select 'is_party'::text, null::text;
      return;
    when invalid_parameter_value or check_violation then
      return query select 'invalid'::text, null::text;
      return;
  end;

  -- 0026's trigger has recorded the change in `audit.audit_logs` and its writer has enqueued the outbox
  -- event. This function writes no audit row, no security event and no second outbox event.
  return query select 'moderated'::text, v_status;
end;
$$;

comment on function app_private.review_moderate_for_staff(uuid, boolean, uuid, text, text) is
  'Records a moderation decision on one review through 0026''s moderate_review, requiring reviews.review.moderate at aal2 first. It passes that writer''s four statuses and imposes no transition matrix, because 0026 has none; it requires a reason, and returns the writer''s refusals as outcomes — a review that does not exist, and one the caller is a party to, which nobody moderates. The writer locks the row, clears the automatic hiding reason, moves published_at only when publishing and enqueues the event; nothing here duplicates any of it. It cannot moderate a reply: no writer for one exists.';

-- ---------------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on function app_private.review_can_read(uuid, boolean) from public;
revoke execute on function app_private.review_can_moderate(uuid, boolean) from public;
revoke execute on function app_private.review_queue_for_staff(uuid, boolean, integer, text, timestamptz, uuid) from public;
revoke execute on function app_private.review_for_staff(uuid, boolean, uuid) from public;
revoke execute on function app_private.review_moderation_actions(uuid, boolean, uuid, integer) from public;
revoke execute on function app_private.review_moderate_for_staff(uuid, boolean, uuid, text, text) from public;

grant execute on function app_private.review_can_read(uuid, boolean) to app_system;
grant execute on function app_private.review_can_moderate(uuid, boolean) to app_system;
grant execute on function app_private.review_queue_for_staff(uuid, boolean, integer, text, timestamptz, uuid) to app_system;
grant execute on function app_private.review_for_staff(uuid, boolean, uuid) to app_system;
grant execute on function app_private.review_moderation_actions(uuid, boolean, uuid, integer) to app_system;
grant execute on function app_private.review_moderate_for_staff(uuid, boolean, uuid, text, text) to app_system;

select app_private.assert_security_contract();
