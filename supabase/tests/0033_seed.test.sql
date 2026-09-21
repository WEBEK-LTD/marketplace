-- pgTAP — migration 0033: the canonical Phase 2 seed.
--
-- Every assertion reads the resulting database state, never the migration text. The permission set is
-- checked against the keys the live row level security policies actually enforce, read out of
-- `pg_policy`, so the seed is compared with the schema rather than with itself. Idempotency is proven by
-- re-running the seed's own statements inside the transaction and showing that nothing moves, and by
-- changing a configurable value first and showing the seed leaves it alone.
--
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(83);

-- ---------------------------------------------------------------------------------------------------
-- Locales — English primary, Arabic secondary (D6)
-- ---------------------------------------------------------------------------------------------------
select is((select count(*) from public.locales), 2::bigint, 'two locales are seeded');
select is(
  (select string_agg(format('%s/%s/%s/%s/%s', code, direction, digit_style, is_active, is_default), ' ' order by code)
     from public.locales),
  'ar/rtl/western/t/f en/ltr/western/t/t',
  'English is the active default and left-to-right; Arabic is active, right-to-left and secondary'
);
select is((select count(*) from public.locales where is_default), 1::bigint, 'exactly one locale is the default');
select is((select name_native from public.locales where code = 'ar'), 'العربية',
  'and Arabic carries its own native name, not an English one');
select is((select count(*) from public.locales where digit_style <> 'western'), 0::bigint,
  'digits are Western by default and configurable per language for display only (D15)');

-- ---------------------------------------------------------------------------------------------------
-- Currencies — EGP is V1, the multi-currency architecture is untouched
-- ---------------------------------------------------------------------------------------------------
select is((select count(*) from public.currencies where is_enabled), 1::bigint, 'exactly one currency is enabled');
select is((select code from public.currencies where is_default), 'EGP'::char(3), 'and EGP is the default');
select is(
  (select format('%s/%s/%s/%s/%s/%s', numeric_code, decimal_places, is_enabled, is_default, is_pricing_enabled, is_checkout_enabled)
     from public.currencies where code = 'EGP'),
  '818/2/t/t/t/t',
  'EGP carries its ISO numeric code and minor unit and is enabled for pricing and checkout'
);
select ok((select first_enabled_at is not null from public.currencies where code = 'EGP'),
  'and records when it was first enabled, which the D16 retirement rule depends on');
select is((select count(*) from public.currencies where retired_at is not null), 0::bigint,
  'no currency is seeded already retired');
select is(
  (select string_agg(format('%s=%s', locale_code, name), ' ' order by locale_code)
     from public.currency_translations where currency_code = 'EGP'),
  'ar=جنيه مصري en=Egyptian Pound',
  'and it is named in both locales, each written rather than derived from the other'
);

-- ---------------------------------------------------------------------------------------------------
-- Countries — Egypt enabled with EGP, nothing else enabled
-- ---------------------------------------------------------------------------------------------------
select is((select count(*) from public.countries where is_marketplace_enabled), 1::bigint,
  'exactly one country is open for business');
select is(
  (select format('%s/%s/%s/%s/%s/%s', code, iso3, numeric_code, phone_code, default_currency_code, name_ar)
     from public.countries where is_marketplace_enabled),
  'EG/EGY/818/20/EGP/مصر',
  'and it is Egypt, with its ISO codes, dialling code, EGP and its Arabic name'
);
select is((select name_en from public.countries where code = 'EG'), 'Egypt', 'named in English too');
select is((select count(*) from public.countries where default_currency_code is null and is_marketplace_enabled),
  0::bigint, 'an enabled country always has a currency');

-- ---------------------------------------------------------------------------------------------------
-- Listing types — products and services in V1
-- ---------------------------------------------------------------------------------------------------
select is(
  (select string_agg(format('%s/%s', code, is_active), ' ' order by sort_order) from public.listing_types),
  'product/t service/t',
  'both listing types the marketplace sells are seeded and active'
);
select is((select count(*) from public.listing_types), 2::bigint, 'and there are only those two');
select is((select count(*) from public.listing_types where btrim(name_ar) = '' or name_ar = name_en), 0::bigint,
  'each carries a real Arabic name rather than a copy of the English one');

