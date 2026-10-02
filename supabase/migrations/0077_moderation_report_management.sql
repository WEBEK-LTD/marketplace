-- 0077 — Listing moderation and report management (Phase 7-N).
--
-- Fourteen functions, no schema change, no new permission, no new table, no new status and no second state
-- machine. 0027 and 0011 already own everything substantive: the `reports` table and its five statuses, the
-- `moderation_actions` and `listing_moderation_actions` trails, the ten listing statuses, and the three
-- writers — `resolve_report`, `record_moderation_action` and `moderate_listing`. Nothing here changes,
-- wraps or second-guesses any of it.
--
-- ---------------------------------------------------------------------------------------------------
-- Why a migration is needed at all
-- ---------------------------------------------------------------------------------------------------
-- Two reasons, the same two 7-K and 7-L had:
--
--   * **`app_system` holds no table privileges** (0003, S8), and 0027 defines no reader for `reports`,
--     `moderation_actions` or `listing_moderation_actions`. Their RLS policies are written for
--     `authenticated` — a database session carrying claims — which is not how this application connects.
--     So a queue that is authorized in the database needs a named function, or it does not exist.
--   * **the three writers authorize nothing.** `resolve_report` refuses a moderator ruling on their own
--     report and `moderate_listing` refuses one moderating their own listing, and that is *all* either
--     checks: neither looks at a permission, because both are definer functions whose caller is trusted to
--     have established one. The wrappers below are where the permission and the assurance level are
--     required, and they are the only thing the wrappers add.
--
-- ---------------------------------------------------------------------------------------------------
-- The four permissions, and no fifth
-- ---------------------------------------------------------------------------------------------------
-- All four are keys 0033 already seeds and already grants to `moderator`, `admin` and `super_admin`. Not
-- one is created, granted or reassigned here.
--
--   * `moderation.report.read`     — the report queue, a report's detail, and a report's own history
--   * `moderation.report.manage`   — resolving a report, and nothing else
--   * `moderation.action.read`     — the moderation trails, generic and listing-shaped
--   * `catalog.listing.read`       — the listings awaiting review, and one listing's moderation detail
--   * `catalog.listing.moderate`   — moderating a listing, and nothing else
--
-- That is five keys for five distinct capabilities, which is 0027's and 0011's own split: their policies
-- gate reading reports on `report.read`, writing them on `report.manage` **and `is_aal2()`**, reading
-- actions on `action.read`, and moderating listings on `catalog.listing.moderate` **and `is_aal2()`**. The
-- predicates below restate 0003's rule with the assurance level supplied as a parameter and each key as a
-- **literal**, so no caller can name a different one — the shape 0072, 0075 and this file share.
--
-- **Read is gated at `aal2` here too.** 0027's read policies do not AND `is_aal2()`, but every role that
-- holds these keys is `requires_mfa` in 0033, so the predicate's own `(not r.requires_mfa or p_is_aal2)`
-- already refuses staff at `aal1` — the same effective outcome 7-L has, reached the same way, without
-- strengthening or weakening a policy.
--
-- ---------------------------------------------------------------------------------------------------
-- The report transitions, read off `resolve_report`
-- ---------------------------------------------------------------------------------------------------
--     open → triaged              picked up, with no decision recorded yet. The writer preserves any
--                                 existing note and resolver and nulls `resolution` and `resolved_at`
--     open | triaged → actioned   a decision, with a reason. Stamps `resolved_at` and `resolved_by`
--     open | triaged → dismissed  the same, with the opposite meaning
--     open | triaged → duplicate  the same, and it **must name the original**:
--                                 `reports_duplicate_names_the_original` makes `duplicate_of_report_id`
--                                 required exactly when the status is `duplicate`, and
--                                 `reports_not_its_own_duplicate` refuses a report pointing at itself
--     triaged → triaged           accepted and moves nothing, because `triaged` is not final
--     actioned | dismissed | duplicate → (refused)
--                                 `restrict_violation`: "report % is already %". A closed report is not
--                                 reopened, re-decided or re-noted by this path
--
-- **`open` is not a value this writer accepts.** There is no un-triage and no reopen, and none is invented:
-- the console offers the four the writer takes and nothing else.
--
-- **A reason is required for every close.** The writer raises `check_violation` for an empty note on
-- anything but `triaged`, so the console asks for one and the database is what enforces it.
--
-- **Nobody rules on their own report** — `insufficient_privilege`, 0027's own rule. The detail reader
-- returns `is_own_report` so a moderator is told *before* they try, rather than meeting an opaque refusal.
--
-- **Report assignment is not implemented, because the repository does not support it.** `reports` carries
-- `assigned_to` and `assigned_at`, and **no writer in this repository ever sets either** — there is no
-- `assign_report`, and `resolve_report` does not touch them. A claim control here would need a writer that
-- does not exist, so the queue has none and neither column is returned. Reported as a finding.
--
-- ---------------------------------------------------------------------------------------------------
-- The listing moderation actions, read off `moderate_listing`
-- ---------------------------------------------------------------------------------------------------
--     approve         → `approved`, stamping `approved_at` if it was not already stamped
--     reject          → `rejected`
--     suspend         → `suspended`
--     reinstate       → `active`
--     request_changes → the status **does not move**; the seller is asked to act
--
-- Five actions, and no sixth is invented. Each one also writes both trails in the same transaction —
-- `record_moderation_action` with its own mapped generic action (`none`, `remove`, `suspend`, `reinstate`,
-- `warn`) and a `listing_moderation_actions` row carrying the status move — and enqueues
-- `moderation.action_recorded`. Nothing above this migration writes any of that a second time.
--
-- **Repeating an action is refused by the schema, not by anything added here.**
-- `listing_moderation_actions_status_moved` is `check (from_status <> to_status or action =
-- 'request_changes')`, so approving an approved listing, suspending a suspended one, rejecting a rejected
-- one or reinstating an active one raises `check_violation` on that constraint. That is the whole of the
-- concurrency answer for listings: two moderators pressing the same button race for one row lock, the
-- winner moves the status, and the loser's write fails on this constraint and is reported as a conflict.
-- The wrapper reads the constraint name to tell that case apart from the others.
--
-- **Two further rules can refuse an action, and they are a different answer again — one of them deferred.**
--
--   * `listings_approved_has_time` is an ordinary CHECK, so a listing that was never approved cannot be
--     reinstated to `active`: the update raises `check_violation` naming that constraint, inside the call.
--   * the **live-price rule is not a CHECK at all.** 0011 shipped it as `listings_live_needs_price`; 0048
--     dropped that constraint and replaced it with `listings_live_price_rule`, a **`deferrable initially
--     deferred` constraint trigger**, because the rule has to consult `listing_service_details` (a
--     custom-priced service may be live with no price) and a CHECK cannot see another table. Deferred
--     means it fires at **COMMIT** — after `moderate_listing` has returned and after this wrapper would
--     normally have answered — so it cannot be caught where the other refusals are, and a priceless
--     product approved through this path would look like a success and then take the whole transaction
--     down at commit time.
--
--     The fix is not to restate the rule. 0048 exposes it as a named predicate,
--     `app_private.live_listing_price_is_valid(listing)`, and that predicate is evaluated **inside the
--     same subtransaction as the write**: if the listing the writer just moved would not satisfy it, the
--     block raises, PostgreSQL rolls the writer's work back with it, and the outcome is
--     `not_applicable`. The rule stays in exactly one place; only the moment it is evaluated changes.
--
-- Neither is a conflict and neither is the moderator's mistake to correct by retrying, so both share one
-- outcome that says the listing cannot hold that status.
--
-- **Reinstatement is an action, not a reversal API.** `moderation_actions.reverses_action_id` exists and
-- **no writer in this repository ever sets it**; `moderate_listing` records a `reinstate` action without
-- one. So the console offers `reinstate` as one of the five and builds nothing around
-- `reverses_action_id` — which the brief asks for explicitly and which is also the only honest option.
--
-- ---------------------------------------------------------------------------------------------------
-- What the console is given, and what it is not
-- ---------------------------------------------------------------------------------------------------
--   * **No account identifier, anywhere.** Not the reporter's, not a colleague moderator's, not a
--     seller's. A report reports `is_own_report`, an action reports `is_own_action`, and that is the whole
--     of identity on this surface. `is_own_report` exists because the workflow needs it — `resolve_report`
--     refuses a moderator their own report — and a boolean is what the workflow needs, not an id.
--   * **No reporter name and no reporter contact.** Judging a report is judging what was reported; who
--     reported it changes nothing a moderator may do, and 0027's accountability is carried by the row
--     itself rather than by this projection. Reported as a decision.
--   * **`priority` is returned and never ordered by.** `reports_queue` is `(status, priority desc,
--     created_at)` and `priority` is `text`, so `desc` orders it lexically — `normal`, `low`, `high` —
--     which is not a severity. This is the same finding 7-L reported for support tickets, in the same
--     shape: the queue is **oldest first**, total and deterministic, and priority is a fact for a
--     colleague to read. No score, no ranking, no SLA.
--   * **A subject summary only where the repository can resolve one.** A reported `listing` resolves to
--     its slug, title and current status — a moderator cannot judge a report about a listing without
--     knowing whether it is already suspended — and a reported `seller` to its slug and display name. The
--     other six of 0027's subject types get their **type and nothing else**, because no staff read path
--     exists for them: messages are scoped to participants by 0053 and this migration adds no staff
--     reader for one, reviews are read by the seller they are about, and a reported person has no staff
--     projection here. That is a limit of the repository, reported rather than worked around, and it is
--     why nothing in these readers fetches a row because an id appeared in a request.
--   * **No secret, ever.** No column touched below is authentication material, an OTP, a password, a
--     token or a provider credential, and nothing here reads a table that holds one.

