-- 0088 — The catalogue vocabulary and the seller's answers.
--
-- What is proven here, in order: the two permission predicates apply 0003's `requires_mfa` rule and ignore a
-- revoked assignment; the vocabulary readers return nothing without their key and every writer refuses with
-- 42501; the key and the data type of a definition cannot be changed, nor an option's value, nor a tag's slug;
-- a select attribute cannot be shown with no option and a non-select cannot be given one; attaching is governed
-- by the **category** key rather than the attribute key, which is what the table's own RLS says; and then the
-- seller half — 0011's trigger still decides every type rule, options must belong to their attribute and be
-- active, an unknown tag voids the whole selection, editing is draft-only, and an **unanswered required
-- attribute changes nothing about submission**, because this increment does not touch the submit writer.
--
-- The last section proves the point of the whole increment: an answered attribute and a chosen tag come back
-- through the **existing** public readers of 0046, untouched.
--
-- Deterministic: fixed uuids, explicit states, and every assertion inside a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(233);

-- ---------------------------------------------------------------------------------------------------
-- Shape
-- ---------------------------------------------------------------------------------------------------
select has_function('app_private', 'attribute_can_manage', array['uuid', 'boolean'], 'the attribute predicate exists');
select has_function('app_private', 'tag_can_manage', array['uuid', 'boolean'], 'the tag predicate exists');
select has_function('app_private', 'attribute_definitions_for_staff', array['uuid', 'boolean'], 'the definitions reader exists');
select has_function('app_private', 'attribute_options_for_staff', array['uuid', 'boolean', 'uuid'], 'the options reader exists');
select has_function('app_private', 'tags_for_staff', array['uuid', 'boolean'], 'the tags reader exists');
select has_function('app_private', 'category_attributes_for_staff', array['uuid', 'boolean', 'uuid'], 'the attachment reader exists');
select has_function('app_private', 'seller_listing_vocabulary_context', array['uuid', 'text', 'text'],
  'the seller context reader exists');
select has_function('app_private', 'seller_listing_attributes', array['uuid', 'text', 'text', 'text'], 'the seller attribute reader exists');
select has_function('app_private', 'seller_listing_attribute_options', array['uuid', 'text', 'text', 'text'], 'the seller option reader exists');
select has_function('app_private', 'seller_listing_attributes_save', array['uuid', 'text', 'text', 'jsonb'], 'the seller answer writer exists');
select has_function('app_private', 'seller_listing_tags_save', array['uuid', 'text', 'text', 'text[]'], 'the seller tag writer exists');
select has_function('app_private', 'seller_listing_tag_choices', array['uuid', 'text', 'text', 'text'], 'the seller tag reader exists');

select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and (p.proname like 'attribute%' or p.proname like 'tag%' or p.proname like 'category_attribute%'
           or p.proname like 'seller_listing_attribute%' or p.proname like 'seller_listing_tag%'
           or p.proname like 'seller_listing_vocabulary%')
      and p.prosecdef),
  24, 'all twenty-four are security definer');

select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and (p.proname like 'attribute%' or p.proname like 'tag%' or p.proname like 'category_attribute%'
           or p.proname like 'seller_listing_attribute%' or p.proname like 'seller_listing_tag%'
           or p.proname like 'seller_listing_vocabulary%')
      and p.proconfig @> array['search_path=pg_catalog, public']),
  24, 'all twenty-four pin search_path to pg_catalog, public');

-- The immutable values are immutable in the signature, not only in a comment.
select ok(
  pg_get_function_arguments(p.oid) !~ '\mp_key\M' and pg_get_function_arguments(p.oid) !~ '\mp_data_type\M',
  'the definition update takes neither a key nor a data type')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and p.proname = 'attribute_definition_update_for_staff';

select ok(
  pg_get_function_arguments(p.oid) !~ '\mp_value\M',
  'the option update takes no value')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and p.proname = 'attribute_option_update_for_staff';

select ok(
  pg_get_function_arguments(p.oid) !~ '\mp_slug\M',
  'the tag update takes no slug')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and p.proname = 'tag_update_for_staff';

-- The whole point of the advisory decision: the approved submit writers are not touched, and nothing here calls
-- them or mentions a required attribute.
select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and (p.proname like 'seller_listing_attribute%' or p.proname like 'seller_listing_tag%')
      and pg_get_functiondef(p.oid) ~* 'seller_listing_submit|seller_service_submit'),
  0, 'no function here calls a submit writer');

-- The readers report `is_required` — that is how the seller's form knows to mark a field. The **writers** must
-- not read it at all, which is precisely what advisory means here.
select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and p.proname in ('seller_listing_attributes_save', 'seller_listing_tags_save')
      and pg_get_functiondef(p.oid) ~* 'is_required'),
  0, 'and neither seller writer reads is_required, which is what advisory means');

select ok(
  pg_get_functiondef(p.oid) ~* 'is_required',
  'while the reader does report it, so the form can mark the field')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and p.proname = 'seller_listing_attributes';

-- Nothing here duplicates 0011's validation.
select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'seller_listing_attributes_save'
      and pg_get_functiondef(p.oid) ~* 'expects text|expects a number|expects a boolean|single option'),
  0, 'the answer writer restates none of the trigger''s type rules');

-- The attribution channel stays closed (8-B).
select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and (p.proname like 'attribute%' or p.proname like 'tag%' or p.proname like 'category_attribute%'
           or p.proname like 'seller_listing_attribute%' or p.proname like 'seller_listing_tag%'
           or p.proname like 'seller_listing_vocabulary%')
      and pg_get_functiondef(p.oid) like '%app.audit_actor_id%'),
  0, 'no function here names the audit attribution channel');

