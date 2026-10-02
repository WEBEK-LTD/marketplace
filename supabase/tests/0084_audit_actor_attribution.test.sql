-- pgTAP — migration 0084: the audit actor attribution channel (Phase 8-B).
--
-- What these assertions hold to account:
--
--   * **a staff write names the staff member.** A financial audited table is written through a real
--     writer with a real actor, and the audit row carries `actor_type = 'user'` and that person's id.
--   * **nothing else is promoted to a person.** A write with no attributed actor stays `system` with a
--     null actor; a write arriving on the worker's own connection is `worker` with a null actor. No
--     worker identity is invented, and `system` is never silently upgraded.
--   * **Alice is never replaced by Bob while Alice is acting.** A different actor arriving inside an
--     active writer scope raises 42501; the same actor is a no-op; a nested call that names nobody keeps
--     the actor it found; and when the writer returns, the actor it found is restored.
--   * **but Alice and Bob may act in sequence.** A seller requests a withdrawal and a staff member then
--     reviews it, in one transaction, and the trail shows the seller on the request and the staff member
--     on the review — which is exactly what 0021's and 0022's own fixtures do.
--   * **the context is transaction-local.** An actor published inside a savepoint is gone when that
--     savepoint rolls back — the same mechanism a transaction rollback uses — and no session state is
--     created at all, which is what keeps it safe under transaction-mode pooling (C3).
--   * **the channel cannot become an authorization input.** `current_user_id()` still reads only the
--     verified claims; no authorization predicate names the channel; `has_permission` and `is_aal2`
--     answer exactly the same with an actor attributed as without one; and the guard is driven against
--     four real violations, three of which are shown to fail the deployment.
--   * **nobody can call the channel directly.** Neither function is executable by any role — not
--     `app_system`, not `app_worker` — so only a definer function running as the owner can reach it.
--   * **one row per change, still.** The trigger's redaction, its no-op-update rule and its record id are
--     unchanged, an attributed write produces exactly one audit row, and `audit.audit_logs` still has
--     exactly two writers.
--
-- Deterministic: fixed uuids and explicit values, and every state change that must not leak into the
-- next assertion is taken inside a savepoint. Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(163);

-- ---------------------------------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('fb000000-0000-4000-8000-00000000000a', 'attribution-alice@test.invalid'),
  ('fb000000-0000-4000-8000-00000000000b', 'attribution-bob@test.invalid');

insert into public.payment_providers (id, key, display_name) values
  ('fb000000-0000-4000-8000-000000000101', 'attribution_provider', 'Attribution Provider');

-- The newest audit row for a table. `now()` is transaction-stable, so `occurred_at` cannot order these:
-- the identity column is the only true order.
create function pg_temp.latest(p_table text)
returns table (actor_type text, actor_id uuid, action text, changed_columns text[])
language sql as $fn$
  select l.actor_type, l.actor_id, l.action, l.changed_columns
    from audit.audit_logs l
   where l.table_name = p_table
   order by l.id desc
   limit 1;
$fn$;

-- ---------------------------------------------------------------------------------------------------
-- The channel's shape
-- ---------------------------------------------------------------------------------------------------
select has_function('app_private', 'audit_actor', array[]::text[], 'the channel reader exists');
select has_function('app_private', 'set_audit_actor', array['uuid'], 'the scope entry point exists');
select has_function('app_private', 'restore_audit_actor', array['uuid'], 'the scope exit point exists');

select is(p.provolatile::text, 'v',
          'the reader is VOLATILE: a writer publishes and then writes inside one statement, and a stable marking would answer from before the publish')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and p.proname = 'audit_actor';

select ok(p.prosecdef, format('%s is SECURITY DEFINER', p.proname))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and p.proname in ('audit_actor', 'set_audit_actor', 'restore_audit_actor');

select ok('search_path=pg_catalog, public' = any(p.proconfig), format('%s pins the established search_path', p.proname))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and p.proname in ('audit_actor', 'set_audit_actor', 'restore_audit_actor');

-- No role at all. This is the property that keeps the browser, and the API itself, off the channel.
select ok(not has_function_privilege(r.rolname, p.oid, 'execute'),
          format('%s may not call %s directly', r.rolname, p.proname))
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  cross join (values ('public'), ('anon'), ('authenticated'), ('app_api'), ('app_system'), ('app_worker')) as r(rolname)
 where n.nspname = 'app_private' and p.proname in ('audit_actor', 'set_audit_actor', 'restore_audit_actor');

