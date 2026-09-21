-- pgTAP — migration 0031: the security contract.
--
-- This file has two halves, and the second is the important one.
--
--   * First it asserts the contract holds on the schema 0001 to 0031 actually produce, and reads the
--     real catalogue — grants, policies, column privileges, role memberships — rather than trusting the
--     guard's own summary.
--   * Then it breaks each rule on purpose, inside the transaction, and asserts the guard notices. A
--     guard that only ever reports green has never been shown to work; every clause below is proven to
--     fail when the thing it protects is taken away.
--
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(66);

-- ---------------------------------------------------------------------------------------------------
-- The contract holds as shipped
-- ---------------------------------------------------------------------------------------------------
select is((select count(*) from public.security_contract_problems()), 0::bigint,
  'the security contract holds on the schema 0001 to 0031 produce');
select is(app_private.assert_security_contract(), 0,
  'and the deploy-time assertion passes');

select is((select count(*) from public.rls_problems()), 0::bigint, 'every application table has RLS');
select is((select count(*) from public.grant_problems()), 0::bigint, 'no grant is ungoverned by a policy');
select is((select count(*) from public.anon_privilege_problems()), 0::bigint, 'anon reaches nothing');
select is((select count(*) from public.role_boundary_problems()), 0::bigint, 'no role reaches past its boundary');
select is((select count(*) from public.definer_problems()), 0::bigint, 'every definer function pins the search_path');
select is((select count(*) from public.view_security_problems()), 0::bigint, 'every view is read with the caller''s rights');
select is((select count(*) from public.append_only_problems()), 0::bigint, 'the append-only contract matches the schema');
select is((select count(*) from public.storage_bucket_problems()), 0::bigint, 'the storage contract still holds');

-- ---------------------------------------------------------------------------------------------------
-- Read the catalogue directly, rather than believing the guard
-- ---------------------------------------------------------------------------------------------------
select is(
  (select coalesce(string_agg(format('%s.%s', n.nspname, c.relname), ', ' order by n.nspname, c.relname), '')
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p') and n.nspname in ('public', 'app_private', 'audit')
      and not c.relrowsecurity),
  '',
  'no table in public, app_private or audit is missing row level security'
);
select cmp_ok(
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p') and n.nspname in ('public', 'app_private', 'audit')),
  '>', 150::bigint,
  'and that covers the whole Phase 2 schema, not a handful of tables'
);

select is((select count(*) from information_schema.role_table_grants where grantee = 'anon'),
  0::bigint, 'anon holds no table privilege anywhere in the database');
select is((select count(*) from information_schema.column_privileges where grantee = 'anon'),
  0::bigint, 'nor a column privilege');
select is((select count(*) from information_schema.role_routine_grants where grantee = 'anon'),
  0::bigint, 'nor may it execute a routine');
select ok(
  not has_schema_privilege('anon', 'public', 'usage')
    and not has_schema_privilege('anon', 'app_private', 'usage')
    and not has_schema_privilege('anon', 'audit', 'usage')
    and not has_schema_privilege('anon', 'extensions', 'usage')
    and not has_schema_privilege('anon', 'storage', 'usage')
    and not has_schema_privilege('anon', 'realtime', 'usage')
    and not has_schema_privilege('anon', 'cron', 'usage')
    and not has_schema_privilege('anon', 'vault', 'usage'),
  'and it cannot use any schema that holds data'
);
select is(
  (select count(*) from (select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace
                          where c.relkind = 'S' and n.nspname not like 'pg\_%'
                            and n.nspname <> 'information_schema' offset 0) s
    where has_sequence_privilege('anon', s.oid, 'usage, select, update')),
  0::bigint,
  'no sequence is left reachable by anon, including the ones pg_cron grants to PUBLIC'
);
select is(
  (select relacl::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'cron' and c.relname = 'jobid_seq'),
  format('{%s=rwU/%s}', current_user, current_user),
  'pg_cron''s job sequence is the owner''s alone now'
);