-- ---------------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------------
select ok(
  has_function_privilege('app_system', p.oid, 'execute'),
  format('app_system may execute %s', p.proname))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private'
   and (p.proname like 'attribute%' or p.proname like 'tag%' or p.proname like 'category_attribute%'
        or p.proname like 'seller_listing_attribute%' or p.proname like 'seller_listing_tag%'
        or p.proname like 'seller_listing_vocabulary%');

select ok(
  not has_function_privilege('app_worker', p.oid, 'execute'),
  format('app_worker may not execute %s', p.proname))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private'
   and (p.proname like 'attribute%' or p.proname like 'tag%' or p.proname like 'category_attribute%'
        or p.proname like 'seller_listing_attribute%' or p.proname like 'seller_listing_tag%'
        or p.proname like 'seller_listing_vocabulary%');

select ok(
  not has_function_privilege('public', p.oid, 'execute'),
  format('public may not execute %s', p.proname))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private'
   and (p.proname like 'attribute%' or p.proname like 'tag%' or p.proname like 'category_attribute%'
        or p.proname like 'seller_listing_attribute%' or p.proname like 'seller_listing_tag%'
        or p.proname like 'seller_listing_vocabulary%');

-- ---------------------------------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('a0000000-0000-4000-8000-0000000000d1', 'vocab-manager@test.invalid'),
  ('a0000000-0000-4000-8000-0000000000d2', 'tag-manager@test.invalid'),
  ('a0000000-0000-4000-8000-0000000000d3', 'outsider@test.invalid'),
  ('b0000000-0000-4000-8000-0000000000d4', 'seller@test.invalid'),
  ('b0000000-0000-4000-8000-0000000000d5', 'other-seller@test.invalid');

-- One role per key, so the two vocabulary keys are proved to be genuinely separate.
insert into public.roles (key, name_en, name_ar, requires_mfa, is_admin_console, is_assignable, sort_order) values
  ('vocab_only', 'Vocabulary', 'المفردات', true, true, true, 91),
  ('tags_only', 'Tags', 'الوسوم', true, true, true, 92);
insert into public.role_permissions (role_key, permission_key) values
  ('vocab_only', 'catalog.attribute.manage'),
  ('tags_only', 'catalog.tag.manage');

insert into public.user_roles (user_id, role_key) values
  ('a0000000-0000-4000-8000-0000000000d1', 'vocab_only'),
  ('a0000000-0000-4000-8000-0000000000d2', 'tags_only');

insert into public.seller_profiles
  (user_id, slug, display_name, legal_name, contact_email, contact_phone_e164, country_code,
   status, verification_status, verified_at)
values
  ('b0000000-0000-4000-8000-0000000000d4', 'the-shop', 'The Shop', 'The Shop LLC',
   'shop@test.invalid', '+201000000021', 'EG', 'active', 'verified', now() - interval '5 days'),
  ('b0000000-0000-4000-8000-0000000000d5', 'other-shop', 'Other Shop', 'Other Shop LLC',
   'other@test.invalid', '+201000000022', 'EG', 'active', 'verified', now() - interval '5 days');

insert into public.categories (id, parent_id, slug, listing_type_code, is_active, sort_order) values
  ('c1000000-0000-4000-8000-0000000000d1', null, 'furniture', 'product', true, 1);
insert into public.category_translations (category_id, locale_code, name) values
  ('c1000000-0000-4000-8000-0000000000d1', 'en', 'Furniture'),
  ('c1000000-0000-4000-8000-0000000000d1', 'ar', 'أثاث');

insert into public.listings
  (id, seller_user_id, listing_type_code, category_id, slug, title, description, content_language,
   currency_code, price_minor, is_negotiable, status, country_code, city)
values
  ('11110000-0000-4000-8000-0000000000d1', 'b0000000-0000-4000-8000-0000000000d4', 'product',
   'c1000000-0000-4000-8000-0000000000d1', 'oak-table', 'An oak table',
   'A description long enough to satisfy the length rule.', 'en', 'EGP', 250000, false, 'draft', 'EG', 'Cairo'),
  ('11110000-0000-4000-8000-0000000000d2', 'b0000000-0000-4000-8000-0000000000d4', 'product',
   'c1000000-0000-4000-8000-0000000000d1', 'sold-desk', 'A sold desk',
   'A description long enough to satisfy the length rule.', 'en', 'EGP', 100000, false, 'draft', 'EG', 'Cairo');

-- ---------------------------------------------------------------------------------------------------
-- The permission predicates
-- ---------------------------------------------------------------------------------------------------
select ok(app_private.attribute_can_manage('a0000000-0000-4000-8000-0000000000d1', true),
  'the vocabulary manager may manage attributes at aal2');
select ok(not app_private.attribute_can_manage('a0000000-0000-4000-8000-0000000000d1', false),
  'and nothing at aal1, because the role requires MFA');
select ok(not app_private.attribute_can_manage('a0000000-0000-4000-8000-0000000000d1', null),
  'a null assurance level is not aal2');
select ok(not app_private.tag_can_manage('a0000000-0000-4000-8000-0000000000d1', true),
  'the vocabulary key does not grant the tag key');
select ok(app_private.tag_can_manage('a0000000-0000-4000-8000-0000000000d2', true),
  'the tag manager may manage tags');
select ok(not app_private.attribute_can_manage('a0000000-0000-4000-8000-0000000000d2', true),
  'and the tag key does not grant the vocabulary key');
select ok(not app_private.attribute_can_manage('a0000000-0000-4000-8000-0000000000d3', true),
  'somebody with no role holds neither');
select ok(not app_private.tag_can_manage('a0000000-0000-4000-8000-0000000000d3', true),
  'neither one');

update public.user_roles set revoked_at = now()
 where user_id = 'a0000000-0000-4000-8000-0000000000d1';
select ok(not app_private.attribute_can_manage('a0000000-0000-4000-8000-0000000000d1', true),
  'a revoked role grants nothing');
