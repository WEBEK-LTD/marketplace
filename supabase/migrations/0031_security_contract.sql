-- 0031 — The RLS and grant guard: the Phase 2 security contract, enforced at deploy time (S6, S8, C15).
--
-- Migrations 0001 to 0030 each secured what they created. This migration adds nothing to the domain and
-- takes nothing away from it. It does three things, and nothing else:
--
--   1. **It writes the contract down.** `app_private.append_only_contract` names every table that must
--      stay append-only and the exact columns, if any, that a user may still update — the same idiom
--      0012 used for storage buckets, where the contract is a table rather than a comment.
--   2. **It turns the structural guards into functions.** `public.security_contract_problems()` returns
--      one row per violation, and returns nothing when the contract holds. The pgTAP suite, CI and the
--      admin security page all read that one source of truth instead of each re-deriving the rules.
--   3. **It enforces the contract at deploy time.** The last statement of this migration calls
--      `app_private.assert_security_contract()`, so a deployment that would leave the database in a
--      state the contract forbids fails here rather than in production.
--
-- Nothing in this migration grants a privilege. Every privilege statement is a `revoke`, and the only
-- grants are `execute` on the new guard functions to the two server roles that need to call them. No
-- existing policy, grant, trigger or SECURITY DEFINER boundary is altered, removed or relaxed: the
-- audit that produced this file found the model already correct, and the file's job is to keep it that
-- way rather than to change it.
--
-- What the contract asserts, and why each clause exists:
--
--   * **RLS everywhere.** Every ordinary and partitioned table in `public`, `app_private` and `audit`
--     has row level security. A table with none is reachable by anyone holding a privilege on it.
--   * **No grant without a policy.** Anything `authenticated` can reach must be governed by at least one
--     policy, and a write privilege must have a policy that can actually satisfy that command — an
--     INSERT grant with no INSERT or ALL policy is a dead grant, and dead grants hide mistakes.
--   * **`anon` reaches nothing.** No table, column, routine or sequence privilege, and no schema usage,
--     in any application schema or in `extensions`, `storage`, `realtime`, `auth`, `vault` or `cron`.
--   * **Role boundaries.** `authenticated` holds nothing in `app_private`; `app_system` and `app_worker`
--     hold no table or column privilege anywhere and act only through named SECURITY DEFINER functions;
--     `app_api` holds nothing of its own, because S8 makes it a `NOINHERIT` member of `authenticated`;
--     no application function is executable by `PUBLIC`; no `app_private` function is executable by
--     `authenticated`.
--   * **SECURITY DEFINER hygiene.** Every definer function in the three schemas pins exactly
--     `search_path = pg_catalog, public`. A definer function with a searchable path is a privilege
--     escalation waiting for a shadowing object.
--   * **Views cannot launder RLS.** Every view in the three schemas sets `security_invoker = true`, so a
--     view is read with the caller's rights rather than its owner's. `wallet_transactions` and
--     `seller_ratings` already do; this keeps a future one honest.
--   * **Append-only really is append-only.** Each contracted table has a BEFORE UPDATE OR DELETE trigger
--     that refuses the write, `authenticated` holds no table-level UPDATE or DELETE on it, and any
--     column-level UPDATE it does hold is inside the contract's `updatable_columns`. The ledger, the
--     audit log, every status and slug history and every event stream are covered. The reverse direction
--     is checked too: a table that rejects writes but is missing from the contract is itself a problem,
--     so the contract cannot quietly fall behind the schema.
--   * **Cross-schema reach.** `authenticated` may hold exactly one privilege outside the application
--     schemas — `select` on `realtime.messages`, which 0014's private-topic policy governs — and
--     nothing at all in `storage`, `auth`, `vault` or `cron`.
--   * **Storage.** 0012's `storage_bucket_problems()` is folded into the umbrella, so a sensitive bucket
--     turning public is a contract violation, not just a failing test.
--
-- Two things this migration deliberately does **not** do:
--
--   * It does not set `force row level security`. Every `SECURITY DEFINER` writer in 0001 to 0030 — the
--     outbox enqueuer, the ledger poster, the notification writer, the fulfilment function — is owned by
--     the table owner and is meant to write rows no policy permits. Forcing RLS would break all of them,
--     which is why the model reaches those tables through named functions instead of forcing the owner
--     through policies it was never given.
--   * It does not revoke anything that is currently in use. The audit behind this file examined every
--     grant, policy and column privilege on the schema 0001 to 0030 produces; the `revoke` statements
--     below name `anon` and `PUBLIC`, which hold nothing today, so they change nothing and prevent the
--     accidental grant tomorrow. No privilege was removed to make a count-based test pass.
--
-- Nothing here touches payments, payouts, providers, settlement, the wallet, the ledger's contents or
-- withdrawals; `finance.settlement_posting_enabled` is not read or written; no deferred decision opens.

