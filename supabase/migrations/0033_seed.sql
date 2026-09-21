-- 0033 — Seed: the canonical Phase 2 reference data (v5.2 "Seed (0033)"; D5, D6, D15, D19, D22, D23, D25, C20).
--
-- The specification defines this migration in one paragraph, and it is followed literally:
--
--   > Seed (0033): all currencies inserted, only EGP enabled as default, pricing and checkout currency
--   > (payable only once a provider is active); Egypt enabled with EGP; other countries disabled; roles
--   > and permissions; neutral branding values; admin settings for approved D-items. No payment
--   > providers, payout providers, capabilities, fee schedules or demo listings.
--
-- **Reference data only.** There is not a single user, seller, buyer, order, payment, payout, ledger
-- entry, review, dispute, ticket, listing, page or post in this file. No password, OTP, token, API key
-- or provider secret is created, and no staff account is made through SQL — an account is a person, and
-- a person arrives through the authentication flow, never through a migration.
--
-- **Idempotency.** Every statement is an `insert ... on conflict do nothing` keyed on the row's natural
-- key — the currency code, the country code, the locale code, the listing-type code, the role key, the
-- permission key, the (role, permission) pair, the setting key — or, where a table has only a surrogate
-- key, an `insert ... select ... where not exists` on the natural key. Running the migration a second
-- time inserts nothing and updates nothing. That last part is deliberate: the seed never overwrites a
-- value an administrator has since changed. `site_settings`, `currencies.is_enabled`, a country's
-- `is_marketplace_enabled` and every exception policy are configuration, and configuration belongs to
-- whoever is running the marketplace once it exists.
--
-- **Immutable baseline versus configurable value.** The immutable part of this seed is identity: which
-- codes exist and what they are called — `EGP`, `EG`, `en`, `ar`, `product`, `service`, the role keys and
-- the permission keys. The configurable part is everything with a flag or a number in it: which currency
-- is enabled, which country is open for business, how long a guest cart lives, how an exception is
-- resolved. The first group is what the rest of the schema references by key; the second is what the
-- admin console exists to change.
--
-- **Permissions are derived, not invented.** The 82 rows below are exactly the keys that migrations 0001
-- to 0032 enforce through `public.has_permission()` — every key the schema actually checks, and no key
-- it does not. A permission that nothing enforces would be a promise the database cannot keep.
--
-- **What the specification does not define is not invented here.** Four things are deliberately absent,
-- and each is reported rather than guessed:
--
--   1. **The other 177 ISO 4217 currencies.** The specification asks for all currencies, but neither it
--      nor the repository supplies their numeric codes, minor units or symbols: `policy/iso4217-currencies.json`
--      carries alphabetic codes alone, and `currencies.numeric_code`, `decimal_places` and `symbol` are
--      all `not null`. `decimal_places` drives every money calculation in the system, so a wrong value
--      is a financial defect rather than a cosmetic one. They are left unseeded pending an authoritative
--      ISO 4217 data file; adding them later is one deterministic insert, and every one of them would be
--      disabled anyway.
--   2. **The other countries.** `countries.name_ar` is `not null`, and D7 forbids machine translation.
--      The specification names Egypt and no other country, so Egypt is seeded and the rest await their
--      canonical Arabic names. "Other countries disabled" holds trivially: none is enabled.
--   3. **Baseline taxonomy, tax rules, commission rules, cancellation policies, withdrawal limits,
--      promotion packages, email templates and CMS content.** The specification defines no baseline
--      values for any of them, and 0025 says in so many words that promotion prices and durations are
--      owner values that nothing seeds. They are admin-console work, not seed data.
--   4. **The C18 retention settings.** C18 is deferred to before production and Phase 2 "needs
--      configurable fields only", so seeding a retention period would be choosing the deferred value.
--
-- Nothing here enables settlement posting, seeds a payment or payout provider, a provider capability, a
-- credential, a fee schedule or an adapter, activates `pay_on_sale`, creates MFA backup codes (O-1), or
-- opens any decision marked blocked or deferred. No grant, policy, function or trigger is created, so
-- the 0031 security contract and the 0032 cron contract are untouched by construction.

-- ---------------------------------------------------------------------------------------------------
-- Locales — English primary, Arabic secondary (D6). Digits are Western by default and configurable
-- per language for display only (D15).
-- ---------------------------------------------------------------------------------------------------
insert into public.locales (code, name_en, name_native, direction, digit_style, is_active, is_default, sort_order)
values
  ('en', 'English', 'English', 'ltr', 'western', true, true, 1),
  ('ar', 'Arabic', 'العربية', 'rtl', 'western', true, false, 2)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------------------------------