update public.user_roles set revoked_at = null
 where user_id = 'a0000000-0000-4000-8000-0000000000d1';

-- ---------------------------------------------------------------------------------------------------
-- Attribute definitions
-- ---------------------------------------------------------------------------------------------------
create temporary table defs as
select
  app_private.attribute_definition_create_for_staff(
    'a0000000-0000-4000-8000-0000000000d1', true, 'width', 'number', 'Width', 'العرض', 'cm', true, 1) as width,
  app_private.attribute_definition_create_for_staff(
    'a0000000-0000-4000-8000-0000000000d1', true, 'assembled', 'boolean', 'Assembled', 'مُجمَّع', null, true, 2) as assembled,
  app_private.attribute_definition_create_for_staff(
    'a0000000-0000-4000-8000-0000000000d1', true, 'material', 'single_select', 'Material', 'الخامة', null, true, 3) as material,
  app_private.attribute_definition_create_for_staff(
    'a0000000-0000-4000-8000-0000000000d1', true, 'features', 'multi_select', 'Features', 'الميزات', null, true, 4) as features,
  app_private.attribute_definition_create_for_staff(
    'a0000000-0000-4000-8000-0000000000d1', true, 'note', 'text', 'Note', 'ملاحظة', null, false, 5) as note;

select ok((select width from defs) is not null, 'a definition is created');

select ok(
  not (select d.is_active from public.attribute_definitions d where d.id = (select width from defs)),
  'a new definition is inactive, whatever anybody asked for');

select is(
  (select d.unit from public.attribute_definitions d where d.id = (select width from defs)),
  'cm', 'the unit is stored');

select is(
  (select d.unit from public.attribute_definitions d where d.id = (select assembled from defs)),
  null, 'and a blank unit becomes null');

select throws_ok(
  $$select app_private.attribute_definition_create_for_staff('a0000000-0000-4000-8000-0000000000d2', true, 'denied', 'text', 'D', 'د')$$,
  '42501', null, 'the tag manager cannot create an attribute');

select throws_ok(
  $$select app_private.attribute_definition_create_for_staff('a0000000-0000-4000-8000-0000000000d3', true, 'denied', 'text', 'D', 'د')$$,
  '42501', null, 'nor an outsider');

select throws_ok(
  $$select app_private.attribute_definition_create_for_staff('a0000000-0000-4000-8000-0000000000d1', false, 'denied', 'text', 'D', 'د')$$,
  '42501', null, 'nor the manager at aal1');

-- 0010's constraints still decide.
select throws_ok(
  $$select app_private.attribute_definition_create_for_staff('a0000000-0000-4000-8000-0000000000d1', true, 'width', 'text', 'W', 'ع')$$,
  '23505', null, 'a duplicate key is refused by the unique index');

select throws_ok(
  $$select app_private.attribute_definition_create_for_staff('a0000000-0000-4000-8000-0000000000d1', true, 'Width', 'text', 'W', 'ع')$$,
  '23514', null, 'a key that is not key-shaped is refused by the check constraint');

select throws_ok(
  $$select app_private.attribute_definition_create_for_staff('a0000000-0000-4000-8000-0000000000d1', true, 'colour', 'colour', 'C', 'ل')$$,
  '23514', null, 'a data type outside the five is refused');

-- The update changes what it may and nothing else.
select ok(
  app_private.attribute_definition_update_for_staff(
    'a0000000-0000-4000-8000-0000000000d1', true, (select width from defs), 'Width (cm)', 'العرض بالسنتيمتر', 'mm', false, 9),
  'the labels, unit, filterability and ordering change');

select is(
  (select d.name_en from public.attribute_definitions d where d.id = (select width from defs)),
  'Width (cm)', 'the English label is stored');

select is(
  (select d.key from public.attribute_definitions d where d.id = (select width from defs)),
  'width', 'and the key is unchanged, because it is not a parameter');

select is(
  (select d.data_type from public.attribute_definitions d where d.id = (select width from defs)),
  'number', 'as is the data type');

select ok(
  not (select d.is_filterable from public.attribute_definitions d where d.id = (select width from defs)),
  'filterability is stored — and nothing in this increment filters');

select ok(
  not app_private.attribute_definition_update_for_staff(
    'a0000000-0000-4000-8000-0000000000d1', true, 'f0000000-0000-4000-8000-00000000ffff', 'X', 'س', null, true, 1),
  'updating a definition that does not exist is false, not an error');

-- ---------------------------------------------------------------------------------------------------
-- Options, and the select-only rule
-- ---------------------------------------------------------------------------------------------------
select throws_ok(
  format($$select app_private.attribute_option_create_for_staff('a0000000-0000-4000-8000-0000000000d1', true, %L, 'oak', 'Oak', 'بلوط')$$,
    (select width from defs)),
  '23001', null, 'a number attribute cannot be given an option');

select throws_ok(
  format($$select app_private.attribute_option_create_for_staff('a0000000-0000-4000-8000-0000000000d1', true, %L, 'yes', 'Yes', 'نعم')$$,
    (select assembled from defs)),
  '23001', null, 'nor a boolean one');

create temporary table opts as
select
  app_private.attribute_option_create_for_staff(
    'a0000000-0000-4000-8000-0000000000d1', true, (select material from defs), 'oak', 'Oak', 'بلوط', 1) as oak,
  app_private.attribute_option_create_for_staff(
    'a0000000-0000-4000-8000-0000000000d1', true, (select material from defs), 'pine', 'Pine', 'صنوبر', 2) as pine,
  app_private.attribute_option_create_for_staff(
    'a0000000-0000-4000-8000-0000000000d1', true, (select features from defs), 'folding', 'Folding', 'قابل للطي', 1) as folding,
  app_private.attribute_option_create_for_staff(
    'a0000000-0000-4000-8000-0000000000d1', true, (select features from defs), 'extendable', 'Extendable', 'قابل للتمديد', 2) as extendable;