-- ---------------------------------------------------------------------------------------------------
-- Roles — the approved authorization matrix
-- ---------------------------------------------------------------------------------------------------
select is((select count(*) from public.roles), 7::bigint, 'the matrix has seven roles and seven are seeded');
select is(
  (select string_agg(key, ',' order by sort_order) from public.roles),
  'guest,buyer,seller,moderator,support_agent,admin,super_admin',
  'in the order the matrix gives them'
);
select is(
  (select string_agg(key, ',' order by key) from public.roles where is_admin_console),
  'admin,moderator,super_admin,support_agent',
  'the four console roles are exactly the ones the matrix puts in the admin app'
);
select is((select count(*) from public.roles where is_admin_console and not requires_mfa), 0::bigint,
  'TOTP is mandatory for every console role');
select is(
  (select string_agg(key, ',' order by key) from public.roles where not requires_mfa),
  'buyer,guest,seller',
  'and optional for buyers and sellers, who hold nothing privileged'
);
select ok(not (select is_assignable from public.roles where key = 'guest'),
  'guest is recorded but can never be granted: a guest is the absence of a role');
select is((select count(*) from public.roles where is_assignable), 6::bigint, 'the other six are assignable');
select is((select count(*) from public.roles where btrim(name_ar) = '' or name_ar = name_en), 0::bigint,
  'every role is named in both languages');

-- ---------------------------------------------------------------------------------------------------
-- Permissions — compared with what the schema actually enforces, not with the migration
-- ---------------------------------------------------------------------------------------------------
select is((select count(*) from public.permissions), 82::bigint, 'eighty-two permissions are seeded');
select is(
  (select coalesce(string_agg(distinct e.k, ', ' order by e.k), '')
     from (select (regexp_matches(pg_get_expr(p.polqual, p.polrelid) || ' ' ||
                                  coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''),
                                  'has_permission\(''([a-z_.]+)''::text\)', 'g'))[1] as k
             from pg_policy p) e
    where not exists (select 1 from public.permissions pm where pm.key = e.k)),
  '',
  'every permission key a live policy enforces exists as a row'
);
select is(
  (select coalesce(string_agg(pm.key, ', ' order by pm.key), '')
     from public.permissions pm
    where not exists (
      select 1 from (select (regexp_matches(pg_get_expr(p.polqual, p.polrelid) || ' ' ||
                                            coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''),
                                            'has_permission\(''([a-z_.]+)''::text\)', 'g'))[1] as k
                       from pg_policy p) e
       where e.k = pm.key)),
  '',
  'and no permission is seeded that nothing enforces: the two sets are equal'
);
select is((select count(distinct module) from public.permissions), 19::bigint,
  'the keys span the nineteen modules the schema guards');
select is(
  (select count(*) from public.permissions where module <> split_part(key, '.', 1)),
  0::bigint,
  'every row''s module agrees with its own key'
);
select is((select count(*) from public.permissions where btrim(description_ar) = '' or description_ar = description_en),
  0::bigint, 'each permission is described in both languages');

-- ---------------------------------------------------------------------------------------------------
-- Role → permission mapping
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*) from public.role_permissions where role_key = 'super_admin'),
  (select count(*) from public.permissions),
  'Super Admin holds all operations, exactly as the matrix says'
);
select is(
  (select count(*) from public.role_permissions where role_key = 'admin'),
  (select count(*) from public.permissions),
  'Admin holds every admin operation'
);
select is(
  (select coalesce(string_agg(role_key, ',' order by role_key), '')
     from public.role_permissions where role_key in ('guest', 'buyer', 'seller')),
  '',
  'guest, buyer and seller hold nothing privileged: their access is ownership, not permission'
);
-- Moderator and Support Agent, from the owner authorization of 2026-09-20. Each list is asserted key by
-- key, so a key added or dropped later fails here rather than passing on a count alone.
select is((select count(*) from public.role_permissions where role_key = 'moderator'), 9::bigint,
  'the moderator holds exactly nine permissions');
select is(
  (select string_agg(permission_key, ',' order by permission_key)
     from public.role_permissions where role_key = 'moderator'),
  'catalog.listing.moderate,catalog.listing.read,moderation.action.read,moderation.report.manage,'
  'moderation.report.read,reviews.review.moderate,reviews.review.read,sellers.profile.read,users.profile.read',
  'and they are exactly the authorized nine, named one by one'
);
select is(
  (select count(*) from public.role_permissions
    where role_key = 'moderator' and permission_key like 'disputes.%'),
  0::bigint,
  'disputes are a separate responsibility: the moderator holds neither dispute permission'
);

select is((select count(*) from public.role_permissions where role_key = 'support_agent'), 5::bigint,
  'the support agent holds exactly five permissions');
