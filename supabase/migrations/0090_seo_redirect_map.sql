-- 0090 — The SEO redirect map: the named definer functions that finally serve and manage it.
--
-- 0030 built the whole of this cluster and gave the application no way to reach it. `public.redirects` has
-- existed since then with its constraints, its unique index, its `updated_at` trigger, its audit trigger, its
-- outbox announcement `tg_redirects_announce()` and the resolver `public.resolve_redirect(text)`. What has
-- never existed is a single caller: `app_system` holds no table privileges, so every read and every write goes
-- through a named SECURITY DEFINER function, and 0030 defined none for redirects. Every row an operator could
-- have created, and every row 0033 seeds, has therefore been inert — stored, audited, announced, and never
-- consulted by the public site.
--
-- This migration adds exactly those functions. **No table, column, constraint, index, trigger or policy is
-- created or changed, and no new table exists after it.** The redirect schema is 0030's and stays 0030's.
--
-- ---------------------------------------------------------------------------------------------------
-- THE PRECEDENCE RULE — LIVE PAGE WINS (owner decision, approved for this increment)
-- ---------------------------------------------------------------------------------------------------
--
-- The public site resolves an incoming path against its own authoritative route behaviour **first**. Only a
-- path that would otherwise answer 404 may consult this map. The consequence is the one the decision asks for:
-- an active entry can never shadow a live catalogue URL, so a stale or mistaken row cannot take a listing, a
-- category, a service or a CMS page away from the public.
--
-- That ordering is the **caller's**, and it is enforced where the ordering physically happens — in the public
-- web's own request path, which is the last place a response status can still be chosen. It is deliberately not
-- re-implemented here: a reader in this schema cannot know whether a path resolves to a live page without
-- duplicating the catalogue's visibility rules, and a second, weaker copy of those rules is exactly the thing
-- this project does not build. `public_redirect_resolve` below therefore answers one narrow question — *does
-- the map name this path* — and answers it identically whoever asks.
--
-- ---------------------------------------------------------------------------------------------------
-- WHAT IS COMPOSED AND NEVER RESTATED
-- ---------------------------------------------------------------------------------------------------
--
-- `public.resolve_redirect(text)` is 0030's and is called, not copied. It owns:
--
--   * following a chain to its destination;
--   * the **five-hop limit**;
--   * **cycle detection**, by remembering the paths it has already stood on;
--   * ignoring an inactive entry, because its own predicate is `r.is_active`.
--
-- None of those four behaviours is re-decided, re-tuned or wrapped in a second opinion anywhere below. The
-- status code returned is the one stored on the last entry followed, which is 0030's choice too.
--
-- The one thing `public_redirect_resolve` adds is a refusal to hand back a redirect **to the path that was
-- asked for**. A cycle is stopped by the resolver rather than refused by it, and stopping inside a two-entry
-- cycle leaves the walk standing on the path it started from; answering that as a redirect would send a browser
-- to the address it already asked for, forever. The table's own
-- `redirects_do_not_point_at_themselves` constraint says a single entry may not do this, so declining to
-- synthesise the same thing out of a chain enforces 0030's intent rather than adding a rule to it.
--
-- ---------------------------------------------------------------------------------------------------
-- PERMISSIONS
-- ---------------------------------------------------------------------------------------------------
--
-- Two seeded keys, both from 0033, pinned here as literals, with 0003's own `requires_mfa` rule applied to the
-- assurance level as a parameter: `seo.redirect.read` to see the section, `seo.redirect.manage` to change
-- anything. Neither is invented, granted or assigned here, and 0030's RLS policies on the table already name
-- exactly this pair. No role name is tested anywhere in this file.
--
-- Every staff function re-applies its own test before it reaches a row, and an unauthorized caller gets the
-- same answer as a caller asking about an entry that does not exist.
--
-- ---------------------------------------------------------------------------------------------------
-- AUDIT ATTRIBUTION
-- ---------------------------------------------------------------------------------------------------
--
-- These writers do **not** touch the 8-B attribution channel, exactly as 0085's writers do not. 8-B's approved
-- scope is the financial subset and `public.audit_attribution_problems()` fails any function that names the
-- channel without being in that contract; extending it would reopen a closed increment.
--
-- The actor is recorded where 0030's own schema puts it: `redirects.created_by` is a column of the row, so the
-- audit trigger 0030 installed captures it inside the audited payload. There is no `updated_by` column on this
-- table and none is added — an edit and a removal are recorded by the audit trigger as the change they are.
--
-- ---------------------------------------------------------------------------------------------------
-- WHAT IS NOT HERE
-- ---------------------------------------------------------------------------------------------------
--
-- No analytics, no hit counting, no priority column, no groups, no wildcard matching, no regular expressions
-- and no external destination — 0030's `redirects_to_path_is_relative` constraint already makes the last of
-- those impossible and nothing here works around it. No cache: the published map is read from PostgreSQL, which
-- is the behaviour the specification's own Redis-unavailable table prescribes for a cache. `seo_settings` and
-- `seo_metadata` keep their tables and get no functions, for 0085's reason — each is its own cluster with its
-- own seeded keys, and a half-reader would be worse than leaving them untouched.