-- Currencies — EGP is the V1 currency; the multi-currency architecture around it is untouched.
-- Enabled, default, priceable and checkout-able. "Payable only once a provider is active" is not a
-- currency flag: it is B1-A, and `payment_providers` stays empty.
-- ---------------------------------------------------------------------------------------------------
insert into public.currencies (
  code, numeric_code, symbol, decimal_places,
  is_enabled, is_default, is_pricing_enabled, is_checkout_enabled, first_enabled_at, sort_order)
values ('EGP', '818', 'E£', 2, true, true, true, true, now(), 1)
on conflict (code) do nothing;

insert into public.currency_translations (currency_code, locale_code, name)
values
  ('EGP', 'en', 'Egyptian Pound'),
  ('EGP', 'ar', 'جنيه مصري')
on conflict (currency_code, locale_code) do nothing;

-- ---------------------------------------------------------------------------------------------------
-- Countries — Egypt, enabled, with EGP.
-- ---------------------------------------------------------------------------------------------------
insert into public.countries (
  code, iso3, numeric_code, name_en, name_ar, phone_code,
  default_currency_code, is_marketplace_enabled, is_phone_allowed, sort_order)
values ('EG', 'EGY', '818', 'Egypt', 'مصر', '20', 'EGP', true, true, 1)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------------------------------
-- Listing types — products and services in V1.
-- ---------------------------------------------------------------------------------------------------
insert into public.listing_types (code, name_en, name_ar, is_active, sort_order)
values
  ('product', 'Product', 'منتج', true, 1),
  ('service', 'Service', 'خدمة', true, 2)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------------------------------
-- Roles — the approved authorization matrix, transcribed.
--
-- `guest` is the unauthenticated visitor. It is recorded because the matrix names it, and it is
-- `is_assignable = false` because no user row can ever hold it: a guest is the absence of a role, and
-- what a guest may read is decided by row level security, not by a permission.
-- TOTP is mandatory for every admin-console role and optional for buyers and sellers, which is what
-- `requires_mfa` records; the CHECK in 0003 already refuses a console role without it.
-- ---------------------------------------------------------------------------------------------------
insert into public.roles (key, name_en, name_ar, description_en, description_ar,
                          requires_mfa, is_admin_console, is_assignable, sort_order)
values
  ('guest', 'Guest', 'زائر',
   'An unauthenticated visitor: public reads and a guest cart.',
   'زائر غير مسجل: تصفح عام وسلة زائر.', false, false, false, 1),
  ('buyer', 'Buyer', 'مشترٍ',
   'Own account, orders, messages, offers, reviews and support.',
   'الحساب الشخصي والطلبات والرسائل والعروض والتقييمات والدعم.', false, false, true, 2),
  ('seller', 'Seller', 'بائع',
   'Own listings, services, orders, messages and earnings view.',
   'القوائم والخدمات والطلبات والرسائل وعرض الأرباح.', false, false, true, 3),
  ('moderator', 'Moderator', 'مشرف',
   'All moderation actions. The role is inactive until TOTP is enrolled.',
   'جميع إجراءات الإشراف. الدور غير مفعّل حتى تسجيل التحقق بخطوتين.', true, true, true, 4),
  ('support_agent', 'Support Agent', 'موظف دعم',
   'Assigned tickets and account-recovery review. The role is inactive until TOTP is enrolled.',
   'التذاكر المسندة ومراجعة استرداد الحساب. الدور غير مفعّل حتى تسجيل التحقق بخطوتين.', true, true, true, 5),
  ('admin', 'Admin', 'مسؤول',
   'All admin operations, each one per permission.',
   'جميع عمليات الإدارة، كل منها بحسب الصلاحية.', true, true, true, 6),
  ('super_admin', 'Super Admin', 'مسؤول أعلى',
   'All operations, including recovery of privileged accounts.',
   'جميع العمليات، بما في ذلك استرداد الحسابات المميزة.', true, true, true, 7)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------------------------------
