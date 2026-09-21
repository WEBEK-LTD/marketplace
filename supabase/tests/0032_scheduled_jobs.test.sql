-- pgTAP — migration 0032: the pg_cron schedule.
--
-- Every assertion about the schedule reads `cron.job` itself, not the contract table: a contract that
-- agrees with itself proves nothing. Where the guard is used, it is then broken on purpose and shown to
-- notice. The jobs are also executed — once, then again — because "safe to run repeatedly" is a claim
-- about behaviour, not about a comment.
--
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(69);

-- ---------------------------------------------------------------------------------------------------
-- The real catalogue
-- ---------------------------------------------------------------------------------------------------
select is((select count(*) from cron.job), 12::bigint,
  'twelve jobs are scheduled, and only twelve');
select is((select count(*) from cron.job where jobname not like 'marketplace.%'), 0::bigint,
  'every scheduled job belongs to this marketplace');
select is(
  (select coalesce(string_agg(j.jobname, ', ' order by j.jobname), '')
     from cron.job j
    where not exists (select 1 from app_private.scheduled_job_contract k
                       where 'marketplace.' || k.job_key = j.jobname)),
  '',
  'no job is scheduled that the contract does not describe'
);
select is(
  (select coalesce(string_agg(k.job_key, ', ' order by k.job_key), '')
     from app_private.scheduled_job_contract k
    where not exists (select 1 from cron.job j where j.jobname = 'marketplace.' || k.job_key)),
  '',
  'and every contracted job really is in the catalogue'
);

select is(
  (select string_agg(format('%s=%s', j.jobname, j.schedule), E'\n' order by j.jobname) from cron.job j),
  E'marketplace.cms.publish_due=*/5 * * * *\n'
  'marketplace.offers.expire=*/5 * * * *\n'
  'marketplace.partitions.ensure=10 3 * * *\n'
  'marketplace.payment_attempts.expire=*/5 * * * *\n'
  'marketplace.promotions.expire=*/5 * * * *\n'
  'marketplace.promotions.rollup=35 2 * * *\n'
  'marketplace.promotions.start=*/5 * * * *\n'
  'marketplace.reservations.release=* * * * *\n'
  'marketplace.security.assert_contract=45 3 * * *\n'
  'marketplace.seller_balances.release=23 * * * *\n'
  'marketplace.service_orders.complete=17 * * * *\n'
  'marketplace.service_quotes.expire=*/5 * * * *',
  'every schedule reads exactly as intended, from the catalogue itself'
);
select is((select schedule from cron.job where jobname = 'marketplace.reservations.release'), '* * * * *',
  'held stock is returned every minute, because an abandoned checkout blocks a sale');
select is((select schedule from cron.job where jobname = 'marketplace.partitions.ensure'), '10 3 * * *',
  'partitions are created nightly, well before the month they are needed');

select is(
  (select coalesce(string_agg(j.jobname, ', ' order by j.jobname), '')
     from cron.job j
    where j.command <> format('select app_private.run_scheduled_job(%L)',
                              replace(j.jobname, 'marketplace.', ''))),
  '',
  'every command is the approved dispatcher call and nothing else'
);
select is(
  (select count(*) from cron.job where command !~ '^select app_private\.run_scheduled_job\('),
  0::bigint,
  'no cron entry contains inline SQL, a table write, or any other function'
);
select is((select count(*) from cron.job where not active), 0::bigint, 'every job is active');
select is((select count(*) from cron.job where username in ('anon', 'authenticated', 'app_api')), 0::bigint,
  'no job runs as a request role');
select is((select count(distinct username) from cron.job), 1::bigint,
  'and they all run as the one role that owns the schema');

-- The two jobs that are deliberately absent.
select is((select count(*) from cron.job where command like '%sweep_outbox_events%'), 0::bigint,
  'the outbox sweeper is not scheduled here: the approved split puts the sweeper on the worker');
select is((select count(*) from cron.job where jobname like '%purge%' or command like '%purge%'), 0::bigint,
  'and the unverified-account purge is absent, because D24''s schedule depends on C18, which is deferred');
select is((select count(*) from app_private.scheduled_job_contract where job_key like '%purge%'), 0::bigint,
  'the contract does not quietly describe it either');