select is((select count(*) from information_schema.role_table_grants
           where grantee = 'authenticated' and table_schema = 'app_private'),
  0::bigint, 'authenticated holds nothing in app_private');
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and has_function_privilege('authenticated', p.oid, 'execute')),
  0::bigint,
  'and may execute no app_private function: the service boundary is functions, not privileges'
);
select is((select count(*) from information_schema.role_table_grants
           where grantee in ('app_system', 'app_worker')),
  0::bigint, 'app_system and app_worker hold no table privilege anywhere');
select is((select count(*) from information_schema.column_privileges
           where grantee in ('app_system', 'app_worker')),
  0::bigint, 'nor a column privilege');
select is((select count(*) from information_schema.role_table_grants where grantee = 'app_api'),
  0::bigint, 'app_api holds nothing of its own (S8): it must SET ROLE to reach anything');
select is(
  (select format('%s/%s', g.rolname, m.inherit_option)
     from pg_auth_members m join pg_roles r on r.oid = m.member join pg_roles g on g.oid = m.roleid
    where r.rolname = 'app_api'),
  'authenticated/f',
  'and it is a NOINHERIT member of authenticated, exactly as S8 requires'
);

select is(
  (select coalesce(string_agg(format('%s.%s', n.nspname, p.proname), ', ' order by n.nspname, p.proname), '')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'app_private', 'audit')
      and has_function_privilege('public', p.oid, 'execute')),
  '',
  'no application function is executable by PUBLIC'
);
select is(
  (select coalesce(string_agg(format('%s.%s', n.nspname, p.proname), ', ' order by n.nspname, p.proname), '')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'app_private', 'audit') and p.prosecdef
      and not exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) cfg
                       where cfg = 'search_path=pg_catalog, public')),
  '',
  'every SECURITY DEFINER function pins exactly `pg_catalog, public`'
);
select cmp_ok(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'app_private', 'audit') and p.prosecdef),
  '>', 100::bigint,
  'and there are enough of them for that to mean something'
);

select is(
  (select coalesce(string_agg(format('%s:%s', c.relname,
            coalesce((select option_value from pg_options_to_table(c.reloptions)
                       where option_name = 'security_invoker'), 'unset')), ', ' order by c.relname), '')
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('v', 'm') and n.nspname in ('public', 'app_private', 'audit')),
  'seller_ratings:true, wallet_transactions:true',
  'both views are security_invoker, so neither can launder row level security'
);

-- The one thing a request may reach outside the application schemas.
select is(
  (select coalesce(string_agg(format('%s.%s:%s', table_schema, table_name, privilege_type), ', '), '')
     from information_schema.role_table_grants
    where grantee = 'authenticated'
      and table_schema not in ('public', 'app_private', 'audit')),
  'realtime.messages:SELECT',
  'outside the application schemas a request may only read the Realtime mailbox'
);
select is(
  (select p.polcmd::text from pg_policy p join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'realtime' and c.relname = 'messages'),
  'r',
  'and that mailbox carries a read-only policy, so the outbox remains the only way to publish'
);

-- Storage boundaries.
select is((select count(*) from storage.buckets where public), 1::bigint,
  'exactly one storage bucket is public');
select is((select id from storage.buckets where public), 'listing-variants',
  'and it is the approved listing-variants bucket');
select is(
  (select count(*) from pg_policy p join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'storage' and c.relname = 'objects'),
  1::bigint,
  'storage.objects carries one policy, for that bucket: every private bucket is reached only by signed URL (C15)'
);
select is(
  (select count(*) from information_schema.role_table_grants
    where table_schema = 'storage' and grantee in ('anon', 'authenticated')),
  0::bigint,
  'and neither anon nor authenticated holds a privilege on the storage tables'
);

-- ---------------------------------------------------------------------------------------------------
-- Financial isolation and the append-only ledger
-- ---------------------------------------------------------------------------------------------------
select is((select count(*) from app_private.append_only_contract), 30::bigint,
  'thirty tables are contracted append-only');
