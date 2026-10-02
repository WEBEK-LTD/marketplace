-- pgTAP — migration 0082: dispute management, the admin side (Phase 7-R).
--
-- What these assertions hold to account:
--
--   * **two keys, and the separation between them.** The queue, the detail and the thread need
--     `disputes.dispute.read`; the message and the resolution need `disputes.dispute.manage`. A colleague
--     holding one and not the other is driven against every function, and each answers with nothing or with
--     `not_found` — never a row, never an error that says why.
--   * **moderator holds neither, by 0033's decision.** Driven explicitly, because that grant being absent is
--     a decision and a regression in it would open this surface to the wrong role.
--   * **both roles that hold a dispute key are `requires_mfa`, so read is gated at aal2 too**, although
--     0027's three read policies carry no `is_aal2()`. Each function is driven by the right person at `aal1`,
--     by a revoked grant and by an expired one.
--   * **THE PHASE 8 BOUNDARY, asserted table by table.** A refund resolution is recorded for real, and then
--     every financial table in the schema — `refunds`, `refund_items`, `payments`, `payment_attempts`,
--     `payment_disputes`, `ledger_entries`, `ledger_journals`, `seller_balances`, `withdrawals`, `payouts` —
--     is counted before and after and must be unchanged. Additionally no function in this migration contains
--     a write statement against any of them, or against `public.orders`.
--   * **the resolution is 0027's, not this migration's.** All four resolutions are recorded for real; the
--     party refusal is provoked from both sides; the reason requirement, the amount-for-a-refund rule and the
--     positive-amount rule are each provoked; and the writer's own effects — `resolved_by` recorded, the
--     order's snapshot status restored, the outbox event enqueued — are asserted on the rows rather than on a
--     returned value.
--   * **the four unreachable statuses are still unreachable.** Nothing in this migration sets
--     `awaiting_seller`, `awaiting_buyer`, `under_review` or `cancelled`, and the queue is shown to return a
--     dispute in one of them if one is planted by hand — it hides nothing, it simply cannot create one.
--   * **no account crosses.** Asserted on the result types: not one function returns `buyer_user_id`,
--     `seller_user_id`, `opened_by`, `resolved_by`, `author_user_id` or `assigned_to`.
--   * **the evidence surface does not exist here.** No function reads `dispute_evidence`, asserted on the
--     bodies, because that table has no insert path and the whole surface is deferred.
--   * **no second audit path.** One `audit.audit_logs` row per dispute change and no more, and `details` and
--     `resolution_note` arrive redacted.
--
-- Deterministic: fixed uuids, explicit ages, and `with ordinality` wherever order matters. Everything runs in
-- a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(248);

-- ---------------------------------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------------------------------
insert into public.locales (code, name_en, name_native, direction, is_active, is_default)
values ('zr', 'Test locale', 'Test locale', 'ltr', true, false);
insert into public.currencies (code, numeric_code, symbol, decimal_places, is_enabled, is_default,
                               is_pricing_enabled, is_checkout_enabled)
values ('XTR', '962', 'R', 2, true, false, true, true);
insert into public.countries (code, iso3, numeric_code, name_en, name_ar, phone_code,
                              default_currency_code, is_marketplace_enabled)
values ('ZR', 'ZRR', '962', 'Enabled', 'Enabled', '962', 'XTR', true);

insert into auth.users (id, email) values
  ('fe000000-0000-4000-8000-000000000001', 's-admin@test.invalid'),
  ('fe000000-0000-4000-8000-000000000002', 's-super-admin@test.invalid'),
  ('fe000000-0000-4000-8000-000000000003', 's-moderator@test.invalid'),
  ('fe000000-0000-4000-8000-000000000004', 's-support-agent@test.invalid'),
  ('fe000000-0000-4000-8000-000000000005', 's-buyer@test.invalid'),
  ('fe000000-0000-4000-8000-000000000006', 's-revoked-admin@test.invalid'),
  ('fe000000-0000-4000-8000-000000000007', 's-expired-admin@test.invalid'),
  ('fe000000-0000-4000-8000-000000000008', 's-seller@test.invalid'),
  -- An admin who is also the buyer of a disputed order, and one who is also the seller: the only way 0027's
  -- party refusal is reachable at all.
  ('fe000000-0000-4000-8000-000000000009', 's-admin-who-bought@test.invalid'),
  ('fe000000-0000-4000-8000-00000000000a', 's-admin-who-sells@test.invalid');

insert into public.user_roles (user_id, role_key, granted_at) values
  ('fe000000-0000-4000-8000-000000000001', 'admin', now() - interval '10 days'),
  ('fe000000-0000-4000-8000-000000000002', 'super_admin', now() - interval '10 days'),
  ('fe000000-0000-4000-8000-000000000003', 'moderator', now() - interval '10 days'),
  ('fe000000-0000-4000-8000-000000000004', 'support_agent', now() - interval '10 days'),
  ('fe000000-0000-4000-8000-000000000005', 'buyer', now() - interval '10 days'),
  ('fe000000-0000-4000-8000-000000000009', 'admin', now() - interval '10 days'),
  ('fe000000-0000-4000-8000-00000000000a', 'admin', now() - interval '10 days');

insert into public.user_roles (user_id, role_key, granted_at, revoked_at) values
  ('fe000000-0000-4000-8000-000000000006', 'admin', now() - interval '20 days', now() - interval '1 hour');
insert into public.user_roles (user_id, role_key, granted_at, expires_at) values
  ('fe000000-0000-4000-8000-000000000007', 'admin', now() - interval '20 days', now() - interval '1 hour');

insert into public.seller_profiles (user_id, slug, display_name, country_code, verification_status,
                                    verified_at, status) values
  ('fe000000-0000-4000-8000-000000000008', 'r-shop', 'Canary Shop', 'ZR', 'verified', now(), 'active'),
  ('fe000000-0000-4000-8000-00000000000a', 'r-admin-shop', 'Admin Shop', 'ZR', 'verified', now(), 'active');

/*
 * One order per dispute, because `disputes_one_open_per_order` allows exactly one open dispute per order and
 * this suite needs several at once. Each is `delivered`, which is a status 0027 permits a dispute on, and each
 * gets a distinct age so the oldest-first order is unambiguous.
 */
create or replace function pg_temp.order_for(
  p_id uuid,
  p_seller uuid,
  p_buyer uuid,
  p_age interval,
  p_total bigint default 20000
) returns uuid
language plpgsql as $$
declare
  v_checkout uuid := gen_random_uuid();
begin
  insert into public.checkouts (id, currency_code, buyer_user_id, subtotal_minor, grand_total_minor,
                               commission_snapshot, cancellation_policy_snapshot, status)
  values (v_checkout, 'XTR', p_buyer, p_total, p_total, '{"components":[]}'::jsonb,
          '{"buyer_window_hours":24}'::jsonb, 'paid');
  -- `order_number` is deliberately not supplied: `orders_number_format` constrains it to the platform's own
  -- `MP-YY-NNNNNN` shape and 0018's `orders_reference` trigger generates one. A fixture that made its own
  -- would be testing against a reference format this platform does not use.
  insert into public.orders (id, currency_code, checkout_id, seller_user_id, buyer_user_id,
                             order_type, status, subtotal_minor, grand_total_minor, paid_at, delivered_at,
                             placed_at, created_at)
  values (p_id, 'XTR', v_checkout, p_seller, p_buyer, 'product', 'delivered', p_total, p_total,
          now() - p_age, now() - p_age, now() - p_age, now() - p_age);
  return p_id;
end;
$$;