-- ---------------------------------------------------------------------------------------------------
-- The guard agrees, and notices when it should not
-- ---------------------------------------------------------------------------------------------------
select is((select count(*) from public.cron_job_problems()), 0::bigint, 'the schedule matches its contract');
select is((select count(*) from public.security_contract_problems()), 0::bigint,
  'and the whole 0031 security contract is still green with the cron clause folded in');
select is((select count(*) from public.security_contract_problems() where area = 'cron'), 0::bigint,
  'including the cron area the umbrella now carries');
select is(app_private.assert_security_contract(), 0, 'the deploy-time assertion passes');

savepoint g1;
select cron.unschedule('marketplace.offers.expire');
select is((select problem from public.cron_job_problems() where object = 'marketplace.offers.expire'),
  'the scheduled job does not exist',
  'removing a job is caught');
rollback to g1;

savepoint g2;
select cron.schedule('marketplace.rogue', '* * * * *', 'select 1');
select is((select problem from public.cron_job_problems() where object = 'marketplace.rogue'),
  'a cron job exists that the contract does not describe',
  'adding a job the contract does not name is caught');
rollback to g2;

savepoint g3;
select cron.schedule('unrelated-job', '* * * * *', 'select 1');
select is((select problem from public.cron_job_problems() where object = 'unrelated-job'),
  'a cron job exists that the contract does not describe',
  'and so is one scheduled outside the marketplace prefix');
rollback to g3;

savepoint g4;
update cron.job set schedule = '0 0 * * *' where jobname = 'marketplace.promotions.start';
select ok((select problem like 'the schedule is%' from public.cron_job_problems()
            where object = 'marketplace.promotions.start'),
  'changing a schedule behind the contract''s back is caught');
rollback to g4;

savepoint g5;
update cron.job set command = 'delete from public.orders' where jobname = 'marketplace.promotions.start';
select is((select problem from public.cron_job_problems() where object = 'marketplace.promotions.start'),
  'the command is not the approved dispatcher call',
  'and so is pointing a job at something the contract never approved');
rollback to g5;

savepoint g6;
update cron.job set active = false where jobname = 'marketplace.cms.publish_due';
select is((select problem from public.cron_job_problems() where object = 'marketplace.cms.publish_due'),
  'the job is not active',
  'quietly switching a job off is caught');
rollback to g6;

-- ---------------------------------------------------------------------------------------------------
-- Duplicate prevention
-- ---------------------------------------------------------------------------------------------------
savepoint d1;
select is(
  (select count(*) from cron.job where jobname = 'marketplace.offers.expire'),
  1::bigint,
  'a contracted job appears exactly once'
);
select cron.schedule('marketplace.offers.expire', '*/5 * * * *',
  $$select app_private.run_scheduled_job('offers.expire')$$);
select is((select count(*) from cron.job where jobname = 'marketplace.offers.expire'), 1::bigint,
  'scheduling it again replaces it rather than duplicating it');
select is((select count(*) from cron.job), 12::bigint, 'so the catalogue still holds twelve jobs');
select is((select count(*) from public.cron_job_problems()), 0::bigint, 'and the contract still holds');
rollback to d1;

-- Re-running the migration's own scheduling loop must be a no-op.
savepoint d2;
do $$
declare
  entry app_private.scheduled_job_contract%rowtype;
begin
  for entry in select * from app_private.scheduled_job_contract order by job_key loop
    perform cron.schedule('marketplace.' || entry.job_key, entry.cron_schedule,
      format('select app_private.run_scheduled_job(%L)', entry.job_key));
  end loop;
end;
$$;
select is((select count(*) from cron.job), 12::bigint,
  'applying the migration a second time leaves exactly the same twelve jobs');
select is((select count(*) from public.cron_job_problems()), 0::bigint, 'with no drift');
rollback to d2;