-- ---------------------------------------------------------------------------------------------------
-- 1. The two permission predicates
-- ---------------------------------------------------------------------------------------------------
create or replace function app_private.redirect_can_read(
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
       and rp.permission_key = 'seo.redirect.read'
       and (not r.requires_mfa or coalesce(p_is_aal2, false))
  );
$$;

comment on function app_private.redirect_can_read(uuid, boolean) is
  'Whether one account effectively holds seo.redirect.read — the key as a literal, with 0003''s own requires_mfa rule applied to the assurance level as a parameter. No role name is tested anywhere.';

create or replace function app_private.redirect_can_manage(
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
       and rp.permission_key = 'seo.redirect.manage'
       and (not r.requires_mfa or coalesce(p_is_aal2, false))
  );
$$;

comment on function app_private.redirect_can_manage(uuid, boolean) is
  'Whether one account effectively holds seo.redirect.manage — the separate key 0030''s own write policy requires. A reader may hold the first key and not this one, which is why the detail reports the capability.';

-- ---------------------------------------------------------------------------------------------------
-- 2. The public resolution reader
-- ---------------------------------------------------------------------------------------------------
-- The only function here the public site calls, and the narrowest one in the file. It answers whether the map
-- names a path, and nothing else: it does not know and must not know whether a live page answers to that path,
-- because LIVE PAGE WINS is resolved by the caller before this is ever reached.
--
-- The hop limit, the cycle handling, the inactive-entry rule and the status code all come from
-- `public.resolve_redirect`. The single addition is the last condition below.
create or replace function app_private.public_redirect_resolve(
  p_path text
) returns table (
  to_path text,
  status_code integer
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select r.to_path, r.status_code
    from public.resolve_redirect(p_path) as r
   where p_path is not null
     -- A chain that has come back to where it started is not a redirect. 0030 refuses a single self-pointing
     -- entry by constraint; this refuses the same shape assembled out of several, rather than answering with a
     -- redirect a browser would follow forever.
     and r.to_path is distinct from p_path;
$$;

comment on function app_private.public_redirect_resolve(text) is
  'Where the admin redirect map sends one path, or no row. Composes 0030''s public.resolve_redirect for the chain, the five-hop limit, the cycle stop and the inactive-entry rule, and declines only a destination equal to the path asked for. Knows nothing about live pages: LIVE PAGE WINS is decided by the caller before this is reached.';

-- ---------------------------------------------------------------------------------------------------
-- 3. The staff list
-- ---------------------------------------------------------------------------------------------------
-- Newest edit first, like the authored-page list and for the same reason: this is a maintenance list rather
-- than a queue, and somebody opening it is most often looking for what they just changed.
--
-- The search is a **literal substring**, not a pattern. `position()` has no metacharacters, so a path somebody
-- pastes into the box containing `%` or `_` matches those characters and nothing else — which matters here,
-- where every value in the table is a path and `_` is ordinary in one. Nothing in this increment supports
-- wildcard or regular-expression redirects, and a search box that quietly accepted pattern syntax would read
-- like the first step towards them.
create or replace function app_private.redirects_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_limit integer,
  p_search text default null,
  p_is_active boolean default null,
  p_cursor_updated_at timestamptz default null,
  p_cursor_id uuid default null
) returns table (
  redirect_id uuid,
  from_path text,
  to_path text,
  status_code integer,
  is_active boolean,
  note text,
  created_at timestamptz,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    r.id,
    r.from_path,
    r.to_path,
    r.status_code,
    r.is_active,
    r.note,
    r.created_at,
    r.updated_at
    from public.redirects r
   where app_private.redirect_can_read(p_user_id, p_is_aal2)
     and (p_search is null or btrim(p_search) = '' or
          position(lower(btrim(p_search)) in lower(r.from_path)) > 0 or
          position(lower(btrim(p_search)) in lower(r.to_path)) > 0)
     -- A tri-state parameter: null is "both", which is what an unfiltered list means.
     and (p_is_active is null or r.is_active = p_is_active)
     and (
       p_cursor_updated_at is null
       or p_cursor_id is null
       or (r.updated_at, r.id) < (p_cursor_updated_at, p_cursor_id)
     )
   order by r.updated_at desc, r.id desc
   limit greatest(coalesce(p_limit, 25), 1);
$$;

comment on function app_private.redirects_for_staff(uuid, boolean, integer, text, boolean, timestamptz, uuid) is
  'One page of the redirect map, newest edit first, for a holder of seo.redirect.read. The permission is tested in the WHERE clause, so an unauthorized caller reads nothing rather than being told so. The search is a literal substring with no pattern syntax.';

-- ---------------------------------------------------------------------------------------------------
-- 4. The staff detail
-- ---------------------------------------------------------------------------------------------------
-- The detail carries two things the list does not. `can_manage` is the second key, reported so a console
-- renders its controls from the server's answer rather than from a role name. `resolved_to_path` and
-- `resolved_status_code` are where this entry's chain actually **ends**, obtained by composing the same
-- resolver the public site uses — so somebody who has just pointed one path at another can see whether that
-- destination is itself redirected onwards, and whether the chain terminates. They are null when the map would
-- not redirect this path at all, which is what an inactive entry looks like from the outside.
create or replace function app_private.redirect_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_redirect_id uuid
) returns table (
  redirect_id uuid,
  from_path text,
  to_path text,
  status_code integer,
  is_active boolean,
  note text,
  created_at timestamptz,
  updated_at timestamptz,
  created_by uuid,
  can_manage boolean,
  resolved_to_path text,
  resolved_status_code integer
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    r.id,
    r.from_path,
    r.to_path,
    r.status_code,
    r.is_active,
    r.note,
    r.created_at,
    r.updated_at,
    r.created_by,
    app_private.redirect_can_manage(p_user_id, p_is_aal2),
    resolved.to_path,
    resolved.status_code
    from public.redirects r
    left join lateral app_private.public_redirect_resolve(r.from_path) as resolved on true
   where app_private.redirect_can_read(p_user_id, p_is_aal2)
     and r.id = p_redirect_id;
$$;

comment on function app_private.redirect_for_staff(uuid, boolean, uuid) is
  'One redirect for a holder of seo.redirect.read, with the manage capability and where its chain actually ends. No row covers both an entry that does not exist and a caller without the read key.';

-- ---------------------------------------------------------------------------------------------------
-- 5. The writers
-- ---------------------------------------------------------------------------------------------------
-- Each one re-applies `redirect_can_manage` first and raises 42501 when it fails. None of them decides a rule
-- 0030 already decides: that both sides are relative paths, that neither may escape the site with `//`, that an
-- entry may not point at itself, that `from_path` is unique, and which status codes exist are all constraints
-- and are left to raise their own errors. The `updated_at` stamp, the audit row and the outbox announcement are
-- 0030's triggers and are not touched here.
create or replace function app_private.redirect_create_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_from_path text,
  p_to_path text,
  p_status_code integer default 301,
  p_note text default null,
  p_is_active boolean default true
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  new_id uuid;
begin
  if not app_private.redirect_can_manage(p_user_id, p_is_aal2) then
    raise exception 'seo.redirect.manage is required' using errcode = 'insufficient_privilege';
  end if;

  insert into public.redirects (from_path, to_path, status_code, note, is_active, created_by)
  values (
    btrim(p_from_path),
    btrim(p_to_path),
    -- The column's own default, restated so the request may stay small rather than so this function decides it.
    coalesce(p_status_code, 301),
    nullif(btrim(coalesce(p_note, '')), ''),
    coalesce(p_is_active, true),
    p_user_id
  )
  returning id into new_id;

  return new_id;
end;
$$;

comment on function app_private.redirect_create_for_staff(uuid, boolean, text, text, integer, text, boolean) is
  'Creates one redirect-map entry and records the author in 0030''s own created_by column. The path shapes, the self-reference rule, the uniqueness of from_path and the allowed status codes stay in 0030''s constraints.';

create or replace function app_private.redirect_update_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_redirect_id uuid,
  p_from_path text default null,
  p_to_path text default null,
  p_status_code integer default null,
  p_note text default null
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  updated integer;
begin
  if not app_private.redirect_can_manage(p_user_id, p_is_aal2) then
    raise exception 'seo.redirect.manage is required' using errcode = 'insufficient_privilege';
  end if;

  -- `is_active` is deliberately absent from this statement: switching an entry on or off is the next function,
  -- so correcting a typo in a destination can never silently activate a redirect, and turning one off is one
  -- unambiguous action in the audit trail rather than a field inside an edit.
  update public.redirects r
     set from_path = coalesce(nullif(btrim(coalesce(p_from_path, '')), ''), r.from_path),
         to_path = coalesce(nullif(btrim(coalesce(p_to_path, '')), ''), r.to_path),
         status_code = coalesce(p_status_code, r.status_code),
         -- An empty note clears it, which is a different request from not sending the field at all.
         note = case when p_note is null then r.note else nullif(btrim(p_note), '') end
   where r.id = p_redirect_id;

  get diagnostics updated = row_count;
  return updated = 1;
end;
$$;

comment on function app_private.redirect_update_for_staff(uuid, boolean, uuid, text, text, integer, text) is
  'Changes one entry''s paths, status code or note. Never whether it is active: that is its own call, so an edit cannot switch a redirect on by accident. A null argument leaves that field alone; an empty note clears it.';

create or replace function app_private.redirect_state_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_redirect_id uuid,
  p_is_active boolean
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  updated integer;
begin
  if not app_private.redirect_can_manage(p_user_id, p_is_aal2) then
    raise exception 'seo.redirect.manage is required' using errcode = 'insufficient_privilege';
  end if;

  if p_is_active is null then
    raise exception 'the state must be given' using errcode = 'null_value_not_allowed';
  end if;

  update public.redirects r
     set is_active = p_is_active
   where r.id = p_redirect_id;

  get diagnostics updated = row_count;
  return updated = 1;
end;
$$;

comment on function app_private.redirect_state_for_staff(uuid, boolean, uuid, boolean) is
  'Switches one entry on or off. The only way to change that field, so deactivating a redirect is one deliberate action and one audit row.';

create or replace function app_private.redirect_delete_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_redirect_id uuid
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  removed integer;
begin
  if not app_private.redirect_can_manage(p_user_id, p_is_aal2) then
    raise exception 'seo.redirect.manage is required' using errcode = 'insufficient_privilege';
  end if;

  -- Removal is real here, where a page is archived rather than deleted. The difference is what the row is: an
  -- authored page is content with a public address and a history, while a redirect-map entry is an instruction
  -- about an address, and an instruction nobody wants any more has no archived form. The audit trigger records
  -- the deleted row, so what the instruction said survives its removal.
  delete from public.redirects r where r.id = p_redirect_id;

  get diagnostics removed = row_count;
  return removed = 1;
end;
$$;

comment on function app_private.redirect_delete_for_staff(uuid, boolean, uuid) is
  'Removes one entry. The audit trigger 0030 installed records the deleted row, so the instruction survives in history even though the entry does not.';

-- ---------------------------------------------------------------------------------------------------
-- 6. Privileges
-- ---------------------------------------------------------------------------------------------------
-- `app_system` is the only role that may call any of these. `app_worker` is named explicitly even though it
-- never held a grant on them: nothing in this increment is a background job, and saying so in the file is worth
-- more than relying on the absence of a line.
revoke execute on all functions in schema app_private from public;

revoke execute on function app_private.redirect_can_read(uuid, boolean) from public, app_worker;
revoke execute on function app_private.redirect_can_manage(uuid, boolean) from public, app_worker;
revoke execute on function app_private.public_redirect_resolve(text) from public, app_worker;
revoke execute on function app_private.redirects_for_staff(uuid, boolean, integer, text, boolean, timestamptz, uuid) from public, app_worker;
revoke execute on function app_private.redirect_for_staff(uuid, boolean, uuid) from public, app_worker;
revoke execute on function app_private.redirect_create_for_staff(uuid, boolean, text, text, integer, text, boolean) from public, app_worker;
revoke execute on function app_private.redirect_update_for_staff(uuid, boolean, uuid, text, text, integer, text) from public, app_worker;
revoke execute on function app_private.redirect_state_for_staff(uuid, boolean, uuid, boolean) from public, app_worker;
revoke execute on function app_private.redirect_delete_for_staff(uuid, boolean, uuid) from public, app_worker;

grant execute on function app_private.redirect_can_read(uuid, boolean) to app_system;
grant execute on function app_private.redirect_can_manage(uuid, boolean) to app_system;
grant execute on function app_private.public_redirect_resolve(text) to app_system;
grant execute on function app_private.redirects_for_staff(uuid, boolean, integer, text, boolean, timestamptz, uuid) to app_system;
grant execute on function app_private.redirect_for_staff(uuid, boolean, uuid) to app_system;
grant execute on function app_private.redirect_create_for_staff(uuid, boolean, text, text, integer, text, boolean) to app_system;
grant execute on function app_private.redirect_update_for_staff(uuid, boolean, uuid, text, text, integer, text) to app_system;
grant execute on function app_private.redirect_state_for_staff(uuid, boolean, uuid, boolean) to app_system;
grant execute on function app_private.redirect_delete_for_staff(uuid, boolean, uuid) to app_system;

select app_private.assert_security_contract();