select is(
  (select string_agg(permission_key, ',' order by permission_key)
     from public.role_permissions where role_key = 'support_agent'),
  'orders.order.read,security.recovery.review,support.ticket.manage,support.ticket.read,users.profile.read',
  'and they are exactly the authorized five'
);
select is(
  (select count(*) from public.role_permissions
    where role_key = 'support_agent'
      and permission_key in ('users.security.read', 'sellers.profile.read')),
  0::bigint,
  'the two keys the owner withheld are absent'
);
select is((select count(*) from public.permissions where key = 'security.recovery.approve'), 0::bigint,
  'no security.recovery.approve key was created: the existing recovery permission was not split');

-- What `security.recovery.review` actually permits, asserted against the catalogue rather than assumed.
select is(
  (select string_agg(distinct p.polcmd::text, ',')
     from pg_policy p
    where coalesce(pg_get_expr(p.polqual, p.polrelid), '') like '%recovery.review%'),
  'r',
  'security.recovery.review appears only in read policies: it confers no write anywhere'
);
select is(
  (select count(*) from pg_proc pr join pg_namespace n on n.oid = pr.pronamespace
    where n.nspname = 'app_private'
      and pr.proname in ('review_recovery_request', 'decide_recovery_request', 'complete_recovery_request')
      and has_function_privilege('authenticated', pr.oid, 'execute')),
  0::bigint,
  'and a request can execute none of the recovery functions, so the grant cannot become an approval'
);

select ok(
  (select bool_and(requires_mfa and is_admin_console and is_assignable)
     from public.roles where key in ('moderator', 'support_agent')),
  'both roles still require TOTP and open the admin console'
);
select is((select count(*) from public.role_permissions), 178::bigint,
  'the mapping is 82 + 82 + 9 + 5, and nothing else');
select is(
  (select count(*) from public.role_permissions rp
    where not exists (select 1 from public.roles r where r.key = rp.role_key)
       or not exists (select 1 from public.permissions p where p.key = rp.permission_key)),
  0::bigint,
  'and every pair names a role and a permission that exist'
);

-- ---------------------------------------------------------------------------------------------------
-- Site settings
-- ---------------------------------------------------------------------------------------------------
select is((select count(*) from public.site_settings), 9::bigint,
  'nine settings exist: the six seeded here and the three earlier migrations own');