-- ---------------------------------------------------------------------------------------------------
-- A note on what does not work, so nobody adds it back
-- ---------------------------------------------------------------------------------------------------
-- PostgreSQL grants EXECUTE on every new function to PUBLIC, which is why each migration so far ends
-- with an explicit sweep. The obvious fix — `alter default privileges in schema public revoke execute
-- on functions from public` — was written, applied and measured here, and it does nothing: PostgreSQL
-- records no default ACL entry for it, and a function created afterwards still carries `=X/owner`. It
-- is therefore deliberately absent rather than shipped as hardening that does not harden.
--
-- The real mechanism is the guard below. `role_boundary_problems()` reports any application function
-- that PUBLIC can execute, `assert_security_contract()` raises on it, and 0032 schedules that assertion,
-- so a future migration that forgets its sweep fails instead of silently widening the surface.

-- ---------------------------------------------------------------------------------------------------
-- Deny by default, for what exists now
-- ---------------------------------------------------------------------------------------------------
-- These hold nothing today. The statements are here so that they still hold nothing after a mistake.
revoke all on all tables in schema public, app_private, audit from public, anon;
revoke all on all sequences in schema public, app_private, audit from public, anon;
revoke all on all functions in schema public, app_private, audit from public, anon;
revoke all on all routines in schema public, app_private, audit from public, anon;
revoke all on schema public, app_private, audit from public, anon;
revoke create on schema public from public;

-- The audit behind this migration found one privilege that nothing in 0001 to 0030 granted: the pg_cron
-- extension script grants `select` on its own two sequences to `PUBLIC`, and every role — `anon`
-- included — inherits it. `anon` cannot reach them today because it has no `usage` on the `cron` schema,
-- so this is a latent hole rather than an open one, and it is closed here. `cron.schedule()` and
-- `cron.unschedule()` are SECURITY DEFINER functions owned by the superuser, so scheduling is unaffected;
-- this was verified against a real schedule/unschedule cycle before the statement was written.
revoke all on sequence cron.jobid_seq, cron.runid_seq from public;

-- `app_api` owns no privilege of its own: S8 makes it a NOINHERIT member of `authenticated` that must
-- `SET ROLE` to reach anything at all.
revoke all on all tables in schema public, app_private, audit from app_api;
revoke all on all functions in schema public, app_private, audit from app_api;

-- ---------------------------------------------------------------------------------------------------
-- The append-only contract
-- ---------------------------------------------------------------------------------------------------
create table app_private.append_only_contract (
  table_schema name not null,
  table_name name not null,
  updatable_columns text[] not null default '{}'::text[],
  reason text not null,
  primary key (table_schema, table_name),
  constraint append_only_contract_reason_present check (length(btrim(reason)) > 0)
);
comment on table app_private.append_only_contract is
  'Every table that must refuse UPDATE and DELETE, and the columns a user may still change. Compared with reality by `append_only_problems()`.';