select ok((select oak from opts) is not null, 'a select attribute takes options');

select throws_ok(
  format($$select app_private.attribute_option_create_for_staff('a0000000-0000-4000-8000-0000000000d1', true, %L, 'oak', 'Oak again', 'بلوط')$$,
    (select material from defs)),
  '23505', null, 'a duplicate value within one attribute is refused');

select lives_ok(
  format($$select app_private.attribute_option_create_for_staff('a0000000-0000-4000-8000-0000000000d1', true, %L, 'oak', 'Oak', 'بلوط')$$,
    (select features from defs)),
  'but the same value under a different attribute is fine');

select throws_ok(
  format($$select app_private.attribute_option_create_for_staff('a0000000-0000-4000-8000-0000000000d2', true, %L, 'teak', 'Teak', 'تيك')$$,
    (select material from defs)),
  '42501', null, 'the tag manager cannot add an option');

select ok(
  app_private.attribute_option_update_for_staff(
    'a0000000-0000-4000-8000-0000000000d1', true, (select oak from opts), 'Solid oak', 'بلوط صلب', 5),
  'an option''s labels and ordering change');

select is(
  (select o.value from public.attribute_options o where o.id = (select oak from opts)),
  'oak', 'and its value does not, because it is not a parameter');

-- Showing a select attribute with no option would put an unanswerable field on a form.
select throws_ok(
  format($$select app_private.attribute_definition_state_for_staff('a0000000-0000-4000-8000-0000000000d1', true, %L, true)$$,
    (select app_private.attribute_definition_create_for_staff(
       'a0000000-0000-4000-8000-0000000000d1', true, 'empty_select', 'multi_select', 'Empty', 'فارغ'))),
  '23001', null, 'a select attribute with no option cannot be shown');

select ok(
  app_private.attribute_definition_state_for_staff('a0000000-0000-4000-8000-0000000000d1', true, (select width from defs), true),
  'a number attribute can be shown with no options at all');

select ok(
  app_private.attribute_definition_state_for_staff('a0000000-0000-4000-8000-0000000000d1', true, (select material from defs), true),
  'and a select attribute once it has one');

select ok(
  app_private.attribute_definition_state_for_staff('a0000000-0000-4000-8000-0000000000d1', true, (select features from defs), true),
  'the multi-select is shown too');
select ok(
  app_private.attribute_definition_state_for_staff('a0000000-0000-4000-8000-0000000000d1', true, (select assembled from defs), true),
  'and the boolean');
select ok(
  app_private.attribute_definition_state_for_staff('a0000000-0000-4000-8000-0000000000d1', true, (select note from defs), true),
  'and the text one');

select ok(
  not app_private.attribute_definition_state_for_staff(
    'a0000000-0000-4000-8000-0000000000d1', true, 'f0000000-0000-4000-8000-00000000ffff', true),
  'changing the state of a definition that does not exist is false');

select throws_ok(
  format($$select app_private.attribute_definition_state_for_staff('a0000000-0000-4000-8000-0000000000d3', true, %L, false)$$,
    (select width from defs)),
  '42501', null, 'an outsider cannot hide an attribute');

-- ---------------------------------------------------------------------------------------------------
-- Tags
-- ---------------------------------------------------------------------------------------------------
create temporary table tagids as
select
  app_private.tag_create_for_staff('a0000000-0000-4000-8000-0000000000d2', true, 'handmade', 'Handmade', 'صناعة يدوية') as handmade,
  app_private.tag_create_for_staff('a0000000-0000-4000-8000-0000000000d2', true, 'vintage', 'Vintage', 'عتيق') as vintage,
  app_private.tag_create_for_staff('a0000000-0000-4000-8000-0000000000d2', true, 'retired', 'Retired', 'متقاعد') as retired;

select ok((select handmade from tagids) is not null, 'a tag is created');

select ok(
  (select t.is_active from public.tags t where t.id = (select handmade from tagids)),
  'and it is active, because there is nothing to fill in first');

select is(
  (select t.usage_count from public.tags t where t.id = (select handmade from tagids)),
  0, 'with no usage yet');

select throws_ok(
  $$select app_private.tag_create_for_staff('a0000000-0000-4000-8000-0000000000d1', true, 'denied', 'D', 'د')$$,
  '42501', null, 'the vocabulary manager cannot create a tag');

select throws_ok(
  $$select app_private.tag_create_for_staff('a0000000-0000-4000-8000-0000000000d2', true, 'handmade', 'Again', 'مرة')$$,
  '23505', null, 'a duplicate slug is refused');

select ok(
  app_private.tag_update_for_staff('a0000000-0000-4000-8000-0000000000d2', true, (select handmade from tagids), 'Hand made', 'يدوي'),
  'a tag''s names change');

select is(
  (select t.slug from public.tags t where t.id = (select handmade from tagids)),
  'handmade', 'and its slug does not');

select ok(
  app_private.tag_state_for_staff('a0000000-0000-4000-8000-0000000000d2', true, (select retired from tagids), false),
  'a tag can be hidden');

select ok(
  not app_private.tag_state_for_staff('a0000000-0000-4000-8000-0000000000d2', true, 'f0000000-0000-4000-8000-00000000ffff', false),
  'hiding a tag that does not exist is false');

-- ---------------------------------------------------------------------------------------------------
-- Attaching to a category
-- ---------------------------------------------------------------------------------------------------
-- Governed by the category key, which is what `category_attributes`' own RLS policy names.
select throws_ok(
  format($$select app_private.category_attribute_attach_for_staff('a0000000-0000-4000-8000-0000000000d1', true, %L, %L)$$,
    'c1000000-0000-4000-8000-0000000000d1', (select width from defs)),
  '42501', null, 'the attribute key does not let somebody attach an attribute to a category');

