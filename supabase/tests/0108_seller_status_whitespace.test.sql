-- pgTAP — migration 0108: whitespace normalisation in the seller status writer (corrective).
--
-- `btrim(x)` with no character set trims **spaces only**. `app_private.admin_seller_status_set` used that
-- loose form twice, and both had a reachable consequence:
--
--   * a suspension reason made entirely of tabs or newlines was not null, so the `reason_required` refusal
--     did not fire and a storefront could be suspended with a reason that reads as blank wherever it is
--     shown;
--   * a slug made entirely of whitespace reached the row lookup instead of being refused as absent.
--
-- What this file proves, in order:
--
--   * **the suspension reason is now refused for every whitespace shape** — space, tab, carriage return,
--     newline and mixtures — with `reason_required`, and the storefront does not move;
--   * **the refusal is a refusal, not a silent pass**: the status, `suspended_at` and `suspension_reason`
--     columns are all unchanged after each attempt;
--   * **a whitespace-only slug is `not_found`**, which is the same answer an absent slug gets, so the
--     refusal cannot be used to ask whether a storefront exists;
--   * **a real reason still works**, including one with interior whitespace — this migration refuses an
--     empty value, it does not reformat text — and a leading/trailing tab is trimmed off a real reason
--     rather than making it blank;
--   * **nothing else about the function changed**: the seven legal transitions, the terminal `closed`, the
--     two verification complements and the `no_change` answer all still behave as 0079 decided.
--
-- The last group matters because this migration recreates the whole function. A corrective change that
-- quietly altered a transition would be far worse than the defect it fixed, so the transition matrix is
-- re-asserted here rather than assumed to have survived.
--
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(35);

-- ---------------------------------------------------------------------------------------------------
-- Fixtures — the same shapes 0079's own suite uses, at their own ids
-- ---------------------------------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('fa080000-0000-4000-8000-000000000001', 'w-admin@test.invalid'),
  ('fa080000-0000-4000-8000-00000000000a', 'w-seller-pending@test.invalid'),
  ('fa080000-0000-4000-8000-00000000000b', 'w-seller-active@test.invalid'),
  ('fa080000-0000-4000-8000-00000000000c', 'w-seller-suspended@test.invalid'),
  ('fa080000-0000-4000-8000-00000000000d', 'w-seller-closed@test.invalid'),
  ('fa080000-0000-4000-8000-00000000000e', 'w-seller-susp-verified@test.invalid'),
  -- A second pending storefront, untouched by the reason assertions above it, so the transition matrix in
  -- section 4 is checked against a storefront that is still where the fixture put it. The first version of
  -- this file reused `w-pending` there and asserted `not_allowed` against a storefront that section 3 had
  -- already suspended — the run caught it, which is the whole reason the suite is run rather than reasoned
  -- about.
  ('fa080000-0000-4000-8000-00000000000f', 'w-seller-pending-2@test.invalid');

insert into public.user_roles (user_id, role_key, granted_at) values
  ('fa080000-0000-4000-8000-000000000001', 'admin', now() - interval '10 days');

create or replace function pg_temp.shop(
  p_user uuid, p_slug text, p_status text, p_verification text
) returns void language plpgsql as $$
begin
  insert into public.seller_profiles (
    user_id, slug, display_name, legal_name, bio, content_language, contact_email, contact_phone_e164,
    country_code, governorate, city, status, suspended_at, suspension_reason, closed_at,
    verification_status, verified_at, created_at
  ) values (
    p_user, p_slug, 'Shop ' || p_slug, 'Shop ' || p_slug || ' LLC', 'A bio.', 'en',
    p_slug || '@test.invalid', '+2010001' || lpad((random() * 99999)::integer::text, 5, '0'),
    'EG', 'Cairo', 'Cairo', p_status,
    case when p_status = 'suspended' then now() - interval '2 days' end,
    case when p_status = 'suspended' then 'The original reason for suspending it.' end,
    case when p_status = 'closed' then now() - interval '2 days' end,
    p_verification,
    case when p_verification = 'verified' then now() - interval '5 days' end,
    now() - interval '10 days'
  );