alter table app_private.append_only_contract enable row level security;

insert into app_private.append_only_contract (table_schema, table_name, updatable_columns, reason) values
  ('audit',  'audit_logs',                    '{}', 'the audit trail itself'),
  ('public', 'ledger_entries',                '{}', 'double-entry lines are never edited (financial isolation)'),
  ('public', 'ledger_journals',               '{}', 'a posted journal is reversed by another journal, never rewritten'),
  ('public', 'commissions',                   '{}', 'commission records follow the journal that created them'),
  ('public', 'payment_fee_allocations',       '{}', 'the D20 fee split is history once allocated'),
  ('public', 'payment_provider_transactions', '{}', 'what a provider told us is evidence, not state'),
  ('public', 'payment_exception_actions',     '{}', 'the exception trail'),
  ('public', 'payout_transactions',           '{}', 'what a payout provider told us'),
  ('public', 'promotion_transactions',        '{}', 'promotion money movements'),
  ('public', 'promotion_status_history',      '{}', 'promotion lifecycle trail'),
  ('public', 'promotion_events',              '{}', 'per-promotion event stream'),
  ('public', 'coupon_usage',                  '{}', 'a redemption is released by its own function, never edited'),
  ('public', 'listing_events',                '{}', 'per-listing event stream'),
  ('public', 'listing_status_history',        '{}', 'listing lifecycle trail'),
  ('public', 'listing_moderation_actions',    '{}', 'moderation decisions on listings'),
  ('public', 'moderation_actions',            '{}', 'moderation decisions generally'),
  ('public', 'listing_slug_history',          '{}', 'retired slugs, which the 301s depend on'),
  ('public', 'page_slug_history',             '{}', 'retired page slugs'),
  ('public', 'blog_post_slug_history',        '{}', 'retired post slugs'),
  ('public', 'order_status_history',          '{}', 'order lifecycle trail'),
  ('public', 'security_events',               '{}', 'the account security log'),
  ('public', 'support_messages',              '{}', 'what was said on a ticket'),
  ('public', 'support_attachments',           '{}', 'what was attached to a ticket'),
  ('public', 'support_internal_notes',        '{}', 'staff notes on a ticket'),
  ('public', 'support_ticket_events',         '{}', 'ticket lifecycle trail'),
  ('public', 'dispute_messages',              '{}', 'what was said on a dispute'),
  ('public', 'dispute_evidence',              '{}', 'evidence attached to a dispute'),
  ('public', 'account_recovery_evidence',     '{}', 'evidence attached to a recovery request'),
  ('public', 'account_recovery_approvals',    '{}', 'the two-person recovery decisions'),
  ('public', 'notifications',   '{read_at,archived_at}',
     'a notification is written by a definer function; the owner may only mark it read or archived');

-- ---------------------------------------------------------------------------------------------------
-- The guards
-- ---------------------------------------------------------------------------------------------------
create or replace function public.rls_problems()
returns table (object text, problem text)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select format('%s.%s', n.nspname, c.relname), 'the table has no row level security'
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where c.relkind in ('r', 'p')
     and n.nspname in ('public', 'app_private', 'audit')
     and not c.relrowsecurity;
$$;
comment on function public.rls_problems() is
  'Tables in the application schemas that row level security does not cover. Empty when the contract holds.';