-- ---------------------------------------------------------------------------------------------------
-- Setting, keeping and refusing an actor
-- ---------------------------------------------------------------------------------------------------
select is(app_private.audit_actor(), null::uuid, 'nothing is attributed until a writer publishes something');

savepoint sp_semantics;

select lives_ok($q$do $x$ begin perform app_private.set_audit_actor(null::uuid); end $x$$q$,
  'a call that names no actor claims nothing');
select is(app_private.audit_actor(), null::uuid, 'and it left the channel empty');

select lives_ok($q$do $x$ begin perform app_private.set_audit_actor('fb000000-0000-4000-8000-00000000000a'::uuid); end $x$$q$,
  'a writer publishes the actor it was authorized with');
select is(app_private.audit_actor(), 'fb000000-0000-4000-8000-00000000000a'::uuid,
  'the channel carries that actor');

select lives_ok($q$do $x$ begin perform app_private.set_audit_actor('fb000000-0000-4000-8000-00000000000a'::uuid); end $x$$q$,
  'a nested call with the same actor continues in the same context');
select is(app_private.audit_actor(), 'fb000000-0000-4000-8000-00000000000a'::uuid,
  'and the actor is unchanged');

select lives_ok($q$do $x$ begin perform app_private.set_audit_actor(null::uuid); end $x$$q$,
  'a nested system step inside a human action names nobody');
select is(app_private.audit_actor(), 'fb000000-0000-4000-8000-00000000000a'::uuid,
  'and it is still that human action');

select throws_ok(
  $q$do $x$ begin perform app_private.set_audit_actor('fb000000-0000-4000-8000-00000000000b'::uuid); end $x$$q$,
  '42501', null,
  'a different actor arriving while this scope is active fails closed rather than replacing the first');
select is(app_private.audit_actor(), 'fb000000-0000-4000-8000-00000000000a'::uuid,
  'Alice is still the actor after Bob was refused');

-- Leaving the scope restores what was active when it was entered, which for an outermost scope is nobody.
select lives_ok($q$do $x$ begin perform app_private.restore_audit_actor(null::uuid); end $x$$q$,
  'leaving the scope restores the actor that was active when it was entered');
select is(app_private.audit_actor(), null::uuid,
  'and an outermost scope leaves the transaction with no active actor, not with its own');

rollback to savepoint sp_semantics;

-- ---------------------------------------------------------------------------------------------------
-- Transaction-locality
-- ---------------------------------------------------------------------------------------------------
select is(app_private.audit_actor(), null::uuid,
  'rolling back discards the attribution context, exactly as a transaction rollback would');

select is((select count(*) from pg_settings where name = 'app.audit_actor_id' and coalesce(setting, '') <> ''),
  0::bigint, 'and nothing is left behind for a pooled connection to carry into another request');

-- ---------------------------------------------------------------------------------------------------
-- A write with nobody attributed
-- ---------------------------------------------------------------------------------------------------
update public.payment_providers set display_name = 'System Path'
 where id = 'fb000000-0000-4000-8000-000000000101';

select is((select actor_type from pg_temp.latest('payment_providers')), 'system',
  'a write with nobody attributed is recorded as a system action');
select is((select actor_id from pg_temp.latest('payment_providers')), null::uuid,
  'and it names no actor, because there is no person behind it');

-- ---------------------------------------------------------------------------------------------------
-- An attributed write
-- ---------------------------------------------------------------------------------------------------
savepoint sp_user;
do $x$ begin perform app_private.set_audit_actor('fb000000-0000-4000-8000-00000000000a'::uuid); end $x$;

update public.payment_providers set display_name = 'Attributed Path'
 where id = 'fb000000-0000-4000-8000-000000000101';

select is((select actor_type from pg_temp.latest('payment_providers')), 'user',
  'an attributed write is recorded as a user action');
select is((select actor_id from pg_temp.latest('payment_providers')), 'fb000000-0000-4000-8000-00000000000a'::uuid,
  'and it names the actor the writer published');
select is((select action from pg_temp.latest('payment_providers')), 'update',
  'the action is still the operation, unchanged from 0006');
select ok((select 'display_name' = any(changed_columns) from pg_temp.latest('payment_providers')),
  'the changed-column list is still computed, unchanged from 0006');

select is(
  (select count(*) from audit.audit_logs
    where table_name = 'payment_providers' and new_values ->> 'display_name' = 'Attributed Path'),
  1::bigint,
  'an attributed write produces exactly one audit row');

rollback to savepoint sp_user;
select is(app_private.audit_actor(), null::uuid, 'and the attribution went with it');