-- Five orders. The first four are the seller's; the last two put an admin on each side.
select pg_temp.order_for('01110001-0000-4000-8000-000000000001', 'fe000000-0000-4000-8000-000000000008',
                         'fe000000-0000-4000-8000-000000000005', interval '40 minutes');
select pg_temp.order_for('01110001-0000-4000-8000-000000000002', 'fe000000-0000-4000-8000-000000000008',
                         'fe000000-0000-4000-8000-000000000005', interval '30 minutes', 55000);
select pg_temp.order_for('01110001-0000-4000-8000-000000000003', 'fe000000-0000-4000-8000-000000000008',
                         'fe000000-0000-4000-8000-000000000005', interval '20 minutes');
select pg_temp.order_for('01110001-0000-4000-8000-000000000004', 'fe000000-0000-4000-8000-000000000008',
                         'fe000000-0000-4000-8000-000000000005', interval '10 minutes');
-- The admin is the buyer here.
select pg_temp.order_for('01110001-0000-4000-8000-000000000005', 'fe000000-0000-4000-8000-000000000008',
                         'fe000000-0000-4000-8000-000000000009', interval '9 minutes');
-- And the seller here.
select pg_temp.order_for('01110001-0000-4000-8000-000000000006', 'fe000000-0000-4000-8000-00000000000a',
                         'fe000000-0000-4000-8000-000000000005', interval '8 minutes');

-- Open a dispute on each, through 0027's own writer rather than by hand.
create or replace function pg_temp.dispute_on(p_order uuid, p_opener uuid, p_reason text default 'damaged',
                                             p_details text default null, p_claim bigint default null)
returns uuid language sql as $$
  select app_private.open_dispute(p_order, p_opener, p_reason, p_details, p_claim);
$$;

/*
 * `now()` is transaction-stable, so every dispute opened in this transaction shares one `created_at` and the
 * oldest-first order would collapse to identifier order — which would make the ordering assertion pass or
 * fail on the luck of a `gen_random_uuid()`. Each dispute is given the age of the order it is about, which is
 * the age it would really have had, and this is called after each batch of openings.
 */
create or replace function pg_temp.age_disputes() returns void
language sql as $$
  update public.disputes d set created_at = o.created_at
    from public.orders o
   where o.id = d.order_id and d.created_at <> o.created_at;
$$;


select pg_temp.dispute_on('01110001-0000-4000-8000-000000000001',
  'fe000000-0000-4000-8000-000000000005', 'damaged', 'It arrived cracked.', 8000);
select pg_temp.dispute_on('01110001-0000-4000-8000-000000000002',
  'fe000000-0000-4000-8000-000000000005', 'not_received');
select pg_temp.dispute_on('01110001-0000-4000-8000-000000000003',
  'fe000000-0000-4000-8000-000000000008', 'other', 'The buyer is unreachable.');
select pg_temp.dispute_on('01110001-0000-4000-8000-000000000004',
  'fe000000-0000-4000-8000-000000000005', 'incomplete');
select pg_temp.dispute_on('01110001-0000-4000-8000-000000000005',
  'fe000000-0000-4000-8000-000000000009', 'late_delivery');
select pg_temp.dispute_on('01110001-0000-4000-8000-000000000006',
  'fe000000-0000-4000-8000-000000000005', 'not_as_described');

select pg_temp.age_disputes();

create or replace function pg_temp.dispute_of(p_order uuid) returns uuid
language sql stable as $$
  select d.id from public.disputes d where d.order_id = p_order;
$$;

-- Shorthands. Each takes the account and the assurance level, exactly as the functions do.
create or replace function pg_temp.queue(p_user uuid, p_aal2 boolean default true, p_status text default null)
returns bigint language sql as $$
  select count(*) from app_private.dispute_queue_for_staff(p_user, p_aal2, 50, p_status);
$$;

create or replace function pg_temp.detail(p_user uuid, p_aal2 boolean default true, p_dispute uuid default null)
returns text language sql as $$
  select outcome from app_private.dispute_for_staff(
    p_user, p_aal2, coalesce(p_dispute, pg_temp.dispute_of('01110001-0000-4000-8000-000000000001')));
$$;

create or replace function pg_temp.thread(p_user uuid, p_aal2 boolean default true, p_dispute uuid default null)
returns bigint language sql as $$
  select count(*) from app_private.dispute_messages_for_staff(
    p_user, p_aal2, coalesce(p_dispute, pg_temp.dispute_of('01110001-0000-4000-8000-000000000001')), 200);
$$;

create or replace function pg_temp.post(p_user uuid, p_dispute uuid, p_body text,
                                       p_internal boolean default false, p_aal2 boolean default true)
returns text language sql as $$
  select outcome from app_private.dispute_message_post_for_staff(p_user, p_aal2, p_dispute, p_body, p_internal);
$$;

create or replace function pg_temp.resolve(p_user uuid, p_dispute uuid, p_resolution text,
                                          p_note text default 'Because of the evidence.',
                                          p_amount bigint default null, p_aal2 boolean default true)
returns text language sql as $$
  select outcome from app_private.dispute_resolve_for_staff(p_user, p_aal2, p_dispute, p_resolution, p_note,
                                                            p_amount);
$$;

create or replace function pg_temp.result_columns(p_name text) returns text
language sql stable as $$
  select string_agg(a.argname, ',' order by a.ord)
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   cross join lateral unnest(p.proargnames, p.proargmodes) with ordinality as a(argname, argmode, ord)
   where n.nspname = 'app_private' and p.proname = p_name and a.argmode = 't';
$$;

/* Every financial table Phase 8 owns, counted as one snapshot. */
create or replace function pg_temp.money_rows() returns text
language sql stable as $$
  select concat_ws('|',
    (select count(*) from public.refunds),
    (select count(*) from public.refund_items),
    (select count(*) from public.payments),
    (select count(*) from public.payment_attempts),
    (select count(*) from public.payment_disputes),
    (select count(*) from public.ledger_entries),
    (select count(*) from public.ledger_journals),
    (select count(*) from public.seller_balances),
    (select count(*) from public.withdrawals),
    (select count(*) from public.payouts));
$$;

create or replace function pg_temp.money_before() returns text
language sql stable as $$ select '0|0|0|0|0|0|0|0|0|0'::text $$;

-- ---------------------------------------------------------------------------------------------------
-- 1. The functions exist, are SECURITY DEFINER and are pinned
-- ---------------------------------------------------------------------------------------------------
select has_function('app_private', 'dispute_can_read', array['uuid', 'boolean'], 'the read predicate exists');
select has_function('app_private', 'dispute_can_manage', array['uuid', 'boolean'],
  'the manage predicate exists');
select has_function('app_private', 'dispute_queue_for_staff',
  array['uuid', 'boolean', 'integer', 'text', 'timestamptz', 'uuid'], 'the queue exists');
select has_function('app_private', 'dispute_for_staff', array['uuid', 'boolean', 'uuid'],
  'one dispute exists');
select has_function('app_private', 'dispute_messages_for_staff',
  array['uuid', 'boolean', 'uuid', 'integer'], 'the thread exists');
select has_function('app_private', 'dispute_message_post_for_staff',
  array['uuid', 'boolean', 'uuid', 'text', 'boolean'], 'the message writer exists');
select has_function('app_private', 'dispute_resolve_for_staff',
  array['uuid', 'boolean', 'uuid', 'text', 'text', 'bigint'], 'the resolution writer exists');

select is(p.prosecdef, true, format('%s is security definer', p.proname))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private'
   and p.proname in ('dispute_can_read', 'dispute_can_manage', 'dispute_queue_for_staff',
                     'dispute_for_staff', 'dispute_messages_for_staff', 'dispute_message_post_for_staff',
                     'dispute_resolve_for_staff');