insert into public.user_roles (user_id, role_key) values ('a0000000-0000-4000-8000-0000000000d1', 'admin');

select ok(
  app_private.category_attribute_attach_for_staff(
    'a0000000-0000-4000-8000-0000000000d1', true, 'c1000000-0000-4000-8000-0000000000d1', (select width from defs), true, true, 1),
  'the category key does');

select ok(
  app_private.category_attribute_attach_for_staff(
    'a0000000-0000-4000-8000-0000000000d1', true, 'c1000000-0000-4000-8000-0000000000d1', (select material from defs), false, true, 2),
  'a second attribute is attached');
select ok(
  app_private.category_attribute_attach_for_staff(
    'a0000000-0000-4000-8000-0000000000d1', true, 'c1000000-0000-4000-8000-0000000000d1', (select features from defs), false, true, 3),
  'and a third');
select ok(
  app_private.category_attribute_attach_for_staff(
    'a0000000-0000-4000-8000-0000000000d1', true, 'c1000000-0000-4000-8000-0000000000d1', (select assembled from defs), false, true, 4),
  'and a fourth');
select ok(
  app_private.category_attribute_attach_for_staff(
    'a0000000-0000-4000-8000-0000000000d1', true, 'c1000000-0000-4000-8000-0000000000d1', (select note from defs), false, false, 5),
  'and a fifth, optional and unfilterable');

select is(
  (select is_required from app_private.category_attributes_for_staff(
     'a0000000-0000-4000-8000-0000000000d1', true, 'c1000000-0000-4000-8000-0000000000d1') where key = 'width'),
  true, 'the required flag is stored and read back');

-- Re-attaching updates rather than failing.
select ok(
  app_private.category_attribute_attach_for_staff(
    'a0000000-0000-4000-8000-0000000000d1', true, 'c1000000-0000-4000-8000-0000000000d1', (select width from defs), false, false, 7),
  'attaching something already attached updates how it is asked');

select is(
  (select is_required from app_private.category_attributes_for_staff(
     'a0000000-0000-4000-8000-0000000000d1', true, 'c1000000-0000-4000-8000-0000000000d1') where key = 'width'),
  false, 'the flag is updated');

select is(
  (select sort_order from app_private.category_attributes_for_staff(
     'a0000000-0000-4000-8000-0000000000d1', true, 'c1000000-0000-4000-8000-0000000000d1') where key = 'width'),
  7, 'and so is the order it is asked in');

-- Put it back as required, which the seller section relies on.
select ok(
  app_private.category_attribute_attach_for_staff(
    'a0000000-0000-4000-8000-0000000000d1', true, 'c1000000-0000-4000-8000-0000000000d1', (select width from defs), true, true, 1),
  'and back to required');

select throws_ok(
  format($$select app_private.category_attribute_attach_for_staff('a0000000-0000-4000-8000-0000000000d1', true, %L, %L)$$,
    'f0000000-0000-4000-8000-00000000ffff', (select width from defs)),
  '23503', null, 'a category that does not exist is refused by the foreign key');

select is(
  (select count(*)::int from app_private.category_attributes_for_staff(
     'a0000000-0000-4000-8000-0000000000d1', true, 'c1000000-0000-4000-8000-0000000000d1')),
  5, 'the category asks five questions');

select is_empty(
  format($$select * from app_private.category_attributes_for_staff('a0000000-0000-4000-8000-0000000000d3', true, %L)$$,
    'c1000000-0000-4000-8000-0000000000d1'),
  'and somebody without the category read key sees none of them');

-- ---------------------------------------------------------------------------------------------------
-- The vocabulary readers
-- ---------------------------------------------------------------------------------------------------
select ok(
  (select count(*) from app_private.attribute_definitions_for_staff('a0000000-0000-4000-8000-0000000000d1', true)) >= 5,
  'the vocabulary manager sees the definitions');

select is_empty(
  $$select * from app_private.attribute_definitions_for_staff('a0000000-0000-4000-8000-0000000000d2', true)$$,
  'the tag manager sees none of them');

select is_empty(
  $$select * from app_private.attribute_definitions_for_staff('a0000000-0000-4000-8000-0000000000d1', false)$$,
  'and neither does the vocabulary manager at aal1');

select is(
  (select option_count from app_private.attribute_definitions_for_staff('a0000000-0000-4000-8000-0000000000d1', true)
    where key = 'material'),
  2, 'the option count is reported');

select is(
  (select category_count from app_private.attribute_definitions_for_staff('a0000000-0000-4000-8000-0000000000d1', true)
    where key = 'width'),
  1, 'and how many categories ask for it');

select is(
  (select count(*)::int from app_private.attribute_options_for_staff(
     'a0000000-0000-4000-8000-0000000000d1', true, (select material from defs))),
  2, 'the options reader returns them');

select is_empty(
  format($$select * from app_private.attribute_options_for_staff('a0000000-0000-4000-8000-0000000000d3', true, %L)$$,
    (select material from defs)),
  'and nothing without the key');

select is(
  (select count(*)::int from app_private.tags_for_staff('a0000000-0000-4000-8000-0000000000d2', true)),
  3, 'the tags reader returns every tag, including the hidden');

select is_empty(
  $$select * from app_private.tags_for_staff('a0000000-0000-4000-8000-0000000000d3', true)$$,
  'and nothing without the tag key');

-- ---------------------------------------------------------------------------------------------------
-- Whether a listing is there at all, and whether its vocabulary may be edited
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.seller_listing_vocabulary_context(
     'b0000000-0000-4000-8000-0000000000d4', 'oak-table', 'product')),
  'found', 'the seller''s own draft is found');

select is(
  (select is_editable from app_private.seller_listing_vocabulary_context(
     'b0000000-0000-4000-8000-0000000000d4', 'oak-table', 'product')),
  true, 'and is editable');