-- ---------------------------------------------------------------------------------------------------
-- The worker's own connection
-- ---------------------------------------------------------------------------------------------------
/*
 * Driven through a real financial writer, as `app_worker`, with no actor parameter anywhere in the call.
 * `session_user` is the login role and a SECURITY DEFINER function cannot change it, so this is a fact
 * about the connection rather than anything a caller asserts.
 */
savepoint sp_worker;
-- pgTAP's own functions live in `extensions`, which is not on the worker's search path, so the facts
-- are captured while the connection really is the worker's and asserted once it is not.
set local session authorization app_worker;
create temporary table worker_facts on commit drop as
  select session_user::text as who,
         app_private.open_settlement(
           'payment'::text, 'EGP'::char(3), 'fb000000-0000-4000-8000-000000000101'::uuid,
           'attribution-worker'::text, current_date, current_date) is not null as opened;
reset session authorization;

select is((select who from worker_facts), 'app_worker', 'the write above really ran on the worker connection');
select ok((select opened from worker_facts),
  'the worker opens a settlement through the same named function the API would use');

select is((select actor_type from pg_temp.latest('provider_settlements')), 'worker',
  'worker-owned execution is recorded as a worker action');
select is((select actor_id from pg_temp.latest('provider_settlements')), null::uuid,
  'and no worker identity is invented');
rollback to savepoint sp_worker;

-- ---------------------------------------------------------------------------------------------------
-- The signed-in path is unchanged
-- ---------------------------------------------------------------------------------------------------
savepoint sp_claims;
do $x$ begin
  perform set_config('request.jwt.claims',
    '{"sub":"fb000000-0000-4000-8000-00000000000b","role":"authenticated"}', true);
end $x$;

update public.payment_providers set display_name = 'Claims Path'
 where id = 'fb000000-0000-4000-8000-000000000101';
select is((select actor_type from pg_temp.latest('payment_providers')), 'user',
  'a write under verified claims is still a user action, exactly as 0006 recorded it');
select is((select actor_id from pg_temp.latest('payment_providers')), 'fb000000-0000-4000-8000-00000000000b'::uuid,
  'and it still names the signed-in person');

-- The published actor wins, because a writer that published one knows which human authorized this
-- particular operation, while ambient claims only say who the connection belongs to.
do $x$ begin perform app_private.set_audit_actor('fb000000-0000-4000-8000-00000000000a'::uuid); end $x$;
update public.payment_providers set display_name = 'Both Present'
 where id = 'fb000000-0000-4000-8000-000000000101';
select is((select actor_id from pg_temp.latest('payment_providers')), 'fb000000-0000-4000-8000-00000000000a'::uuid,
  'the published actor wins over the ambient claims');
rollback to savepoint sp_claims;

-- ---------------------------------------------------------------------------------------------------
-- Through a real financial writer, end to end
-- ---------------------------------------------------------------------------------------------------
savepoint sp_close;

create temporary table settlement_under_test on commit drop as
  select app_private.open_settlement(
    'payment'::text, 'EGP'::char(3), 'fb000000-0000-4000-8000-000000000101'::uuid,
    'attribution-closing'::text, current_date, current_date) as id;

select ok((select app_private.match_settlement(id) is not null from settlement_under_test),
  'the settlement is matched by a call that names no actor');
select is((select actor_type from pg_temp.latest('provider_settlements')), 'system',
  'that match is recorded as a system action, because no actor was named');

-- `close_settlement` requires a reconciled settlement, and the reconciliation journal is blocked while
-- B1-C is open, so the state is set directly here rather than by inventing a settlement outcome.
update public.provider_settlements set status = 'reconciled', reconciled_at = now()
 where id = (select id from settlement_under_test);

select is(
  (select app_private.close_settlement(id, 'fb000000-0000-4000-8000-00000000000a'::uuid)
     from settlement_under_test),
  true,
  'a staff member closes the settlement through the writer that already takes their id');

select is((select actor_type from pg_temp.latest('provider_settlements')), 'user',
  'the closure is recorded as a user action');
select is((select actor_id from pg_temp.latest('provider_settlements')), 'fb000000-0000-4000-8000-00000000000a'::uuid,
  'and it names the staff member who authorized it');

-- One value, one source: the actor the writer authorized with is the actor the trail names.
select is(
  (select reconciled_by from public.provider_settlements where id = (select id from settlement_under_test)),
  (select actor_id from pg_temp.latest('provider_settlements')),
  'the actor recorded on the row and the actor recorded in the audit trail are the same person');

select is(app_private.audit_actor(), null::uuid,
  'and the writer left no actor behind: its scope ended when the call returned');

rollback to savepoint sp_close;