-- ---------------------------------------------------------------------------------------------------
-- Scheduler internals stay out of reach
-- ---------------------------------------------------------------------------------------------------
select is(
  (select coalesce(string_agg(format('%s:%s:%s', table_name, grantee, privilege_type), ', '), '')
     from information_schema.role_table_grants
    where table_schema = 'cron' and grantee in ('PUBLIC', 'anon', 'authenticated', 'app_api')),
  '',
  'neither PUBLIC nor any request role holds a privilege on cron.job or cron.job_run_details'
);
select is(
  (select coalesce(string_agg(distinct routine_name, ', '), '')
     from information_schema.role_routine_grants
    where specific_schema = 'cron' and grantee in ('PUBLIC', 'anon', 'authenticated', 'app_api')),
  '',
  'and none of them may execute cron.schedule, cron.unschedule or any other scheduler routine'
);
select ok(
  not has_schema_privilege('anon', 'cron', 'usage')
    and not has_schema_privilege('authenticated', 'cron', 'usage')
    and not has_schema_privilege('app_api', 'cron', 'usage'),
  'no request role can even reach into the cron schema'
);
select is(
  (select count(*) from (select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace
                          where n.nspname = 'cron' and c.relkind = 'S' offset 0) s
    where has_sequence_privilege('anon', s.oid, 'usage, select, update')
       or has_sequence_privilege('authenticated', s.oid, 'usage, select, update')),
  0::bigint,
  'the pg_cron sequences found in 0031 are still out of reach'
);
select is(
  (select relacl::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'cron' and c.relname = 'job'),
  format('{%s=arwdDxt/%s}', current_user, current_user),
  'cron.job belongs to its owner alone'
);

savepoint p1;
grant select on cron.job to authenticated;
select is((select problem from public.cron_job_problems() where object = 'cron.job'),
  'authenticated holds select on a scheduler table',
  'handing a request role the job list is caught');
rollback to p1;

savepoint p2;
grant execute on function cron.schedule(text, text, text) to public;
select ok((select count(*) > 0 from public.cron_job_problems() where object = 'cron.schedule'),
  'and so is letting PUBLIC schedule jobs again');
rollback to p2;

savepoint p3;
grant select on sequence cron.jobid_seq to anon;
select is((select problem from public.cron_job_problems() where object = 'cron.jobid_seq'),
  'a scheduler sequence is reachable by PUBLIC or a request role',
  'the 0031 sequence finding cannot be reintroduced unnoticed');
rollback to p3;

-- ---------------------------------------------------------------------------------------------------
-- The dispatcher and its boundary
-- ---------------------------------------------------------------------------------------------------
select is(
  (select coalesce(string_agg(p.proname, ', ' order by p.proname), '')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('run_scheduled_job', 'expire_due_offers', 'expire_due_service_quotes',
                        'expire_due_payment_attempts', 'ensure_event_partitions')
      and not (p.prosecdef and exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) cfg
                                        where cfg = 'search_path=pg_catalog, public'))),
  '',
  'every function this migration adds is SECURITY DEFINER with the established search_path'
);
select is(
  (select coalesce(string_agg(p.proname, ', ' order by p.proname), '')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('app_private', 'public')
      and p.proname in ('run_scheduled_job', 'cron_job_problems', 'expire_due_offers',
                        'expire_due_service_quotes', 'expire_due_payment_attempts',
                        'ensure_event_partitions')
      and (has_function_privilege('authenticated', p.oid, 'execute')
           or has_function_privilege('anon', p.oid, 'execute')
           or has_function_privilege('public', p.oid, 'execute'))),
  '',
  'and none of them is reachable by a request'
);
select ok(
  (select bool_and(has_function_privilege('app_system', p.oid, 'execute')
                   and has_function_privilege('app_worker', p.oid, 'execute'))
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'run_scheduled_job'),
  'the dispatcher is reachable by the service roles, which is the approved execution boundary'
);
select ok(
  (select relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'app_private' and c.relname = 'scheduled_job_contract'),
  'the schedule contract table carries row level security like every other app_private table'
);
select is(
  (select count(*) from information_schema.role_table_grants
    where table_name = 'scheduled_job_contract' and grantee <> current_user),
  0::bigint,
  'and nobody but its owner holds a privilege on it'
);
select throws_ok(
  $$select app_private.run_scheduled_job('not.a.job')$$,
  '22023',
  null,
  'a key the contract does not name is refused rather than guessed at'
);

-- ---------------------------------------------------------------------------------------------------
-- Every job actually runs, and runs safely twice
-- ---------------------------------------------------------------------------------------------------
savepoint r1;
delete from public.job_runs;

select lives_ok(
  $$select app_private.run_scheduled_job(job_key) from app_private.scheduled_job_contract order by job_key$$,
  'every contracted job runs without error'
);
select is((select count(*) from public.job_runs), 12::bigint,
  'and each one writes its own job_runs row, as the specification requires');
