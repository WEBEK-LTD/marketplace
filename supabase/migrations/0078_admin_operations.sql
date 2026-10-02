-- 0078 — Seller, user and role reads, recovery review, and the audit trail (Phase 7-O).
--
-- Nineteen functions, no schema change, no new permission, no new table, no new status and no new writer for
-- anything this repository does not already write. 0003, 0005, 0006, 0009 and 0028 own everything
-- substantive: the role catalogue, the profiles, the audit trail, the seller statuses and the recovery state
-- machine with its five writers.
--
-- ---------------------------------------------------------------------------------------------------
-- Why a migration is needed at all
-- ---------------------------------------------------------------------------------------------------
-- The same reason every admin increment has had one, and it is worth stating precisely because it is also
-- the reason **two capabilities in this increment cannot be built at all** (see the next section).
--
-- Every administrative capability in these four domains is defined in this repository as a **row-level
-- security policy for the `authenticated` database role**:
--
--   * `seller_profiles_admin_read`      `has_permission('sellers.profile.read')`
--   * `profiles_admin_read`             `has_permission('users.profile.read')`
--   * `user_roles_admin_read`, `roles_admin_read`, `permissions_admin_read`,
--     `role_permissions_admin_read`     `has_permission('users.role.read')`
--   * `security_events_admin_read`      `has_permission('users.security.read')`
--   * `audit_logs_admin_read`           `has_permission('audit.read')`
--
-- A policy for `authenticated` is a rule about a database session that carries JWT claims. This application
-- does not connect that way: `app_system` is `noinherit`, holds **no table privileges** (0003, S8), and
-- `withRlsContext` is forbidden in production code. So each of those policies describes a capability that is
-- authorized in the database and reachable by nothing — until a named `app_private` function exists for it.
-- That is what the readers below are, and they add nothing to what those policies already permit: each one
-- restates 0003's own permission rule with the assurance level as a parameter and the key as a **literal**.
--
-- **Read is gated at `aal2` here too.** The read policies above do not AND `is_aal2()`, but every role that
-- holds one of these keys is `requires_mfa` in 0033, so the predicate's own
-- `(not r.requires_mfa or p_is_aal2)` refuses staff at `aal1` — the same effective outcome 7-G, 7-L and 7-N
-- reach the same way, without strengthening or weakening a policy.
--
-- ---------------------------------------------------------------------------------------------------
-- TWO CAPABILITIES ARE NOT IMPLEMENTED, AND THIS FILE IS WHERE THE GAP IS RECORDED
-- ---------------------------------------------------------------------------------------------------
-- **1. Role assignment and removal.** `public.user_roles` is written by **nothing** in this repository.
-- There is no `app_private.grant_role`, no `revoke_role`, no `assign_role`, and no migration in this
-- repository contains an `insert into public.user_roles`, an `update public.user_roles` or a
-- `delete from public.user_roles` — 0033 seeds `roles`, `permissions` and `role_permissions`, and touches
-- `user_roles` nowhere. What exists is 0003's pair of policies —
--
--     create policy user_roles_admin_insert on public.user_roles for insert to authenticated
--       with check (public.has_permission('users.role.manage') and public.is_aal2());
--     create policy user_roles_admin_update on public.user_roles for update to authenticated
--       using  (public.has_permission('users.role.manage') and public.is_aal2())
--       with check (public.has_permission('users.role.manage') and public.is_aal2());
--     grant select, insert, update on public.user_roles to authenticated;
--
-- — which say *who may* write the table through a claims-carrying session, and nothing at all about **what a
-- correct write is**. Writing that function means deciding, with no approved rule to read off:
--
--     * which roles a holder of `users.role.manage` may grant — may an `admin` grant `admin`? `super_admin`?
--     * whether granting yourself a role is refused, and whether granting *anyone* the role you hold is;
--     * whether `expires_at` is settable from a console, and by whom;
--     * whether removal is `revoked_at` or a delete, and whether a revoked grant may be reinstated;
--     * what happens to the target's live sessions and `aal2` grants when a role is revoked.
--
-- Every one of those is a privilege-escalation boundary. This is the most security-sensitive writer the
-- platform could have, and the brief for this increment says to stop rather than create an unsafe generic
-- one. **So role management is read-only here**: the console shows a person's roles and the role catalogue,
-- and there is no operation anywhere above this migration that can change either.
--
-- **RESOLVED BY OWNER DECISION.** Role assignment and removal is **deferred to a dedicated
-- security-focused increment after Phase 7**. The read surface in this migration stands; nothing above it
-- writes `public.user_roles`, and this migration's own pgTAP suite asserts that nothing in `app_private`
-- does.
--
-- **2. Seller account status management — RESOLVED, AND IMPLEMENTED IN 0079.** When this migration was
-- written, `seller_profiles.status` was set by no administrative writer: 0009's verification trigger sets
-- `verification_status` (a different column); 0059 sets the seller's own profile fields; 0060 sets media
-- paths; 0063 and 0069 move the *verification request*. What existed was 0009's
-- `seller_profiles_admin_update` policy, on `sellers.profile.manage` and `is_aal2()` — who may, not what a
-- correct transition is.
--
-- The owner has since decided the transition matrix, the reason rule, the two reinstatement conditions, the
-- authorization and the audit mechanism, and **migration 0079 implements them**. The readers in this file are
-- unchanged: a storefront is still addressed by slug here, still reports its standing and still exposes none
-- of the owner's personal details. The nineteen functions below still write nothing — the writer is 0079's,
-- and this file's own assertion that none of *these* functions sets a seller's status remains true.
--
-- So one gap is closed by decision and one is deferred by decision. Neither was invented.
--
-- ---------------------------------------------------------------------------------------------------
-- The recovery workflow, read off 0028's writers
-- ---------------------------------------------------------------------------------------------------
-- This is the one domain in this increment with authoritative writers, and all three admin steps delegate:
--
--     submitted | under_review → under_review     `review_recovery_request(request, reviewer, note)`.
--                                                 Records who reviewed it; refuses the account holder;
--                                                 locks the row. The reviewer is fixed from here on
--     under_review → contact_verification         `decide_recovery_request(request, approver, 'approved')`.
--                                                 **Refuses the reviewer** — the two-person rule 0028
--                                                 states twice — and refuses the account holder
--     under_review → rejected                     the same call with `'rejected'`, which requires a reason
--                                                 and closes the request
--     contact_verification → completed            `complete_recovery_request(request, actor, mfa_was_reset)`.
--                                                 Requires the new contact to have been verified by OTP and
--                                                 the request to have been approved; refuses the account
--                                                 holder; revokes sessions, records any MFA reset, and
--                                                 starts the configured hold
--
-- **`approved` is a status nothing sets.** It is in `account_recovery_requests_status_allowed`, and an
-- approval moves the request to `contact_verification` instead — so the console never offers it and never
-- expects it. Reported as a finding, not worked around.
--
-- **The contact verification step is the requester's, not an admin's.** `verify_recovery_contact` consumes an
-- OTP challenge the account holder answered; no function below calls it, and the console has no control for
-- it. It shows whether the contact has been verified, because completion depends on it.
--
-- **Nothing here bypasses the hold.** `complete_recovery_request` computes `hold_until` from
-- `site_setting('security.recovery_hold_hours')` itself. No parameter below can shorten, skip or clear it,
-- and no function in this file writes `hold_until`, `sessions_revoked_at` or `mfa_reset_at`.
--
-- ---------------------------------------------------------------------------------------------------
-- What these readers return, and what they do not
-- ---------------------------------------------------------------------------------------------------
--   * **No credential, ever.** Nothing below reads a password, an OTP secret, a TOTP secret, a token or a
--     provider credential, and no table it reads holds one. Recovery contacts are stored as **hashes**
--     (`claimed_contact_hash`, `new_contact_hash`), so there is no plaintext contact to return: the readers
--     report the *channel* — `email` or `phone` — and nothing else about it.
--   * **The audit projection is narrow and deliberately excludes the values.** `audit.audit_logs` carries
--     `old_values` and `new_values` as whole-row jsonb, redacted only for the columns each calling trigger
--     names — so a different table redacts a different set. Returning them would hand an audit reader every
--     unredacted column of every audited table at once. The reader below returns **which columns changed**
--     (`changed_columns`, names without values), the action, the table, the record and the time. 0006's own
--     guarantee — "credentials never reach this table" — is not relied on as a substitute for that.
--   * **No account identifier crosses, with one deliberate exception.** A seller is addressed and reported by
--     **slug**; a recovery request reports `is_own_request`, `reviewed_by_me` and `is_the_reviewer` rather
--     than naming a colleague; an audit row reports `actor_type` and `is_own_action` rather than an actor.
--     The exception is the **user** surface, where the account *is* the subject being administered and
--     `users.profile.read` is precisely the permission to read it: those readers take and return
--     `profiles.id`, because a user-management screen addressed by anything else would not be one.
--   * **No `request_ip`, anywhere.** It is on `account_recovery_requests`, `security_events` and
--     `audit.audit_logs`, and it is personal data that none of these screens needs to do its job.
--   * **No object path.** Recovery evidence is a private-bucket path; the reader returns the file's type,
--     name and size so a reviewer knows what was supplied, and the path is not in any result type. Signing a
--     read of one would need a storage step this increment does not add.
--   * **No score, no ranking, no dashboard.** Every list is ordered by time, which is what the schema's own
--     indexes are built for.