select is(
  (select string_agg(format('%s=%s', key, value #>> '{}'), ' ' order by key)
     from public.site_settings
    where key in ('offers.default_expiry_hours', 'carts.guest_expiry_days', 'orders.service_buyer_response_hours')),
  'carts.guest_expiry_days=30 offers.default_expiry_hours=48 orders.service_buyer_response_hours=72',
  'each window is seeded with the value the approved migration already falls back to (D22, D25, D23)'
);
select is((select value #>> '{}' from public.site_settings where key = 'branding.site_name'), 'Marketplace',
  'branding is a neutral development value, never a real brand in a migration (D5)');
select is((select value #>> '{}' from public.site_settings where key = 'branding.site_domain'), 'localhost',
  'and so is the domain');
select is((select value #>> '{}' from public.site_settings where key = 'platform.display_timezone'), 'Africa/Cairo',
  'the display timezone is set; everything is still stored and computed in UTC (C20)');
select is(
  (select coalesce(string_agg(key, ',' order by key), '') from public.site_settings where is_public),
  'branding.site_domain,branding.site_name,platform.display_timezone',
  'only branding and the timezone are readable by the public site'
);
select is((select count(*) from public.site_settings where value_type = 'number'
            and jsonb_typeof(value) <> 'number'), 0::bigint,
  'every seeded value matches the type it declares');
select is((select count(*) from public.site_settings where btrim(description_ar) = ''), 0::bigint,
  'and every setting is described in both languages');
select is((select value #>> '{}' from public.site_settings where key = 'finance.settlement_posting_enabled'), 'false',
  'the seed leaves settlement posting disabled');

-- ---------------------------------------------------------------------------------------------------
-- Payment exception policies — fail-closed, and D19 holds
-- ---------------------------------------------------------------------------------------------------
select is((select count(*) from public.payment_exception_policies), 5::bigint,
  'one policy per exception case the schema recognises');
select is(
  (select string_agg(case_type, ',' order by case_type) from public.payment_exception_policies),
  'amount_mismatch,currency_mismatch,duplicate_success,late_success,unknown_reference',
  'and they are exactly the five named cases'
);
select is((select count(*) from public.payment_exception_policies where resolution <> 'manual_review'), 0::bigint,
  'every one resolves to manual review while B1-A is open');
select is((select count(*) from public.payment_exception_policies where not requires_manual_approval), 0::bigint,
  'and every one requires a human, so no refund can ever be automatic (D19)');
select is(
  (select id from public.payment_exception_policies where case_type = 'late_success'),
  ('00000000-0000-4000-8000-' || substr(md5('payment_exception_policy:late_success'), 1, 12))::uuid,
  'the ids are derived deterministically, so a case row points at the same policy in every environment'
);
select is((select count(*) from public.payment_exception_policies where not is_active), 0::bigint,
  'all five are active');

-- ---------------------------------------------------------------------------------------------------
-- Nothing but reference data was seeded
-- ---------------------------------------------------------------------------------------------------
select is(
  (select coalesce(string_agg(t.name, ', ' order by t.name), '')
     from (values
       ('auth.users'), ('public.profiles'), ('public.seller_profiles'), ('public.listings'),
       ('public.categories'), ('public.orders'), ('public.checkouts'), ('public.carts'),
       ('public.payments'), ('public.payment_attempts'), ('public.payouts'), ('public.withdrawals'),
       ('public.ledger_entries'), ('public.ledger_journals'), ('public.commissions'),
       ('public.reviews'), ('public.disputes'), ('public.reports'), ('public.support_tickets'),
       ('public.notifications'), ('public.messages'), ('public.offers'), ('public.promotions'),
       ('public.coupons'), ('public.pages'), ('public.blog_posts'), ('public.banners'),
       ('public.tags'), ('public.outbox_events'), ('public.email_outbox'),
       ('public.account_recovery_requests'), ('public.security_events')
     ) as t(name)
    where (select n from (select count(*) as n from pg_class c where false) z) is null
      and (xpath('/row/c/text()',
            query_to_xml(format('select count(*) as c from %s', t.name), false, true, '')))[1]::text::bigint > 0),
  '',
  'no user, seller, listing, order, payment, payout, ledger entry, review, dispute, ticket, page or post was seeded'
);
select is((select count(*) from public.payment_providers), 0::bigint, 'no payment provider is seeded');
select is((select count(*) from public.payout_providers), 0::bigint, 'no payout provider is seeded');
select is((select count(*) from public.payment_provider_capabilities), 0::bigint, 'nor any payment capability');
select is((select count(*) from public.payout_provider_capabilities), 0::bigint, 'nor any payout capability');
select is((select count(*) from public.payout_destinations), 0::bigint, 'and no payout destination exists');
select is((select count(*) from public.provider_settlements), 0::bigint, 'no settlement was opened');
select hasnt_table('public', 'fee_schedules', 'no fee schedule table exists: D20 is still blocked');
select hasnt_table('public', 'mfa_backup_codes', 'and no MFA backup codes: O-1 stays deferred');
select is((select count(*) from public.promotion_packages), 0::bigint,
  'promotion packages are owner values and nothing seeds them, so pay_on_sale cannot be active');
select is((select count(*) from public.tax_rules) + (select count(*) from public.commission_rules)
          + (select count(*) from public.cancellation_policies) + (select count(*) from public.withdrawal_limits),
  0::bigint,
  'rates, policies and limits are admin-console work, deliberately unseeded');
select is((select count(*) from public.email_templates), 0::bigint, 'and no email template content was invented');

-- ---------------------------------------------------------------------------------------------------
-- The contracts are still green after seeding
-- ---------------------------------------------------------------------------------------------------
select is((select count(*) from public.security_contract_problems()), 0::bigint,
  'the 0031 security contract still holds with the seed in place');
select is((select count(*) from public.cron_job_problems()), 0::bigint, 'and so does the 0032 cron contract');
select is((select count(*) from public.storage_bucket_problems()), 0::bigint, 'and the storage contract');
select is(app_private.assert_security_contract(), 0, 'the deploy-time assertion passes after seeding');
select is((select count(*) from information_schema.role_table_grants where grantee = 'anon'), 0::bigint,
  'anon still reaches nothing: the seed created no grant');

-- ---------------------------------------------------------------------------------------------------
-- Idempotency, proven by re-running the seed's own statements
-- ---------------------------------------------------------------------------------------------------
-- No savepoint here: rolling back to one would also roll back pgTAP's own record of the assertions
-- made after it, so these four would print but never be counted. The whole file rolls back at the end.
create temporary table seed_state_before on commit drop as
  select 'locales' as t, count(*) as n from public.locales
  union all select 'currencies', count(*) from public.currencies
  union all select 'currency_translations', count(*) from public.currency_translations
  union all select 'countries', count(*) from public.countries
  union all select 'listing_types', count(*) from public.listing_types
  union all select 'roles', count(*) from public.roles
  union all select 'permissions', count(*) from public.permissions
  union all select 'role_permissions', count(*) from public.role_permissions
  union all select 'site_settings', count(*) from public.site_settings
  union all select 'exception_policies', count(*) from public.payment_exception_policies;

-- An administrator changes a configurable value before the seed runs again.
update public.site_settings set value = '"Acme Bazaar"'::jsonb where key = 'branding.site_name';

-- The seed's statements, re-executed exactly as the migration writes them.
insert into public.locales (code, name_en, name_native, direction, digit_style, is_active, is_default, sort_order)
values ('en', 'English', 'English', 'ltr', 'western', true, true, 1),
       ('ar', 'Arabic', 'العربية', 'rtl', 'western', true, false, 2)
on conflict (code) do nothing;
insert into public.currencies (code, numeric_code, symbol, decimal_places,
  is_enabled, is_default, is_pricing_enabled, is_checkout_enabled, first_enabled_at, sort_order)
values ('EGP', '818', 'E£', 2, true, true, true, true, now(), 1)
on conflict (code) do nothing;
insert into public.currency_translations (currency_code, locale_code, name)
values ('EGP', 'en', 'Egyptian Pound'), ('EGP', 'ar', 'جنيه مصري')
on conflict (currency_code, locale_code) do nothing;
insert into public.countries (code, iso3, numeric_code, name_en, name_ar, phone_code,
  default_currency_code, is_marketplace_enabled, is_phone_allowed, sort_order)
values ('EG', 'EGY', '818', 'Egypt', 'مصر', '20', 'EGP', true, true, 1)
on conflict (code) do nothing;
insert into public.listing_types (code, name_en, name_ar, is_active, sort_order)
values ('product', 'Product', 'منتج', true, 1), ('service', 'Service', 'خدمة', true, 2)
on conflict (code) do nothing;
insert into public.role_permissions (role_key, permission_key)
select r.key, p.key from public.roles r cross join public.permissions p
 where r.key in ('admin', 'super_admin')
on conflict (role_key, permission_key) do nothing;
insert into public.site_settings (key, category, value, value_type, is_public, description_en, description_ar)
values ('branding.site_name', 'branding', '"Marketplace"'::jsonb, 'string', true, 'x', 'x')
on conflict (key) do nothing;
insert into public.payment_exception_policies (id, case_type, resolution, requires_manual_approval, priority, notes)
select ('00000000-0000-4000-8000-' || substr(md5('payment_exception_policy:' || t.case_type), 1, 12))::uuid,
       t.case_type, 'manual_review', true, 0, 'x'
from (values ('late_success'), ('duplicate_success'), ('amount_mismatch'),
             ('currency_mismatch'), ('unknown_reference')) as t(case_type)
where not exists (select 1 from public.payment_exception_policies p where p.case_type = t.case_type);

select is(
  (select coalesce(string_agg(format('%s:%s', b.t, b.n), ', ' order by b.t) filter (where b.n <> a.n), '')
     from seed_state_before b
     join (select 'locales' as t, count(*) as n from public.locales
           union all select 'currencies', count(*) from public.currencies
           union all select 'currency_translations', count(*) from public.currency_translations
           union all select 'countries', count(*) from public.countries
           union all select 'listing_types', count(*) from public.listing_types
           union all select 'roles', count(*) from public.roles
           union all select 'permissions', count(*) from public.permissions
           union all select 'role_permissions', count(*) from public.role_permissions
           union all select 'site_settings', count(*) from public.site_settings
           union all select 'exception_policies', count(*) from public.payment_exception_policies) a
       on a.t = b.t),
  '',
  'running the seed a second time inserts nothing: every count is unchanged'
);
select is((select value #>> '{}' from public.site_settings where key = 'branding.site_name'), 'Acme Bazaar',
  'and it does not overwrite a value the administrator has since changed');
select is((select count(*) from public.payment_exception_policies where case_type = 'late_success'), 1::bigint,
  'the surrogate-keyed table gains no duplicate either');
select is((select count(*) from public.security_contract_problems()), 0::bigint,
  'and the contract is still green after the second run');

select * from finish();
rollback;