-- ---------------------------------------------------------------------------------------------------
-- A seller asking for their own funds
-- ---------------------------------------------------------------------------------------------------
/*
 * `request_withdrawal` is a human financial action, so it records the human: `actor_type = 'user'` with
 * the seller's own id. The seller is not staff, and that is the point — the taxonomy is about whether a
 * person authorized the action, not about which console they used.
 *
 * Nothing about 0021's authorization changes here. The withdrawal limits, the available balance, the
 * dispute freeze and the post-recovery hold all still decide the request, and the actor published is the
 * same seller those checks are applied to: one value, one source.
 */
savepoint sp_seller;

insert into public.locales (code, name_en, name_native, direction, is_active, is_default)
values ('zz', 'Test locale', 'Test locale', 'ltr', true, false);
insert into public.currencies (code, numeric_code, symbol, decimal_places, is_enabled, is_default, is_pricing_enabled, is_checkout_enabled)
values ('XTS', '963', 'T', 2, true, false, true, true);
insert into public.countries (code, iso3, numeric_code, name_en, name_ar, phone_code, default_currency_code, is_marketplace_enabled)
values ('ZZ', 'ZZZ', '999', 'Enabled', 'Enabled', '999', 'XTS', true);

insert into auth.users (id, email) values
  ('fb000000-0000-4000-8000-0000000000c1', 'attribution-seller-one@test.invalid'),
  ('fb000000-0000-4000-8000-0000000000c2', 'attribution-seller-two@test.invalid');
insert into public.seller_profiles (user_id, slug, display_name, country_code, verification_status, verified_at, status)
values
  ('fb000000-0000-4000-8000-0000000000c1', 'attribution-seller-one', 'Seller One', 'ZZ', 'verified', now(), 'active'),
  ('fb000000-0000-4000-8000-0000000000c2', 'attribution-seller-two', 'Seller Two', 'ZZ', 'verified', now(), 'active');

-- Only seller one has funds. Seller two has none, which is what makes the isolation assertion real.
select ok(app_private.post_ledger_journal('adjustment', 'XTS', jsonb_build_array(
    jsonb_build_object('account_type', 'provider_clearing', 'direction', 'debit', 'amount_minor', 32000),
    jsonb_build_object('account_type', 'seller_available', 'seller_user_id', 'fb000000-0000-4000-8000-0000000000c1',
                       'direction', 'credit', 'amount_minor', 32000)
  ), 'manual', 'attribution-8b', 'fixture:attribution-8b', 'Fixture funds') is not null,
  'seller one is credited through the ordinary ledger path');

insert into public.withdrawal_limits (currency_code, min_amount_minor, max_amount_minor, max_open_requests)
values ('XTS', 1000, 100000, 2);

select is((select available_minor || '/' || reserved_minor from public.seller_balances
            where seller_user_id = 'fb000000-0000-4000-8000-0000000000c1'), '32000/0',
  'and the balance is what the journal made it, before any request');

savepoint sp_fresh_scope;

-- The legitimate request.
select ok(
  app_private.request_withdrawal('fb000000-0000-4000-8000-0000000000c1'::uuid, 'XTS'::char(3), 20000::bigint, 'attribution-wd-1'::text) is not null,
  'the seller asks for their own funds, through the writer that already authorizes that seller');

select is((select actor_type from pg_temp.latest('withdrawals')), 'user',
  'a seller withdrawal request is recorded as a user action, not a system one');
select is((select actor_id from pg_temp.latest('withdrawals')), 'fb000000-0000-4000-8000-0000000000c1'::uuid,
  'and it names the seller the request was authorized for');

select is(
  (select actor_id from audit.audit_logs
    where table_name = 'withdrawals' and action = 'insert' order by id desc limit 1),
  (select seller_user_id from public.withdrawals where idempotency_key = 'attribution-wd-1'),
  'the actor recorded in the trail is the seller recorded on the withdrawal row');

-- 0021 makes two changes of its own — the row, then its reservation journal — and both are that seller's.
-- Attribution adds no row of its own to either.
select is((select count(*) from audit.audit_logs where table_name = 'withdrawals' and action = 'insert'),
  1::bigint, 'the request wrote exactly one audit row for the withdrawal it created');
select is((select count(*) from audit.audit_logs where table_name = 'withdrawals'
            and actor_id is distinct from 'fb000000-0000-4000-8000-0000000000c1'::uuid), 0::bigint,
  'and every row it wrote names that seller, with no unattributed duplicate beside it');
select is((select count(*) from audit.audit_logs where table_name = 'withdrawals'), 2::bigint,
  'two rows for the two changes 0021 already made: the withdrawal, then its reserve journal id');