-- ---------------------------------------------------------------------------------------------------
-- 1. The six predicates
-- ---------------------------------------------------------------------------------------------------
-- 0003's own rule with the assurance level supplied instead of read from a claim, and each key written as a
-- **literal** so that no caller anywhere can name a different one. This is the shape 0072, 0075 and 0077
-- share, and each body is repeated rather than factored into one function taking a key: a shared
-- `holds_key(user, aal2, key)` reachable from `app_system` would be a generic permission oracle, and the
-- whole point of the pattern is that the key is not a value that travels.
create or replace function app_private.admin_can_read_sellers(
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
       and rp.permission_key = 'sellers.profile.read'
       and (not r.requires_mfa or coalesce(p_is_aal2, false))
  );
$$;

create or replace function app_private.admin_can_read_users(
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
       and rp.permission_key = 'users.profile.read'
       and (not r.requires_mfa or coalesce(p_is_aal2, false))
  );
$$;

create or replace function app_private.admin_can_read_roles(
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
       and rp.permission_key = 'users.role.read'
       and (not r.requires_mfa or coalesce(p_is_aal2, false))
  );
$$;

create or replace function app_private.admin_can_read_security(
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
       and rp.permission_key = 'users.security.read'
       and (not r.requires_mfa or coalesce(p_is_aal2, false))
  );
$$;

create or replace function app_private.admin_can_review_recovery(
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
       and rp.permission_key = 'security.recovery.review'
       and (not r.requires_mfa or coalesce(p_is_aal2, false))
  );
$$;

create or replace function app_private.admin_can_read_audit(
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
       and rp.permission_key = 'audit.read'
       and (not r.requires_mfa or coalesce(p_is_aal2, false))
  );
$$;

comment on function app_private.admin_can_read_sellers(uuid, boolean) is
  'True when the account holds sellers.profile.read in a session strong enough for the role that grants it. Gates the administrative seller reads; managing a seller''s account status has no writer in this repository and is not reachable from anywhere in this migration.';
comment on function app_private.admin_can_read_users(uuid, boolean) is
  'True when the account holds users.profile.read in a session strong enough for the role that grants it.';