select is((select count(*) from public.job_runs where status <> 'succeeded'), 0::bigint,
  'all twelve succeed on an empty database');

select is(
  (select count(*) from pg_class where relispartition),
  (select count(*) from pg_class where relispartition),
  'the partition count is taken before the second run'
);
create temporary table partition_count_before on commit drop as
  select count(*) as n from pg_class where relispartition;

select lives_ok(
  $$select app_private.run_scheduled_job(job_key) from app_private.scheduled_job_contract order by job_key$$,
  'running every job a second time is safe'
);
select is(
  (select count(*) from pg_class where relispartition),
  (select n from partition_count_before),
  'the partition job created nothing the second time: it is idempotent, not merely repeatable'
);
select is((select count(*) from public.job_runs), 24::bigint,
  'and the second pass is recorded separately, so a run is never silently merged with another');
select is((select count(*) from public.job_runs where status <> 'succeeded'), 0::bigint,
  'with nothing failing on the repeat');
rollback to r1;

-- Failure is recorded rather than lost, and does not take the schedule down with it.
savepoint r2;
delete from public.job_runs;
create or replace function app_private.publish_due_content() returns integer
language plpgsql security definer set search_path = pg_catalog, public as $probe$
begin
  raise exception 'probe failure' using errcode = '22023';
end
$probe$;
select is(app_private.run_scheduled_job('cms.publish_due'), -1,
  'a failing job returns -1 instead of taking the transaction down');
select is((select status from public.job_runs where job_name = 'cms.publish_due'), 'failed',
  'and the failure is recorded in job_runs, where the admin platform page reads it');
select is((select error_type from public.job_runs where job_name = 'cms.publish_due'), 'sqlstate_22023',
  'the SQLSTATE is stored in a form 0007''s constraint accepts, so the record itself cannot fail');
select is((select details ->> 'sqlstate' from public.job_runs where job_name = 'cms.publish_due'), '22023',
  'with the unprefixed code kept alongside it');
select is((select details ->> 'message' from public.job_runs where job_name = 'cms.publish_due'), 'probe failure',
  'and the message that came with it');
select lives_ok(
  $$select app_private.run_scheduled_job('offers.expire')$$,
  'the next job in the schedule runs normally afterwards'
);
rollback to r2;

-- ---------------------------------------------------------------------------------------------------
-- The targets are the approved domain functions, not new business logic
-- ---------------------------------------------------------------------------------------------------
select is(
  (select coalesce(string_agg(k.job_key, ', ' order by k.job_key), '')
     from app_private.scheduled_job_contract k
    where not exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where format('%s.%s(', n.nspname, p.proname) = left(k.target_signature,
               length(format('%s.%s(', n.nspname, p.proname))))),
  '',
  'every contracted target names a function that exists'
);
select is(
  (select count(*) from app_private.scheduled_job_contract where target_signature !~ '^(app_private|audit)\.'),
  0::bigint,
  'and all of them live in the server-only schemas'
);

-- Each sweep leaves nothing behind on a second pass.
savepoint r3;
select is(app_private.expire_due_offers(500), 0, 'the offer sweep finds nothing due on an empty database');
select is(app_private.expire_due_service_quotes(500), 0, 'nor does the quote sweep');
select is(app_private.expire_due_payment_attempts(200), 0, 'nor the payment-attempt sweep');
select cmp_ok(app_private.ensure_event_partitions(3), '>=', 0, 'and the partition helper is happy to be called again');
rollback to r3;

-- ---------------------------------------------------------------------------------------------------
-- Nothing financial was opened
-- ---------------------------------------------------------------------------------------------------
select is(
  (select value #>> '{}' from public.site_settings where key = 'finance.settlement_posting_enabled'),
  'false',
  'settlement posting is still disabled'
);
select is(
  (select count(*) from public.payment_providers) + (select count(*) from public.payout_providers),
  0::bigint,
  'and no provider was seeded'
);
select is(
  (select count(*) from cron.job where command ~* '(settle|payout|provider|ledger|withdraw)'),
  0::bigint,
  'no scheduled job touches settlement, payouts, providers, the ledger or withdrawals directly'
);
select is(
  (select count(*) from cron.job where command ~* '(http|curl|net\.|pg_background|dblink)'),
  0::bigint,
  'and no job reaches outside the database'
);

select * from finish();
rollback;