-- The financial behaviour is 0021's, unchanged.
select is((select available_minor || '/' || reserved_minor from public.seller_balances
            where seller_user_id = 'fb000000-0000-4000-8000-0000000000c1'), '12000/20000',
  'the funds are reserved exactly as 0021 reserves them: attribution moved no money');
select is((select status from public.withdrawals where idempotency_key = 'attribution-wd-1'), 'requested',
  'and the withdrawal is in the state 0021 creates it in');

-- Authorization is untouched: the limits and the balance still decide.
select throws_ok(
  $q$select app_private.request_withdrawal('fb000000-0000-4000-8000-0000000000c1'::uuid, 'XTS'::char(3), 50000::bigint, 'attribution-wd-over'::text)$q$,
  '23514', null,
  'a seller still cannot withdraw more than is available');

-- The seller's scope ended when the request returned, so the transaction carries no actor now.
select is(app_private.audit_actor(), null::uuid,
  'the seller''s scope ended when the request returned, leaving nothing active');

-- SEQUENTIAL ACTORS, the case 0021 and 0022 really perform: the seller asked, and now a staff member
-- reviews. Two humans, one transaction, each recording their own rows.
select lives_ok(
  $q$do $x$ begin
      perform app_private.transition_withdrawal(
        (select id from public.withdrawals where idempotency_key = 'attribution-wd-1'),
        'under_review', 'fb000000-0000-4000-8000-00000000000a'::uuid);
    end $x$$q$,
  'a staff member reviews the withdrawal the seller asked for, in the same transaction');

select is((select actor_type from pg_temp.latest('withdrawals')), 'user',
  'the review is a user action too');
select is((select actor_id from pg_temp.latest('withdrawals')), 'fb000000-0000-4000-8000-00000000000a'::uuid,
  'and it names the staff member, not the seller');
select is(
  (select actor_id from audit.audit_logs
    where table_name = 'withdrawals' and action = 'insert' order by id limit 1),
  'fb000000-0000-4000-8000-0000000000c1'::uuid,
  'while the request that created the withdrawal still names the seller: the trail holds both');
select is((select reviewed_by from public.withdrawals where idempotency_key = 'attribution-wd-1'),
  'fb000000-0000-4000-8000-00000000000a'::uuid,
  'and 0021''s own review actor field is untouched by any of this');
select is(app_private.audit_actor(), null::uuid,
  'the staff scope ended with its call as well');

-- A different actor *inside* an active scope is still refused. `set_audit_actor` is entered here by hand
-- to stand in for an outer writer that has not yet returned.
-- The active actor here is the staff member, not the seller: `withdrawals_approver_is_not_the_seller`
-- means a seller may never approve their own withdrawal, and that constraint is 0021's, not 8-B's.
savepoint sp_nested;
do $x$ begin perform app_private.set_audit_actor('fb000000-0000-4000-8000-00000000000a'::uuid); end $x$;
select throws_ok(
  $q$do $x$ begin perform app_private.set_audit_actor('fb000000-0000-4000-8000-00000000000b'::uuid); end $x$$q$,
  '42501', null,
  'a different actor cannot take over a scope that is still active');
select throws_ok(
  $q$select app_private.transition_withdrawal(
      (select id from public.withdrawals where idempotency_key = 'attribution-wd-1'),
      'approved', 'fb000000-0000-4000-8000-00000000000b'::uuid)$q$,
  '42501', null,
  'and neither can a writer called with a different actor while that scope is active');
select is(app_private.audit_actor(), 'fb000000-0000-4000-8000-00000000000a'::uuid,
  'the active actor survives both refusals unchanged');

-- A nested writer with the same actor is allowed, and returns the scope as it found it.
select lives_ok(
  $q$select app_private.transition_withdrawal(
      (select id from public.withdrawals where idempotency_key = 'attribution-wd-1'),
      'approved', 'fb000000-0000-4000-8000-00000000000a'::uuid)$q$,
  'a nested writer with the same actor continues in the active scope');
select is(app_private.audit_actor(), 'fb000000-0000-4000-8000-00000000000a'::uuid,
  'and the previous actor is restored after it returns');
select is((select actor_id from pg_temp.latest('withdrawals')), 'fb000000-0000-4000-8000-00000000000a'::uuid,
  'its own row names that same actor');

-- A nested actorless step inherits the active actor rather than falling back to system.
select lives_ok(
  $q$select app_private.transition_withdrawal(
      (select id from public.withdrawals where idempotency_key = 'attribution-wd-1'),
      'processing', null)$q$,
  'a nested step that names no actor is allowed inside an active scope');