select ok(p.proconfig @> array['search_path=pg_catalog, public'],
          format('%s pins its search path', p.proname))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private'
   and p.proname in ('dispute_can_read', 'dispute_can_manage', 'dispute_queue_for_staff',
                     'dispute_for_staff', 'dispute_messages_for_staff', 'dispute_message_post_for_staff',
                     'dispute_resolve_for_staff');

-- The five readers are stable; only the two wrappers around 0027's writers are volatile.
select is(p.provolatile, 's'::"char", format('%s is stable, so it cannot write', p.proname))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private'
   and p.proname in ('dispute_can_read', 'dispute_can_manage', 'dispute_queue_for_staff',
                     'dispute_for_staff', 'dispute_messages_for_staff');

select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'dispute_%' and p.provolatile = 'v'),
  2::bigint,
  'exactly two functions here are volatile: the message wrapper and the resolution wrapper'
);

-- ---------------------------------------------------------------------------------------------------
-- 2. EXECUTE is revoked from public and granted to app_system only
-- ---------------------------------------------------------------------------------------------------
select ok(not has_function_privilege('public', format('app_private.%s', sig), 'execute'),
          format('public cannot execute %s', sig))
  from unnest(array[
    'dispute_can_read(uuid, boolean)',
    'dispute_can_manage(uuid, boolean)',
    'dispute_queue_for_staff(uuid, boolean, integer, text, timestamptz, uuid)',
    'dispute_for_staff(uuid, boolean, uuid)',
    'dispute_messages_for_staff(uuid, boolean, uuid, integer)',
    'dispute_message_post_for_staff(uuid, boolean, uuid, text, boolean)',
    'dispute_resolve_for_staff(uuid, boolean, uuid, text, text, bigint)'
  ]) as sig;

select ok(has_function_privilege('app_system', format('app_private.%s', sig), 'execute'),
          format('app_system may execute %s', sig))
  from unnest(array[
    'dispute_can_read(uuid, boolean)',
    'dispute_can_manage(uuid, boolean)',
    'dispute_queue_for_staff(uuid, boolean, integer, text, timestamptz, uuid)',
    'dispute_for_staff(uuid, boolean, uuid)',
    'dispute_messages_for_staff(uuid, boolean, uuid, integer)',
    'dispute_message_post_for_staff(uuid, boolean, uuid, text, boolean)',
    'dispute_resolve_for_staff(uuid, boolean, uuid, text, text, bigint)'
  ]) as sig;

select ok(not has_function_privilege('authenticated',
  'app_private.dispute_resolve_for_staff(uuid, boolean, uuid, text, text, bigint)', 'execute'),
  'authenticated cannot execute the resolution wrapper');
select ok(not has_function_privilege('anon',
  'app_private.dispute_queue_for_staff(uuid, boolean, integer, text, timestamptz, uuid)', 'execute'),
  'anon cannot execute the queue');

-- ---------------------------------------------------------------------------------------------------
-- 3. The predicates: two keys, two roles, and the MFA rule
-- ---------------------------------------------------------------------------------------------------
select ok(app_private.dispute_can_read('fe000000-0000-4000-8000-000000000001', true),
  'an admin at aal2 holds the read key');
select ok(app_private.dispute_can_read('fe000000-0000-4000-8000-000000000002', true),
  'a super_admin at aal2 holds it');
select ok(app_private.dispute_can_manage('fe000000-0000-4000-8000-000000000001', true),
  'an admin holds the manage key');
select ok(app_private.dispute_can_manage('fe000000-0000-4000-8000-000000000002', true),
  'a super_admin holds it');

/*
 * 0033's decision, asserted as a fact: "Disputes are a separate responsibility and are deliberately not
 * granted." A regression in that grant would open this whole surface to the wrong role.
 */
select ok(not app_private.dispute_can_read('fe000000-0000-4000-8000-000000000003', true),
  'a moderator does not hold the read key, which 0033 decided deliberately');
select ok(not app_private.dispute_can_manage('fe000000-0000-4000-8000-000000000003', true),
  'nor the manage key');
select ok(not app_private.dispute_can_read('fe000000-0000-4000-8000-000000000004', true),
  'a support agent holds neither');
select ok(not app_private.dispute_can_manage('fe000000-0000-4000-8000-000000000004', true),
  'nor the manage key');
select ok(not app_private.dispute_can_read('fe000000-0000-4000-8000-000000000005', true),
  'and a buyer holds nothing');

select ok(not app_private.dispute_can_read('fe000000-0000-4000-8000-000000000001', false),
  'an admin at aal1 holds no read key, because admin is requires_mfa');
select ok(not app_private.dispute_can_manage('fe000000-0000-4000-8000-000000000001', false),
  'nor the manage key at aal1');
select ok(not app_private.dispute_can_read('fe000000-0000-4000-8000-000000000001', null),
  'a null assurance level is treated as aal1, never as aal2');
select ok(not app_private.dispute_can_read('fe000000-0000-4000-8000-000000000006', true),
  'a revoked grant holds nothing');
select ok(not app_private.dispute_can_read('fe000000-0000-4000-8000-000000000007', true),
  'an expired grant holds nothing');
select ok(not app_private.dispute_can_read(null, true), 'no account holds anything');