-- Permissions — exactly the keys migrations 0001 to 0032 enforce, and nothing else.
-- ---------------------------------------------------------------------------------------------------
insert into public.permissions (key, module, description_en, description_ar) values
  ('analytics.listing.read', 'analytics', 'Read listings in analytics', 'عرض القوائم في التحليلات'),
  ('audit.read', 'audit', 'Read the audit log', 'عرض سجل التدقيق'),
  ('catalog.attribute.manage', 'catalog', 'Manage attributes in the catalogue', 'إدارة الخصائص في الكتالوج'),
  ('catalog.category.manage', 'catalog', 'Manage categories in the catalogue', 'إدارة الفئات في الكتالوج'),
  ('catalog.category.read', 'catalog', 'Read categories in the catalogue', 'عرض الفئات في الكتالوج'),
  ('catalog.listing.moderate', 'catalog', 'Moderate listings in the catalogue', 'الإشراف على القوائم في الكتالوج'),
  ('catalog.listing.read', 'catalog', 'Read listings in the catalogue', 'عرض القوائم في الكتالوج'),
  ('catalog.tag.manage', 'catalog', 'Manage tags in the catalogue', 'إدارة الوسوم في الكتالوج'),
  ('cms.banner.manage', 'cms', 'Manage banners in site content', 'إدارة اللافتات في محتوى الموقع'),
  ('cms.banner.read', 'cms', 'Read banners in site content', 'عرض اللافتات في محتوى الموقع'),
  ('cms.blog.manage', 'cms', 'Manage blog posts in site content', 'إدارة مقالات المدونة في محتوى الموقع'),
  ('cms.blog.read', 'cms', 'Read blog posts in site content', 'عرض مقالات المدونة في محتوى الموقع'),
  ('cms.faq.manage', 'cms', 'Manage FAQs in site content', 'إدارة الأسئلة الشائعة في محتوى الموقع'),
  ('cms.faq.read', 'cms', 'Read FAQs in site content', 'عرض الأسئلة الشائعة في محتوى الموقع'),
  ('cms.homepage.manage', 'cms', 'Manage homepage sections in site content', 'إدارة أقسام الصفحة الرئيسية في محتوى الموقع'),
  ('cms.homepage.read', 'cms', 'Read homepage sections in site content', 'عرض أقسام الصفحة الرئيسية في محتوى الموقع'),
  ('cms.media.manage', 'cms', 'Manage media in site content', 'إدارة الوسائط في محتوى الموقع'),
  ('cms.navigation.manage', 'cms', 'Manage navigation menus in site content', 'إدارة قوائم التنقل في محتوى الموقع'),
  ('cms.navigation.read', 'cms', 'Read navigation menus in site content', 'عرض قوائم التنقل في محتوى الموقع'),
  ('cms.page.manage', 'cms', 'Manage pages in site content', 'إدارة الصفحات في محتوى الموقع'),
  ('cms.page.read', 'cms', 'Read pages in site content', 'عرض الصفحات في محتوى الموقع'),
  ('disputes.dispute.manage', 'disputes', 'Manage disputes in disputes', 'إدارة النزاعات في النزاعات'),
  ('disputes.dispute.read', 'disputes', 'Read disputes in disputes', 'عرض النزاعات في النزاعات'),
  ('finance.balance.read', 'finance', 'Read seller balances in finance', 'عرض أرصدة البائعين في الشؤون المالية'),
  ('finance.commission.read', 'finance', 'Read commissions in finance', 'عرض العمولات في الشؤون المالية'),
  ('finance.ledger.read', 'finance', 'Read the ledger in finance', 'عرض دفتر الأستاذ في الشؤون المالية'),
  ('finance.withdrawal.read', 'finance', 'Read withdrawals in finance', 'عرض طلبات السحب في الشؤون المالية'),
  ('marketing.coupon.manage', 'marketing', 'Manage coupons in marketing', 'إدارة الكوبونات في التسويق'),
  ('marketing.coupon.read', 'marketing', 'Read coupons in marketing', 'عرض الكوبونات في التسويق'),
  ('marketing.promotion.manage', 'marketing', 'Manage promotions in marketing', 'إدارة العروض الترويجية في التسويق'),
  ('marketing.promotion.read', 'marketing', 'Read promotions in marketing', 'عرض العروض الترويجية في التسويق'),
  ('moderation.action.read', 'moderation', 'Read moderation actions in moderation', 'عرض إجراءات الإشراف في الإشراف'),
  ('moderation.report.manage', 'moderation', 'Manage reports in moderation', 'إدارة البلاغات في الإشراف'),
  ('moderation.report.read', 'moderation', 'Read reports in moderation', 'عرض البلاغات في الإشراف'),
  ('orders.cancellation.manage', 'orders', 'Manage cancellations in orders', 'إدارة عمليات الإلغاء في الطلبات'),
  ('orders.checkout.read', 'orders', 'Read checkouts in orders', 'عرض عمليات الدفع في الطلبات'),
  ('orders.order.manage', 'orders', 'Manage orders in orders', 'إدارة الطلبات في الطلبات'),
  ('orders.order.read', 'orders', 'Read orders in orders', 'عرض الطلبات في الطلبات'),
  ('payments.dispute.manage', 'payments', 'Manage disputes in payments', 'إدارة النزاعات في المدفوعات'),
  ('payments.dispute.read', 'payments', 'Read disputes in payments', 'عرض النزاعات في المدفوعات'),
  ('payments.exception.manage', 'payments', 'Manage payment exception cases in payments', 'إدارة حالات استثناءات الدفع في المدفوعات'),
  ('payments.exception.read', 'payments', 'Read payment exception cases in payments', 'عرض حالات استثناءات الدفع في المدفوعات'),
  ('payments.payment.read', 'payments', 'Read payments in payments', 'عرض المدفوعات في المدفوعات'),
  ('payments.provider.manage', 'payments', 'Manage providers in payments', 'إدارة مزودي الخدمة في المدفوعات'),
  ('payments.refund.manage', 'payments', 'Manage refunds in payments', 'إدارة المبالغ المستردة في المدفوعات'),
  ('payments.refund.read', 'payments', 'Read refunds in payments', 'عرض المبالغ المستردة في المدفوعات'),
  ('payments.settlement.manage', 'payments', 'Manage provider settlements in payments', 'إدارة تسويات المزود في المدفوعات'),
  ('payments.settlement.read', 'payments', 'Read provider settlements in payments', 'عرض تسويات المزود في المدفوعات'),
  ('payouts.destination.read', 'payouts', 'Read payout destinations in payouts', 'عرض وجهات التحويل في التحويلات'),
  ('payouts.payout.read', 'payouts', 'Read payouts in payouts', 'عرض التحويلات في التحويلات'),
  ('payouts.provider.manage', 'payouts', 'Manage providers in payouts', 'إدارة مزودي الخدمة في التحويلات'),
  ('payouts.reversal.manage', 'payouts', 'Manage payout reversals in payouts', 'إدارة عكس التحويلات في التحويلات'),
  ('platform.job.read', 'platform', 'Read job runs in the platform', 'عرض تشغيل المهام في المنصة'),
  ('reviews.review.moderate', 'reviews', 'Moderate reviews in reviews', 'الإشراف على التقييمات في التقييمات'),
  ('reviews.review.read', 'reviews', 'Read reviews in reviews', 'عرض التقييمات في التقييمات'),
  ('security.recovery.review', 'security', 'Review account recovery requests in security', 'مراجعة طلبات استرداد الحساب في الأمان'),
  ('sellers.profile.manage', 'sellers', 'Manage profiles in sellers', 'إدارة الملفات الشخصية في البائعين'),
  ('sellers.profile.read', 'sellers', 'Read profiles in sellers', 'عرض الملفات الشخصية في البائعين'),
  ('sellers.verification.review', 'sellers', 'Review seller verifications in sellers', 'مراجعة توثيق البائعين في البائعين'),
  ('seo.metadata.manage', 'seo', 'Manage SEO metadata in SEO', 'إدارة بيانات تحسين محركات البحث في تحسين محركات البحث'),
  ('seo.metadata.read', 'seo', 'Read SEO metadata in SEO', 'عرض بيانات تحسين محركات البحث في تحسين محركات البحث'),
  ('seo.redirect.manage', 'seo', 'Manage redirects in SEO', 'إدارة عمليات إعادة التوجيه في تحسين محركات البحث'),
  ('seo.redirect.read', 'seo', 'Read redirects in SEO', 'عرض عمليات إعادة التوجيه في تحسين محركات البحث'),
  ('seo.settings.manage', 'seo', 'Manage SEO settings in SEO', 'إدارة إعدادات تحسين محركات البحث في تحسين محركات البحث'),
  ('settings.cancellation.manage', 'settings', 'Manage cancellations in settings', 'إدارة عمليات الإلغاء في الإعدادات'),
  ('settings.commission.manage', 'settings', 'Manage commissions in settings', 'إدارة العمولات في الإعدادات'),
  ('settings.country.manage', 'settings', 'Manage countries in settings', 'إدارة الدول في الإعدادات'),
  ('settings.currency.manage', 'settings', 'Manage currencies in settings', 'إدارة العملات في الإعدادات'),
  ('settings.email_template.manage', 'settings', 'Manage email templates in settings', 'إدارة قوالب البريد في الإعدادات'),
  ('settings.email_template.read', 'settings', 'Read email templates in settings', 'عرض قوالب البريد في الإعدادات'),
  ('settings.listing_type.manage', 'settings', 'Manage listing types in settings', 'إدارة أنواع القوائم في الإعدادات'),
  ('settings.locale.manage', 'settings', 'Manage locales in settings', 'إدارة اللغات في الإعدادات'),
  ('settings.site.manage', 'settings', 'Manage site settings in settings', 'إدارة إعدادات الموقع في الإعدادات'),
  ('settings.site.read', 'settings', 'Read site settings in settings', 'عرض إعدادات الموقع في الإعدادات'),
  ('settings.tax.manage', 'settings', 'Manage tax rules in settings', 'إدارة قواعد الضرائب في الإعدادات'),
  ('settings.withdrawal.manage', 'settings', 'Manage withdrawals in settings', 'إدارة طلبات السحب في الإعدادات'),
  ('support.ticket.manage', 'support', 'Manage support tickets in support', 'إدارة تذاكر الدعم في الدعم'),
  ('support.ticket.read', 'support', 'Read support tickets in support', 'عرض تذاكر الدعم في الدعم'),
  ('users.profile.read', 'users', 'Read profiles in users', 'عرض الملفات الشخصية في المستخدمين'),
  ('users.role.manage', 'users', 'Manage roles in users', 'إدارة الأدوار في المستخدمين'),
  ('users.role.read', 'users', 'Read roles in users', 'عرض الأدوار في المستخدمين'),
  ('users.security.read', 'users', 'Read security events in users', 'عرض أحداث الأمان في المستخدمين')