create or replace function public.grant_problems()
returns table (object text, problem text)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  -- Anything reachable by a request must be governed by a policy.
  select format('%s.%s', n.nspname, c.relname), 'granted to authenticated with no policy'
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where c.relkind in ('r', 'p')
     and n.nspname in ('public', 'app_private', 'audit')
     and exists (select 1 from information_schema.role_table_grants g
                  where g.grantee = 'authenticated'
                    and g.table_schema = n.nspname and g.table_name = c.relname)
     and not exists (select 1 from pg_policy p where p.polrelid = c.oid)
  union all
  -- A write privilege no policy can ever satisfy is a mistake, whichever way round it was made.
  select format('%s.%s', g.table_schema, g.table_name),
         format('%s is granted to authenticated with no policy for that command', lower(g.privilege_type))
    from information_schema.role_table_grants g
    join pg_class c on c.relname = g.table_name
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = g.table_schema
   where g.grantee = 'authenticated'
     and g.table_schema in ('public', 'app_private', 'audit')
     and g.privilege_type in ('INSERT', 'UPDATE', 'DELETE')
     and not exists (
       select 1 from pg_policy p
        where p.polrelid = c.oid
          and p.polcmd in ('*', case g.privilege_type when 'INSERT' then 'a'
                                                      when 'UPDATE' then 'w'
                                                      else 'd' end))
  union all
  -- A policy that names `anon` would hand an unauthenticated request a row.
  select format('%s.%s', n.nspname, c.relname), format('policy %s names anon', p.polname)
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('public', 'app_private', 'audit')
     and exists (select 1 from unnest(p.polroles) r where pg_get_userbyid(r) = 'anon');
$$;
comment on function public.grant_problems() is
  'Grants that no policy governs, write grants no policy can satisfy, and policies that name anon.';

create or replace function public.anon_privilege_problems()
returns table (object text, problem text)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select format('%s.%s', table_schema, table_name), format('anon holds %s', lower(privilege_type))
    from information_schema.role_table_grants
   where grantee = 'anon'
  union all
  select format('%s.%s.%s', table_schema, table_name, column_name),
         format('anon holds %s on the column', lower(privilege_type))
    from information_schema.column_privileges
   where grantee = 'anon'
  union all
  select format('%s.%s', specific_schema, routine_name), 'anon may execute the routine'
    from information_schema.role_routine_grants
   where grantee = 'anon'
  union all
  -- Every sequence outside the system and per-session schemas: a `pg_temp_*` sequence belongs to the
  -- session that made it and is unreachable from another, and `pg_catalog` is PostgreSQL's own. The
  -- `offset 0` keeps the planner from testing the privilege before the relkind filter, which would ask
  -- `has_sequence_privilege` about a TOAST relation and raise.
  select format('%s.%s', s.nspname, s.relname), 'anon reaches the sequence'
    from (select n.nspname, c.relname, c.oid
            from pg_class c
            join pg_namespace n on n.oid = c.relnamespace
           where c.relkind = 'S'
             and n.nspname not like 'pg\_%'
             and n.nspname <> 'information_schema'
           offset 0) s
   where has_sequence_privilege('anon', s.oid, 'usage, select, update')
  union all
  select n.nspname, format('anon holds %s on the schema', lower(p.priv))
    from pg_namespace n,
         lateral (select unnest(array['USAGE', 'CREATE']) as priv) p
   where n.nspname in ('public', 'app_private', 'audit', 'extensions',
                       'storage', 'realtime', 'auth', 'vault', 'cron')
     and has_schema_privilege('anon', n.nspname, p.priv);
$$;
comment on function public.anon_privilege_problems() is
  'Anything at all that the anonymous role can reach. The Data API is off and anon is granted nothing (S8).';