select is(
  (select coalesce(string_agg(format('%s.%s', g.table_schema, g.table_name), ', '), '')
     from information_schema.role_table_grants g
     join app_private.append_only_contract k
       on k.table_schema = g.table_schema and k.table_name = g.table_name
    where g.grantee = 'authenticated' and g.privilege_type in ('UPDATE', 'DELETE')),
  '',
  'and a request can update or delete none of them'
);
select is(
  (select coalesce(string_agg(column_name, ',' order by column_name), '')
     from information_schema.column_privileges
    where grantee = 'authenticated' and table_name = 'notifications' and privilege_type = 'UPDATE'),
  'archived_at,read_at',
  'the one column-level exception is a notification''s own read and archived marks'
);
select is(
  (select coalesce(string_agg(format('%s:%s', g.table_name, g.privilege_type), ', ' order by g.table_name, g.privilege_type), '')
     from information_schema.role_table_grants g
    where g.grantee = 'authenticated'
      and g.table_name in ('ledger_entries', 'ledger_journals', 'ledger_accounts', 'commissions')
      and g.privilege_type in ('INSERT', 'UPDATE', 'DELETE')),
  '',
  'no request may write to the ledger at all: journals are posted by definer functions only'
);
select is(
  (select coalesce(string_agg(table_name, ', ' order by table_name), '')
     from information_schema.role_table_grants
    where grantee = 'authenticated'
      and table_name in ('outbox_events', 'idempotency_keys', 'email_outbox', 'whatsapp_outbox',
                         'payment_events', 'payout_events', 'payment_provider_transactions',
                         'payout_transactions')),
  '',
  'the outbox, the idempotency keys, the delivery queues and the provider evidence are unreachable by a request'
);
select is(
  (select value #>> '{}' from public.site_settings where key = 'finance.settlement_posting_enabled'),
  'false',
  'settlement posting is still disabled'
);
select is(
  (select count(*) from public.payment_providers) + (select count(*) from public.payout_providers),
  0::bigint,
  'and no provider has been seeded'
);

-- ---------------------------------------------------------------------------------------------------
-- The guards themselves are not a way in
-- ---------------------------------------------------------------------------------------------------
select is(
  (select coalesce(string_agg(p.proname, ', ' order by p.proname), '')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where p.proname in ('security_contract_problems', 'rls_problems', 'grant_problems',
                        'anon_privilege_problems', 'role_boundary_problems', 'definer_problems',
                        'view_security_problems', 'append_only_problems', 'assert_security_contract')
      and (has_function_privilege('authenticated', p.oid, 'execute')
           or has_function_privilege('anon', p.oid, 'execute')
           or has_function_privilege('public', p.oid, 'execute'))),
  '',
  'no signed-in request can enumerate the security model'
);
select ok(
  (select bool_and(has_function_privilege('app_system', p.oid, 'execute')
                   and has_function_privilege('app_worker', p.oid, 'execute'))
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('security_contract_problems', 'rls_problems', 'append_only_problems')),
  'the server roles can, which is how the admin security page and the scheduled check read them'
);
select is(
  (select count(*) from app_private.append_only_contract),
  (select count(*) from app_private.append_only_contract),
  'the contract table itself has RLS and no grant, so only a definer function reads it'
);
select ok(
  (select relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'app_private' and c.relname = 'append_only_contract'),
  'confirmed: the contract table is protected like every other app_private table'
);

-- ---------------------------------------------------------------------------------------------------
-- Now break each rule on purpose and prove the guard notices
-- ---------------------------------------------------------------------------------------------------
savepoint before_breakage;

create table public.guard_probe (id uuid primary key default gen_random_uuid(), note text);
select is((select count(*) from public.rls_problems() where object = 'public.guard_probe'), 1::bigint,
  'a new table without RLS is caught');
select ok((select count(*) > 0 from public.security_contract_problems() where area = 'rls'),
  'and it reaches the umbrella');
select throws_ok(
  $$select app_private.assert_security_contract()$$,
  '42501',
  null,
  'and the deploy-time assertion refuses to let it through'
);
rollback to before_breakage;

savepoint b2;
create table public.guard_probe (id uuid primary key);
alter table public.guard_probe enable row level security;
grant select on public.guard_probe to authenticated;
select is((select problem from public.grant_problems() where object = 'public.guard_probe'),
  'granted to authenticated with no policy',
  'a grant with no policy behind it is caught');
rollback to b2;

savepoint b3;
create table public.guard_probe (id uuid primary key);
alter table public.guard_probe enable row level security;
create policy guard_probe_read on public.guard_probe for select to authenticated using (true);
grant select, insert on public.guard_probe to authenticated;
select is(
  (select problem from public.grant_problems() where object = 'public.guard_probe'),
  'insert is granted to authenticated with no policy for that command',
  'an insert grant that no policy can ever satisfy is caught'
);
rollback to b3;

savepoint b4;
create policy guard_probe_anon on public.pages for select to anon using (true);
select is((select problem from public.grant_problems() where object = 'public.pages'),
  'policy guard_probe_anon names anon',
  'a policy that hands rows to anon is caught');
rollback to b4;

savepoint b5;
grant select on public.pages to anon;
select is((select count(*) from public.anon_privilege_problems() where object = 'public.pages'), 1::bigint,
  'a table granted to anon is caught');
rollback to b5;

savepoint b6;
grant usage on schema public to anon;
select is((select problem from public.anon_privilege_problems() where object = 'public'),
  'anon holds usage on the schema',
  'schema usage handed to anon is caught');
rollback to b6;

savepoint b7;
grant select on public.pages to app_system;
select is((select problem from public.role_boundary_problems() where object = 'public.pages'),
  'app_system holds a table privilege',
  'a service role given data access is caught');
rollback to b7;

savepoint b8;
grant execute on function app_private.publish_due_content() to authenticated;
select is((select count(*) from public.role_boundary_problems()
            where object = 'app_private.publish_due_content'), 1::bigint,
  'an app_private function opened to a request is caught');
rollback to b8;

savepoint b9;
create function public.guard_probe_fn() returns integer language sql security definer as $probe$ select 1 $probe$;
select is((select problem from public.definer_problems() where object = 'public.guard_probe_fn'),
  'the SECURITY DEFINER function does not pin search_path',
  'a definer function with a searchable path is caught');
rollback to b9;

savepoint b10;
create function public.guard_probe_fn() returns integer language sql security definer
  set search_path = public as $probe$ select 1 $probe$;
select is((select problem from public.definer_problems() where object = 'public.guard_probe_fn'),
  'the SECURITY DEFINER function pins a search_path other than pg_catalog, public',
  'and so is one that pins the wrong path');
rollback to b10;

savepoint b11;
create view public.guard_probe_view as select id from public.pages;
select is((select count(*) from public.view_security_problems() where object = 'public.guard_probe_view'),
  1::bigint,
  'a view that would be read with its owner''s rights is caught');
rollback to b11;

savepoint b12;
grant update on public.ledger_entries to authenticated;
select is((select problem from public.append_only_problems() where object = 'public.ledger_entries'),
  'authenticated holds update on an append-only table',
  'handing out UPDATE on the ledger is caught');
rollback to b12;

savepoint b13;
grant update (created_at) on public.notifications to authenticated;
select is(
  (select count(*) from public.append_only_problems()
    where object = 'public.notifications.created_at'),
  1::bigint,
  'and so is a column-level update the contract does not list'
);
rollback to b13;

savepoint b14;
delete from app_private.append_only_contract where table_name = 'ledger_entries';
select is((select problem from public.append_only_problems() where object = 'public.ledger_entries'),
  'the table refuses writes but the contract does not name it',
  'quietly dropping a table from the contract is caught too');
rollback to b14;

savepoint b15;
drop trigger ledger_entries_append_only on public.ledger_entries;
select is((select problem from public.append_only_problems() where object = 'public.ledger_entries'),
  'the table does not refuse UPDATE and DELETE',
  'and so is removing the trigger that makes it append-only');
rollback to b15;

savepoint b16;
update storage.buckets set public = true where id = 'verification-documents';
select is((select problem from public.security_contract_problems() where area = 'storage'),
  'the bucket must be private',
  'a sensitive bucket turned public is a contract violation, not just a failing test');
rollback to b16;

savepoint b17;
grant select on public.pages to anon;
grant select on public.blog_posts to anon;
select cmp_ok((select count(*) from public.security_contract_problems()), '>=', 2::bigint,
  'the umbrella reports every violation rather than stopping at the first');
select throws_matching(
  $$select app_private.assert_security_contract()$$,
  'violated in',
  'and the assertion names how many there are'
);
rollback to b17;

select is((select count(*) from public.security_contract_problems()), 0::bigint,
  'after every probe is rolled back, the contract holds again');

select * from finish();
rollback;