select is(
  (select outcome from app_private.seller_listing_vocabulary_context(
     'b0000000-0000-4000-8000-0000000000d5', 'oak-table', 'product')),
  'not_found', 'another seller is told it is not there, not that it is not theirs');

select is(
  (select outcome from app_private.seller_listing_vocabulary_context(
     'b0000000-0000-4000-8000-0000000000d4', 'oak-table', 'service')),
  'not_found', 'and the services surface is told the same about a product');

select is(
  (select outcome from app_private.seller_listing_vocabulary_context(
     'b0000000-0000-4000-8000-0000000000d4', 'no-such-listing', 'product')),
  'not_found', 'as is a slug that names nothing');

select is(
  (select outcome from app_private.seller_listing_vocabulary_context(
     null, 'oak-table', 'product')),
  'not_found', 'and nobody at all');

-- ---------------------------------------------------------------------------------------------------
-- What a seller is asked
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::int from app_private.seller_listing_attributes(
     'b0000000-0000-4000-8000-0000000000d4', 'oak-table', 'product', 'en')),
  5, 'the seller is asked the five questions their category asks');

select is(
  (select label from app_private.seller_listing_attributes(
     'b0000000-0000-4000-8000-0000000000d4', 'oak-table', 'product', 'en') where key = 'width'),
  'Width (cm)', 'labelled in the requested locale');

select is(
  (select label from app_private.seller_listing_attributes(
     'b0000000-0000-4000-8000-0000000000d4', 'oak-table', 'product', 'ar') where key = 'width'),
  'العرض بالسنتيمتر', 'and in Arabic when Arabic is asked for');

select is(
  (select is_required from app_private.seller_listing_attributes(
     'b0000000-0000-4000-8000-0000000000d4', 'oak-table', 'product', 'en') where key = 'width'),
  true, 'and told which are required');

select is_empty(
  $$select * from app_private.seller_listing_attributes('b0000000-0000-4000-8000-0000000000d5', 'oak-table', 'product', 'en')$$,
  'another seller is asked nothing about it at all');

select is_empty(
  $$select * from app_private.seller_listing_attributes('b0000000-0000-4000-8000-0000000000d4', 'oak-table', 'service', 'en')$$,
  'and the services surface answers nothing about a product');

select is(
  (select count(*)::int from app_private.seller_listing_attribute_options(
     'b0000000-0000-4000-8000-0000000000d4', 'oak-table', 'product', 'en')),
  5, 'the options a seller may choose from are the active ones of the select attributes');