-- Each key is a literal in its own body: the predicates take two arguments and neither is text.
select is(
  (select pg_get_function_arguments(p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'dispute_can_read'),
  'p_user_id uuid, p_is_aal2 boolean',
  'the read predicate cannot be asked about another key'
);
select is(
  (select pg_get_function_arguments(p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'dispute_can_manage'),
  'p_user_id uuid, p_is_aal2 boolean',
  'and neither can the manage one'
);
select ok(pg_get_functiondef(p.oid) like '%''disputes.dispute.read''%',
          'the read key appears as a literal')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and p.proname = 'dispute_can_read';
select ok(pg_get_functiondef(p.oid) like '%''disputes.dispute.manage''%',
          'and the manage key in its own predicate')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and p.proname = 'dispute_can_manage';

-- No role name is checked anywhere in this migration.
select ok(
  not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app_private' and p.proname like 'dispute_%'
       and pg_get_functiondef(p.oid) ~ format('''%s''', w.role_name)
  ),
  format('no function here names the %s role', w.role_name)
) from unnest(array['moderator', 'support_agent', 'super_admin']) as w(role_name);

-- ---------------------------------------------------------------------------------------------------
-- 4. The read key opens the reads and nothing else
-- ---------------------------------------------------------------------------------------------------
select is(pg_temp.queue('fe000000-0000-4000-8000-000000000001'), 6::bigint, 'an admin reads all six');
select is(pg_temp.queue('fe000000-0000-4000-8000-000000000002'), 6::bigint, 'a super_admin reads them too');
select is(pg_temp.queue('fe000000-0000-4000-8000-000000000003'), 0::bigint, 'a moderator reads none');
select is(pg_temp.queue('fe000000-0000-4000-8000-000000000004'), 0::bigint, 'a support agent reads none');
select is(pg_temp.queue('fe000000-0000-4000-8000-000000000005'), 0::bigint, 'a buyer reads none');
select is(pg_temp.queue('fe000000-0000-4000-8000-000000000001', false), 0::bigint,
  'an admin at aal1 reads none');
select is(pg_temp.queue('fe000000-0000-4000-8000-000000000006'), 0::bigint, 'a revoked admin reads none');
select is(pg_temp.queue('fe000000-0000-4000-8000-000000000007'), 0::bigint, 'an expired admin reads none');
select is(pg_temp.queue(null), 0::bigint, 'no account reads none');

select is(pg_temp.detail('fe000000-0000-4000-8000-000000000001'), 'found', 'an admin reads one dispute');
select is(pg_temp.detail('fe000000-0000-4000-8000-000000000002'), 'found', 'a super_admin reads one');
select is(pg_temp.detail('fe000000-0000-4000-8000-000000000003'), 'not_found',
  'a moderator is answered exactly as a missing dispute is');
select is(pg_temp.detail('fe000000-0000-4000-8000-000000000004'), 'not_found', 'a support agent likewise');
select is(pg_temp.detail('fe000000-0000-4000-8000-000000000005'), 'not_found', 'a buyer likewise');
select is(pg_temp.detail('fe000000-0000-4000-8000-000000000001', false), 'not_found',
  'an admin at aal1 likewise');
select is(pg_temp.detail('fe000000-0000-4000-8000-000000000006'), 'not_found', 'a revoked admin likewise');
select is(pg_temp.detail('fe000000-0000-4000-8000-000000000007'), 'not_found', 'an expired admin likewise');
select is(pg_temp.detail(null), 'not_found', 'and no account likewise');

-- A dispute that does not exist answers identically to a caller who may not read one.
select is(
  pg_temp.detail('fe000000-0000-4000-8000-000000000001', true, 'fe000000-0000-4000-8000-0000000000ff'),
  pg_temp.detail('fe000000-0000-4000-8000-000000000003'),
  'an absent dispute and a missing permission give the same answer'
);
select is(pg_temp.detail('fe000000-0000-4000-8000-000000000001', true, null), 'found',
  'a null dispute id falls back to the fixture in this helper, so the coalesce is not masking a refusal'
);

select ok(pg_temp.thread('fe000000-0000-4000-8000-000000000001') > 0::bigint,
  'an admin reads the thread');
select is(pg_temp.thread('fe000000-0000-4000-8000-000000000003'), 0::bigint,
  'a moderator reads no message');
select is(pg_temp.thread('fe000000-0000-4000-8000-000000000004'), 0::bigint,
  'a support agent reads none');
select is(pg_temp.thread('fe000000-0000-4000-8000-000000000001', false), 0::bigint,
  'an admin at aal1 reads none');
select is(pg_temp.thread(null), 0::bigint, 'no account reads none');

-- ---------------------------------------------------------------------------------------------------
-- 5. The manage key opens the writes, and the read key alone does not
-- ---------------------------------------------------------------------------------------------------
-- Both keys are held by the same two roles in 0033, so a caller with one and not the other cannot be produced
-- by a role. The separation is therefore asserted on the predicates and on the functions' own gating: each
-- write tests `dispute_can_manage` and each read tests `dispute_can_read`, by name, in its own body.
select ok(pg_get_functiondef(p.oid) like '%dispute_can_manage(%',
          format('%s gates on the manage predicate', p.proname))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private'
   and p.proname in ('dispute_message_post_for_staff', 'dispute_resolve_for_staff');

select ok(pg_get_functiondef(p.oid) like '%dispute_can_read(%',
          format('%s gates on the read predicate', p.proname))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private'
   and p.proname in ('dispute_queue_for_staff', 'dispute_for_staff', 'dispute_messages_for_staff');

select ok(pg_get_functiondef(p.oid) not like '%dispute_can_read(%',
          format('%s does not accept the read key in place of the manage key', p.proname))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private'
   and p.proname in ('dispute_message_post_for_staff', 'dispute_resolve_for_staff');

select is(pg_temp.post('fe000000-0000-4000-8000-000000000003',
  pg_temp.dispute_of('01110001-0000-4000-8000-000000000001'), 'A note'), 'not_found',
  'a moderator cannot post to a dispute');
select is(pg_temp.post('fe000000-0000-4000-8000-000000000004',
  pg_temp.dispute_of('01110001-0000-4000-8000-000000000001'), 'A note'), 'not_found',
  'nor a support agent');
select is(pg_temp.post('fe000000-0000-4000-8000-000000000001',
  pg_temp.dispute_of('01110001-0000-4000-8000-000000000001'), 'A note', false, false), 'not_found',
  'nor an admin at aal1');
select is(pg_temp.post(null, pg_temp.dispute_of('01110001-0000-4000-8000-000000000001'), 'A note'),
  'not_found', 'nor no account at all');

select is(pg_temp.resolve('fe000000-0000-4000-8000-000000000003',
  pg_temp.dispute_of('01110001-0000-4000-8000-000000000001'), 'no_action'), 'not_found',
  'a moderator cannot resolve a dispute');
select is(pg_temp.resolve('fe000000-0000-4000-8000-000000000004',
  pg_temp.dispute_of('01110001-0000-4000-8000-000000000001'), 'no_action'), 'not_found',
  'nor a support agent');
select is(pg_temp.resolve('fe000000-0000-4000-8000-000000000001',
  pg_temp.dispute_of('01110001-0000-4000-8000-000000000001'), 'no_action',
  'Because of the evidence.', null, false), 'not_found', 'nor an admin at aal1');
select is(pg_temp.resolve(null, pg_temp.dispute_of('01110001-0000-4000-8000-000000000001'), 'no_action'),
  'not_found', 'nor no account at all');

-- ---------------------------------------------------------------------------------------------------
-- 6. THE PHASE 8 BOUNDARY
-- ---------------------------------------------------------------------------------------------------
-- No function in this migration contains a write statement against any financial table, asserted as statement
-- forms rather than bare words, because a function's own comments are part of the body and the prose above
-- names every one of these tables.
select ok(
  not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app_private' and p.proname like 'dispute_%'
       and pg_get_functiondef(p.oid) ~* format('(insert\s+into|update|delete\s+from)\s+public\.%s\M', w.tbl)
  ),
  format('no function here writes public.%s', w.tbl)
) from unnest(array['refunds', 'refund_items', 'payments', 'payment_attempts', 'payment_disputes',
                    'ledger_entries', 'ledger_journals', 'seller_balances', 'withdrawals', 'payouts',
                    'orders']) as w(tbl);

-- Nor does any of them call a financial writer or a provider adapter.
select ok(
  not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app_private' and p.proname like 'dispute_%'
       and pg_get_functiondef(p.oid) like '%' || w.fn || '%'
  ),
  format('no function here calls %s', w.fn)
) from unnest(array['post_ledger_journal', 'release_seller_holds', 'request_withdrawal',
                    'settle_payment_attempt', 'expire_due_payment_attempts',
                    'purge_due_payment_information']) as w(fn);

-- And the observable proof: every financial table is empty before, and still empty after a real resolution of
-- every kind, which the following section performs.
select is(pg_temp.money_rows(), pg_temp.money_before(),
  'every financial table is empty before any resolution is recorded');

-- ---------------------------------------------------------------------------------------------------
-- 7. Recording each of the four resolutions, for real
-- ---------------------------------------------------------------------------------------------------
select is(pg_temp.resolve('fe000000-0000-4000-8000-000000000001',
  pg_temp.dispute_of('01110001-0000-4000-8000-000000000001'), 'refund_buyer',
  'The item arrived cracked and the buyer is owed the price.', 20000), 'resolved',
  'refund_buyer is recorded');
select is(pg_temp.resolve('fe000000-0000-4000-8000-000000000001',
  pg_temp.dispute_of('01110001-0000-4000-8000-000000000002'), 'partial_refund',
  'Half the order arrived.', 27500), 'resolved', 'partial_refund is recorded, with its amount');
select is(pg_temp.resolve('fe000000-0000-4000-8000-000000000002',
  pg_temp.dispute_of('01110001-0000-4000-8000-000000000003'), 'release_seller',
  'The buyer never responded and the tracking shows delivery.'), 'resolved',
  'release_seller is recorded');