end;
$$;

select pg_temp.shop('fa080000-0000-4000-8000-00000000000a', 'w-pending',   'pending',   'unverified');
select pg_temp.shop('fa080000-0000-4000-8000-00000000000b', 'w-active',    'active',    'verified');
select pg_temp.shop('fa080000-0000-4000-8000-00000000000c', 'w-suspended', 'suspended', 'rejected');
select pg_temp.shop('fa080000-0000-4000-8000-00000000000d', 'w-closed',    'closed',    'verified');
select pg_temp.shop('fa080000-0000-4000-8000-00000000000e', 'w-susp-ver',  'suspended', 'verified');
select pg_temp.shop('fa080000-0000-4000-8000-00000000000f', 'w-pending-2',  'pending',   'unverified');

create or replace function pg_temp.move(p_slug text, p_status text, p_reason text default null)
returns text language sql as $$
  select outcome from app_private.admin_seller_status_set(
    'fa080000-0000-4000-8000-000000000001'::uuid, true, p_slug, p_status, p_reason
  );
$$;

create or replace function pg_temp.status_of(p_slug text) returns text language sql as $$
  select status from public.seller_profiles where slug = p_slug;
$$;

-- ---------------------------------------------------------------------------------------------------
-- 1. The defect: a whitespace-only suspension reason
-- ---------------------------------------------------------------------------------------------------
-- Each shape is attempted against `w-active`, which is a legal source for `suspended`, so the only thing
-- that can refuse the transition is the reason itself. Before 0108 the four non-space shapes all returned
-- `updated` and wrote a blank-looking reason.
select is(pg_temp.move('w-active', 'suspended', '    '), 'reason_required',
  'a reason of spaces is refused');
select is(pg_temp.move('w-active', 'suspended', E'\t\t'), 'reason_required',
  'a reason of tabs is refused — the defect this migration closes');
select is(pg_temp.move('w-active', 'suspended', E'\n'), 'reason_required',
  'a reason of one newline is refused');
select is(pg_temp.move('w-active', 'suspended', E'\r\n'), 'reason_required',
  'a reason of a carriage return and a newline is refused');
select is(pg_temp.move('w-active', 'suspended', E' \t\r\n '), 'reason_required',
  'a reason mixing every whitespace character is refused');
select is(pg_temp.move('w-active', 'suspended', ''), 'reason_required',
  'an empty reason is refused, as it always was');
select is(pg_temp.move('w-active', 'suspended', null), 'reason_required',
  'a null reason is refused, as it always was');

-- The refusal has to be a refusal. A function that returned `reason_required` and wrote anyway would pass
-- every assertion above.
select is(pg_temp.status_of('w-active'), 'active',
  'the storefront did not move through any of those refusals');
select is(
  (select suspended_at from public.seller_profiles where slug = 'w-active'), null,
  'and suspended_at was not set');
select is(
  (select suspension_reason from public.seller_profiles where slug = 'w-active'), null,
  'and no suspension reason was stored');

-- ---------------------------------------------------------------------------------------------------
-- 2. The second loose call: a whitespace-only slug
-- ---------------------------------------------------------------------------------------------------
-- `not_found` is the same answer an unknown slug gets, deliberately: a distinguishable refusal here would
-- be a way to ask whether a storefront exists.
select is(pg_temp.move(E'\t', 'suspended', 'A real reason.'), 'not_found',
  'a slug of one tab is not found');
select is(pg_temp.move(E'\n\n', 'suspended', 'A real reason.'), 'not_found',
  'a slug of newlines is not found');
select is(pg_temp.move('   ', 'suspended', 'A real reason.'), 'not_found',
  'a slug of spaces is not found, as it always was');
select is(pg_temp.move('w-no-such-shop', 'suspended', 'A real reason.'), 'not_found',
  'and an unknown slug gives the identical answer');

-- ---------------------------------------------------------------------------------------------------
-- 3. A real reason still works, and is not reformatted
-- ---------------------------------------------------------------------------------------------------
select is(pg_temp.move('w-active', 'suspended', 'Selling counterfeit goods.'), 'updated',
  'a real reason suspends the storefront');