select is((select actor_id from pg_temp.latest('withdrawals')), 'fb000000-0000-4000-8000-00000000000a'::uuid,
  'and inherits the active actor, because it is part of that operation');
select is((select actor_type from pg_temp.latest('withdrawals')), 'user',
  'so it is still recorded as a user action');
select is(app_private.audit_actor(), 'fb000000-0000-4000-8000-00000000000a'::uuid,
  'and the scope is unchanged by it');
rollback to savepoint sp_nested;

-- Authorization is exactly 0021's. Seller two has no funds, so seller two cannot withdraw — being named
-- is not being funded.
rollback to savepoint sp_fresh_scope;
select is(app_private.audit_actor(), null::uuid,
  'a fresh scope carries no attribution, so the next request is judged on its own');
select is((select available_minor || '/' || reserved_minor from public.seller_balances
            where seller_user_id = 'fb000000-0000-4000-8000-0000000000c1'), '32000/0',
  'and seller one is back to an unreserved balance');

select throws_ok(
  $q$select app_private.request_withdrawal('fb000000-0000-4000-8000-0000000000c2'::uuid, 'XTS'::char(3), 20000::bigint, 'attribution-wd-other'::text)$q$,
  '23514', null,
  'seller two cannot draw on seller one''s balance by being named instead');
select is((select count(*) from public.withdrawals where seller_user_id = 'fb000000-0000-4000-8000-0000000000c2'),
  0::bigint, 'and no withdrawal exists for the seller who has no funds');
select is(app_private.audit_actor(), null::uuid,
  'a refused request attributes nobody, because it changed nothing');

rollback to savepoint sp_seller;
select is(app_private.audit_actor(), null::uuid, 'the seller attribution ended with its own transaction');

-- ---------------------------------------------------------------------------------------------------
-- The writers in scope, and only those
-- ---------------------------------------------------------------------------------------------------
select is((select count(*) from app_private.audit_attribution_contract where role = 'writer'), 4::bigint,
  '8-B brings exactly four writers into attribution');

select set_eq(
  $q$select function_name || ':' || actor_parameter from app_private.audit_attribution_contract where role = 'writer'$q$,
  array['transition_withdrawal:p_actor_user_id', 'request_withdrawal:p_seller_user_id',
        'reconcile_settlement:p_actor_user_id', 'close_settlement:p_actor_user_id'],
  'and each names the parameter it publishes: a staff decision, a seller asking for their own funds, and two settlement steps');

select ok(
  (select bool_and(
            pg_get_function_arguments(p.oid) like '%' || c.actor_parameter || ' uuid%'
            and pg_get_functiondef(p.oid) ~ ('perform\s+app_private\.set_audit_actor\(' || c.actor_parameter || '\)'))
     from app_private.audit_attribution_contract c
     join pg_namespace n on n.nspname = c.function_schema
     join pg_proc p on p.pronamespace = n.oid and p.proname = c.function_name
    where c.role = 'writer'),
  'every approved writer takes the parameter it names and publishes exactly that one, so the audited actor is the authorized actor');

select ok(pg_get_functiondef(p.oid) ~ 'perform\s+app_private\.set_audit_actor',
          format('%s publishes its actor', p.proname))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private'
   and p.proname in ('transition_withdrawal', 'request_withdrawal', 'reconcile_settlement', 'close_settlement');

select ok(pg_get_functiondef(p.oid) ~ 'perform\s+app_private\.restore_audit_actor\(audit_scope_saved\)',
          format('%s leaves the scope it entered', p.proname))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private'
   and p.proname in ('transition_withdrawal', 'request_withdrawal', 'reconcile_settlement', 'close_settlement');

-- One exit point per writer: every `return` was turned into an exit from the labelled scope, so no path
-- can leave a writer without restoring the actor it found.
select ok(
  (select bool_and(pg_get_functiondef(p.oid) ~ '<<actor_scope>>'
                   and pg_get_functiondef(p.oid) ~ 'exit actor_scope')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('transition_withdrawal', 'request_withdrawal', 'reconcile_settlement', 'close_settlement')),
  'each writer wraps its body in one labelled scope and leaves through it');

select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('app_private', 'public', 'audit') and p.prokind = 'f'
      and pg_get_functiondef(p.oid) ~ 'set_audit_actor'
      -- The guard names the setter in order to police it, which is why the contract lists it.
      and p.proname not in ('set_audit_actor', 'restore_audit_actor', 'transition_withdrawal',
                            'request_withdrawal', 'reconcile_settlement', 'close_settlement',
                            'audit_attribution_problems')),
  0::bigint,
  'no other function was turned into an attribution writer');