create or replace function public.role_boundary_problems()
returns table (object text, problem text)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  -- `app_private` is server-only.
  select format('app_private.%s', table_name), 'authenticated holds a privilege in app_private'
    from information_schema.role_table_grants
   where grantee = 'authenticated' and table_schema = 'app_private'
  union all
  -- The service roles own no data; they act only through named definer functions.
  select format('%s.%s', table_schema, table_name), format('%s holds a table privilege', grantee)
    from information_schema.role_table_grants
   where grantee in ('app_system', 'app_worker')
     and table_schema in ('public', 'app_private', 'audit')
  union all
  select format('%s.%s.%s', table_schema, table_name, column_name), format('%s holds a column privilege', grantee)
    from information_schema.column_privileges
   where grantee in ('app_system', 'app_worker')
     and table_schema in ('public', 'app_private', 'audit')
  union all
  -- `app_api` carries nothing of its own (S8): it is a NOINHERIT member of `authenticated`.
  select format('%s.%s', table_schema, table_name), 'app_api holds a privilege of its own'
    from information_schema.role_table_grants
   where grantee = 'app_api' and table_schema in ('public', 'app_private', 'audit')
  union all
  select format('%s.%s', n.nspname, p.proname), 'the function is executable by PUBLIC'
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'app_private', 'audit')
     and has_function_privilege('public', p.oid, 'execute')
  union all
  select format('app_private.%s', p.proname), 'an app_private function is executable by authenticated'
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app_private'
     and has_function_privilege('authenticated', p.oid, 'execute')
  union all
  -- Outside the application schemas, a request may reach exactly one thing: the Realtime mailbox, which
  -- 0014's private-topic policy governs.
  select format('%s.%s', table_schema, table_name), format('authenticated holds %s outside the application schemas', lower(privilege_type))
    from information_schema.role_table_grants
   where grantee = 'authenticated'
     and table_schema in ('storage', 'realtime', 'auth', 'vault', 'cron', 'graphql', 'graphql_public')
     and not (table_schema = 'realtime' and table_name = 'messages' and privilege_type = 'SELECT')
  union all
  select n.nspname, 'authenticated may create objects in the schema'
    from pg_namespace n
   where n.nspname in ('public', 'app_private', 'audit', 'extensions')
     and has_schema_privilege('authenticated', n.nspname, 'CREATE');
$$;
comment on function public.role_boundary_problems() is
  'Where a role reaches past the boundary S6 and S8 give it, in either direction.';

create or replace function public.definer_problems()
returns table (object text, problem text)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select format('%s.%s', n.nspname, p.proname),
         case when p.proconfig is null or not exists (
                select 1 from unnest(p.proconfig) cfg where cfg like 'search_path=%')
              then 'the SECURITY DEFINER function does not pin search_path'
              else 'the SECURITY DEFINER function pins a search_path other than pg_catalog, public'
         end
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'app_private', 'audit')
     and p.prosecdef
     and not exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) cfg
                      where cfg = 'search_path=pg_catalog, public');
$$;
comment on function public.definer_problems() is
  'Definer functions whose search_path is not exactly the established `pg_catalog, public`.';

create or replace function public.view_security_problems()
returns table (object text, problem text)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select format('%s.%s', n.nspname, c.relname),
         'the view does not set security_invoker, so it would be read with its owner''s rights'
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where c.relkind in ('v', 'm')
     and n.nspname in ('public', 'app_private', 'audit')
     and coalesce((select option_value from pg_options_to_table(c.reloptions)
                    where option_name = 'security_invoker'), 'false') <> 'true';
$$;
comment on function public.view_security_problems() is
  'Views that would launder row level security by being read with the owner''s rights.';