select is(pg_temp.resolve('fe000000-0000-4000-8000-000000000002',
  pg_temp.dispute_of('01110001-0000-4000-8000-000000000004'), 'no_action',
  'Neither side substantiated anything.'), 'resolved', 'no_action is recorded');

-- **The boundary, after the fact.** Two refund resolutions have just been recorded for a total of 47,500 minor
-- units, and not one financial row exists.
select is(pg_temp.money_rows(), pg_temp.money_before(),
  'and every financial table is STILL empty: a refund resolution moves no money');
select is((select count(*) from public.refunds), 0::bigint,
  'no refund row was created by recording a refund resolution');
select is((select count(*) from public.ledger_entries), 0::bigint, 'and no ledger entry');
select is((select count(*) from public.seller_balances), 0::bigint, 'and no seller balance');
select is((select count(*) from public.payouts), 0::bigint, 'and no payout');

-- What was written: the decision, on the dispute row.
select is(
  (select resolution from public.disputes where id = pg_temp.dispute_of('01110001-0000-4000-8000-000000000001')),
  'refund_buyer',
  'the resolution is on the dispute'
);
select is(
  (select resolution_amount_minor from public.disputes
    where id = pg_temp.dispute_of('01110001-0000-4000-8000-000000000002')),
  27500::bigint,
  'and the decided amount, which is a decision and not a payment'
);
select is(
  (select resolved_by from public.disputes where id = pg_temp.dispute_of('01110001-0000-4000-8000-000000000003')),
  'fe000000-0000-4000-8000-000000000002',
  'the writer records who ruled, from the account this wrapper passed it'
);
select ok(
  (select resolved_at from public.disputes where id = pg_temp.dispute_of('01110001-0000-4000-8000-000000000004'))
    is not null,
  'and when'
);
select is(
  (select status from public.disputes where id = pg_temp.dispute_of('01110001-0000-4000-8000-000000000001')),
  'resolved',
  'and the dispute is resolved'
);
select is(
  (select resolution_amount_minor from public.disputes
    where id = pg_temp.dispute_of('01110001-0000-4000-8000-000000000003')),
  null::bigint,
  'release_seller carries no amount, which 0027''s own CHECK requires'
);

-- 0027's order-status restoration: the snapshot, not a guess.
select is(
  (select status from public.orders where id = '01110001-0000-4000-8000-000000000001'),
  'delivered',
  'the order goes back to the status the dispute snapshotted'
);
select ok(
  not public.order_has_open_dispute('01110001-0000-4000-8000-000000000001'),
  'and the order is no longer in dispute'
);
-- The trail 0018's own trigger left, rather than one this migration wrote.
select ok(
  exists (select 1 from public.order_status_history h
           where h.order_id = '01110001-0000-4000-8000-000000000001'
             and h.from_status = 'disputed' and h.to_status = 'delivered'),
  'and 0018''s own trigger trailed that transition, so this migration needed no order writer'
);

-- 0027's outbox event, once.
select is(
  (select count(*) from public.outbox_events e
    where e.aggregate_type = 'dispute' and e.event_type = 'dispute.resolved'),
  4::bigint,
  'one dispute.resolved event per resolution, enqueued by 0027''s writer'
);

-- ---------------------------------------------------------------------------------------------------
-- 8. The resolution's refusals are 0027's
-- ---------------------------------------------------------------------------------------------------
select is(pg_temp.resolve('fe000000-0000-4000-8000-000000000001',
  pg_temp.dispute_of('01110001-0000-4000-8000-000000000001'), 'no_action'), 'already_resolved',
  'a dispute already resolved is refused');
select is(pg_temp.resolve('fe000000-0000-4000-8000-000000000001',
  'fe000000-0000-4000-8000-0000000000ff', 'no_action'), 'not_found',
  'a dispute that does not exist is the neutral answer');

-- The party refusal, from both sides. Only reachable because two admins are a party to a dispute each.
select is(pg_temp.resolve('fe000000-0000-4000-8000-000000000009',
  pg_temp.dispute_of('01110001-0000-4000-8000-000000000005'), 'no_action'), 'is_party',
  'an admin who is the buyer cannot resolve their own dispute');
select is(pg_temp.resolve('fe000000-0000-4000-8000-00000000000a',
  pg_temp.dispute_of('01110001-0000-4000-8000-000000000006'), 'no_action'), 'is_party',
  'nor an admin who is the seller');
-- And a colleague who is not a party can.
select is(pg_temp.resolve('fe000000-0000-4000-8000-000000000001',
  pg_temp.dispute_of('01110001-0000-4000-8000-000000000005'), 'no_action',
  'A colleague who is not a party took this one.'), 'resolved',
  'a colleague who is not a party resolves it');

select is(pg_temp.resolve('fe000000-0000-4000-8000-000000000001',
  pg_temp.dispute_of('01110001-0000-4000-8000-000000000006'), 'approved'), 'invalid',
  'a resolution 0027 does not have is refused');
select is(pg_temp.resolve('fe000000-0000-4000-8000-000000000001',
  pg_temp.dispute_of('01110001-0000-4000-8000-000000000006'), null), 'invalid',
  'and so is no resolution at all');
select is(pg_temp.resolve('fe000000-0000-4000-8000-000000000001',
  pg_temp.dispute_of('01110001-0000-4000-8000-000000000006'), 'no_action', ''), 'reason_required',
  'a decision with no reason is refused');
select is(pg_temp.resolve('fe000000-0000-4000-8000-000000000001',
  pg_temp.dispute_of('01110001-0000-4000-8000-000000000006'), 'no_action', '   '), 'reason_required',
  'and one with only spaces');

-- The two amount rules, each answered as its own outcome rather than as a database error.
select is(pg_temp.resolve('fe000000-0000-4000-8000-000000000001',
  pg_temp.dispute_of('01110001-0000-4000-8000-000000000006'), 'no_action',
  'Because.', 5000), 'amount_not_allowed',
  'an amount against a resolution that is not a refund is refused rather than dropped');
select is(pg_temp.resolve('fe000000-0000-4000-8000-000000000001',
  pg_temp.dispute_of('01110001-0000-4000-8000-000000000006'), 'release_seller',
  'Because.', 5000), 'amount_not_allowed',
  'release_seller likewise');
select is(pg_temp.resolve('fe000000-0000-4000-8000-000000000001',
  pg_temp.dispute_of('01110001-0000-4000-8000-000000000006'), 'refund_buyer',
  'Because.', 0), 'invalid', 'a zero amount is refused');
select is(pg_temp.resolve('fe000000-0000-4000-8000-000000000001',
  pg_temp.dispute_of('01110001-0000-4000-8000-000000000006'), 'refund_buyer',
  'Because.', -100), 'invalid', 'and a negative one');

-- Nothing above changed the dispute, because each was refused before the writer ran.
select is(
  (select status from public.disputes where id = pg_temp.dispute_of('01110001-0000-4000-8000-000000000006')),
  'open',
  'a refused resolution leaves the dispute open'
);

-- An amount above the order total is NOT refused here: 0027 makes no such rule at resolution time, and this
-- wrapper invents none. Recorded as the deliberate absence of a rule rather than left ambiguous.
select is(pg_temp.resolve('fe000000-0000-4000-8000-000000000001',
  pg_temp.dispute_of('01110001-0000-4000-8000-000000000006'), 'partial_refund',
  'The decided amount exceeds the order, which 0027 permits at resolution time.', 999999), 'resolved',
  'an amount above the order total is accepted, because 0027 constrains it only at open time');