-- ---------------------------------------------------------------------------------------------------
-- 1. The five predicates
-- ---------------------------------------------------------------------------------------------------
create or replace function app_private.moderation_can_read_reports(
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
       and rp.permission_key = 'moderation.report.read'
       and (not r.requires_mfa or coalesce(p_is_aal2, false))
  );
$$;

comment on function app_private.moderation_can_read_reports(uuid, boolean) is
  'True when the account holds moderation.report.read in a session strong enough for the role that grants it. The key is a literal and the assurance level is a parameter, because app_system carries no claims. A predicate: it reads no report and writes nothing.';

create or replace function app_private.moderation_can_manage_reports(
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
       and rp.permission_key = 'moderation.report.manage'
       and (not r.requires_mfa or coalesce(p_is_aal2, false))
  );
$$;

comment on function app_private.moderation_can_manage_reports(uuid, boolean) is
  'True when the account holds moderation.report.manage in a session strong enough for the role that grants it. Required by resolving a report and by nothing else; reading is governed by the read key instead.';

create or replace function app_private.moderation_can_read_actions(
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
       and rp.permission_key = 'moderation.action.read'
       and (not r.requires_mfa or coalesce(p_is_aal2, false))
  );
$$;

comment on function app_private.moderation_can_read_actions(uuid, boolean) is
  'True when the account holds moderation.action.read in a session strong enough for the role that grants it. Gates the two moderation trails, which 0027 gates on this key and no other.';