-- ---------------------------------------------------------------------------------------------------
-- Answering
-- ---------------------------------------------------------------------------------------------------
select is(
  (select outcome from app_private.seller_listing_attributes_save(
     'b0000000-0000-4000-8000-0000000000d4', 'oak-table', 'product',
     '[{"key":"width","number":180},{"key":"assembled","boolean":true},
       {"key":"material","options":["oak"]},{"key":"features","options":["folding","extendable"]}]'::jsonb)),
  'saved', 'a seller answers every kind of attribute');

select is(
  (select v.value_number from public.listing_attribute_values v
    where v.listing_id = '11110000-0000-4000-8000-0000000000d1' and v.attribute_definition_id = (select width from defs)),
  180::numeric, 'the number is stored');

select is(
  (select v.value_boolean from public.listing_attribute_values v
    where v.listing_id = '11110000-0000-4000-8000-0000000000d1' and v.attribute_definition_id = (select assembled from defs)),
  true, 'the boolean is stored');

select is(
  (select cardinality(v.option_ids) from public.listing_attribute_values v
    where v.listing_id = '11110000-0000-4000-8000-0000000000d1' and v.attribute_definition_id = (select features from defs)),
  2, 'and both chosen options of the multi-select');

-- 0011's trigger, still deciding.
select is(
  (select outcome from app_private.seller_listing_attributes_save(
     'b0000000-0000-4000-8000-0000000000d4', 'oak-table', 'product',
     '[{"key":"width","text":"about 180"}]'::jsonb)),
  'invalid', 'a number attribute answered with text is refused');

select is(
  (select outcome from app_private.seller_listing_attributes_save(
     'b0000000-0000-4000-8000-0000000000d4', 'oak-table', 'product',
     '[{"key":"material","options":["oak","pine"]}]'::jsonb)),
  'invalid', 'a single-select answered with two options is refused');

select is(
  (select outcome from app_private.seller_listing_attributes_save(
     'b0000000-0000-4000-8000-0000000000d4', 'oak-table', 'product',
     '[{"key":"material","options":["folding"]}]'::jsonb)),
  'invalid', 'an option belonging to another attribute is refused');

select is(
  (select outcome from app_private.seller_listing_attributes_save(
     'b0000000-0000-4000-8000-0000000000d4', 'oak-table', 'product',
     '[{"key":"material","options":["mahogany"]}]'::jsonb)),
  'invalid', 'an option that does not exist is refused');

select is(
  (select outcome from app_private.seller_listing_attributes_save(
     'b0000000-0000-4000-8000-0000000000d4', 'oak-table', 'product',
     '[{"key":"note","text":"A note"}]'::jsonb)),
  'saved', 'a text attribute the category asks for is accepted');

-- The replace semantics: what is left out is cleared.
select is(
  (select count(*)::int from public.listing_attribute_values v
    where v.listing_id = '11110000-0000-4000-8000-0000000000d1'),
  1, 'answers left out of a save are removed, which is how a seller clears one');

select is(
  (select outcome from app_private.seller_listing_attributes_save(
     'b0000000-0000-4000-8000-0000000000d4', 'oak-table', 'product', '[]'::jsonb)),
  'saved', 'an empty set is a valid save');

select is(
  (select count(*)::int from public.listing_attribute_values v
    where v.listing_id = '11110000-0000-4000-8000-0000000000d1'),
  0, 'and clears every answer');

-- An attribute the category does not ask for.
select is(
  (select outcome from app_private.seller_listing_attributes_save(
     'b0000000-0000-4000-8000-0000000000d4', 'oak-table', 'product',
     '[{"key":"empty_select","options":[]}]'::jsonb)),
  'invalid', 'an attribute this category does not ask for is refused');

select is(
  (select outcome from app_private.seller_listing_attributes_save(
     'b0000000-0000-4000-8000-0000000000d4', 'oak-table', 'product', '{"key":"width"}'::jsonb)),
  'invalid', 'a payload that is not an array is refused');

-- Ownership and surface.
select is(
  (select outcome from app_private.seller_listing_attributes_save(
     'b0000000-0000-4000-8000-0000000000d5', 'oak-table', 'product', '[]'::jsonb)),
  'not_found', 'another seller cannot answer for somebody else''s listing');

select is(
  (select outcome from app_private.seller_listing_attributes_save(
     'b0000000-0000-4000-8000-0000000000d4', 'oak-table', 'service', '[]'::jsonb)),
  'not_found', 'and the services surface refuses a product');

select is(
  (select outcome from app_private.seller_listing_attributes_save(
     null, 'oak-table', 'product', '[]'::jsonb)),
  'not_found', 'and nobody at all gets nothing');

-- 0061's draft-only rule, read from the same column.
update public.listings set status = 'active', approved_at = now()
 where id = '11110000-0000-4000-8000-0000000000d2';

select is(
  (select outcome from app_private.seller_listing_attributes_save(
     'b0000000-0000-4000-8000-0000000000d4', 'sold-desk', 'product', '[]'::jsonb)),
  'not_editable', 'a listing that is no longer a draft cannot have its answers changed');

-- A suspended seller edits nothing, which is 0061's rule too.
update public.seller_profiles set status = 'suspended', suspended_at = now()
 where user_id = 'b0000000-0000-4000-8000-0000000000d5';
select is(
  (select outcome from app_private.seller_listing_attributes_save(
     'b0000000-0000-4000-8000-0000000000d5', 'oak-table', 'product', '[]'::jsonb)),
  'not_editable', 'a suspended seller edits nothing');
update public.seller_profiles set status = 'active', suspended_at = null
 where user_id = 'b0000000-0000-4000-8000-0000000000d5';

-- ---------------------------------------------------------------------------------------------------
-- `is_required` is advisory — the point of this section
-- ---------------------------------------------------------------------------------------------------
-- `width` is attached as required and is deliberately left unanswered.
select is(
  (select outcome from app_private.seller_listing_attributes_save(
     'b0000000-0000-4000-8000-0000000000d4', 'oak-table', 'product',
     '[{"key":"note","text":"Only the optional one"}]'::jsonb)),
  'saved', 'leaving a required attribute unanswered still saves');

select is(
  (select count(*)::int from public.listing_attribute_values v
    where v.listing_id = '11110000-0000-4000-8000-0000000000d1'
      and v.attribute_definition_id = (select width from defs)),
  0, 'the required attribute has no answer');

-- And submission is unaffected, because this increment does not touch the submit writer.
select is(
  (select outcome from app_private.seller_listing_submit('b0000000-0000-4000-8000-0000000000d4', 'oak-table')),
  'submitted', 'and the listing submits anyway: is_required is advisory in this increment');

select is(
  (select l.status from public.listings l where l.id = '11110000-0000-4000-8000-0000000000d1'),
  'pending_review', 'the submission went through, unchanged by anything here');

-- ---------------------------------------------------------------------------------------------------
-- Tags on a listing
-- ---------------------------------------------------------------------------------------------------
-- A fresh draft, because the one above has been submitted.
insert into public.listings
  (id, seller_user_id, listing_type_code, category_id, slug, title, description, content_language,
   currency_code, price_minor, is_negotiable, status, country_code, city)
values
  ('11110000-0000-4000-8000-0000000000d3', 'b0000000-0000-4000-8000-0000000000d4', 'product',
   'c1000000-0000-4000-8000-0000000000d1', 'pine-chair', 'A pine chair',
   'A description long enough to satisfy the length rule.', 'en', 'EGP', 50000, false, 'draft', 'EG', 'Cairo');

select is(
  (select outcome from app_private.seller_listing_tags_save(
     'b0000000-0000-4000-8000-0000000000d4', 'pine-chair', 'product', array['handmade', 'vintage'])),
  'saved', 'a seller chooses two tags');

select is(
  (select count(*)::int from public.listing_tags lt where lt.listing_id = '11110000-0000-4000-8000-0000000000d3'),
  2, 'both are stored');

select is(
  (select t.usage_count from public.tags t where t.id = (select handmade from tagids)),
  1, 'and 0010''s trigger counted the usage without anything here touching it');

select is(
  (select outcome from app_private.seller_listing_tags_save(
     'b0000000-0000-4000-8000-0000000000d4', 'pine-chair', 'product', array['handmade'])),
  'saved', 'the selection is replaced');

select is(
  (select count(*)::int from public.listing_tags lt where lt.listing_id = '11110000-0000-4000-8000-0000000000d3'),
  1, 'leaving one');

select is(
  (select t.usage_count from public.tags t where t.id = (select vintage from tagids)),
  0, 'and the count came back down');

select is(
  (select outcome from app_private.seller_listing_tags_save(
     'b0000000-0000-4000-8000-0000000000d4', 'pine-chair', 'product', array['handmade', 'retired'])),
  'invalid', 'a hidden tag cannot be chosen, and voids the whole selection');

select is(
  (select outcome from app_private.seller_listing_tags_save(
     'b0000000-0000-4000-8000-0000000000d4', 'pine-chair', 'product', array['handmade', 'nonexistent'])),
  'invalid', 'nor can one that does not exist');

select is(
  (select count(*)::int from public.listing_tags lt where lt.listing_id = '11110000-0000-4000-8000-0000000000d3'),
  1, 'and a refused selection changed nothing');

select is(
  (select outcome from app_private.seller_listing_tags_save(
     'b0000000-0000-4000-8000-0000000000d4', 'pine-chair', 'product', array[]::text[])),
  'saved', 'clearing every tag is a valid save');

select is(
  (select count(*)::int from public.listing_tags lt where lt.listing_id = '11110000-0000-4000-8000-0000000000d3'),
  0, 'and removes them');

select is(
  (select outcome from app_private.seller_listing_tags_save(
     'b0000000-0000-4000-8000-0000000000d5', 'pine-chair', 'product', array['handmade'])),
  'not_found', 'another seller cannot tag somebody else''s listing');

select is(
  (select outcome from app_private.seller_listing_tags_save(
     'b0000000-0000-4000-8000-0000000000d4', 'sold-desk', 'product', array['handmade'])),
  'not_editable', 'and a listing that is not a draft cannot be retagged');

select is(
  (select count(*)::int from app_private.seller_listing_tag_choices(
     'b0000000-0000-4000-8000-0000000000d4', 'pine-chair', 'product', 'en')),
  2, 'the tag choices are the active tags only');

select is_empty(
  $$select * from app_private.seller_listing_tag_choices('b0000000-0000-4000-8000-0000000000d5', 'pine-chair', 'product', 'en')$$,
  'and another seller is offered none, learning nothing about the listing');

-- ---------------------------------------------------------------------------------------------------
-- It reaches the public readers that were already there
-- ---------------------------------------------------------------------------------------------------
-- The point of the whole increment: 0046's readers and the pages above them are untouched, and this is what
-- they now return.
select ok(
  app_private.seller_listing_tags_save(
    'b0000000-0000-4000-8000-0000000000d4', 'pine-chair', 'product', array['handmade']) is not null,
  'the chair is tagged again');

select is(
  (select outcome from app_private.seller_listing_attributes_save(
     'b0000000-0000-4000-8000-0000000000d4', 'pine-chair', 'product',
     '[{"key":"width","number":45},{"key":"material","options":["pine"]}]'::jsonb)),
  'saved', 'and answered');

-- Make it publicly visible the way the catalogue does.
update public.listings set status = 'active', approved_at = now()
 where id = '11110000-0000-4000-8000-0000000000d3';

-- The readers return 0047's jsonb projection, which is what the detail contract carries.
select is(
  jsonb_array_length(app_private.public_listing_attributes('11110000-0000-4000-8000-0000000000d3', 'en')),
  2, 'the existing public reader returns both answered attributes');

select is(
  (select a ->> 'text' from jsonb_array_elements(
     app_private.public_listing_attributes('11110000-0000-4000-8000-0000000000d3', 'en')) a
    where a ->> 'key' = 'width'),
  '45', 'with the value the seller gave, formatted by the reader that was already there');

select is(
  (select a -> 'options' from jsonb_array_elements(
     app_private.public_listing_attributes('11110000-0000-4000-8000-0000000000d3', 'en')) a
    where a ->> 'key' = 'material'),
  '["Pine"]'::jsonb, 'and the chosen option as its label, which is what the page renders');

select is(
  jsonb_array_length(app_private.public_listing_tags('11110000-0000-4000-8000-0000000000d3', 'en')),
  1, 'and the existing tag reader returns the chosen tag');

select is(
  (select t ->> 'name' from jsonb_array_elements(
     app_private.public_listing_tags('11110000-0000-4000-8000-0000000000d3', 'en')) t),
  'Hand made', 'under the name an administrator gave it');

-- Hiding a definition takes the answer off the public page without rewriting it.
select ok(
  app_private.attribute_definition_state_for_staff('a0000000-0000-4000-8000-0000000000d1', true, (select width from defs), false),
  'the width attribute is hidden');

select is(
  jsonb_array_length(app_private.public_listing_attributes('11110000-0000-4000-8000-0000000000d3', 'en')),
  1, 'the public page stops showing it');

select is(
  (select count(*)::int from public.listing_attribute_values v
    where v.listing_id = '11110000-0000-4000-8000-0000000000d3'),
  2, 'while the answer itself is untouched, so showing it again restores it');

-- Hiding a tag does the same.
select ok(
  app_private.tag_state_for_staff('a0000000-0000-4000-8000-0000000000d2', true, (select handmade from tagids), false),
  'the tag is hidden');

select is(
  jsonb_array_length(app_private.public_listing_tags('11110000-0000-4000-8000-0000000000d3', 'en')),
  0, 'and the public page stops showing it');

select is(
  (select count(*)::int from public.listing_tags lt where lt.listing_id = '11110000-0000-4000-8000-0000000000d3'),
  1, 'while the listing keeps it');

-- ---------------------------------------------------------------------------------------------------
-- Nothing financial is touched
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and (p.proname like 'attribute%' or p.proname like 'tag%' or p.proname like 'category_attribute%'
           or p.proname like 'seller_listing_attribute%' or p.proname like 'seller_listing_tag%'
           or p.proname like 'seller_listing_vocabulary%')
      and pg_get_functiondef(p.oid) ~* 'settle_payout|transition_withdrawal|reconcile_settlement|ledger_entries|commission_rules|tax_rules|coupons|promotion'),
  0, 'no function here names a financial function or table');

-- And nothing here writes a listing's status, which is why 6-F's own rule about that is untouched: every
-- function in this increment reads the status and the seller's state, and assigns neither.
select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and (p.proname like 'seller_listing_attribute%' or p.proname like 'seller_listing_tag%'
           or p.proname like 'seller_listing_vocabulary%')
      and pg_get_functiondef(p.oid) ~* 'update public\.listings[^;]*\mstatus\M'),
  0, 'no function here assigns a listing status');

select * from finish();
rollback;