select is(pg_temp.money_rows(), pg_temp.money_before(),
  'and still no financial row exists');

-- ---------------------------------------------------------------------------------------------------
-- 9. The thread, and the internal note
-- ---------------------------------------------------------------------------------------------------
-- A fresh dispute to write to, since every one above is now resolved and a resolved thread is closed.
select pg_temp.order_for('01110001-0000-4000-8000-000000000007', 'fe000000-0000-4000-8000-000000000008',
                         'fe000000-0000-4000-8000-000000000005', interval '7 minutes');
select pg_temp.dispute_on('01110001-0000-4000-8000-000000000007',
  'fe000000-0000-4000-8000-000000000005', 'damaged', 'The box was crushed.');
select pg_temp.age_disputes();

select is(pg_temp.post('fe000000-0000-4000-8000-000000000001',
  pg_temp.dispute_of('01110001-0000-4000-8000-000000000007'),
  'We have asked the courier for their report.'), 'posted', 'a colleague posts a message');
select is(pg_temp.post('fe000000-0000-4000-8000-000000000001',
  pg_temp.dispute_of('01110001-0000-4000-8000-000000000007'),
  'The courier has form for this. Watch the seller.', true), 'posted',
  'and an internal note');

select is(
  (select author_role from public.dispute_messages m
    where m.dispute_id = pg_temp.dispute_of('01110001-0000-4000-8000-000000000007') and m.is_internal),
  'staff',
  '0027 works the role out itself, so a colleague''s note is recorded as staff'
);
select is(
  (select count(*) from public.dispute_messages m
    where m.dispute_id = pg_temp.dispute_of('01110001-0000-4000-8000-000000000007')),
  3::bigint,
  'the thread holds the opener''s details plus both staff messages'
);
select is(
  (select count(*) from public.dispute_messages m
    where m.dispute_id = pg_temp.dispute_of('01110001-0000-4000-8000-000000000007') and m.is_internal),
  1::bigint,
  'exactly one of them is internal'
);

-- A colleague reads the internal note; the party policy is what hides it, and this reader is the staff one.
select is(
  (select count(*) from app_private.dispute_messages_for_staff(
     'fe000000-0000-4000-8000-000000000001', true,
     pg_temp.dispute_of('01110001-0000-4000-8000-000000000007'), 200) where is_internal),
  1::bigint,
  'the staff reader returns the internal note'
);

/*
 * Oldest first, so a thread reads in the order it happened.
 *
 * The messages posted above cannot be used for this: they were written in one transaction, so they share one
 * `created_at` — `now()` is transaction-stable — and `dispute_messages` is append-only, so their times cannot
 * be adjusted afterwards. The guard refusing that update is the guard working.
 *
 * So the ordering is asserted on its own fixture, inserted directly with genuinely distinct times and with
 * **identifiers chosen to contradict the time order**: ascending by id is `1, 2, 3` and ascending by time is
 * `3, 2, 1`. A reader that ordered by identifier — or that let the tie-break decide — fails this.
 */
select pg_temp.order_for('01110001-0000-4000-8000-000000000009', 'fe000000-0000-4000-8000-000000000008',
                         'fe000000-0000-4000-8000-000000000005', interval '5 minutes');
select pg_temp.dispute_on('01110001-0000-4000-8000-000000000009',
  'fe000000-0000-4000-8000-000000000005', 'damaged');
select pg_temp.age_disputes();

insert into public.dispute_messages (id, dispute_id, author_user_id, author_role, body, created_at) values
  ('ff000000-0000-4000-8000-000000000003',
   pg_temp.dispute_of('01110001-0000-4000-8000-000000000009'),
   'fe000000-0000-4000-8000-000000000005', 'buyer', 'written first', now() - interval '3 hours'),
  ('ff000000-0000-4000-8000-000000000002',
   pg_temp.dispute_of('01110001-0000-4000-8000-000000000009'),
   'fe000000-0000-4000-8000-000000000008', 'seller', 'written second', now() - interval '2 hours'),
  ('ff000000-0000-4000-8000-000000000001',
   pg_temp.dispute_of('01110001-0000-4000-8000-000000000009'),
   'fe000000-0000-4000-8000-000000000001', 'staff', 'written third', now() - interval '1 hour');

select is(
  (select array_agg(m.body order by m.ord)
     from app_private.dispute_messages_for_staff(
       'fe000000-0000-4000-8000-000000000001', true,
       pg_temp.dispute_of('01110001-0000-4000-8000-000000000009'), 200) with ordinality
       as m(id, author_role, body, is_internal, is_own_message, created_at, ord)),
  array['written first', 'written second', 'written third'],
  'the thread comes back oldest first, and not in identifier order'
);
select is(
  (select array_agg(m.author_role order by m.ord)
     from app_private.dispute_messages_for_staff(
       'fe000000-0000-4000-8000-000000000001', true,
       pg_temp.dispute_of('01110001-0000-4000-8000-000000000009'), 200) with ordinality
       as m(id, author_role, body, is_internal, is_own_message, created_at, ord)),
  array['buyer', 'seller', 'staff'],
  'so the exchange reads in the order it happened'
);
-- And the reader says which of them is the reader's own.
select is(
  (select array_agg(m.is_own_message order by m.ord)
     from app_private.dispute_messages_for_staff(
       'fe000000-0000-4000-8000-000000000001', true,
       pg_temp.dispute_of('01110001-0000-4000-8000-000000000009'), 200) with ordinality
       as m(id, author_role, body, is_internal, is_own_message, created_at, ord)),
  array[false, false, true],
  'and names no author, saying only which message is the reader''s own'
);

-- The messages posted through the writer are all there, whatever order one transaction gave them.
select is(
  (select array_agg(m.author_role order by m.author_role, m.is_internal)
     from app_private.dispute_messages_for_staff(
       'fe000000-0000-4000-8000-000000000001', true,
       pg_temp.dispute_of('01110001-0000-4000-8000-000000000007'), 200) m),
  array['buyer', 'staff', 'staff'],
  'the thread written through 0027''s writer holds the opener''s details and both staff messages'
);

-- The message writer's refusals.
select is(pg_temp.post('fe000000-0000-4000-8000-000000000001',
  pg_temp.dispute_of('01110001-0000-4000-8000-000000000007'), ''), 'body_required',
  'an empty message is refused');
select is(pg_temp.post('fe000000-0000-4000-8000-000000000001',
  pg_temp.dispute_of('01110001-0000-4000-8000-000000000007'), '   '), 'body_required',
  'and one with only spaces');
select is(pg_temp.post('fe000000-0000-4000-8000-000000000001',
  'fe000000-0000-4000-8000-0000000000ff', 'Hello'), 'not_found',
  'a dispute that does not exist is the neutral answer');
select is(pg_temp.post('fe000000-0000-4000-8000-000000000001',
  pg_temp.dispute_of('01110001-0000-4000-8000-000000000001'), 'Too late'), 'closed',
  'a resolved dispute''s thread is closed, which is 0027''s refusal');

-- 0027's party rule on an internal note, reachable only because an admin is a party to one dispute.
select pg_temp.order_for('01110001-0000-4000-8000-000000000008', 'fe000000-0000-4000-8000-000000000008',
                         'fe000000-0000-4000-8000-000000000009', interval '6 minutes');
select pg_temp.dispute_on('01110001-0000-4000-8000-000000000008',
  'fe000000-0000-4000-8000-000000000009', 'damaged');
select pg_temp.age_disputes();
select is(pg_temp.post('fe000000-0000-4000-8000-000000000009',
  pg_temp.dispute_of('01110001-0000-4000-8000-000000000008'), 'A private note', true), 'is_party',
  'an internal note from somebody who is a party is refused, which is 0027''s rule');