create or replace function app_private.moderation_can_read_catalog(
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
       and rp.permission_key = 'catalog.listing.read'
       and (not r.requires_mfa or coalesce(p_is_aal2, false))
  );
$$;

comment on function app_private.moderation_can_read_catalog(uuid, boolean) is
  'True when the account holds catalog.listing.read in a session strong enough for the role that grants it. Gates reading the listings awaiting review and one listing''s moderation detail.';

create or replace function app_private.moderation_can_moderate_listings(
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
       and rp.permission_key = 'catalog.listing.moderate'
       and (not r.requires_mfa or coalesce(p_is_aal2, false))
  );
$$;

comment on function app_private.moderation_can_moderate_listings(uuid, boolean) is
  'True when the account holds catalog.listing.moderate in a session strong enough for the role that grants it. Required by moderating a listing and by nothing else, exactly as 0011''s own write policy requires it.';

-- ---------------------------------------------------------------------------------------------------
-- 2. The report queue
-- ---------------------------------------------------------------------------------------------------
-- Oldest first — `created_at, id`, total and deterministic — for the reason the header gives about
-- `priority`. The optional status filter is over 0027's own five values and is compared as a parameter, so
-- an unknown value simply matches nothing rather than building a predicate.
create or replace function app_private.moderation_report_queue(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_limit integer,
  p_status text default null,
  p_cursor_created_at timestamptz default null,
  p_cursor_id uuid default null
) returns table (
  id uuid,
  subject_type text,
  subject_label text,
  reason_code text,
  status text,
  priority text,
  is_own_report boolean,
  action_count integer,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select r.id,
         r.subject_type,
         -- Resolved in the same statement, for the two subject types the repository can resolve. Nothing
         -- is fetched because an id arrived in a request: this is one join, inside the reader.
         case when r.subject_type = 'listing' then l.title
              when r.subject_type = 'seller' then s.display_name end,
         r.reason_code,
         r.status,
         r.priority,
         r.reporter_user_id = p_user_id,
         (select count(*)::integer from public.moderation_actions a where a.report_id = r.id),
         r.created_at
    from public.reports r
    left join public.listings l on r.subject_type = 'listing' and l.id = r.subject_id
    left join public.seller_profiles s on r.subject_type = 'seller' and s.user_id = r.subject_id
   where p_user_id is not null
     and app_private.moderation_can_read_reports(p_user_id, p_is_aal2)
     and (p_status is null or r.status = p_status)
     and (
       p_cursor_created_at is null
       or p_cursor_id is null
       or (r.created_at, r.id) > (p_cursor_created_at, p_cursor_id)
     )
   order by r.created_at, r.id
   limit least(greatest(coalesce(p_limit, 20), 1), 51);
$$;

comment on function app_private.moderation_report_queue(uuid, boolean, integer, text, timestamptz, uuid) is
  'One page of reports for a colleague holding moderation.report.read at aal2, oldest first. Optionally narrowed to one of 0027''s five statuses. A row carries the subject''s type and, where the repository can resolve one, its label; the reason; the status; the priority as a fact rather than an order; whether the report is the caller''s own; and how many moderation actions cite it. It returns no reporter, no assignee and no resolution note. Nobody without the key reads a row.';

-- ---------------------------------------------------------------------------------------------------
-- 3. One report
-- ---------------------------------------------------------------------------------------------------
-- Everything the queue carries, plus what a decision needs: the reporter's own words, the decision already
-- recorded if there is one, and — for a reported listing — its current status, because acting on a report
-- about a listing that is already suspended is the stale-state case this surface has to be able to see.
create or replace function app_private.moderation_report_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_report_id uuid
) returns table (
  outcome text,
  id uuid,
  subject_type text,
  subject_slug text,
  subject_label text,
  subject_status text,
  subject_is_resolvable boolean,
  reason_code text,
  details text,
  status text,
  priority text,
  is_own_report boolean,
  resolution text,
  resolution_note text,
  resolved_at timestamptz,
  resolved_by_me boolean,
  duplicate_of_report_id uuid,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_user_id is null or p_report_id is null
     or not app_private.moderation_can_read_reports(p_user_id, p_is_aal2) then
    return query select 'not_found'::text, null::uuid, null::text, null::text, null::text, null::text,
                        null::boolean, null::text, null::text, null::text, null::text, null::boolean,
                        null::text, null::text, null::timestamptz, null::boolean, null::uuid,
                        null::timestamptz, null::timestamptz;
    return;
  end if;

  return query
    select 'found'::text,
           r.id,
           r.subject_type,
           case when r.subject_type = 'listing' then l.slug
                when r.subject_type = 'seller' then s.slug end,
           case when r.subject_type = 'listing' then l.title
                when r.subject_type = 'seller' then s.display_name end,
           -- A listing's own status, which is what makes a decision about it a decision about something
           -- current. A seller's status is not returned: nothing on this surface acts on a storefront.
           case when r.subject_type = 'listing' then l.status end,
           -- Whether the repository can show this subject at all. False for the six types with no staff
           -- read path, so the console says so rather than rendering an empty summary.
           r.subject_type in ('listing', 'seller'),
           r.reason_code,
           r.details,
           r.status,
           r.priority,
           r.reporter_user_id = p_user_id,
           r.resolution,
           r.resolution_note,
           r.resolved_at,
           -- Whether the caller made the decision, never which colleague did.
           r.resolved_by is not null and r.resolved_by = p_user_id,
           r.duplicate_of_report_id,
           r.created_at,
           r.updated_at
      from public.reports r
      left join public.listings l on r.subject_type = 'listing' and l.id = r.subject_id
      left join public.seller_profiles s on r.subject_type = 'seller' and s.user_id = r.subject_id
     where r.id = p_report_id;

  if not found then
    return query select 'not_found'::text, null::uuid, null::text, null::text, null::text, null::text,
                        null::boolean, null::text, null::text, null::text, null::text, null::boolean,
                        null::text, null::text, null::timestamptz, null::boolean, null::uuid,
                        null::timestamptz, null::timestamptz;
  end if;
end;
$$;

comment on function app_private.moderation_report_for_staff(uuid, boolean, uuid) is
  'One report for a colleague holding moderation.report.read at aal2: what was reported, what the reporter wrote, the decision already recorded if there is one, and — for a listing — the subject''s current status. A missing report and a caller without the key answer identically. It returns no reporter account, no assignee and no colleague''s identity: the caller learns whether the report and the decision are their own, and nothing else about anybody.';

-- ---------------------------------------------------------------------------------------------------
-- 4. The moderation trail for one subject
-- ---------------------------------------------------------------------------------------------------
-- 0027 gates `moderation_actions` on `moderation.action.read` and nothing else, so this reader requires
-- exactly that key. The subject type is compared as a parameter against the table's own allowed list.
create or replace function app_private.moderation_actions_for_subject(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_subject_type text,
  p_subject_id uuid,
  p_limit integer
) returns table (
  id uuid,
  action text,
  reason text,
  notes text,
  report_id uuid,
  expires_at timestamptz,
  reverses_action_id uuid,
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
         a.expires_at,
         a.reverses_action_id,
         a.moderator_user_id = p_user_id,
         a.created_at
    from public.moderation_actions a
   where p_user_id is not null
     and p_subject_id is not null
     and app_private.moderation_can_read_actions(p_user_id, p_is_aal2)
     and a.subject_type = p_subject_type
     and a.subject_id = p_subject_id
   order by a.created_at desc, a.id desc
   limit least(greatest(coalesce(p_limit, 20), 1), 51);
$$;

comment on function app_private.moderation_actions_for_subject(uuid, boolean, text, uuid, integer) is
  'The moderation trail for one subject, newest first, for a colleague holding moderation.action.read at aal2. Every field is one 0027''s own staff-read policy admits, except the moderator: the caller learns whether an action was their own and never which colleague recorded another. Nobody without the key reads a row.';

-- ---------------------------------------------------------------------------------------------------
-- 4b. The moderation actions citing one report
-- ---------------------------------------------------------------------------------------------------
-- The same key and the same projection, matched on `report_id` instead of on the subject. Both readers
-- exist because both questions are asked: a report's page asks "what has already been done about this",
-- and a listing's page asks "what has been done to this listing". `moderation_actions_report` is 0027's
-- own partial index for exactly the first one.
create or replace function app_private.moderation_actions_for_report(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_report_id uuid,
  p_limit integer
) returns table (
  id uuid,
  action text,
  reason text,
  notes text,
  report_id uuid,
  expires_at timestamptz,
  reverses_action_id uuid,
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
         a.expires_at,
         a.reverses_action_id,
         a.moderator_user_id = p_user_id,
         a.created_at
    from public.moderation_actions a
   where p_user_id is not null
     and p_report_id is not null
     and app_private.moderation_can_read_actions(p_user_id, p_is_aal2)
     and a.report_id = p_report_id
   order by a.created_at desc, a.id desc
   limit least(greatest(coalesce(p_limit, 20), 1), 51);
$$;

comment on function app_private.moderation_actions_for_report(uuid, boolean, uuid, integer) is
  'The moderation actions citing one report, newest first, for a colleague holding moderation.action.read at aal2. The same projection as the subject reader and the same key, matched on the report instead. It names no moderator.';

-- ---------------------------------------------------------------------------------------------------
-- 5. The listing-shaped trail
-- ---------------------------------------------------------------------------------------------------
-- The same key, because 0027 gates this table's staff read on the same one. It carries the status move,
-- which the generic trail does not, and that is the whole reason both exist.
create or replace function app_private.listing_moderation_history(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_listing_id uuid,
  p_limit integer
) returns table (
  id uuid,
  action text,
  from_status text,
  to_status text,
  reason text,
  report_id uuid,
  is_own_action boolean,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select m.id,
         m.action,
         m.from_status,
         m.to_status,
         m.reason,
         m.report_id,
         m.moderator_user_id = p_user_id,
         m.created_at
    from public.listing_moderation_actions m
   where p_user_id is not null
     and p_listing_id is not null
     and app_private.moderation_can_read_actions(p_user_id, p_is_aal2)
     and m.listing_id = p_listing_id
   order by m.created_at desc, m.id desc
   limit least(greatest(coalesce(p_limit, 20), 1), 51);
$$;

comment on function app_private.listing_moderation_history(uuid, boolean, uuid, integer) is
  'One listing''s moderation trail, newest first, for a colleague holding moderation.action.read at aal2. It carries the status move each decision made, which is what this table records and the generic trail does not. It names no moderator.';

-- ---------------------------------------------------------------------------------------------------
-- 6. The listings awaiting review
-- ---------------------------------------------------------------------------------------------------
-- A work queue, so `pending_review` and oldest first. Gated on `catalog.listing.read`, which is the key
-- 7-F already gates the catalogue section on; moderating one of them needs the other key, checked on the
-- action rather than on the reading.
create or replace function app_private.moderation_listing_queue(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_limit integer,
  p_cursor_created_at timestamptz default null,
  p_cursor_id uuid default null
) returns table (
  id uuid,
  slug text,
  title text,
  status text,
  listing_type_code text,
  currency_code text,
  price_minor bigint,
  is_own_listing boolean,
  report_count integer,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select l.id,
         l.slug,
         l.title,
         l.status,
         l.listing_type_code,
         l.currency_code::text,
         l.price_minor,
         -- `moderate_listing` refuses a moderator their own listing, so the queue says so before they try.
         l.seller_user_id = p_user_id,
         (select count(*)::integer from public.reports r
           where r.subject_type = 'listing' and r.subject_id = l.id
             and r.status in ('open', 'triaged')),
         l.created_at
    from public.listings l
   where p_user_id is not null
     and app_private.moderation_can_read_catalog(p_user_id, p_is_aal2)
     and l.status = 'pending_review'
     and (
       p_cursor_created_at is null
       or p_cursor_id is null
       or (l.created_at, l.id) > (p_cursor_created_at, p_cursor_id)
     )
   order by l.created_at, l.id
   limit least(greatest(coalesce(p_limit, 20), 1), 51);
$$;

comment on function app_private.moderation_listing_queue(uuid, boolean, integer, timestamptz, uuid) is
  'One page of listings awaiting review, oldest first, for a colleague holding catalog.listing.read at aal2. A row carries what a moderator needs to recognise the listing, whether it is their own — which the writer would refuse — and how many reports are still open against it. It names no seller.';

-- ---------------------------------------------------------------------------------------------------
-- 7. One listing, for a moderation decision
-- ---------------------------------------------------------------------------------------------------
-- Addressed by the listing's own id, which is what `moderate_listing` takes and what a colleague holding
-- `catalog.listing.read` legitimately holds. There is no slug resolution here and no second implementation
-- of one: 0047's resolver answers the *public* question of which listing a public address names, and this
-- surface is not asking that question.
create or replace function app_private.moderation_listing_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_listing_id uuid
) returns table (
  outcome text,
  id uuid,
  slug text,
  title text,
  description text,
  content_language text,
  status text,
  listing_type_code text,
  currency_code text,
  price_minor bigint,
  city text,
  seller_slug text,
  seller_display_name text,
  is_own_listing boolean,
  can_moderate boolean,
  open_report_count integer,
  created_at timestamptz,
  approved_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_user_id is null or p_listing_id is null
     or not app_private.moderation_can_read_catalog(p_user_id, p_is_aal2) then
    return query select 'not_found'::text, null::uuid, null::text, null::text, null::text, null::text,
                        null::text, null::text, null::text, null::bigint, null::text, null::text,
                        null::text, null::boolean, null::boolean, null::integer, null::timestamptz,
                        null::timestamptz;
    return;
  end if;

  return query
    select 'found'::text,
           l.id,
           l.slug,
           l.title,
           l.description,
           l.content_language,
           l.status,
           l.listing_type_code,
           -- `currency_code` is `character(3)`, not `text`: cast, or the row shape does not match the
           -- declared one and the function fails at return time rather than at creation time.
           l.currency_code::text,
           l.price_minor,
           l.city,
           s.slug,
           s.display_name,
           l.seller_user_id = p_user_id,
           -- Whether this caller may act, answered by the database rather than guessed at by a page.
           app_private.moderation_can_moderate_listings(p_user_id, p_is_aal2),
           (select count(*)::integer from public.reports r
             where r.subject_type = 'listing' and r.subject_id = l.id
               and r.status in ('open', 'triaged')),
           l.created_at,
           l.approved_at
      from public.listings l
      left join public.seller_profiles s on s.user_id = l.seller_user_id
     where l.id = p_listing_id;

  if not found then
    return query select 'not_found'::text, null::uuid, null::text, null::text, null::text, null::text,
                        null::text, null::text, null::text, null::bigint, null::text, null::text,
                        null::text, null::boolean, null::boolean, null::integer, null::timestamptz,
                        null::timestamptz;
  end if;
end;
$$;

comment on function app_private.moderation_listing_for_staff(uuid, boolean, uuid) is
  'One listing for a colleague holding catalog.listing.read at aal2, with what a moderation decision needs: its content, its current status, its storefront''s public name and slug, whether it is the caller''s own, whether they hold the moderate key, and how many reports are still open. A missing listing and a caller without the key answer identically. It returns no seller account and no storage path: moderating a listing touches no storage at all.';

-- ---------------------------------------------------------------------------------------------------
-- 8. Resolving a report
-- ---------------------------------------------------------------------------------------------------
-- The permission and the assurance level are required here; everything else is 0027's. `resolve_report`
-- raises for each of its own rules, and each one is caught and returned as an outcome so the API answers a
-- caller rather than logging a database error. The mapping is exhaustive over what that writer raises:
--
--   invalid_parameter_value  an unknown status                          → invalid
--   check_violation          a close with no reason                     → invalid
--   no_data_found            no such report                             → not_found
--   insufficient_privilege   the caller filed it                        → own_report
--   restrict_violation       already actioned, dismissed or duplicate   → already_final
--   foreign_key_violation    a duplicate naming a report that is gone   → invalid
--
-- The status is also checked against the four the writer accepts *before* calling it, so `open` — which it
-- would reject — is refused here as `invalid` rather than reaching it.
create or replace function app_private.moderation_report_resolve_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_report_id uuid,
  p_status text,
  p_resolution_note text default null,
  p_duplicate_of_report_id uuid default null
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
  if p_user_id is null or p_report_id is null
     or not app_private.moderation_can_manage_reports(p_user_id, p_is_aal2) then
    return query select 'not_found'::text, null::text;
    return;
  end if;

  -- 0027's own four. `open` is not among them: there is no un-triage and no reopen in this repository.
  if p_status is null or p_status not in ('triaged', 'actioned', 'dismissed', 'duplicate') then
    return query select 'invalid'::text, null::text;
    return;
  end if;

  -- `reports_duplicate_names_the_original` requires the original exactly when the status is `duplicate`,
  -- and `reports_not_its_own_duplicate` refuses a self-reference. Both are answered before the call.
  if p_status = 'duplicate'
     and (p_duplicate_of_report_id is null or p_duplicate_of_report_id = p_report_id) then
    return query select 'invalid'::text, null::text;
    return;
  end if;
  if p_status <> 'duplicate' and p_duplicate_of_report_id is not null then
    return query select 'invalid'::text, null::text;
    return;
  end if;

  begin
    v_status := app_private.resolve_report(
      p_report_id, p_status, p_user_id, p_resolution_note, p_duplicate_of_report_id
    );
  exception
    when no_data_found then
      return query select 'not_found'::text, null::text;
      return;
    when insufficient_privilege then
      return query select 'own_report'::text, null::text;
      return;
    when restrict_violation then
      return query select 'already_final'::text, null::text;
      return;
    when invalid_parameter_value or check_violation or foreign_key_violation then
      return query select 'invalid'::text, null::text;
      return;
  end;

  return query select 'resolved'::text, v_status;
end;
$$;

comment on function app_private.moderation_report_resolve_for_staff(uuid, boolean, uuid, text, text, uuid) is
  'Moves one report through 0027''s resolve_report, requiring moderation.report.manage at aal2 first. It accepts the four statuses that writer accepts and no fifth — there is no open, no un-triage and no reopen anywhere in this repository — and turns each of the writer''s own refusals into an outcome: a report that is gone, one the caller filed, one already closed, and an unusable request. The row is locked by the writer, so two colleagues resolving at once are ordered rather than raced.';

-- ---------------------------------------------------------------------------------------------------
-- 9. Moderating a listing
-- ---------------------------------------------------------------------------------------------------
-- Same shape. `moderate_listing` raises for its own rules and for two of the schema's constraints, and the
-- constraint name is what tells them apart:
--
--   invalid_parameter_value                      an unknown action           → invalid
--   check_violation / moderation_actions_reason_length
--                     / (empty reason)           a decision with no reason   → invalid
--   check_violation / listing_moderation_actions_status_moved
--                                                the status would not move   → no_change
--   check_violation / listings_approved_has_time  reinstating something that
--                                                was never approved          → not_applicable
--   0048's live-price predicate says no           a priceless product would
--                                                have gone live              → not_applicable
--   no_data_found                                no such listing             → not_found
--   insufficient_privilege                       the caller sells it         → own_listing
create or replace function app_private.moderation_listing_moderate_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_listing_id uuid,
  p_action text,
  p_reason text,
  p_report_id uuid default null
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
  v_constraint text;
begin
  if p_user_id is null or p_listing_id is null
     or not app_private.moderation_can_moderate_listings(p_user_id, p_is_aal2) then
    return query select 'not_found'::text, null::text;
    return;
  end if;

  -- 0027's own five, and no sixth.
  if p_action is null
     or p_action not in ('approve', 'reject', 'suspend', 'reinstate', 'request_changes') then
    return query select 'invalid'::text, null::text;
    return;
  end if;

  -- The writer requires a reason and `moderation_actions_reason_length` bounds it at 500. Both answered
  -- here so neither becomes a database error.
  if p_reason is null or btrim(p_reason) = '' or length(btrim(p_reason)) > 500 then
    return query select 'invalid'::text, null::text;
    return;
  end if;

  begin
    v_status := app_private.moderate_listing(p_listing_id, p_action, p_user_id, btrim(p_reason), p_report_id);

    -- 0048's rule, asked at the one moment it can still be answered. Its own trigger is deferred to
    -- COMMIT, which is too late for this wrapper to report anything, so the predicate it is built on is
    -- evaluated here instead — inside this block, so raising rolls the writer's work back with it. The
    -- rule itself is 0048's and is not restated.
    if not app_private.live_listing_price_is_valid(p_listing_id) then
      raise exception 'the live-price rule refuses this listing' using errcode = 'MO001';
    end if;
  exception
    when sqlstate 'MO001' then
      return query select 'not_applicable'::text, null::text;
      return;
    when no_data_found then
      return query select 'not_found'::text, null::text;
      return;
    when insufficient_privilege then
      return query select 'own_listing'::text, null::text;
      return;
    when check_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint = 'listing_moderation_actions_status_moved' then
        -- The listing is already where this action would put it. Two colleagues pressing the same button
        -- reach here, as does one pressing it twice.
        return query select 'no_change'::text, null::text;
      elsif v_constraint = 'listings_approved_has_time' then
        return query select 'not_applicable'::text, null::text;
      else
        return query select 'invalid'::text, null::text;
      end if;
      return;
    when invalid_parameter_value or foreign_key_violation then
      return query select 'invalid'::text, null::text;
      return;
  end;

  return query select 'moderated'::text, v_status;
end;
$$;

comment on function app_private.moderation_listing_moderate_for_staff(uuid, boolean, uuid, text, text, uuid) is
  'Moderates one listing through 0027''s moderate_listing, requiring catalog.listing.moderate at aal2 first — the same key 0011''s own write policy requires. It accepts that writer''s five actions and no sixth, and turns each refusal into an outcome: no such listing, the caller''s own listing, an action that would move nothing (which is how the schema refuses a repeat and how it orders two colleagues acting at once), and one the listing cannot take. That last case includes 0048''s live-price rule, whose own trigger is deferred to COMMIT: its predicate is evaluated inside this wrapper''s subtransaction so the refusal is reported rather than taking the transaction down after the answer was given. Both moderation trails and the outbox event are written by the writer, once.';

-- ---------------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on function app_private.moderation_can_read_reports(uuid, boolean) from public;
revoke execute on function app_private.moderation_can_manage_reports(uuid, boolean) from public;
revoke execute on function app_private.moderation_can_read_actions(uuid, boolean) from public;
revoke execute on function app_private.moderation_can_read_catalog(uuid, boolean) from public;
revoke execute on function app_private.moderation_can_moderate_listings(uuid, boolean) from public;
revoke execute on function app_private.moderation_report_queue(uuid, boolean, integer, text, timestamptz, uuid) from public;
revoke execute on function app_private.moderation_report_for_staff(uuid, boolean, uuid) from public;
revoke execute on function app_private.moderation_actions_for_subject(uuid, boolean, text, uuid, integer) from public;
revoke execute on function app_private.moderation_actions_for_report(uuid, boolean, uuid, integer) from public;
revoke execute on function app_private.listing_moderation_history(uuid, boolean, uuid, integer) from public;
revoke execute on function app_private.moderation_listing_queue(uuid, boolean, integer, timestamptz, uuid) from public;
revoke execute on function app_private.moderation_listing_for_staff(uuid, boolean, uuid) from public;
revoke execute on function app_private.moderation_report_resolve_for_staff(uuid, boolean, uuid, text, text, uuid) from public;
revoke execute on function app_private.moderation_listing_moderate_for_staff(uuid, boolean, uuid, text, text, uuid) from public;

grant execute on function app_private.moderation_can_read_reports(uuid, boolean) to app_system;
grant execute on function app_private.moderation_can_manage_reports(uuid, boolean) to app_system;
grant execute on function app_private.moderation_can_read_actions(uuid, boolean) to app_system;
grant execute on function app_private.moderation_can_read_catalog(uuid, boolean) to app_system;
grant execute on function app_private.moderation_can_moderate_listings(uuid, boolean) to app_system;
grant execute on function app_private.moderation_report_queue(uuid, boolean, integer, text, timestamptz, uuid) to app_system;
grant execute on function app_private.moderation_report_for_staff(uuid, boolean, uuid) to app_system;
grant execute on function app_private.moderation_actions_for_subject(uuid, boolean, text, uuid, integer) to app_system;
grant execute on function app_private.moderation_actions_for_report(uuid, boolean, uuid, integer) to app_system;
grant execute on function app_private.listing_moderation_history(uuid, boolean, uuid, integer) to app_system;
grant execute on function app_private.moderation_listing_queue(uuid, boolean, integer, timestamptz, uuid) to app_system;
grant execute on function app_private.moderation_listing_for_staff(uuid, boolean, uuid) to app_system;
grant execute on function app_private.moderation_report_resolve_for_staff(uuid, boolean, uuid, text, text, uuid) to app_system;
grant execute on function app_private.moderation_listing_moderate_for_staff(uuid, boolean, uuid, text, text, uuid) to app_system;

select app_private.assert_security_contract();