on conflict (key) do nothing;

-- ---------------------------------------------------------------------------------------------------
-- Role → permission mapping
--
-- The matrix is explicit for four of the seven roles, and those four are seeded from it directly:
-- `guest`, `buyer` and `seller` hold nothing privileged, and `super_admin` holds "all operations".
-- `admin` is "all admin operations per permission", which is every key it may be granted, so it too
-- receives the full set; what separates the two is the recovery matrix, where a privileged account can
-- only be recovered by a Super Admin — a rule 0028 already enforces structurally rather than through a
-- permission key.
--
-- `moderator` and `support_agent` are seeded from the owner's authorization of 2026-09-20, which closed
-- the one decision this seed was waiting on. Every key is named explicitly rather than pattern-matched,
-- so the grant is visible in the file and correctable in one place.
-- ---------------------------------------------------------------------------------------------------
insert into public.role_permissions (role_key, permission_key)
select r.key, p.key from public.roles r cross join public.permissions p
 where r.key in ('admin', 'super_admin')
on conflict (role_key, permission_key) do nothing;

-- Moderator — owner authorization, 2026-09-20. "All moderation actions" covers reports, moderation
-- actions, listing moderation and review moderation, and stops there: **Disputes are a separate
-- responsibility and are deliberately not granted**, so `disputes.dispute.read` and
-- `disputes.dispute.manage` are absent by decision, not by oversight. TOTP and `aal2` still apply —
-- every policy below ANDs `is_aal2()`, so the permission alone opens nothing at `aal1`.
insert into public.role_permissions (role_key, permission_key)
select 'moderator', k from unnest(array[
  'moderation.report.read',
  'moderation.report.manage',
  'moderation.action.read',
  'catalog.listing.read',
  'catalog.listing.moderate',
  'reviews.review.read',
  'reviews.review.moderate',
  'users.profile.read',
  'sellers.profile.read'
]) as k
on conflict (role_key, permission_key) do nothing;