create or replace function public.append_only_problems()
returns table (object text, problem text)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with contracted as (
    select k.table_schema, k.table_name, k.updatable_columns,
           to_regclass(format('%I.%I', k.table_schema, k.table_name)) as oid
      from app_private.append_only_contract k
  )
  select format('%s.%s', c.table_schema, c.table_name), 'the contracted table does not exist'
    from contracted c where c.oid is null
  union all
  select format('%s.%s', c.table_schema, c.table_name), 'the table does not refuse UPDATE and DELETE'
    from contracted c
   where c.oid is not null
     and not exists (
       select 1 from pg_trigger tg
        join pg_proc p on p.oid = tg.tgfoid
       where tg.tgrelid = c.oid
         and not tg.tgisinternal
         and (p.proname like 'tg\_%reject%' or p.proname like 'tg\_%no\_delete%'
              or p.proname like 'tg\_%immutable%'))
  union all
  select format('%s.%s', g.table_schema, g.table_name),
         format('authenticated holds %s on an append-only table', lower(g.privilege_type))
    from information_schema.role_table_grants g
    join contracted c on c.table_schema = g.table_schema and c.table_name = g.table_name
   where g.grantee = 'authenticated' and g.privilege_type in ('UPDATE', 'DELETE')
  union all
  select format('%s.%s.%s', p.table_schema, p.table_name, p.column_name),
         'authenticated may update a column the append-only contract does not list'
    from information_schema.column_privileges p
    join contracted c on c.table_schema = p.table_schema and c.table_name = p.table_name
   where p.grantee = 'authenticated' and p.privilege_type = 'UPDATE'
     and not (p.column_name = any (c.updatable_columns))
  union all
  -- The other direction: the contract may not fall behind the schema.
  select format('%s.%s', n.nspname, cl.relname), 'the table refuses writes but the contract does not name it'
    from pg_class cl
    join pg_namespace n on n.oid = cl.relnamespace
   where cl.relkind = 'r'
     and n.nspname in ('public', 'app_private', 'audit')
     and not cl.relispartition
     and exists (
       select 1 from pg_trigger tg
        join pg_proc p on p.oid = tg.tgfoid
       where tg.tgrelid = cl.oid
         and not tg.tgisinternal
         and (p.proname like 'tg\_%reject%' or p.proname like 'tg\_%no\_delete%'
              or p.proname like 'tg\_%immutable%'))
     and not exists (select 1 from app_private.append_only_contract k
                      where k.table_schema = n.nspname and k.table_name = cl.relname);
$$;
comment on function public.append_only_problems() is
  'Where the append-only contract and the schema disagree, in either direction.';

-- ---------------------------------------------------------------------------------------------------
-- The umbrella, and the deploy-time assertion
-- ---------------------------------------------------------------------------------------------------
create or replace function public.security_contract_problems()
returns table (area text, object text, problem text)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select 'rls', * from public.rls_problems()
  union all select 'grants', * from public.grant_problems()
  union all select 'anon', * from public.anon_privilege_problems()
  union all select 'roles', * from public.role_boundary_problems()
  union all select 'security_definer', * from public.definer_problems()
  union all select 'views', * from public.view_security_problems()
  union all select 'append_only', * from public.append_only_problems()
  union all select 'storage', * from public.storage_bucket_problems();
$$;
comment on function public.security_contract_problems() is
  'Every violation of the Phase 2 security contract, in one place. Empty means the contract holds.';

create or replace function app_private.assert_security_contract()
returns integer
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  found_problems integer;
  detail text;
begin
  select count(*), string_agg(format('%s: %s — %s', area, object, problem), E'\n' order by area, object)
    into found_problems, detail
    from public.security_contract_problems();

  if found_problems > 0 then
    raise exception 'the security contract is violated in % place(s)', found_problems
      using detail = detail, errcode = 'insufficient_privilege';
  end if;
  return 0;
end;
$$;
comment on function app_private.assert_security_contract() is
  'Raises 42501 listing every violation. Called at the end of 0031 and scheduled by 0032.';

-- ---------------------------------------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema app_private from public;
revoke execute on all functions in schema audit from public;

-- The guards describe the security model, so only the server may read them. The admin security page
-- reaches them through the API, never directly.
grant execute on function
  public.rls_problems(),
  public.grant_problems(),
  public.anon_privilege_problems(),
  public.role_boundary_problems(),
  public.definer_problems(),
  public.view_security_problems(),
  public.append_only_problems(),
  public.security_contract_problems(),
  app_private.assert_security_contract()
  to app_system, app_worker;

-- ---------------------------------------------------------------------------------------------------
-- Enforcement
-- ---------------------------------------------------------------------------------------------------
-- If anything above is untrue of this database, the deployment stops here.
select app_private.assert_security_contract();