select is(pg_temp.status_of('w-active'), 'suspended', 'and the status moved');
select is(
  (select suspension_reason from public.seller_profiles where slug = 'w-active'),
  'Selling counterfeit goods.',
  'and the reason was stored exactly as given');
select isnt(
  (select suspended_at from public.seller_profiles where slug = 'w-active'), null,
  'and suspended_at was set');

-- Interior whitespace is content. This migration refuses an empty value; it does not tidy text.
select is(pg_temp.move('w-pending', 'suspended', E'Two\treasons,\ntwo lines.'), 'updated',
  'a reason containing tabs and newlines inside it is accepted');
select is(
  (select suspension_reason from public.seller_profiles where slug = 'w-pending'),
  E'Two\treasons,\ntwo lines.',
  'and its interior whitespace is stored untouched');

-- Surrounding whitespace is trimmed off a real reason rather than making it blank.
select is(pg_temp.move('w-susp-ver', 'active', null), 'updated', 'reinstating a verified storefront');
select is(pg_temp.move('w-susp-ver', 'suspended', E'\t  A padded reason.  \n'), 'updated',
  'a real reason wrapped in whitespace is accepted');
select is(
  (select suspension_reason from public.seller_profiles where slug = 'w-susp-ver'),
  'A padded reason.',
  'and the surrounding whitespace was trimmed, including the tab and the newline');

-- ---------------------------------------------------------------------------------------------------
-- 4. Nothing else about the function changed
-- ---------------------------------------------------------------------------------------------------
-- This migration recreates the whole function, so 0079's decisions are re-asserted rather than assumed to
-- have survived the rewrite.
select is(pg_temp.move('w-closed', 'active', null), 'not_allowed',
  'closed is still terminal');
select is(pg_temp.move('w-closed', 'suspended', 'A real reason.'), 'not_allowed',
  'closed is terminal even toward suspended');
select is(pg_temp.move('w-suspended', 'active', null), 'not_verified',
  'reinstating an unverified storefront to active is still refused');
select is(pg_temp.move('w-pending-2', 'active', null), 'not_allowed',
  'pending → active still belongs to verification approval alone');
select is(pg_temp.move('w-active', 'suspended', 'Again.'), 'no_change',
  'a transition to the status it already holds is still no_change');
select is(pg_temp.move('w-active', 'closed', null), 'updated',
  'suspended → closed is still allowed, and needs no reason');
select is(pg_temp.status_of('w-active'), 'closed', 'and it closed');
select is(
  (select closed_at is not null and suspended_at is null and suspension_reason is null
     from public.seller_profiles where slug = 'w-active'), true,
  'and closing cleared the suspension columns the CHECK constraints require it to');
select is(pg_temp.move('w-pending-2', 'nonsense', 'A real reason.'), 'invalid',
  'an unknown status is still invalid');
select is(
  (select outcome from app_private.admin_seller_status_set(
     'fa080000-0000-4000-8000-00000000000a'::uuid, true, 'w-pending-2', 'active', null)),
  'not_found',
  'a caller without the manage key still gets not_found');
select is(
  (select outcome from app_private.admin_seller_status_set(
     'fa080000-0000-4000-8000-000000000001'::uuid, false, 'w-pending-2', 'active', null)),
  'not_found',
  'and so does an administrator below aal2');

-- ---------------------------------------------------------------------------------------------------
-- 5. The loose form is gone from the function's own source
-- ---------------------------------------------------------------------------------------------------
-- The behavioural assertions above are the real proof; this one names the cause, so a future rewrite that
-- reintroduced the loose form would fail here with a message that says what to look for.
select is(
  (select count(*)::integer
     from pg_catalog.pg_proc p
     join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname = 'admin_seller_status_set'
      and p.prosrc ~ 'btrim\s*\([^,)]*\)'),
  0,
  'the function body contains no btrim() call that names no character set');

select * from finish();
rollback;