-- Support Agent — owner authorization, 2026-09-20. Tickets, recovery review, and the two reads a ticket
-- needs to be worked. `users.security.read` and `sellers.profile.read` are deliberately withheld.
--
-- Ticket visibility is not broadened by this grant: 0028's policies already scope an agent to
-- `assigned_to = current_user_id() or assigned_to is null` — assigned or queued — and that scope is
-- ANDed with the permission and `is_aal2()`, not replaced by it.
--
-- `security.recovery.review` is read-only by construction. It appears in exactly three policies, all
-- `for select`, on `account_recovery_requests`, `account_recovery_evidence` and
-- `account_recovery_approvals`. It confers no INSERT, UPDATE or DELETE anywhere. The recovery actions
-- live in `app_private` SECURITY DEFINER functions that `authenticated` cannot execute at all, and each
-- enforces its own rule structurally: nobody reviews, approves or completes their own recovery, and
-- `decide_recovery_request()` refuses an approver who is the reviewer. Granting this key therefore gives
-- a Support Agent sight of a recovery request at `aal2` and nothing else; approval, the reviewer/approver
-- separation and the Super-Admin reservation for privileged accounts are untouched.
insert into public.role_permissions (role_key, permission_key)
select 'support_agent', k from unnest(array[
  'support.ticket.read',
  'support.ticket.manage',
  'security.recovery.review',
  'users.profile.read',
  'orders.order.read'
]) as k
on conflict (role_key, permission_key) do nothing;