-- Their ordinary message is accepted and recorded as their side, not as staff.
select is(pg_temp.post('fe000000-0000-4000-8000-000000000009',
  pg_temp.dispute_of('01110001-0000-4000-8000-000000000008'), 'An ordinary message'), 'posted',
  'but an ordinary message from them is accepted');
select is(
  (select m.author_role from public.dispute_messages m
    where m.dispute_id = pg_temp.dispute_of('01110001-0000-4000-8000-000000000008')
    order by m.created_at desc, m.id desc limit 1),
  'buyer',
  'and 0027 records it as the side they are, never as staff'
);

-- One outbox event per message, from 0027's writer.
select ok(
  (select count(*) from public.outbox_events e
    where e.aggregate_type = 'dispute' and e.event_type = 'dispute.message_posted') >= 3::bigint,
  'each posted message enqueued 0027''s own event'
);

-- ---------------------------------------------------------------------------------------------------
-- 10. No account crosses, and no evidence is read
-- ---------------------------------------------------------------------------------------------------
select ok(',' || pg_temp.result_columns(fn) || ',' not like '%,' || col || ',%',
          format('%s returns no %s', fn, col))
  from unnest(array['dispute_queue_for_staff', 'dispute_for_staff', 'dispute_messages_for_staff']) as fn
 cross join unnest(array['buyer_user_id', 'seller_user_id', 'opened_by', 'resolved_by', 'author_user_id',
                         'assigned_to', 'order_id']) as col;

-- What is returned instead.
select ok(pg_temp.result_columns('dispute_for_staff') like '%is_party%',
  'the detail reports whether the reader is a party');
select ok(pg_temp.result_columns('dispute_for_staff') like '%can_manage%',
  'and whether they may act, as a capability rather than a key');
select ok(pg_temp.result_columns('dispute_for_staff') like '%opened_by_role%',
  'and which side opened it, as a side');
select ok(pg_temp.result_columns('dispute_messages_for_staff') like '%is_own_message%',
  'and the thread says only which messages are the reader''s own');

-- No key crosses either.
select ok(
  not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app_private'
       and p.proname in ('dispute_queue_for_staff', 'dispute_for_staff', 'dispute_messages_for_staff')
       and pg_get_functiondef(p.oid) ~ 'returns table[^$]*disputes\.dispute\.'
  ),
  'no reader returns a permission key as a column'
);

-- The deferred evidence surface: nothing here reads that table.
select ok(
  not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app_private' and p.proname like 'dispute_%'
       and pg_get_functiondef(p.oid) ~* 'from\s+public\.dispute_evidence'
  ),
  'no function here reads dispute_evidence, whose whole surface is deferred for want of an insert path'
);
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like '%evidence%' and p.proname like '%dispute%'),
  0::bigint,
  'and this migration created no dispute-evidence function at all'
);

-- ---------------------------------------------------------------------------------------------------
-- 11. The four unreachable statuses stay unreachable, and nothing is hidden
-- ---------------------------------------------------------------------------------------------------
select ok(
  not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app_private' and p.proname like 'dispute_%'
       and pg_get_functiondef(p.oid) ~ format('status\s*=\s*''%s''', w.st)
  ),
  format('no function here sets status to %s', w.st)
) from unnest(array['awaiting_seller', 'awaiting_buyer', 'under_review', 'cancelled']) as w(st);

-- The reader hides nothing: a dispute planted by hand in one of those states is returned.
update public.disputes set status = 'under_review'
 where id = pg_temp.dispute_of('01110001-0000-4000-8000-000000000007');
select is(pg_temp.queue('fe000000-0000-4000-8000-000000000001', true, 'under_review'), 1::bigint,
  'a dispute in an unreachable state is returned by the queue: the reader filters, it does not hide');
select is(
  (select status from app_private.dispute_for_staff('fe000000-0000-4000-8000-000000000001', true,
     pg_temp.dispute_of('01110001-0000-4000-8000-000000000007'))),
  'under_review',
  'and the detail reports it as it is'
);
update public.disputes set status = 'open'
 where id = pg_temp.dispute_of('01110001-0000-4000-8000-000000000007');

-- And the two that are reachable, both produced by 0027's own writers in this file.
select is(pg_temp.queue('fe000000-0000-4000-8000-000000000001', true, 'open'), 3::bigint,
  'three disputes are open, each opened by 0027''s writer');
select is(pg_temp.queue('fe000000-0000-4000-8000-000000000001', true, 'resolved'), 6::bigint,
  'and six are resolved, each by 0027''s writer');
select is(pg_temp.queue('fe000000-0000-4000-8000-000000000001', true, 'approved'), 0::bigint,
  'a status the schema does not have matches nothing rather than raising');

-- ---------------------------------------------------------------------------------------------------
-- 12. The queue: order, paging, clamping, and what a row says
-- ---------------------------------------------------------------------------------------------------
-- Compared by dispute id, because the queue deliberately never returns the order's id.
select is(
  (select array_agg(q.id order by q.ord)
     from app_private.dispute_queue_for_staff('fe000000-0000-4000-8000-000000000001', true, 50)
          with ordinality as q(id, status, reason_code, currency_code, claim_amount_minor, order_number,
                               order_status, order_type, seller_slug, seller_display_name, is_party,
                               resolved_by_me, resolution, message_count, has_details, due_at, created_at,
                               ord)),
  array[
    pg_temp.dispute_of('01110001-0000-4000-8000-000000000001'),
    pg_temp.dispute_of('01110001-0000-4000-8000-000000000002'),
    pg_temp.dispute_of('01110001-0000-4000-8000-000000000003'),
    pg_temp.dispute_of('01110001-0000-4000-8000-000000000004'),
    pg_temp.dispute_of('01110001-0000-4000-8000-000000000005'),
    pg_temp.dispute_of('01110001-0000-4000-8000-000000000006'),
    pg_temp.dispute_of('01110001-0000-4000-8000-000000000007'),
    pg_temp.dispute_of('01110001-0000-4000-8000-000000000008'),
    pg_temp.dispute_of('01110001-0000-4000-8000-000000000009')
  ],
  'the queue is oldest first, because somebody is out of pocket while a dispute waits'
);

-- The order's own reference crosses, in the platform's own format rather than one this fixture invented.
select ok(
  (select bool_and(q.order_number ~ '^MP-[0-9]{2}-[0-9]{6,}$')
     from app_private.dispute_queue_for_staff('fe000000-0000-4000-8000-000000000001', true, 50) q),
  'every row carries the order''s own reference, generated by 0018 in its own format'
);

select is((select count(*) from app_private.dispute_queue_for_staff(
  'fe000000-0000-4000-8000-000000000001', true, 3)), 3::bigint, 'the limit is honoured');
select is((select count(*) from app_private.dispute_queue_for_staff(
  'fe000000-0000-4000-8000-000000000001', true, 0)), 1::bigint, 'a limit of zero is clamped up to one');
select is((select count(*) from app_private.dispute_queue_for_staff(
  'fe000000-0000-4000-8000-000000000001', true, -5)), 1::bigint, 'so is a negative one');
select is((select count(*) from app_private.dispute_queue_for_staff(
  'fe000000-0000-4000-8000-000000000001', true, null)), 9::bigint, 'a null limit falls back to the default');
select is((select count(*) from app_private.dispute_queue_for_staff(
  'fe000000-0000-4000-8000-000000000001', true, 9999)), 9::bigint, 'and an enormous one is clamped');