-- No actor parameter was invented for a writer that did not already have one.
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('create_payout', 'settle_payout', 'settle_payout_reversal', 'open_settlement',
                        'match_settlement', 'open_payment_exception')
      and pg_get_functiondef(p.oid) ~ 'set_audit_actor'),
  0::bigint,
  'the system-driven and worker-driven financial writers were left exactly as they were');

select is((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'app_private' and p.proname = 'request_withdrawal'
              and pg_get_function_arguments(p.oid) like '%p_seller_user_id uuid%'), 1::bigint,
  'request_withdrawal still takes the seller who asked, and publishes that seller rather than a staff member');

-- ---------------------------------------------------------------------------------------------------
-- Authorization is untouched
-- ---------------------------------------------------------------------------------------------------
select ok(pg_get_functiondef('public.current_user_id'::regproc) !~ 'audit_actor',
  'current_user_id does not read the attribution channel');
select ok(pg_get_functiondef('public.current_user_id'::regproc) ~ 'jwt_claims\(\)\s*->>\s*''sub''',
  'current_user_id still reads the verified claims, and only those');

select ok(pg_get_functiondef(p.oid) !~ 'app\.audit_actor_id|audit_actor\(',
          format('%s does not read the attribution channel', p.proname))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('current_user_id', 'has_permission', 'has_role', 'is_aal2', 'has_step_up_grant',
                     'is_conversation_participant', 'is_verified_seller', 'can_join_realtime_topic');

select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.prokind = 'f'
      and pg_get_function_arguments(p.oid) = 'p_user_id uuid, p_is_aal2 boolean'
      and pg_get_functiondef(p.oid) ~ 'app\.audit_actor_id|audit_actor\('),
  0::bigint,
  'not one of the permission predicates reads the attribution channel');

savepoint sp_authz;
select is(public.has_permission('payments.settlement.manage'), false,
  'has_permission answers false for a caller with no claims');
do $x$ begin perform app_private.set_audit_actor('fb000000-0000-4000-8000-00000000000a'::uuid); end $x$;
select is(public.has_permission('payments.settlement.manage'), false,
  'and it still answers false with an actor attributed, because attribution is not authorization');
select is(public.current_user_id(), null::uuid,
  'current_user_id still reports nobody, however the attribution channel is set');
select is(public.is_aal2(), false,
  'is_aal2 is unaffected by the attribution channel');
select is(public.has_role('admin'), false,
  'has_role is unaffected by the attribution channel');
rollback to savepoint sp_authz;

-- ---------------------------------------------------------------------------------------------------
-- The guard
-- ---------------------------------------------------------------------------------------------------
select has_function('public', 'audit_attribution_problems', array[]::text[], 'the guard exists');
select is((select count(*) from public.audit_attribution_problems()), 0::bigint,
  'the contract holds as delivered');
select is((select count(*) from public.security_contract_problems() where area = 'audit_attribution'), 0::bigint,
  'and it is wired into the security contract');
select is((select count(*) from public.security_contract_problems()), 0::bigint,
  'the whole security contract still holds');
select is(app_private.assert_security_contract(), 0, 'and the deployment assertion passes');

select ok(not has_function_privilege(r.rolname, 'public.audit_attribution_problems()'::regprocedure, 'execute'),
          format('%s may not enumerate the attribution model', r.rolname))
  from (values ('anon'), ('authenticated'), ('public')) as r(rolname);
select ok(has_function_privilege(r.rolname, 'public.audit_attribution_problems()'::regprocedure, 'execute'),
          format('%s may read the guard, which is how the contract check runs', r.rolname))
  from (values ('app_system'), ('app_worker')) as r(rolname);

-- Violation 1: a function nobody approved learns to read the channel.
savepoint violation_one;
create function public.attribution_leak() returns uuid
language sql stable security definer set search_path = pg_catalog, public
as $leak$ select nullif(current_setting('app.audit_actor_id', true), '')::uuid $leak$;
select is((select count(*) from public.audit_attribution_problems()
            where object = 'public.attribution_leak'), 1::bigint,
  'an unapproved reader of the channel is reported');
select throws_ok($$select app_private.assert_security_contract()$$, '42501', null,
  'and it fails the deployment');
rollback to savepoint violation_one;
select is((select count(*) from public.audit_attribution_problems()), 0::bigint,
  'the contract holds again once the leak is gone');

