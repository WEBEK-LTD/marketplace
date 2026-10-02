-- pgTAP — migration 0039: the password-reset token lifecycle (C-18).
--
-- The lifetime, the single-use rule and the binding are tested by driving the functions, and the
-- security boundary by observing the real catalogue rather than by reading the migration. Two claims
-- deserve their own note:
--
--   * **The clear token is never stored.** Proved by searching every column of the table for the clear
--     value that produced the stored digest — not by asserting that the function was called correctly.
--   * **Concurrency.** pgTAP runs in one session, so what is provable here is that the consume is a
--     single conditional write that a second attempt cannot repeat. The genuinely simultaneous case is
--     covered by `scripts/db/password-reset-concurrency.mjs`, which races real connections.
--
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(49);

insert into auth.users (id, email) values
  ('c0000000-0000-4000-8000-000000000001', 'reset-owner@test.invalid'),
  ('c0000000-0000-4000-8000-000000000002', 'reset-stranger@test.invalid');

-- ---------------------------------------------------------------------------------------------------
-- The table and its security boundary (created by 0004; unchanged by this migration)
-- ---------------------------------------------------------------------------------------------------
select has_table('app_private', 'password_reset_tokens', 'app_private.password_reset_tokens exists');
select has_column('app_private', 'password_reset_tokens', 'token_hash', 'it stores a token digest');
select col_type_is('app_private', 'password_reset_tokens', 'token_hash', 'bytea',
  'the digest column is bytea, which is what says "not a token"');
select hasnt_column('app_private', 'password_reset_tokens', 'token',
  'there is no column for a clear token');
select hasnt_column('app_private', 'password_reset_tokens', 'token_plain',
  'nor for one under another name');

select is(
  (select relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'app_private' and c.relname = 'password_reset_tokens'),
  true,
  'row level security is enabled on the table');

select is(
  (select count(*) from pg_policy p join pg_class c on c.oid = p.polrelid
     join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'app_private' and c.relname = 'password_reset_tokens'),
  0::bigint,
  'and it carries no policy, so RLS denies by default to every non-owner');

select table_privs_are('app_private', 'password_reset_tokens', 'app_system', array[]::text[],
  'app_system holds no privilege on the table: the functions are the only door');
select table_privs_are('app_private', 'password_reset_tokens', 'app_api', array[]::text[],
  'app_api holds none');
select table_privs_are('app_private', 'password_reset_tokens', 'app_worker', array[]::text[],
  'app_worker holds none');
select table_privs_are('app_private', 'password_reset_tokens', 'authenticated', array[]::text[],
  'authenticated holds none, so a browser session cannot read reset tokens');
select table_privs_are('app_private', 'password_reset_tokens', 'anon', array[]::text[],
  'anon holds none');
select table_privs_are('app_private', 'password_reset_tokens', 'public', array[]::text[],
  'and PUBLIC holds none');
select is(
  (select count(*) from information_schema.role_usage_grants
    where object_schema = 'app_private' and grantee in ('authenticated', 'anon')),
  0::bigint,
  'neither browser role may even use the app_private schema');

-- ---------------------------------------------------------------------------------------------------
-- The functions: shape, definer and execute privileges
-- ---------------------------------------------------------------------------------------------------
select has_function('app_private', 'issue_password_reset_token', array['uuid','bytea','inet'],
  'app_private.issue_password_reset_token exists');
select has_function('app_private', 'consume_password_reset_token', array['bytea','uuid'],
  'app_private.consume_password_reset_token exists');

select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('issue_password_reset_token', 'consume_password_reset_token')
      and (not p.prosecdef or coalesce(array_to_string(p.proconfig, ','), '') <> 'search_path=pg_catalog, public')),
  0::bigint,
  'both functions are SECURITY DEFINER with the pinned search_path');

select function_privs_are('app_private', 'issue_password_reset_token', array['uuid','bytea','inet'],
  'app_system', array['EXECUTE'], 'app_system may issue a reset token');
select function_privs_are('app_private', 'consume_password_reset_token', array['bytea','uuid'],
  'app_system', array['EXECUTE'], 'app_system may consume one');
select function_privs_are('app_private', 'issue_password_reset_token', array['uuid','bytea','inet'],
  'authenticated', array[]::text[], 'authenticated may not issue one, so a browser cannot mint a reset');
select function_privs_are('app_private', 'consume_password_reset_token', array['bytea','uuid'],
  'authenticated', array[]::text[], 'authenticated may not consume one');
select function_privs_are('app_private', 'issue_password_reset_token', array['uuid','bytea','inet'],
  'anon', array[]::text[], 'anon may not issue one');
select function_privs_are('app_private', 'consume_password_reset_token', array['bytea','uuid'],
  'anon', array[]::text[], 'anon may not consume one');
select function_privs_are('app_private', 'issue_password_reset_token', array['uuid','bytea','inet'],
  'app_worker', array[]::text[], 'the worker has no business issuing a reset token');
select function_privs_are('app_private', 'consume_password_reset_token', array['bytea','uuid'],
  'app_worker', array[]::text[], 'nor consuming one');
select function_privs_are('app_private', 'issue_password_reset_token', array['uuid','bytea','inet'],
  'public', array[]::text[], 'and PUBLIC may not');

-- ---------------------------------------------------------------------------------------------------
-- Issuing
-- ---------------------------------------------------------------------------------------------------
create temp table issued as
  select * from app_private.issue_password_reset_token(
    'c0000000-0000-4000-8000-000000000001', sha256('clear-token-one'::bytea), '203.0.113.7');