-- ---------------------------------------------------------------------------------------------------
-- Site settings
--
-- Neutral development branding (D5: never hard-coded, and no real brand or domain in a migration), the
-- display timezone (C20) and the window settings the schema already reads. Each window is seeded with
-- the value the approved migration itself falls back to, so making the value visible in the admin
-- console changes no behaviour: 48 hours for an offer (D25), 30 days for a guest cart (D22), 72 hours
-- for a buyer to respond to a delivered service (D23).
--
-- `finance.seller_hold_days`, `finance.settlement_posting_enabled` and `security.recovery_hold_hours`
-- are already seeded by 0021, 0023 and 0028 and are deliberately not touched here.
-- ---------------------------------------------------------------------------------------------------
insert into public.site_settings (key, category, value, value_type, is_public, description_en, description_ar)
values
  ('branding.site_name', 'branding', '"Marketplace"'::jsonb, 'string', true,
   'Display name of the marketplace. A neutral development value; the owner sets the real one.',
   'الاسم المعروض للسوق. قيمة تطويرية محايدة يغيّرها المالك.'),
  ('branding.site_domain', 'branding', '"localhost"'::jsonb, 'string', true,
   'Public domain of the marketplace. A neutral development value; the owner sets the real one.',
   'النطاق العام للسوق. قيمة تطويرية محايدة يغيّرها المالك.'),
  ('platform.display_timezone', 'platform', '"Africa/Cairo"'::jsonb, 'string', true,
   'Timezone used for display. Everything is stored and computed in UTC (C20).',
   'المنطقة الزمنية المستخدمة للعرض. كل شيء يُخزَّن ويُحسب بتوقيت UTC (C20).'),
  ('offers.default_expiry_hours', 'marketplace', '48'::jsonb, 'number', false,
   'How long an offer stays open when the buyer does not set a window (D25).',
   'مدة بقاء العرض مفتوحًا عندما لا يحدد المشتري مهلة (D25).'),
  ('carts.guest_expiry_days', 'marketplace', '30'::jsonb, 'number', false,
   'How long a guest cart survives before it expires (D22).',
   'مدة بقاء سلة الزائر قبل انتهاء صلاحيتها (D22).'),
  ('orders.service_buyer_response_hours', 'marketplace', '72'::jsonb, 'number', false,
   'How long a buyer has to respond to a delivered service order before it completes itself (D23).',
   'المهلة المتاحة للمشتري للرد على طلب خدمة مُسلَّم قبل اكتماله تلقائيًا (D23).')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------------------------------
-- Payment exception policies
--
-- One policy per case type the schema recognises. Every one resolves to `manual_review` and requires
-- manual approval: D19 says no refund is ever automatic, B1-A is still open so no provider capability
-- is known, and a fail-closed default is the only one that can be stated without inventing a rule the
-- specification does not give. The owner narrows these in the admin console once a provider exists.
--
-- The table has a surrogate key, so identity comes from the case type and the insert is guarded on it.
-- Deterministic ids keep the row stable across environments, because a case row references its policy.
-- ---------------------------------------------------------------------------------------------------
insert into public.payment_exception_policies (id, case_type, resolution, requires_manual_approval, priority, notes)
select
  ('00000000-0000-4000-8000-' || substr(md5('payment_exception_policy:' || t.case_type), 1, 12))::uuid,
  t.case_type, 'manual_review', true, 0,
  'Fail-closed Phase 2 default: a human decides until a provider is active (B1-A) and D19 is satisfied.'
from (values ('late_success'), ('duplicate_success'), ('amount_mismatch'),
             ('currency_mismatch'), ('unknown_reference')) as t(case_type)
where not exists (
  select 1 from public.payment_exception_policies p where p.case_type = t.case_type
);
