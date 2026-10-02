-- 0076 — Reports: reporter side (Phase 7-M).
--
-- Two functions, no schema change, no new permission, no new table and no second reporting system. 0027
-- already owns reporting entirely — the `reports` table, the eight subject types, the eleven reason codes,
-- the five statuses, the one-open-report-per-reporter-per-subject unique index, the C10 early return, the
-- audit trigger, the `report.filed` outbox event and `app_private.file_report()` itself. Nothing here
-- changes, wraps or second-guesses any of that.
--
-- ---------------------------------------------------------------------------------------------------
-- Why a wrapper is needed at all
-- ---------------------------------------------------------------------------------------------------
-- `file_report(reporter, subject_type, subject_id, reason_code, details)` takes a subject **id** and,
-- deliberately, authorizes nothing about it: its own comment says a report is polymorphic and the writer
-- is "ignorant of each subject's own visibility rules". 0056 already drew the conclusion for messaging —
-- one thin function per family of subjects, whose only job is authorization, delegating the report itself
-- to 0027. This is that same function for the two subjects a **public** page can produce, and it is
-- modelled on 0056 line for line: the same three outcomes, the same single `not_found` branch, the same
-- delegation on the last line.
--
-- There is a second reason here that messaging did not have, and it is the stronger one:
--
-- **the browser has no subject id to send, and must not be given one.** 0050's `public_seller_by_slug`
-- returns five public fields and explicitly "never the seller id"; a seller report's `subject_id` is a
-- *user* id, which is exactly what that projection exists to withhold. So the only honest handle a public
-- page can report by is the one the page is addressed by — its **slug** — and resolving that slug to a row
-- is a database step, not a browser claim. A request on this surface therefore cannot carry a subject id
-- at all, which is what makes "an arbitrary uuid aimed at the report writer" not a threat to be filtered
-- but a shape that does not exist.
--
-- The resolution reuses the authoritative resolvers rather than restating their rules:
--
--   * a **listing** through 0047's `app_private.public_listing_resolve(slug)`, which is "the single place
--     the public listing-state rules are applied for both surfaces" and which also accepts a *previous*
--     slug, so a report filed from a page reached by an old link lands on the right listing. Its
--     `not_found` — a draft, a rejected listing, a suspended seller's listing, a slug that never
--     existed — is this function's `not_found`, unchanged;
--   * a **seller** by the same predicate 0050's reader uses, `status in ('active', 'suspended')`, because
--     that is precisely the set whose page renders: a suspended seller's profile is reachable and reads
--     "unavailable", and somebody looking at a page they can see must be able to report it.
--
-- ---------------------------------------------------------------------------------------------------
-- The two subject types, and the six that are not here
-- ---------------------------------------------------------------------------------------------------
-- 0027 allows eight: `listing`, `review`, `review_reply`, `message`, `conversation`, `seller`, `user`,
-- `promotion`. **None is added and none is removed.** This function accepts `listing` and `seller` and
-- answers `invalid` for the rest, for reasons that are facts about the repository rather than choices:
--
--   * `message`, `conversation` — already filed, since 5-H, through 0056's `messaging_file_report` and
--     `POST /v1/messaging/reports`. A second path to the same subjects would be the duplicate reporting
--     system this increment is forbidden to build. Untouched.
--   * `review`, `review_reply` — no public surface renders a review. The only review read path is 0064's
--     `seller_reviews`, whose reader is the reviewed seller looking at their own dashboard. There is no
--     page on which one person sees another person's review, so there is no reportable surface to put a
--     control on.
--   * `user` — there is no public profile page for a person. A person is met in a conversation, and that
--     is 5-H's surface.
--   * `promotion` — promotions are read only by the seller who owns them (`/v1/sellers/me/promotions`).
--     No public page shows one.
--
-- ---------------------------------------------------------------------------------------------------
-- What this function refuses, and what it deliberately does not
-- ---------------------------------------------------------------------------------------------------
--   * an unknown subject type, an unknown reason code, or details past `reports_details_length` →
--     `invalid`. The vocabulary is read off 0027's own check constraints and duplicated nowhere: an
--     invalid value is turned into an outcome here rather than into an exception from the insert, so the
--     API never has to read a constraint name to answer a caller;
--   * a subject the public cannot see, or one that is not there → `not_found`, one branch for both, as
--     0056 has it: "there is no 'it exists but you may not report it' outcome, because that sentence is
--     the disclosure";
--   * **reporting yourself** → `own_subject`. 0027 raises `check_violation` for a `seller` or `user`
--     subject whose id is the reporter's own; this returns it as an outcome instead so the API answers a
--     caller rather than logging a database error. The rule is 0027's, the shape is this boundary's.
--   * **reporting your own listing is not refused**, because 0027 does not refuse it — its self-report
--     check covers `seller` and `user` only. Inventing the missing half of that rule here would be a new
--     business rule, so the writer's behaviour stands as it is.
--
-- **Nothing here dedupes.** 0027's C10 early return already makes a repeat land on the report already
-- open and return its id, and `reports_one_open_per_reporter` enforces it in the index. A first filing and
-- a repeat are therefore the same outcome with the same id, which is what lets this surface say one thing
-- either way. No second dedupe mechanism exists in this migration or above it.
--
-- **Nothing here writes an event.** `file_report` enqueues `report.filed` and the `reports_audit` trigger
-- records the insert with `details` redacted. Both happen inside the delegation, once.
--
-- ---------------------------------------------------------------------------------------------------
-- The reporter's own reports
-- ---------------------------------------------------------------------------------------------------
-- 0027's RLS grants the reporter a read of their own rows — `reports_reporter_read`, `using
-- (reporter_user_id = public.current_user_id())` — so a reporter read path is sanctioned by the schema
-- rather than invented here. That policy is row-level, though, and a `reports` row carries moderation
-- state in its columns, so a reader function is where the *projection* is decided.
--
-- **What crosses to the reporter:** their own `id`, `subject_type`, `reason_code` and `details`, the
-- `status` in 0027's own vocabulary, and `created_at`. Plus, when the subject is *still publicly visible*,
-- its current slug and display name — resolved through the same public readers, so a reporter sees what
-- they reported rather than five rows reading "listing", and a subject that has since been removed simply
-- resolves to nothing.
--
-- **What does not, and why each one is a disclosure:** `priority` is triage; `assigned_to`/`assigned_at`
-- name a moderator and say one is on it; `resolution`, `resolution_note`, `resolved_at` and `resolved_by`
-- are the decision, its internal note and its author; `duplicate_of_report_id` is a *different report's*
-- identifier, which is another reporter's row. `subject_id` does not cross either: for a `seller` report
-- it is a user id, which 0050 exists to withhold, and the slug is the handle this surface speaks in.
--
-- `status` is returned as 0027 spells it, because a reduced reporter-facing vocabulary would be an
-- invented one and reporting the outcome of somebody's own report is the read that policy allows.

-- ---------------------------------------------------------------------------------------------------
-- 1. Filing a report from a public page
-- ---------------------------------------------------------------------------------------------------
create or replace function app_private.report_file_for_reporter(
  p_reporter_user_id uuid,
  p_subject_type text,
  p_subject_slug text,
  p_reason_code text,
  p_details text default null
) returns table (
  outcome text,
  report_id uuid
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_subject_id uuid;
  v_details text;
  v_report uuid;
begin
  if p_reporter_user_id is null or p_subject_slug is null or btrim(p_subject_slug) = '' then
    return query select 'not_found'::text, null::uuid;
    return;
  end if;

  -- The two subject types a public page can produce. Everything else 0027 allows belongs to a surface
  -- that either already files its own reports or does not exist; see the header.
  if p_subject_type is null or p_subject_type not in ('listing', 'seller') then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;

  -- 0027's `reports_reason_code_allowed`, checked here so an unknown reason is an answer rather than a
  -- constraint violation from the insert.
  if p_reason_code is null or p_reason_code not in (
    'prohibited_item', 'counterfeit', 'intellectual_property', 'fraud_or_scam', 'harassment',
    'adult_content', 'violence', 'spam', 'misleading', 'off_platform', 'other'
  ) then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;

  -- 0027's `reports_details_length`: null or 1..4000 after trimming. An all-whitespace box is no details
  -- at all rather than a validation failure, which is what the column's nullability is for.
  v_details := nullif(btrim(coalesce(p_details, '')), '');
  if v_details is not null and length(v_details) > 4000 then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;

  if p_subject_type = 'listing' then
    -- 0047's resolver, which owns the public listing-state rules and accepts a previous slug.
    select r.listing_id into v_subject_id
      from app_private.public_listing_resolve(p_subject_slug) r
     where r.outcome in ('found', 'moved');
  else
    -- 0050's own visibility predicate: the set whose profile page renders.
    select s.user_id into v_subject_id
      from public.seller_profiles s
     where s.slug = p_subject_slug and s.status in ('active', 'suspended');
  end if;

  if v_subject_id is null then
    return query select 'not_found'::text, null::uuid;
    return;
  end if;

  -- 0027's rule, returned rather than raised. It covers `seller` and `user`; a listing is not included
  -- there and is not included here.
  if p_subject_type = 'seller' and v_subject_id = p_reporter_user_id then
    return query select 'own_subject'::text, null::uuid;
    return;
  end if;

  -- 0027's entry point, unchanged: it owns the row, the C10 early return that makes a repeat land on the
  -- report already open, the audit trigger and the `report.filed` outbox event.
  v_report := app_private.file_report(
    p_reporter_user_id, p_subject_type, v_subject_id, p_reason_code, v_details
  );

  return query select 'filed'::text, v_report;
end;
$$;

comment on function app_private.report_file_for_reporter(uuid, text, text, text, text) is
  'Files a report about a listing or a seller the caller can actually see, through 0027''s file_report. Authorization and slug resolution are the only things it adds: the subject is named by its public slug, never by an id from a browser, a subject the public cannot see and one that does not exist answer identically, and any other subject type is invalid. Reporting yourself is own_subject. A repeat lands on the report already open, because 0027 does. Creates no moderation action and changes nothing about the subject.';

-- ---------------------------------------------------------------------------------------------------
-- 2. The reporter's own reports
-- ---------------------------------------------------------------------------------------------------
-- Newest first over `(created_at desc, id desc)`, seeking from the cursor the previous page ended on. The
-- projection is the one the header argues for: what the reporter wrote, what became of it, and — only
-- while the subject is still publicly visible — what it was about.
create or replace function app_private.reports_for_reporter(
  p_reporter_user_id uuid,
  p_limit integer,
  p_cursor_created_at timestamptz default null,
  p_cursor_id uuid default null
) returns table (
  id uuid,
  subject_type text,
  subject_slug text,
  subject_label text,
  reason_code text,
  details text,
  status text,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select r.id,
         r.subject_type,
         -- Looked up, not stored: a report survives its subject, so a subject that has since left public
         -- view simply has no slug and no label here. Neither lookup can disclose anything the reader
         -- could not already load for themselves by opening the page.
         case when r.subject_type = 'listing' then l.slug when r.subject_type = 'seller' then s.slug end,
         case when r.subject_type = 'listing' then l.title when r.subject_type = 'seller' then s.display_name end,
         r.reason_code,
         r.details,
         r.status,
         r.created_at
    from public.reports r
    left join public.listings l
      on r.subject_type = 'listing'
     and l.id = r.subject_id
     and public.listing_status_is_public(l.status)
     and public.is_seller_publicly_visible(l.seller_user_id)
    left join public.seller_profiles s
      on r.subject_type = 'seller'
     and s.user_id = r.subject_id
     and s.status in ('active', 'suspended')
   where r.reporter_user_id = p_reporter_user_id
     and p_reporter_user_id is not null
     and (
       p_cursor_created_at is null
       or p_cursor_id is null
       or (r.created_at, r.id) < (p_cursor_created_at, p_cursor_id)
     )
   order by r.created_at desc, r.id desc
   limit least(greatest(coalesce(p_limit, 20), 1), 51);
$$;

comment on function app_private.reports_for_reporter(uuid, integer, timestamptz, uuid) is
  'One page of the caller''s own reports, newest first, as 0027''s reports_reporter_read policy allows. It returns what the reporter wrote and the status in 0027''s own vocabulary, and — only while the subject is still publicly visible — that subject''s slug and label. It never returns the subject id, the priority, the assignee, the resolution, the resolution note, the resolver or the report this one was ruled a duplicate of.';

-- ---------------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on function app_private.report_file_for_reporter(uuid, text, text, text, text) from public;
revoke execute on function app_private.reports_for_reporter(uuid, integer, timestamptz, uuid) from public;
grant execute on function app_private.report_file_for_reporter(uuid, text, text, text, text) to app_system;
grant execute on function app_private.reports_for_reporter(uuid, integer, timestamptz, uuid) to app_system;

select app_private.assert_security_contract();