comment on function app_private.admin_can_read_roles(uuid, boolean) is
  'True when the account holds users.role.read in a session strong enough for the role that grants it. Reading roles only: users.role.manage is used by nothing here, because no writer for user_roles exists in this repository.';
comment on function app_private.admin_can_read_security(uuid, boolean) is
  'True when the account holds users.security.read in a session strong enough for the role that grants it. A separate key from the profile read, and 0033 withholds it from support agents by decision.';
comment on function app_private.admin_can_review_recovery(uuid, boolean) is
  'True when the account holds security.recovery.review in a session strong enough for the role that grants it. Gates the recovery queue, one request, its evidence, and the three steps that delegate to 0028''s writers.';
comment on function app_private.admin_can_read_audit(uuid, boolean) is
  'True when the account holds audit.read in a session strong enough for the role that grants it. Gates the one audit reader, which is read-only and returns no values.';

-- ---------------------------------------------------------------------------------------------------
-- 2. The sellers a colleague may read
-- ---------------------------------------------------------------------------------------------------
-- Newest first, optionally narrowed to one of 0009's four statuses — compared as a parameter, so an unknown
-- value matches nothing rather than building a predicate. A seller is identified by **slug**, which is the
-- storefront's own public handle; the account behind it is not returned, and no operation in this increment
-- takes one.
create or replace function app_private.admin_seller_page(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_limit integer,
  p_status text default null,
  p_verification_status text default null,
  p_cursor_created_at timestamptz default null,
  p_cursor_slug text default null
) returns table (
  slug text,
  display_name text,
  status text,
  verification_status text,
  country_code text,
  city text,
  listing_count integer,
  open_report_count integer,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select s.slug,
         s.display_name,
         s.status,
         s.verification_status,
         s.country_code::text,
         s.city,
         (select count(*)::integer from public.listings l where l.seller_user_id = s.user_id),
         (select count(*)::integer from public.reports r
           where r.subject_type = 'seller' and r.subject_id = s.user_id
             and r.status in ('open', 'triaged')),
         s.created_at
    from public.seller_profiles s
   where p_user_id is not null
     and app_private.admin_can_read_sellers(p_user_id, p_is_aal2)
     and (p_status is null or s.status = p_status)
     and (p_verification_status is null or s.verification_status = p_verification_status)
     and (
       p_cursor_created_at is null
       or p_cursor_slug is null
       or (s.created_at, s.slug) < (p_cursor_created_at, p_cursor_slug)
     )
   order by s.created_at desc, s.slug desc
   limit least(greatest(coalesce(p_limit, 20), 1), 51);
$$;

comment on function app_private.admin_seller_page(uuid, boolean, integer, text, text, timestamptz, text) is
  'One page of storefronts for a colleague holding sellers.profile.read at aal2, newest first, optionally narrowed to one of the four account statuses or the four verification statuses 0009 defines. It returns no account identifier, no legal name and no contact details: a storefront is named by its slug. Nobody without the key reads a row.';

-- ---------------------------------------------------------------------------------------------------
-- 3. One seller
-- ---------------------------------------------------------------------------------------------------
-- Addressed by slug. It carries what an administrative reader needs to understand the storefront's standing
-- and **not** what only its owner or a verification reviewer needs: no legal name, no contact email, no
-- phone, no document, no object path. 7-G owns the verification review and its evidence; this reports only
-- the verification *status*, which is a fact about the storefront.
create or replace function app_private.admin_seller_detail(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_slug text
) returns table (
  outcome text,
  slug text,
  display_name text,
  bio text,
  content_language text,
  status text,
  suspended_at timestamptz,
  suspension_reason text,
  closed_at timestamptz,
  verification_status text,
  verified_at timestamptz,
  country_code text,
  governorate text,
  city text,
  listing_count integer,
  live_listing_count integer,
  open_report_count integer,
  is_own_storefront boolean,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_user_id is null or p_slug is null or btrim(p_slug) = ''
     or not app_private.admin_can_read_sellers(p_user_id, p_is_aal2) then
    return query select 'not_found'::text, null::text, null::text, null::text, null::text, null::text,
                        null::timestamptz, null::text, null::timestamptz, null::text, null::timestamptz,
                        null::text, null::text, null::text, null::integer, null::integer, null::integer,
                        null::boolean, null::timestamptz;
    return;
  end if;

  return query
    select 'found'::text,
           s.slug,
           s.display_name,
           s.bio,
           s.content_language,
           s.status,
           s.suspended_at,
           s.suspension_reason,
           s.closed_at,
           s.verification_status,
           s.verified_at,
           s.country_code::text,
           s.governorate,
           s.city,
           (select count(*)::integer from public.listings l where l.seller_user_id = s.user_id),
           (select count(*)::integer from public.listings l
             where l.seller_user_id = s.user_id and public.listing_status_is_public(l.status)),
           (select count(*)::integer from public.reports r
             where r.subject_type = 'seller' and r.subject_id = s.user_id
               and r.status in ('open', 'triaged')),
           s.user_id = p_user_id,
           s.created_at
      from public.seller_profiles s
     where s.slug = p_slug;

  if not found then
    return query select 'not_found'::text, null::text, null::text, null::text, null::text, null::text,
                        null::timestamptz, null::text, null::timestamptz, null::text, null::timestamptz,
                        null::text, null::text, null::text, null::integer, null::integer, null::integer,
                        null::boolean, null::timestamptz;
  end if;
end;
$$;

comment on function app_private.admin_seller_detail(uuid, boolean, text) is
  'One storefront for a colleague holding sellers.profile.read at aal2, by slug. A storefront that does not exist and a caller without the key answer identically. It returns the standing — status, any suspension and its reason, the verification status, the listing and open-report counts — and none of the owner''s personal or contact details, no verification document and no object path. Read-only: no writer for a seller''s account status exists in this repository.';

-- ---------------------------------------------------------------------------------------------------
-- 4. The users a colleague may read
-- ---------------------------------------------------------------------------------------------------
-- The one surface where an account identifier crosses, because the account is the subject being administered
-- and `users.profile.read` is the permission to read it. Newest first over `(created_at, id)`.
--
-- `full_name`, `phone_e164` and `avatar_object_path` are **not** returned: an administrative list does not
-- need somebody's legal name, their phone number or a path into private storage to do its job.
create or replace function app_private.admin_user_page(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_limit integer,
  p_status text default null,
  p_cursor_created_at timestamptz default null,
  p_cursor_id uuid default null
) returns table (
  id uuid,
  display_name text,
  status text,
  locale_code text,
  has_verified_email boolean,
  has_verified_phone boolean,
  is_staff boolean,
  is_seller boolean,
  is_self boolean,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select p.id,
         p.display_name,
         p.status,
         p.locale_code,
         -- Whether a contact was verified, never the contact itself.
         p.email_verified_at is not null,
         p.phone_verified_at is not null,
         exists (
           select 1 from public.user_roles ur
             join public.roles r on r.key = ur.role_key
            where ur.user_id = p.id and ur.revoked_at is null
              and (ur.expires_at is null or ur.expires_at > now())
              and r.is_admin_console
         ),
         exists (select 1 from public.seller_profiles s where s.user_id = p.id),
         p.id = p_user_id,
         p.created_at
    from public.profiles p
   where p_user_id is not null
     and app_private.admin_can_read_users(p_user_id, p_is_aal2)
     and p.deleted_at is null
     and (p_status is null or p.status = p_status)
     and (
       p_cursor_created_at is null
       or p_cursor_id is null
       or (p.created_at, p.id) < (p_cursor_created_at, p_cursor_id)
     )
   order by p.created_at desc, p.id desc
   limit least(greatest(coalesce(p_limit, 20), 1), 51);
$$;

comment on function app_private.admin_user_page(uuid, boolean, integer, text, timestamptz, uuid) is
  'One page of accounts for a colleague holding users.profile.read at aal2, newest first. It reports the display name, the status, whether each contact channel was verified, whether the account holds a console role and whether it has a storefront — and never a legal name, a phone number, an email address or an avatar path. Deleted accounts are excluded. Nobody without the key reads a row.';

-- ---------------------------------------------------------------------------------------------------
-- 5. One user
-- ---------------------------------------------------------------------------------------------------
create or replace function app_private.admin_user_detail(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_target_user_id uuid
) returns table (
  outcome text,
  id uuid,
  display_name text,
  status text,
  locale_code text,
  timezone text,
  has_verified_email boolean,
  has_verified_phone boolean,
  is_staff boolean,
  is_seller boolean,
  seller_slug text,
  is_self boolean,
  last_seen_at timestamptz,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_user_id is null or p_target_user_id is null
     or not app_private.admin_can_read_users(p_user_id, p_is_aal2) then
    return query select 'not_found'::text, null::uuid, null::text, null::text, null::text, null::text,
                        null::boolean, null::boolean, null::boolean, null::boolean, null::text,
                        null::boolean, null::timestamptz, null::timestamptz;
    return;
  end if;

  return query
    select 'found'::text,
           p.id,
           p.display_name,
           p.status,
           p.locale_code,
           p.timezone,
           p.email_verified_at is not null,
           p.phone_verified_at is not null,
           exists (
             select 1 from public.user_roles ur
               join public.roles r on r.key = ur.role_key
              where ur.user_id = p.id and ur.revoked_at is null
                and (ur.expires_at is null or ur.expires_at > now())
                and r.is_admin_console
           ),
           s.user_id is not null,
           s.slug,
           p.id = p_user_id,
           p.last_seen_at,
           p.created_at
      from public.profiles p
      left join public.seller_profiles s on s.user_id = p.id
     where p.id = p_target_user_id and p.deleted_at is null;

  if not found then
    return query select 'not_found'::text, null::uuid, null::text, null::text, null::text, null::text,
                        null::boolean, null::boolean, null::boolean, null::boolean, null::text,
                        null::boolean, null::timestamptz, null::timestamptz;
  end if;
end;
$$;

comment on function app_private.admin_user_detail(uuid, boolean, uuid) is
  'One account for a colleague holding users.profile.read at aal2. An account that does not exist, one that was deleted, and a caller without the key answer identically. It returns no legal name, no phone number, no email address and no avatar path, and links to the storefront by slug rather than by account.';

-- ---------------------------------------------------------------------------------------------------
-- 6. What roles one account holds
-- ---------------------------------------------------------------------------------------------------
-- A different key — `users.role.read` — because 0003 gates `user_roles` on that one and not on the profile
-- read. **Read-only, and there is nothing above it that writes:** no writer for `user_roles` exists in this
-- repository, so the console can show a grant and cannot make, change or remove one.
create or replace function app_private.admin_user_roles(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_target_user_id uuid
) returns table (
  role_key text,
  name_en text,
  name_ar text,
  requires_mfa boolean,
  is_admin_console boolean,
  granted_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  is_effective boolean,
  permission_count integer
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select r.key,
         r.name_en,
         r.name_ar,
         r.requires_mfa,
         r.is_admin_console,
         ur.granted_at,
         ur.expires_at,
         ur.revoked_at,
         -- 0003's own rule, reported rather than recomputed by a page: a grant that was revoked or has
         -- expired counts for nothing, and a role that requires MFA counts for nothing at aal1.
         ur.revoked_at is null and (ur.expires_at is null or ur.expires_at > now()),
         (select count(*)::integer from public.role_permissions rp where rp.role_key = r.key)
    from public.user_roles ur
    join public.roles r on r.key = ur.role_key
   where p_user_id is not null
     and p_target_user_id is not null
     and app_private.admin_can_read_roles(p_user_id, p_is_aal2)
     and ur.user_id = p_target_user_id
   order by r.sort_order, r.key;
$$;

comment on function app_private.admin_user_roles(uuid, boolean, uuid) is
  'The roles granted to one account, for a colleague holding users.role.read at aal2 — a different key from the profile read, because 0003 gates user_roles on this one. Each row says whether the grant is currently effective under 0003''s own rule. It names nobody who granted it, and nothing anywhere above this migration can create, change or remove a grant: no writer for user_roles exists in this repository.';

-- ---------------------------------------------------------------------------------------------------
-- 7. The role catalogue
-- ---------------------------------------------------------------------------------------------------
-- The same key. Reference data, so a colleague reading somebody's roles can see what each one carries
-- without a second screen inventing its own list of permissions.
create or replace function app_private.admin_role_catalogue(
  p_user_id uuid,
  p_is_aal2 boolean
) returns table (
  role_key text,
  name_en text,
  name_ar text,
  requires_mfa boolean,
  is_admin_console boolean,
  is_assignable boolean,
  permission_count integer,
  holder_count integer
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select r.key,
         r.name_en,
         r.name_ar,
         r.requires_mfa,
         r.is_admin_console,
         r.is_assignable,
         (select count(*)::integer from public.role_permissions rp where rp.role_key = r.key),
         (select count(*)::integer from public.user_roles ur
           where ur.role_key = r.key and ur.revoked_at is null
             and (ur.expires_at is null or ur.expires_at > now()))
    from public.roles r
   where p_user_id is not null
     and app_private.admin_can_read_roles(p_user_id, p_is_aal2)
   order by r.sort_order, r.key;
$$;

comment on function app_private.admin_role_catalogue(uuid, boolean) is
  'The role catalogue for a colleague holding users.role.read at aal2: each role, whether it requires MFA, whether it opens the console, whether it is assignable, how many permissions it carries and how many accounts currently hold it. Reference data only — it names no holder, and nothing above this migration changes a role, its permissions or its requires_mfa.';

-- ---------------------------------------------------------------------------------------------------
-- 8. One account's security timeline
-- ---------------------------------------------------------------------------------------------------
-- A third key — `users.security.read` — which 0033 withholds from support agents by decision. 0004's own
-- comment says `security_events.details` "carries identifiers only, never credentials or message bodies",
-- which is why it may cross; `request_ip` and `device_id` do not.
--
-- Named for what it is — a timeline a colleague reads — rather than after the table, because 7-A's own suite
-- counts `app_private` functions whose *name* contains `security_event` to prove there is exactly one
-- writer for that table. A reader called `admin_user_security_events` would have made that count read 2 and
-- turned a true statement about writers into a failing test about names.
create or replace function app_private.admin_account_security_timeline(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_target_user_id uuid,
  p_limit integer
) returns table (
  id bigint,
  event_type text,
  details jsonb,
  occurred_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select e.id,
         e.event_type,
         e.details,
         e.occurred_at
    from public.security_events e
   where p_user_id is not null
     and p_target_user_id is not null
     and app_private.admin_can_read_security(p_user_id, p_is_aal2)
     and e.user_id = p_target_user_id
   order by e.occurred_at desc, e.id desc
   limit least(greatest(coalesce(p_limit, 20), 1), 51);
$$;

comment on function app_private.admin_account_security_timeline(uuid, boolean, uuid, integer) is
  'One account''s security timeline, newest first, for a colleague holding users.security.read at aal2 — the key 0033 deliberately withholds from support agents. It returns the event type, its identifier-only details and when it happened, and never the request address or the device. A reader: it writes no event.';

-- ---------------------------------------------------------------------------------------------------
-- 9. The recovery review queue
-- ---------------------------------------------------------------------------------------------------
-- Oldest first: a queue of people locked out of their accounts. It reports the channel a request claims and
-- never a contact, and whether the reading colleague is already the reviewer — because 0028 refuses the
-- reviewer as the second approver, and a colleague should know that before they try.
create or replace function app_private.recovery_review_queue(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_limit integer,
  p_status text default null,
  p_cursor_created_at timestamptz default null,
  p_cursor_id uuid default null
) returns table (
  id uuid,
  status text,
  claimed_contact_channel text,
  new_contact_channel text,
  matched_an_account boolean,
  is_own_request boolean,
  is_the_reviewer boolean,
  has_been_reviewed boolean,
  contact_verified boolean,
  evidence_count integer,
  expires_at timestamptz,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select r.id,
         r.status,
         r.claimed_contact_channel,
         r.new_contact_channel,
         -- Whether it matched an account at all: a request that matched none can never complete, which is
         -- 0028's own rule and the first thing a reviewer needs to know.
         r.user_id is not null,
         r.user_id is not null and r.user_id = p_user_id,
         r.reviewer_user_id is not null and r.reviewer_user_id = p_user_id,
         r.reviewed_at is not null,
         r.contact_verified_at is not null,
         (select count(*)::integer from public.account_recovery_evidence e
           where e.account_recovery_request_id = r.id),
         r.expires_at,
         r.created_at
    from public.account_recovery_requests r
   where p_user_id is not null
     and app_private.admin_can_review_recovery(p_user_id, p_is_aal2)
     and (p_status is null or r.status = p_status)
     and (
       p_cursor_created_at is null
       or p_cursor_id is null
       or (r.created_at, r.id) > (p_cursor_created_at, p_cursor_id)
     )
   order by r.created_at, r.id
   limit least(greatest(coalesce(p_limit, 20), 1), 51);
$$;

comment on function app_private.recovery_review_queue(uuid, boolean, integer, text, timestamptz, uuid) is
  'One page of account recovery requests for a colleague holding security.recovery.review at aal2, oldest first, optionally narrowed to one of 0028''s eight statuses. It reports the contact channel and never a contact — they are stored as hashes — and says whether the request is the reader''s own and whether they are already its reviewer, because 0028 refuses both from deciding it. It returns no account identifier, no colleague''s identity and no request address.';

-- ---------------------------------------------------------------------------------------------------
-- 10. One recovery request
-- ---------------------------------------------------------------------------------------------------
create or replace function app_private.recovery_request_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_request_id uuid
) returns table (
  outcome text,
  id uuid,
  status text,
  claimed_contact_channel text,
  new_contact_channel text,
  matched_an_account boolean,
  is_own_request boolean,
  is_the_reviewer boolean,
  reviewed_by_me boolean,
  review_note text,
  reviewed_at timestamptz,
  approved_at timestamptz,
  rejection_reason text,
  contact_verified_at timestamptz,
  sessions_revoked_at timestamptz,
  mfa_reset_at timestamptz,
  hold_until timestamptz,
  completed_at timestamptz,
  closed_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_user_id is null or p_request_id is null
     or not app_private.admin_can_review_recovery(p_user_id, p_is_aal2) then
    return query select 'not_found'::text, null::uuid, null::text, null::text, null::text, null::boolean,
                        null::boolean, null::boolean, null::boolean, null::text, null::timestamptz,
                        null::timestamptz, null::text, null::timestamptz, null::timestamptz,
                        null::timestamptz, null::timestamptz, null::timestamptz, null::timestamptz,
                        null::timestamptz, null::timestamptz;
    return;
  end if;

  return query
    select 'found'::text,
           r.id,
           r.status,
           r.claimed_contact_channel,
           r.new_contact_channel,
           r.user_id is not null,
           r.user_id is not null and r.user_id = p_user_id,
           r.reviewer_user_id is not null and r.reviewer_user_id = p_user_id,
           r.reviewer_user_id is not null and r.reviewer_user_id = p_user_id,
           r.review_note,
           r.reviewed_at,
           r.approved_at,
           r.rejection_reason,
           r.contact_verified_at,
           -- The effects 0028's completion records. Reported so a reviewer can see what happened; no
           -- function in this file writes any of them.
           r.sessions_revoked_at,
           r.mfa_reset_at,
           r.hold_until,
           r.completed_at,
           r.closed_at,
           r.expires_at,
           r.created_at
      from public.account_recovery_requests r
     where r.id = p_request_id;

  if not found then
    return query select 'not_found'::text, null::uuid, null::text, null::text, null::text, null::boolean,
                        null::boolean, null::boolean, null::boolean, null::text, null::timestamptz,
                        null::timestamptz, null::text, null::timestamptz, null::timestamptz,
                        null::timestamptz, null::timestamptz, null::timestamptz, null::timestamptz,
                        null::timestamptz, null::timestamptz;
  end if;
end;
$$;

comment on function app_private.recovery_request_for_staff(uuid, boolean, uuid) is
  'One recovery request for a colleague holding security.recovery.review at aal2. A request that does not exist and a caller without the key answer identically. It carries the state, the review note, the rejection reason and the effects 0028''s completion recorded — sessions revoked, any MFA reset, and the hold it started — and never a contact, an account identifier, a colleague''s identity, the OTP challenge or the request address.';

-- ---------------------------------------------------------------------------------------------------
-- 11. The evidence attached to one request
-- ---------------------------------------------------------------------------------------------------
-- What was supplied, so a reviewer knows whether it is enough to judge. **Not the object path**: the bucket
-- is private and signing a read of one would need a storage step this increment does not add.
create or replace function app_private.recovery_evidence_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_request_id uuid
) returns table (
  id uuid,
  evidence_type text,
  original_filename text,
  content_type text,
  byte_size bigint,
  uploaded_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select e.id,
         e.evidence_type,
         e.original_filename,
         e.content_type,
         e.byte_size,
         e.uploaded_at
    from public.account_recovery_evidence e
   where p_user_id is not null
     and p_request_id is not null
     and app_private.admin_can_review_recovery(p_user_id, p_is_aal2)
     and e.account_recovery_request_id = p_request_id
   order by e.uploaded_at, e.id;
$$;

comment on function app_private.recovery_evidence_for_staff(uuid, boolean, uuid) is
  'What a recovery request supplied, for a colleague holding security.recovery.review at aal2: the kind of document, its file name, type and size. It returns no object path, so nothing here is a way to read the file — that would need a signing step this increment does not add.';

-- ---------------------------------------------------------------------------------------------------
-- 12. Recording the identity review
-- ---------------------------------------------------------------------------------------------------
-- The permission and the assurance level are required here; every other rule is 0028's.
-- `review_recovery_request` locks the row, refuses a request that is no longer reviewable and refuses the
-- account holder, and each refusal is returned as an outcome rather than raised.
create or replace function app_private.recovery_review_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_request_id uuid,
  p_note text default null
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
  if p_user_id is null or p_request_id is null
     or not app_private.admin_can_review_recovery(p_user_id, p_is_aal2) then
    return query select 'not_found'::text, null::text;
    return;
  end if;

  begin
    v_status := app_private.review_recovery_request(p_request_id, p_user_id, nullif(btrim(coalesce(p_note, '')), ''));
  exception
    when no_data_found then
      return query select 'not_found'::text, null::text;
      return;
    when insufficient_privilege then
      return query select 'own_request'::text, null::text;
      return;
    when restrict_violation then
      return query select 'not_reviewable'::text, null::text;
      return;
    when invalid_parameter_value or check_violation then
      return query select 'invalid'::text, null::text;
      return;
  end;

  return query select 'reviewed'::text, v_status;
end;
$$;

comment on function app_private.recovery_review_for_staff(uuid, boolean, uuid, text) is
  'Records the identity review through 0028''s review_recovery_request, requiring security.recovery.review at aal2 first. It fixes the caller as the reviewer, which is what 0028 later checks the second approver against. A request already past review, one that does not exist and the caller''s own each become an outcome rather than a database error.';

-- ---------------------------------------------------------------------------------------------------
-- 13. The second approver's decision
-- ---------------------------------------------------------------------------------------------------
-- 0028's two-person rule is the whole point of this step and is enforced entirely inside its writer: the
-- reviewer cannot approve their own review, and the account holder can do neither. Both come back as their
-- own outcomes so the console can say which happened.
create or replace function app_private.recovery_decide_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_request_id uuid,
  p_decision text,
  p_note text default null
) returns table (
  outcome text,
  status text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_decision text;
begin
  if p_user_id is null or p_request_id is null
     or not app_private.admin_can_review_recovery(p_user_id, p_is_aal2) then
    return query select 'not_found'::text, null::text;
    return;
  end if;

  -- 0028's own two, and no third. `approved` and `rejected` are what that writer accepts; the status the
  -- request lands on is its own mapping and is not something a caller names.
  if p_decision is null or p_decision not in ('approved', 'rejected') then
    return query select 'invalid'::text, null::text;
    return;
  end if;
  -- A rejection is always recorded with its reason. The writer raises for this; answering here keeps it a
  -- validation failure rather than a database error.
  if p_decision = 'rejected' and btrim(coalesce(p_note, '')) = '' then
    return query select 'invalid'::text, null::text;
    return;
  end if;

  begin
    v_decision := app_private.decide_recovery_request(
      p_request_id, p_user_id, p_decision, nullif(btrim(coalesce(p_note, '')), '')
    );
  exception
    when no_data_found then
      return query select 'not_found'::text, null::text;
      return;
    when insufficient_privilege then
      -- Either the caller reviewed it, or it is their own account. Both are 0028's refusals and both mean
      -- the same thing to a console: somebody else has to decide this one.
      return query select 'needs_another_person'::text, null::text;
      return;
    when restrict_violation then
      return query select 'not_decidable'::text, null::text;
      return;
    when invalid_parameter_value or check_violation or unique_violation then
      return query select 'invalid'::text, null::text;
      return;
  end;

  -- The status the request now holds, which for an approval is `contact_verification` rather than
  -- `approved`: 0028's writer moves it on to verifying the new contact, and `approved` is a value in the
  -- table's own list that nothing sets.
  return query
    select 'decided'::text, r.status from public.account_recovery_requests r where r.id = p_request_id;
end;
$$;

comment on function app_private.recovery_decide_for_staff(uuid, boolean, uuid, text, text) is
  'The second approver''s decision, through 0028''s decide_recovery_request, requiring security.recovery.review at aal2 first. It passes that writer''s two decisions and no third, requires a reason for a rejection, and returns its refusals as outcomes: a request that was never reviewed, one already decided, and the case where the caller is the reviewer or the account holder — which 0028 refuses and which means somebody else has to decide it. An approval moves the request to contact_verification, not to approved.';

-- ---------------------------------------------------------------------------------------------------
-- 14. Completing a recovery
-- ---------------------------------------------------------------------------------------------------
-- The last step, and the one with consequences: `complete_recovery_request` revokes the account's sessions,
-- records any MFA reset, starts the configured hold on withdrawals and payout changes, writes the account's
-- own `security_events` row and enqueues the outbox event. **Nothing here computes or shortens the hold** —
-- that writer reads `site_setting('security.recovery_hold_hours')` itself — and no parameter below can
-- bypass the requirement that the new contact was verified by OTP first.
create or replace function app_private.recovery_complete_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_request_id uuid,
  p_mfa_was_reset boolean default false
) returns table (
  outcome text,
  hold_until timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_hold timestamptz;
begin
  if p_user_id is null or p_request_id is null
     or not app_private.admin_can_review_recovery(p_user_id, p_is_aal2) then
    return query select 'not_found'::text, null::timestamptz;
    return;
  end if;

  begin
    v_hold := app_private.complete_recovery_request(p_request_id, p_user_id, coalesce(p_mfa_was_reset, false));
  exception
    when no_data_found then
      return query select 'not_found'::text, null::timestamptz;
      return;
    when insufficient_privilege then
      return query select 'own_request'::text, null::timestamptz;
      return;
    when restrict_violation then
      -- Not approved, the contact not verified, or the request matched no account and never can complete.
      -- One outcome for all three: each means the same thing to a console, and telling them apart would say
      -- more about somebody's account than a completion screen needs to.
      return query select 'not_completable'::text, null::timestamptz;
      return;
    when invalid_parameter_value or check_violation then
      return query select 'invalid'::text, null::timestamptz;
      return;
  end;

  return query select 'completed'::text, v_hold;
end;
$$;

comment on function app_private.recovery_complete_for_staff(uuid, boolean, uuid, boolean) is
  'Finishes a recovery through 0028''s complete_recovery_request, requiring security.recovery.review at aal2 first. That writer revokes the account''s sessions, records any MFA reset, starts the configured hold and writes both the security event and the outbox event; nothing here duplicates any of that, and no parameter can shorten the hold or skip the OTP verification it depends on. A request that is not approved, whose contact was not verified, or that matched no account is one outcome, because each means the same thing to the screen.';

-- ---------------------------------------------------------------------------------------------------
-- 15. The audit trail
-- ---------------------------------------------------------------------------------------------------
-- One reader, read-only, over the table 0006 partitions by month. Ordered `(occurred_at desc, id desc)`,
-- which is the leading index and what the partitioning is for, and paged by that same pair so a page is
-- total and repeats nothing.
--
-- **The values are deliberately absent.** `old_values` and `new_values` are whole-row jsonb redacted only
-- for the columns each calling trigger names, so returning them would hand an audit reader every unredacted
-- column of every audited table at once. `changed_columns` — the names, without the values — is what an
-- audit reader needs to see what happened, and is what this returns.
--
-- The two filters are the ones 0006's own indexes support: the table, and one record within it.
create or replace function app_private.admin_audit_page(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_limit integer,
  p_table_schema text default null,
  p_table_name text default null,
  p_record_id text default null,
  p_cursor_occurred_at timestamptz default null,
  p_cursor_id bigint default null
) returns table (
  id bigint,
  occurred_at timestamptz,
  actor_type text,
  is_own_action boolean,
  action text,
  table_schema text,
  table_name text,
  record_id text,
  changed_columns text[],
  request_id text
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select a.id,
         a.occurred_at,
         a.actor_type,
         -- Whether the reader did this, never which colleague did.
         a.actor_id is not null and a.actor_id = p_user_id,
         a.action,
         a.table_schema::text,
         a.table_name::text,
         a.record_id,
         a.changed_columns,
         a.request_id
    from audit.audit_logs a
   where p_user_id is not null
     and app_private.admin_can_read_audit(p_user_id, p_is_aal2)
     and (p_table_schema is null or a.table_schema = p_table_schema::name)
     and (p_table_name is null or a.table_name = p_table_name::name)
     and (p_record_id is null or a.record_id = p_record_id)
     and (
       p_cursor_occurred_at is null
       or p_cursor_id is null
       or (a.occurred_at, a.id) < (p_cursor_occurred_at, p_cursor_id)
     )
   order by a.occurred_at desc, a.id desc
   limit least(greatest(coalesce(p_limit, 20), 1), 51);
$$;

comment on function app_private.admin_audit_page(uuid, boolean, integer, text, text, text, timestamptz, bigint) is
  'One page of the audit trail for a colleague holding audit.read at aal2, newest first over the index 0006 built for it, optionally narrowed to one table or one record — the two filters those indexes support. It returns what changed and never the values: old_values and new_values are whole-row jsonb redacted per calling trigger, so a projection carrying them would expose every unredacted column of every audited table. It returns no actor identifier and no request address, and it writes nothing.';

-- ---------------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on function app_private.admin_can_read_sellers(uuid, boolean) from public;
revoke execute on function app_private.admin_can_read_users(uuid, boolean) from public;
revoke execute on function app_private.admin_can_read_roles(uuid, boolean) from public;
revoke execute on function app_private.admin_can_read_security(uuid, boolean) from public;
revoke execute on function app_private.admin_can_review_recovery(uuid, boolean) from public;
revoke execute on function app_private.admin_can_read_audit(uuid, boolean) from public;
revoke execute on function app_private.admin_seller_page(uuid, boolean, integer, text, text, timestamptz, text) from public;
revoke execute on function app_private.admin_seller_detail(uuid, boolean, text) from public;
revoke execute on function app_private.admin_user_page(uuid, boolean, integer, text, timestamptz, uuid) from public;
revoke execute on function app_private.admin_user_detail(uuid, boolean, uuid) from public;
revoke execute on function app_private.admin_user_roles(uuid, boolean, uuid) from public;
revoke execute on function app_private.admin_role_catalogue(uuid, boolean) from public;
revoke execute on function app_private.admin_account_security_timeline(uuid, boolean, uuid, integer) from public;
revoke execute on function app_private.recovery_review_queue(uuid, boolean, integer, text, timestamptz, uuid) from public;
revoke execute on function app_private.recovery_request_for_staff(uuid, boolean, uuid) from public;
revoke execute on function app_private.recovery_evidence_for_staff(uuid, boolean, uuid) from public;
revoke execute on function app_private.recovery_review_for_staff(uuid, boolean, uuid, text) from public;
revoke execute on function app_private.recovery_decide_for_staff(uuid, boolean, uuid, text, text) from public;
revoke execute on function app_private.recovery_complete_for_staff(uuid, boolean, uuid, boolean) from public;
revoke execute on function app_private.admin_audit_page(uuid, boolean, integer, text, text, text, timestamptz, bigint) from public;

grant execute on function app_private.admin_can_read_sellers(uuid, boolean) to app_system;
grant execute on function app_private.admin_can_read_users(uuid, boolean) to app_system;
grant execute on function app_private.admin_can_read_roles(uuid, boolean) to app_system;
grant execute on function app_private.admin_can_read_security(uuid, boolean) to app_system;
grant execute on function app_private.admin_can_review_recovery(uuid, boolean) to app_system;
grant execute on function app_private.admin_can_read_audit(uuid, boolean) to app_system;
grant execute on function app_private.admin_seller_page(uuid, boolean, integer, text, text, timestamptz, text) to app_system;
grant execute on function app_private.admin_seller_detail(uuid, boolean, text) to app_system;
grant execute on function app_private.admin_user_page(uuid, boolean, integer, text, timestamptz, uuid) to app_system;
grant execute on function app_private.admin_user_detail(uuid, boolean, uuid) to app_system;
grant execute on function app_private.admin_user_roles(uuid, boolean, uuid) to app_system;
grant execute on function app_private.admin_role_catalogue(uuid, boolean) to app_system;
grant execute on function app_private.admin_account_security_timeline(uuid, boolean, uuid, integer) to app_system;
grant execute on function app_private.recovery_review_queue(uuid, boolean, integer, text, timestamptz, uuid) to app_system;
grant execute on function app_private.recovery_request_for_staff(uuid, boolean, uuid) to app_system;
grant execute on function app_private.recovery_evidence_for_staff(uuid, boolean, uuid) to app_system;
grant execute on function app_private.recovery_review_for_staff(uuid, boolean, uuid, text) to app_system;
grant execute on function app_private.recovery_decide_for_staff(uuid, boolean, uuid, text, text) to app_system;
grant execute on function app_private.recovery_complete_for_staff(uuid, boolean, uuid, boolean) to app_system;
grant execute on function app_private.admin_audit_page(uuid, boolean, integer, text, text, text, timestamptz, bigint) to app_system;

select app_private.assert_security_contract();