-- Violation 2: a permission predicate learns to read it.
savepoint violation_two;
create function app_private.attribution_predicate(p_user_id uuid, p_is_aal2 boolean) returns boolean
language sql stable security definer set search_path = pg_catalog, public
as $pred$ select nullif(current_setting('app.audit_actor_id', true), '') is not null $pred$;
select ok((select count(*) from public.audit_attribution_problems()
            where object = 'app_private.attribution_predicate') >= 2,
  'a permission predicate that reads the channel is reported twice over: unapproved, and a predicate');
select throws_ok($$select app_private.assert_security_contract()$$, '42501', null,
  'and that fails the deployment too');
rollback to savepoint violation_two;

-- Violation 3: the channel is granted to a role.
savepoint violation_three;
grant execute on function app_private.restore_audit_actor(uuid) to app_system;
select is((select count(*) from public.audit_attribution_problems()
            where object = 'app_private.restore_audit_actor'), 1::bigint,
  'granting the scope exit point to a role is reported');
rollback to savepoint violation_three;

savepoint violation_three_b;
grant execute on function app_private.set_audit_actor(uuid) to app_system;
select is((select count(*) from public.audit_attribution_problems()
            where object = 'app_private.set_audit_actor'), 1::bigint,
  'granting the setter to a role is reported');
select throws_ok($$select app_private.assert_security_contract()$$, '42501', null,
  'and fails the deployment, because the API must never choose an actor of its own');
rollback to savepoint violation_three_b;

-- Violation 4: an approved writer loses the actor parameter it publishes.
savepoint violation_four;
insert into app_private.audit_attribution_contract (function_schema, function_name, role, actor_parameter, reason)
values ('app_private', 'match_settlement', 'writer', 'p_actor_user_id', 'a writer that takes no actor at all');
select is((select count(*) from public.audit_attribution_problems()
            where object = 'app_private.match_settlement'), 1::bigint,
  'an approved writer without an actor parameter is reported');
rollback to savepoint violation_four;

select is((select count(*) from public.audit_attribution_problems()), 0::bigint,
  'and the contract holds after every violation was rolled back');

-- ---------------------------------------------------------------------------------------------------
-- The contract table itself
-- ---------------------------------------------------------------------------------------------------
select ok((select relrowsecurity from pg_class where oid = 'app_private.audit_attribution_contract'::regclass),
  'the contract table has row level security enabled');
select is((select count(*) from pg_policies where schemaname = 'app_private'
            and tablename = 'audit_attribution_contract'), 0::bigint,
  'and no policy, so it is reachable only through the guard');
select is((select count(*) from app_private.audit_attribution_contract), 9::bigint,
  'nine functions may name the channel: two scope helpers, one reader, the trigger, the guard and four writers');
select set_eq(
  $$select role from app_private.audit_attribution_contract group by role$$,
  array['setter', 'reader', 'writer', 'guard'],
  'and every one of them is classified');
select is((select count(*) from information_schema.role_table_grants
            where table_schema = 'app_private' and table_name = 'audit_attribution_contract'
              and grantee in ('app_system', 'app_worker', 'authenticated', 'anon')), 0::bigint,
  'and no role holds a privilege on it');

-- ---------------------------------------------------------------------------------------------------
-- Nothing else moved
-- ---------------------------------------------------------------------------------------------------
select is((select count(*) from pg_trigger tg join pg_proc p on p.oid = tg.tgfoid
            where p.proname = 'tg_record_change'), 43::bigint,
  'the same forty-three tables are audited: no trigger was attached or detached');

select ok(pg_get_functiondef('audit.tg_record_change'::regproc) ~ 'jsonb_set\(old_row, array\[key\]',
  'the trigger still redacts the columns its arguments name');
select ok(pg_get_functiondef('audit.tg_record_change'::regproc) ~ 'if array_length\(changed, 1\) is null then',
  'and still writes nothing for an update that changed nothing');
select ok(pg_get_functiondef('audit.tg_record_change'::regproc) ~ 'coalesce\(new_row, old_row\) ->> ''id''',
  'and still takes the record id the same way');

select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where p.prokind = 'f' and pg_get_functiondef(p.oid) ~ 'insert\s+into\s+audit\.audit_logs'),
  2::bigint,
  'audit.audit_logs still has exactly two writers, so no second audit path was created');

select is((select count(*) from app_private.append_only_contract
            where table_schema = 'audit' and table_name = 'audit_logs'), 1::bigint,
  'the audit trail is still append-only, which is why attribution has to be right at insert time');

select is((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = 'record_audit_event'
              and has_function_privilege('app_system', p.oid, 'execute')), 0::bigint,
  'record_audit_event is still not reachable from the API: 8-B adds no second, explicit audit path');

select * from finish();
rollback;