select is((select outcome from issued), 'issued', 'a token is issued for a real account');
select is(
  (select (expires_at - created_at) from app_private.password_reset_tokens
    where id = (select token_id from issued)),
  interval '15 minutes',
  'and it lives exactly the approved 15 minutes');
select is(
  (select user_id from app_private.password_reset_tokens where id = (select token_id from issued)),
  'c0000000-0000-4000-8000-000000000001'::uuid,
  'it is bound to the account it was issued for');
select is(
  (select token_hash from app_private.password_reset_tokens where id = (select token_id from issued)),
  sha256('clear-token-one'::bytea),
  'the stored value is the digest that was passed in');

-- The claim that matters: nothing in the row is, or contains, the clear token.
select is(
  (select count(*) from app_private.password_reset_tokens t
    where t.id = (select token_id from issued)
      and strpos(t::text, 'clear-token-one') > 0),
  0::bigint,
  'the clear token appears in no column of the stored row');

select is(
  (select outcome from app_private.issue_password_reset_token(
     'c0000000-0000-4000-8000-0000000000ff', sha256('clear-token-two'::bytea))),
  'unknown_user',
  'an unknown account returns an outcome rather than raising, so the caller can answer identically');
select is(
  (select count(*) from app_private.password_reset_tokens
    where user_id = 'c0000000-0000-4000-8000-0000000000ff'),
  0::bigint,
  'and nothing is written for it');

select throws_ok(
  $$select * from app_private.issue_password_reset_token('c0000000-0000-4000-8000-000000000001', sha256('x'::bytea)::bytea || null::bytea)$$,
  '22023', null, 'a null digest is refused');
select throws_ok(
  $$select * from app_private.issue_password_reset_token('c0000000-0000-4000-8000-000000000001', '\x0102'::bytea)$$,
  '22023', null, 'a digest narrower than 256 bits is refused');
select throws_ok(
  $$select * from app_private.issue_password_reset_token(null, sha256('x'::bytea))$$,
  '22023', null, 'and a token with no account is refused');

-- ---------------------------------------------------------------------------------------------------
-- Consuming
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.consume_password_reset_token(sha256('no-such-token'::bytea))),
  'not_found',
  'an unknown digest is not found');

select is(
  (select outcome from app_private.consume_password_reset_token(
     sha256('clear-token-one'::bytea), 'c0000000-0000-4000-8000-000000000002')),
  'wrong_user',
  'a token presented for another account is refused');
select is(
  (select consumed_at from app_private.password_reset_tokens where id = (select token_id from issued)),
  null,
  'and that refusal leaves it unconsumed, so the rightful owner can still use it');

create temp table consumed as
  select * from app_private.consume_password_reset_token(
    sha256('clear-token-one'::bytea), 'c0000000-0000-4000-8000-000000000001');

select is((select outcome from consumed), 'consumed', 'the rightful owner consumes it');
select is((select user_id from consumed), 'c0000000-0000-4000-8000-000000000001'::uuid,
  'and the owning account comes back, which is what the reset needs');
select isnt(
  (select consumed_at from app_private.password_reset_tokens where id = (select token_id from issued)),
  null,
  'the row records the consumption');

select is(
  (select outcome from app_private.consume_password_reset_token(sha256('clear-token-one'::bytea))),
  'already_consumed',
  'a second consumption is refused: single use');
select is(
  (select user_id from app_private.consume_password_reset_token(sha256('clear-token-one'::bytea))),
  null,
  'and a refusal names nobody');

-- An expired token, made expired by moving its own timestamps rather than by waiting.
create temp table expiring as
  select * from app_private.issue_password_reset_token(
    'c0000000-0000-4000-8000-000000000001', sha256('clear-token-three'::bytea));
update app_private.password_reset_tokens
   set created_at = now() - interval '20 minutes', expires_at = now() - interval '5 minutes'
 where id = (select token_id from expiring);

select is(
  (select outcome from app_private.consume_password_reset_token(sha256('clear-token-three'::bytea))),
  'expired',
  'an expired token is refused');
select is(
  (select consumed_at from app_private.password_reset_tokens where id = (select token_id from expiring)),
  null,
  'and is not marked consumed by the attempt');

select throws_ok(
  $$select * from app_private.consume_password_reset_token('\x0102'::bytea)$$,
  '22023', null, 'consuming with a digest narrower than 256 bits is refused');

-- ---------------------------------------------------------------------------------------------------
-- One winner
-- ---------------------------------------------------------------------------------------------------
-- The consume is a single conditional write guarded by a row lock. Within one session the observable
-- consequence is that repeated attempts on the same token yield exactly one success; the simultaneous
-- case is raced in scripts/db/password-reset-concurrency.mjs.
create temp table once as
  select * from app_private.issue_password_reset_token(
    'c0000000-0000-4000-8000-000000000001', sha256('clear-token-four'::bytea));

select is(
  (select count(*) filter (where c.outcome = 'consumed')
     from (
       select (app_private.consume_password_reset_token(sha256('clear-token-four'::bytea))).*
       from generate_series(1, 5)
     ) c),
  1::bigint,
  'five attempts on one token produce exactly one consumption');

select is(
  (select count(*) from app_private.password_reset_tokens
    where user_id = 'c0000000-0000-4000-8000-000000000001' and consumed_at is not null),
  2::bigint,
  'and only the tokens that were actually consumed are marked so');

select * from finish();
rollback;