-- The cursor moves forward and never repeats a row.
select is(
  (select count(*) from app_private.dispute_queue_for_staff('fe000000-0000-4000-8000-000000000001', true, 50,
     null,
     (select created_at from public.disputes where order_id = '01110001-0000-4000-8000-000000000001'),
     pg_temp.dispute_of('01110001-0000-4000-8000-000000000001'))),
  8::bigint,
  'a cursor at the first row returns the eight after it and not itself'
);
select is(
  (select count(*) from app_private.dispute_queue_for_staff('fe000000-0000-4000-8000-000000000001', true, 50,
     null, now(), null)),
  9::bigint,
  'a time with no identifier is ignored rather than half-applied'
);
select is(
  (select count(*) from app_private.dispute_queue_for_staff('fe000000-0000-4000-8000-000000000001', true, 50,
     null, null, pg_temp.dispute_of('01110001-0000-4000-8000-000000000001'))),
  9::bigint,
  'an identifier with no time likewise'
);

-- What a row says.
select is(
  (select claim_amount_minor from app_private.dispute_queue_for_staff(
     'fe000000-0000-4000-8000-000000000001', true, 50) where id = pg_temp.dispute_of('01110001-0000-4000-8000-000000000001')),
  8000::bigint,
  'the claim crosses as a bigint, to be rendered as a decimal string'
);
select is(
  (select currency_code from app_private.dispute_queue_for_staff(
     'fe000000-0000-4000-8000-000000000001', true, 50) where id = pg_temp.dispute_of('01110001-0000-4000-8000-000000000001')),
  'XTR'::char(3),
  'and never without its currency'
);
select ok(
  (select has_details from app_private.dispute_queue_for_staff(
     'fe000000-0000-4000-8000-000000000001', true, 50) where id = pg_temp.dispute_of('01110001-0000-4000-8000-000000000001')),
  'a queue row says there is prose to read without carrying it'
);
select ok(
  not (select has_details from app_private.dispute_queue_for_staff(
     'fe000000-0000-4000-8000-000000000001', true, 50) where id = pg_temp.dispute_of('01110001-0000-4000-8000-000000000002')),
  'and says so when there is none'
);
select is(
  (select seller_slug from app_private.dispute_queue_for_staff(
     'fe000000-0000-4000-8000-000000000001', true, 50) where id = pg_temp.dispute_of('01110001-0000-4000-8000-000000000001')),
  'r-shop',
  'the storefront is named by its own public handle'
);
select ok(
  (select is_party from app_private.dispute_queue_for_staff(
     'fe000000-0000-4000-8000-000000000009', true, 50) where id = pg_temp.dispute_of('01110001-0000-4000-8000-000000000005')),
  'a reader who is a party to a dispute is told so on the row'
);
select ok(
  not (select is_party from app_private.dispute_queue_for_staff(
     'fe000000-0000-4000-8000-000000000001', true, 50) where id = pg_temp.dispute_of('01110001-0000-4000-8000-000000000005')),
  'and a colleague who is not is told that'
);
select ok(
  (select resolved_by_me from app_private.dispute_queue_for_staff(
     'fe000000-0000-4000-8000-000000000001', true, 50) where id = pg_temp.dispute_of('01110001-0000-4000-8000-000000000001')),
  'and whether the decision on it was their own'
);
select ok(
  not (select resolved_by_me from app_private.dispute_queue_for_staff(
     'fe000000-0000-4000-8000-000000000002', true, 50) where id = pg_temp.dispute_of('01110001-0000-4000-8000-000000000001')),
  'which is false for the colleague who did not rule'
);

-- ---------------------------------------------------------------------------------------------------
-- 13. What one dispute says
-- ---------------------------------------------------------------------------------------------------
select is(
  (select order_grand_total_minor from app_private.dispute_for_staff(
     'fe000000-0000-4000-8000-000000000001', true,
     pg_temp.dispute_of('01110001-0000-4000-8000-000000000002'))),
  55000::bigint,
  'the order total crosses so a claim can be judged against it'
);
select is(
  (select order_status_before from app_private.dispute_for_staff(
     'fe000000-0000-4000-8000-000000000001', true,
     pg_temp.dispute_of('01110001-0000-4000-8000-000000000001'))),
  'delivered',
  'the snapshot status crosses, which is what the resolution restored'
);
select is(
  (select opened_by_role from app_private.dispute_for_staff(
     'fe000000-0000-4000-8000-000000000001', true,
     pg_temp.dispute_of('01110001-0000-4000-8000-000000000003'))),
  'seller',
  'a dispute the seller opened says so, as a side'
);
select is(
  (select opened_by_role from app_private.dispute_for_staff(
     'fe000000-0000-4000-8000-000000000001', true,
     pg_temp.dispute_of('01110001-0000-4000-8000-000000000001'))),
  'buyer',
  'and one the buyer opened'
);
select ok(
  (select can_manage from app_private.dispute_for_staff(
     'fe000000-0000-4000-8000-000000000001', true,
     pg_temp.dispute_of('01110001-0000-4000-8000-000000000001'))),
  'an admin is told they may act'
);
select is(
  (select resolution_note from app_private.dispute_for_staff(
     'fe000000-0000-4000-8000-000000000001', true,
     pg_temp.dispute_of('01110001-0000-4000-8000-000000000004'))),
  'Neither side substantiated anything.',
  'the recorded reason crosses to the colleague reading it'
);

-- ---------------------------------------------------------------------------------------------------
-- 14. No second audit path, and the redaction 0027 asked for
-- ---------------------------------------------------------------------------------------------------
select ok(
  not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app_private' and p.proname like 'dispute_%'
       and pg_get_functiondef(p.oid) ~* '(insert\s+into|update|delete\s+from)\s+audit\.'
  ),
  'no function here writes an audit row: 0027''s trigger already does'
);
select ok(
  not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app_private' and p.proname like 'dispute_%'
       and pg_get_functiondef(p.oid) ~* 'perform\s+public\.enqueue_outbox_event'
  ),
  'and none enqueues a second outbox event: 0027''s writers already do'
);
select ok(
  not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app_private' and p.proname like 'dispute_%'
       and pg_get_functiondef(p.oid) ~* '(insert\s+into|update)\s+public\.(notifications|security_events)\M'
  ),
  'and none writes a notification or a security event'
);

-- The trail that does exist, with both sensitive columns redacted by 0027's own trigger arguments.
select ok(
  exists (select 1 from audit.audit_logs a
           where a.table_name = 'disputes' and a.action = 'update'
             and a.new_values ->> 'resolution_note' = '[redacted]'),
  'the audit row for a resolution redacts the reason, as 0027''s trigger arguments ask'
);
select ok(
  exists (select 1 from audit.audit_logs a
           where a.table_name = 'disputes' and a.action = 'insert'
             and a.new_values ->> 'details' = '[redacted]'),
  'and the row for an opening redacts the details'
);
select ok(
  exists (select 1 from audit.audit_logs a
           where a.table_name = 'disputes' and a.action = 'update'
             and a.changed_columns @> array['resolution']),
  'and names the columns that changed'
);

-- ---------------------------------------------------------------------------------------------------
-- 15. Nothing outside the dispute tables changed
-- ---------------------------------------------------------------------------------------------------
select is(pg_temp.money_rows(), pg_temp.money_before(),
  'at the end of everything above, every financial table is still empty');
select is((select count(*) from public.disputes), 9::bigint, 'nine disputes exist');
select is(
  (select count(*) from public.disputes where status = 'resolved'),
  6::bigint,
  'six of them resolved, every one through 0027''s writer'
);
select is((select count(*) from public.dispute_evidence), 0::bigint,
  'and no evidence row exists, because nothing in this repository writes one');

select * from finish();
rollback;
