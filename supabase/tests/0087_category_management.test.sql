-- 0087 — Managing the category tree: the named readers and writers.
--
-- What is proven here, in order: the two permission predicates apply 0003's `requires_mfa` rule and ignore a
-- revoked or expired role assignment; the staff readers return nothing at all to a caller without the read key;
-- every writer refuses a caller without the manage key with 42501; 0010's tree rules still decide the shape of
-- the tree — the three-level limit, the self-parent and cycle guards, the unique slug, and the refusal to
-- re-depth a category that has children — and are not restated anywhere; the slug cannot be changed; a category
-- cannot be shown before it is named, nor stripped of its last locale while shown; and **deactivation reaches
-- every public surface**, which is asserted against the public tree reader, the public landing reader and the
-- sitemap reader rather than against a copy of their rule.
--
-- Deterministic: fixed uuids, explicit states, and every assertion inside a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(151);

-- ---------------------------------------------------------------------------------------------------
-- Shape
-- ---------------------------------------------------------------------------------------------------
-- The `category_attribute_*` functions of 8-C share this prefix and belong to that increment's own
-- inventory, so the shape and privilege assertions below name this migration's ten and exclude them.
select has_function('app_private', 'category_can_read', array['uuid', 'boolean'], 'the read predicate exists');
select has_function('app_private', 'category_can_manage', array['uuid', 'boolean'], 'the manage predicate exists');
select has_function('app_private', 'categories_for_staff', array['uuid', 'boolean'], 'the staff tree exists');
select has_function('app_private', 'category_for_staff', array['uuid', 'boolean', 'uuid'], 'the staff detail exists');
select has_function('app_private', 'category_translations_for_staff', array['uuid', 'boolean', 'uuid'],
  'the staff translation reader exists');
select has_function('app_private', 'category_create_for_staff',
  array['uuid', 'boolean', 'text', 'uuid', 'text', 'integer'], 'the create writer exists');
select has_function('app_private', 'category_update_for_staff',
  array['uuid', 'boolean', 'uuid', 'boolean', 'uuid', 'text', 'integer'], 'the update writer exists');
select has_function('app_private', 'category_state_for_staff', array['uuid', 'boolean', 'uuid', 'boolean'],
  'the state writer exists');
select has_function('app_private', 'category_translation_save_for_staff',
  array['uuid', 'boolean', 'uuid', 'text', 'text', 'text', 'text', 'text'], 'the translation writer exists');
select has_function('app_private', 'category_translation_delete_for_staff',
  array['uuid', 'boolean', 'uuid', 'text'], 'the translation remover exists');

select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and (p.proname like 'categor%_for_staff' and p.proname not like 'category\_attribute%') and p.prosecdef),
  8, 'all eight staff functions are security definer');

select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'
      and ((p.proname like 'categor%_for_staff' and p.proname not like 'category\_attribute%') or p.proname in ('category_can_read', 'category_can_manage'))
      and p.proconfig @> array['search_path=pg_catalog, public']),
  10, 'all ten pin search_path to pg_catalog, public');

-- The slug is immutable, and that is visible in the signature rather than only in a comment: the update writer
-- takes no slug at all.
select ok(
  pg_get_function_arguments(p.oid) not like '%slug%',
  'the update writer takes no slug, so a rename is not expressible')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and p.proname = 'category_update_for_staff';

select ok(
  pg_get_functiondef(p.oid) !~* 'set[^;]*\mslug\M',
  'and it does not write one either')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private' and p.proname = 'category_update_for_staff';

-- `depth` is the trigger's. A writer that set it would be a second opinion about the shape of the tree.
select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname in (
      'category_create_for_staff', 'category_update_for_staff', 'category_state_for_staff')
      and pg_get_functiondef(p.oid) ~* '(insert into public\.categories[^;]*\mdepth\M|set[^;]*\mdepth\M)'),
  0, 'no writer writes depth');

-- The attribution channel is closed (8-B): nothing here may name it.
select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'categor%'
      and pg_get_functiondef(p.oid) like '%app.audit_actor_id%'),
  0, 'no category function names the audit attribution channel');

-- ---------------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------------
select ok(
  has_function_privilege('app_system', p.oid, 'execute'),
  format('app_system may execute %s', p.proname))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private'
   and ((p.proname like 'categor%_for_staff' and p.proname not like 'category\_attribute%') or p.proname in ('category_can_read', 'category_can_manage'));

select ok(
  not has_function_privilege('app_worker', p.oid, 'execute'),
  format('app_worker may not execute %s', p.proname))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private'
   and ((p.proname like 'categor%_for_staff' and p.proname not like 'category\_attribute%') or p.proname in ('category_can_read', 'category_can_manage'));

select ok(
  not has_function_privilege('public', p.oid, 'execute'),
  format('public may not execute %s', p.proname))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app_private'
   and ((p.proname like 'categor%_for_staff' and p.proname not like 'category\_attribute%') or p.proname in ('category_can_read', 'category_can_manage'));

-- ---------------------------------------------------------------------------------------------------
-- Fixtures: one manager, one reader, one outsider, and one whose role was revoked
-- ---------------------------------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('a0000000-0000-4000-8000-0000000000c1', 'cat-manager@test.invalid'),
  ('a0000000-0000-4000-8000-0000000000c2', 'cat-reader@test.invalid'),
  ('a0000000-0000-4000-8000-0000000000c3', 'cat-outsider@test.invalid'),
  ('a0000000-0000-4000-8000-0000000000c4', 'cat-revoked@test.invalid');

-- A role that holds only the read key, to prove the two keys are genuinely separate.
insert into public.roles (key, name_en, name_ar, requires_mfa, is_admin_console, is_assignable, sort_order)
  values ('category_reader', 'Category reader', 'قارئ الأقسام', true, true, true, 90);
insert into public.role_permissions (role_key, permission_key)
  values ('category_reader', 'catalog.category.read');

insert into public.user_roles (user_id, role_key) values
  ('a0000000-0000-4000-8000-0000000000c1', 'admin'),
  ('a0000000-0000-4000-8000-0000000000c2', 'category_reader'),
  ('a0000000-0000-4000-8000-0000000000c4', 'admin');

update public.user_roles set revoked_at = now()
 where user_id = 'a0000000-0000-4000-8000-0000000000c4';

-- ---------------------------------------------------------------------------------------------------
-- The permission predicates
-- ---------------------------------------------------------------------------------------------------
select ok(app_private.category_can_read('a0000000-0000-4000-8000-0000000000c1', true),
  'a manager may read at aal2');
select ok(app_private.category_can_manage('a0000000-0000-4000-8000-0000000000c1', true),
  'a manager may manage at aal2');

-- 0003's rule: both roles holding a category key require MFA, so aal1 holds neither key.
select ok(not app_private.category_can_read('a0000000-0000-4000-8000-0000000000c1', false),
  'the same account reads nothing at aal1');
select ok(not app_private.category_can_manage('a0000000-0000-4000-8000-0000000000c1', false),
  'and manages nothing at aal1');
select ok(not app_private.category_can_manage('a0000000-0000-4000-8000-0000000000c1', null),
  'a null assurance level is not aal2');

select ok(app_private.category_can_read('a0000000-0000-4000-8000-0000000000c2', true),
  'a reader may read');
select ok(not app_private.category_can_manage('a0000000-0000-4000-8000-0000000000c2', true),
  'a reader may not manage: the two keys are separate');

select ok(not app_private.category_can_read('a0000000-0000-4000-8000-0000000000c3', true),
  'somebody with no role reads nothing');
select ok(not app_private.category_can_manage('a0000000-0000-4000-8000-0000000000c3', true),
  'and manages nothing');

select ok(not app_private.category_can_read('a0000000-0000-4000-8000-0000000000c4', true),
  'a revoked role grants nothing');
select ok(not app_private.category_can_manage('a0000000-0000-4000-8000-0000000000c4', true),
  'not even at aal2');

-- An expired assignment is the same as a revoked one.
-- `user_roles_expiry_after_grant` refuses an expiry before the grant, so the whole assignment moves back.
update public.user_roles
   set revoked_at = null,
       granted_at = now() - interval '10 days',
       expires_at = now() - interval '1 day'
 where user_id = 'a0000000-0000-4000-8000-0000000000c4';
select ok(not app_private.category_can_manage('a0000000-0000-4000-8000-0000000000c4', true),
  'an expired role assignment grants nothing either');

-- ---------------------------------------------------------------------------------------------------
-- Create
-- ---------------------------------------------------------------------------------------------------
create temporary table ids as
select app_private.category_create_for_staff(
  'a0000000-0000-4000-8000-0000000000c1', true, 'furniture', null, 'product', 1) as root;

select ok((select root from ids) is not null, 'a manager creates a root category');

select is(
  (select c.depth from public.categories c where c.id = (select root from ids)),
  0::smallint, 'a root is at depth zero, which the trigger decided');

select ok(
  not (select c.is_active from public.categories c where c.id = (select root from ids)),
  'a new category is inactive, whatever anybody asked for');

select is(
  (select c.listing_type_code from public.categories c where c.id = (select root from ids)),
  'product', 'the listing type is stored');

select throws_ok(
  $$select app_private.category_create_for_staff('a0000000-0000-4000-8000-0000000000c2', true, 'denied-one')$$,
  '42501', null, 'a reader cannot create');

select throws_ok(
  $$select app_private.category_create_for_staff('a0000000-0000-4000-8000-0000000000c3', true, 'denied-two')$$,
  '42501', null, 'an outsider cannot create');

select throws_ok(
  $$select app_private.category_create_for_staff('a0000000-0000-4000-8000-0000000000c1', false, 'denied-three')$$,
  '42501', null, 'a manager at aal1 cannot create');

-- The unique slug rule is 0010's, and it still decides.
select throws_ok(
  $$select app_private.category_create_for_staff('a0000000-0000-4000-8000-0000000000c1', true, 'furniture')$$,
  '23505', null, 'a duplicate slug is refused by the unique index');

-- As is the slug format.
select throws_ok(
  $$select app_private.category_create_for_staff('a0000000-0000-4000-8000-0000000000c1', true, 'Not A Slug')$$,
  '23514', null, 'a slug that is not slug-shaped is refused by the check constraint');

select throws_ok(
  $$select app_private.category_create_for_staff('a0000000-0000-4000-8000-0000000000c1', true, 'nope',
      'f0000000-0000-4000-8000-00000000ffff')$$,
  '23503', null, 'a parent that does not exist is refused by the foreign key');

-- ---------------------------------------------------------------------------------------------------
-- The three-level limit, and the guards around a move
-- ---------------------------------------------------------------------------------------------------
create temporary table more_ids as
select
  app_private.category_create_for_staff('a0000000-0000-4000-8000-0000000000c1', true, 'seating',
    (select root from ids), null, 1) as level_two,
  app_private.category_create_for_staff('a0000000-0000-4000-8000-0000000000c1', true, 'armchairs',
    (select app_private.category_create_for_staff('a0000000-0000-4000-8000-0000000000c1', true, 'spare', (select root from ids))),
    null, 1) as level_three;

select is(
  (select c.depth from public.categories c where c.id = (select level_two from more_ids)),
  1::smallint, 'a child of a root is at depth one');

select is(
  (select c.depth from public.categories c where c.id = (select level_three from more_ids)),
  2::smallint, 'a grandchild is at depth two');

select throws_ok(
  format($$select app_private.category_create_for_staff('a0000000-0000-4000-8000-0000000000c1', true, 'too-deep', %L)$$,
    (select level_three from more_ids)),
  '23001', null, 'a fourth level is refused: the tree is three deep (D8)');

-- Self-parent and cycles, both the trigger's.
select throws_ok(
  format($$select app_private.category_update_for_staff('a0000000-0000-4000-8000-0000000000c1', true, %L, true, %L, null, null)$$,
    (select level_two from more_ids), (select level_two from more_ids)),
  '23001', null, 'a category cannot be its own parent');

select throws_ok(
  format($$select app_private.category_update_for_staff('a0000000-0000-4000-8000-0000000000c1', true, %L, true, %L, null, null)$$,
    (select root from ids), (select level_two from more_ids)),
  '23001', null, 'a category cannot be moved under its own descendant');

-- Re-depthing a category that has children would break the limit, so the trigger refuses it.
select throws_ok(
  format($$select app_private.category_update_for_staff('a0000000-0000-4000-8000-0000000000c1', true, %L, true, %L, null, null)$$,
    (select level_two from more_ids), (select level_three from more_ids)),
  '23001', null, 'a move that would re-depth a category with children is refused');

-- ---------------------------------------------------------------------------------------------------
-- Update
-- ---------------------------------------------------------------------------------------------------
select ok(
  app_private.category_update_for_staff('a0000000-0000-4000-8000-0000000000c1', true,
    (select level_two from more_ids), false, null, 'service', 7),
  'a manager updates the listing type and the ordering');

select is(
  (select c.sort_order from public.categories c where c.id = (select level_two from more_ids)),
  7, 'the new ordering is stored');

select is(
  (select c.listing_type_code from public.categories c where c.id = (select level_two from more_ids)),
  'service', 'and the new listing type');

-- `p_set_parent = false` leaves the parent alone; it does not move the category to the root.
select is(
  (select c.parent_id from public.categories c where c.id = (select level_two from more_ids)),
  (select root from ids), 'not setting the parent leaves it where it was');

-- `p_set_parent = true` with null is a real request: move to the root.
select ok(
  app_private.category_update_for_staff('a0000000-0000-4000-8000-0000000000c1', true,
    (select level_two from more_ids), true, null, null, null),
  'a category can be moved to the root');

select is(
  (select c.parent_id from public.categories c where c.id = (select level_two from more_ids)),
  null, 'its parent is now null');

select is(
  (select c.depth from public.categories c where c.id = (select level_two from more_ids)),
  0::smallint, 'and the trigger moved it to depth zero');

select ok(
  not app_private.category_update_for_staff('a0000000-0000-4000-8000-0000000000c1', true,
    'f0000000-0000-4000-8000-00000000ffff', false, null, null, null),
  'updating a category that does not exist is false, not an error');

select throws_ok(
  format($$select app_private.category_update_for_staff('a0000000-0000-4000-8000-0000000000c2', true, %L, false, null, null, 1)$$,
    (select root from ids)),
  '42501', null, 'a reader cannot update');

select throws_ok(
  format($$select app_private.category_update_for_staff('a0000000-0000-4000-8000-0000000000c1', false, %L, false, null, null, 1)$$,
    (select root from ids)),
  '42501', null, 'nor a manager at aal1');

-- The slug survives every update: it is the category's address and there is no history to redirect from.
select is(
  (select c.slug from public.categories c where c.id = (select root from ids)),
  'furniture', 'the slug is unchanged after an update');

-- ---------------------------------------------------------------------------------------------------
-- Translations
-- ---------------------------------------------------------------------------------------------------
select ok(
  app_private.category_translation_save_for_staff('a0000000-0000-4000-8000-0000000000c1', true,
    (select root from ids), 'en', 'Furniture', 'Tables and chairs.', 'Furniture', 'Buy furniture.'),
  'a manager writes a locale');

select is(
  (select t.name from public.category_translations t
    where t.category_id = (select root from ids) and t.locale_code = 'en'),
  'Furniture', 'the name is stored');

select is(
  (select t.meta_description from public.category_translations t
    where t.category_id = (select root from ids) and t.locale_code = 'en'),
  'Buy furniture.', 'and the SEO metadata D8 names');

-- An upsert: writing the same locale again corrects it rather than failing.
select ok(
  app_private.category_translation_save_for_staff('a0000000-0000-4000-8000-0000000000c1', true,
    (select root from ids), 'en', 'Home furniture', null, null, null),
  'writing the same locale again is a correction');

select is(
  (select t.name from public.category_translations t
    where t.category_id = (select root from ids) and t.locale_code = 'en'),
  'Home furniture', 'the name is replaced');

select is(
  (select t.description from public.category_translations t
    where t.category_id = (select root from ids) and t.locale_code = 'en'),
  null, 'and a field left out is cleared rather than kept');

-- Blanks are null, so "nobody wrote this" and "somebody cleared this" are the same state.
select ok(
  app_private.category_translation_save_for_staff('a0000000-0000-4000-8000-0000000000c1', true,
    (select root from ids), 'ar', 'أثاث', '   ', '  ', '   '),
  'blank optional fields are accepted');

select is(
  (select t.meta_title from public.category_translations t
    where t.category_id = (select root from ids) and t.locale_code = 'ar'),
  null, 'and stored as null rather than as whitespace');

-- 0010's constraints still decide what a translation may contain.
select throws_ok(
  format($$select app_private.category_translation_save_for_staff('a0000000-0000-4000-8000-0000000000c1', true, %L, 'en', '   ')$$,
    (select root from ids)),
  '23514', null, 'a blank name is refused by the length constraint');

select throws_ok(
  format($$select app_private.category_translation_save_for_staff('a0000000-0000-4000-8000-0000000000c1', true, %L, 'en', %L)$$,
    (select root from ids), repeat('x', 121)),
  '23514', null, 'a name past 120 characters is refused');

select throws_ok(
  format($$select app_private.category_translation_save_for_staff('a0000000-0000-4000-8000-0000000000c1', true, %L, 'en', 'Name', null, %L)$$,
    (select root from ids), repeat('x', 71)),
  '23514', null, 'a meta title past 70 characters is refused');

select throws_ok(
  format($$select app_private.category_translation_save_for_staff('a0000000-0000-4000-8000-0000000000c1', true, %L, 'en', 'Name', null, null, %L)$$,
    (select root from ids), repeat('x', 321)),
  '23514', null, 'a meta description past 320 characters is refused');

select throws_ok(
  format($$select app_private.category_translation_save_for_staff('a0000000-0000-4000-8000-0000000000c1', true, %L, 'fr', 'Nom')$$,
    (select root from ids)),
  '23503', null, 'a locale that is not seeded is refused by the foreign key');

select ok(
  not app_private.category_translation_save_for_staff('a0000000-0000-4000-8000-0000000000c1', true,
    'f0000000-0000-4000-8000-00000000ffff', 'en', 'Nowhere'),
  'writing a locale of a category that does not exist is false');

select throws_ok(
  format($$select app_private.category_translation_save_for_staff('a0000000-0000-4000-8000-0000000000c2', true, %L, 'en', 'Denied')$$,
    (select root from ids)),
  '42501', null, 'a reader cannot write a translation');

-- ---------------------------------------------------------------------------------------------------
-- Showing and hiding
-- ---------------------------------------------------------------------------------------------------
-- A category nobody has named cannot be shown: 0045 falls back to the slug, so it would appear as `seating`.
select throws_ok(
  format($$select app_private.category_state_for_staff('a0000000-0000-4000-8000-0000000000c1', true, %L, true)$$,
    (select level_two from more_ids)),
  '23001', null, 'a category named in no locale cannot be shown');

select ok(
  app_private.category_state_for_staff('a0000000-0000-4000-8000-0000000000c1', true, (select root from ids), true),
  'a named category can be shown');

select ok(
  (select c.is_active from public.categories c where c.id = (select root from ids)),
  'and it is active');

select throws_ok(
  format($$select app_private.category_state_for_staff('a0000000-0000-4000-8000-0000000000c2', true, %L, false)$$,
    (select root from ids)),
  '42501', null, 'a reader cannot hide a category');

select ok(
  not app_private.category_state_for_staff('a0000000-0000-4000-8000-0000000000c1', true,
    'f0000000-0000-4000-8000-00000000ffff', true),
  'changing the state of a category that does not exist is false');

-- The last locale of a shown category stays.
select lives_ok(
  format($$select app_private.category_translation_delete_for_staff('a0000000-0000-4000-8000-0000000000c1', true, %L, 'ar')$$,
    (select root from ids)),
  'removing one of two locales is allowed');

select ok(
  not app_private.category_translation_delete_for_staff('a0000000-0000-4000-8000-0000000000c1', true,
    (select root from ids), 'ar'),
  'removing a locale that is not there is false, not a refusal');

select throws_ok(
  format($$select app_private.category_translation_delete_for_staff('a0000000-0000-4000-8000-0000000000c1', true, %L, 'en')$$,
    (select root from ids)),
  '23001', null, 'the last locale of a shown category cannot be removed');

select ok(
  app_private.category_state_for_staff('a0000000-0000-4000-8000-0000000000c1', true, (select root from ids), false),
  'the category can be hidden');

select ok(
  app_private.category_translation_delete_for_staff('a0000000-0000-4000-8000-0000000000c1', true,
    (select root from ids), 'en'),
  'and then its last locale can be removed');

select is(
  (select count(*)::int from public.category_translations t where t.category_id = (select root from ids)),
  0, 'leaving it written in no locale');

-- ---------------------------------------------------------------------------------------------------
-- Deactivation reaches every public surface
-- ---------------------------------------------------------------------------------------------------
-- The point of this section: no propagation is implemented, because every public reader already resolves
-- through the ancestor rule. These assertions are against those readers, not against a copy of the rule.
create temporary table tree as
select
  app_private.category_create_for_staff('a0000000-0000-4000-8000-0000000000c1', true, 'garden', null, 'product', 1) as parent,
  app_private.category_create_for_staff('a0000000-0000-4000-8000-0000000000c1', true, 'planters',
    (select app_private.category_create_for_staff('a0000000-0000-4000-8000-0000000000c1', true, 'outdoor', null, 'product', 2)),
    'product', 1) as child;

-- Name both, then show both.
select ok(
  app_private.category_translation_save_for_staff('a0000000-0000-4000-8000-0000000000c1', true,
    (select parent from tree), 'en', 'Garden'),
  'the parent is named');
select ok(
  app_private.category_translation_save_for_staff('a0000000-0000-4000-8000-0000000000c1', true,
    (select child from tree), 'en', 'Planters'),
  'the child is named');
select ok(
  app_private.category_translation_save_for_staff('a0000000-0000-4000-8000-0000000000c1', true,
    (select c.parent_id from public.categories c where c.id = (select child from tree)), 'en', 'Outdoor'),
  'and so is the child''s own parent');

select ok(
  app_private.category_state_for_staff('a0000000-0000-4000-8000-0000000000c1', true, (select parent from tree), true),
  'the parent is shown');
select ok(
  app_private.category_state_for_staff('a0000000-0000-4000-8000-0000000000c1', true,
    (select c.parent_id from public.categories c where c.id = (select child from tree)), true),
  'the middle category is shown');
select ok(
  app_private.category_state_for_staff('a0000000-0000-4000-8000-0000000000c1', true, (select child from tree), true),
  'the child is shown');

-- Now every public surface sees them.
select ok(
  app_private.public_category_visible((select child from tree)),
  'the visibility predicate says the child is visible');

select ok(
  exists (select 1 from app_private.public_categories('en') where slug = 'planters'),
  'the public tree reader returns the child');

select is(
  (select outcome from app_private.public_category_by_slug('planters', 'en')),
  'found', 'the public landing reader finds it');

select ok(
  exists (select 1 from app_private.public_sitemap_categories(100, 0) where slug = 'planters'),
  'and the sitemap lists it');

select is(
  (select name from app_private.public_categories('en') where slug = 'planters'),
  'Planters', 'with the name that was written');

-- Deactivate the middle category. Nothing cascades in the data; everything changes in the answers.
select ok(
  app_private.category_state_for_staff('a0000000-0000-4000-8000-0000000000c1', true,
    (select c.parent_id from public.categories c where c.id = (select child from tree)), false),
  'the middle category is hidden');

select ok(
  (select c.is_active from public.categories c where c.id = (select child from tree)),
  'the child keeps its own active flag, so the branch can be restored exactly as it was');

select ok(
  not app_private.public_category_visible((select child from tree)),
  'but the predicate no longer calls the child visible');

select ok(
  not exists (select 1 from app_private.public_categories('en') where slug = 'planters'),
  'the public tree reader drops the child');

select is(
  (select outcome from app_private.public_category_by_slug('planters', 'en')),
  'not_found', 'the public landing reader answers not_found');

select ok(
  not exists (select 1 from app_private.public_sitemap_categories(100, 0) where slug = 'planters'),
  'and the sitemap stops listing it');

select ok(
  not exists (select 1 from app_private.public_categories('en') where slug = 'outdoor'),
  'the hidden category itself is gone from the tree too');

-- Restoring the middle category restores the branch, without touching the child.
select ok(
  app_private.category_state_for_staff('a0000000-0000-4000-8000-0000000000c1', true,
    (select c.parent_id from public.categories c where c.id = (select child from tree)), true),
  'the middle category is shown again');

select ok(
  exists (select 1 from app_private.public_categories('en') where slug = 'planters'),
  'and the child is back, having never been edited');

-- ---------------------------------------------------------------------------------------------------
-- The staff readers
-- ---------------------------------------------------------------------------------------------------
select ok(
  (select count(*) from app_private.categories_for_staff('a0000000-0000-4000-8000-0000000000c1', true)) > 0,
  'a manager sees the tree');

select ok(
  exists (
    select 1 from app_private.categories_for_staff('a0000000-0000-4000-8000-0000000000c1', true)
     where slug = 'seating' and not is_active),
  'including the inactive, which is what makes reactivating one possible');

select ok(
  (select count(*) from app_private.categories_for_staff('a0000000-0000-4000-8000-0000000000c2', true)) > 0,
  'a reader sees the tree too');

select is_empty(
  $$select * from app_private.categories_for_staff('a0000000-0000-4000-8000-0000000000c3', true)$$,
  'somebody with no role sees nothing at all, rather than a refusal to tell apart from emptiness');

select is_empty(
  $$select * from app_private.categories_for_staff('a0000000-0000-4000-8000-0000000000c1', false)$$,
  'and a manager at aal1 sees nothing either');

-- Depth order, then sibling order, then slug: a tree a console can indent directly.
select is(
  (select array_agg(slug) from app_private.categories_for_staff('a0000000-0000-4000-8000-0000000000c1', true)),
  (select array_agg(slug order by depth, sort_order, slug)
     from app_private.categories_for_staff('a0000000-0000-4000-8000-0000000000c1', true)),
  'the tree comes back in depth order, then sibling order, then slug');

select is(
  (select is_visible from app_private.categories_for_staff('a0000000-0000-4000-8000-0000000000c1', true)
    where slug = 'seating'),
  false, 'an inactive category reports that the public cannot see it');

select is(
  (select translated_locales from app_private.categories_for_staff('a0000000-0000-4000-8000-0000000000c1', true)
    where slug = 'garden'),
  array['en'], 'the locale coverage is reported');

select is(
  (select translated_locales from app_private.categories_for_staff('a0000000-0000-4000-8000-0000000000c1', true)
    where slug = 'seating'),
  array[]::text[], 'and an unwritten category reports an empty array rather than null');

select is(
  (select child_count from app_private.categories_for_staff('a0000000-0000-4000-8000-0000000000c1', true)
    where slug = 'outdoor'),
  1, 'how many children hang off a node is reported');

select is(
  (select listing_count from app_private.categories_for_staff('a0000000-0000-4000-8000-0000000000c1', true)
    where slug = 'garden'),
  0, 'and how many listings, which is what decides whether a move is safe to offer');

-- The detail reader.
select is(
  (select can_manage from app_private.category_for_staff('a0000000-0000-4000-8000-0000000000c1', true, (select root from ids))),
  true, 'the detail tells a manager it may manage');

select is(
  (select can_manage from app_private.category_for_staff('a0000000-0000-4000-8000-0000000000c2', true, (select root from ids))),
  false, 'and tells a reader it may not, which is what a console renders its controls from');

select is(
  (select slug from app_private.category_for_staff('a0000000-0000-4000-8000-0000000000c1', true, (select child from tree))),
  'planters', 'the detail names the category');

select is(
  (select parent_slug from app_private.category_for_staff('a0000000-0000-4000-8000-0000000000c1', true, (select child from tree))),
  'outdoor', 'and its parent, so a screen needs no second read');

select is_empty(
  format($$select * from app_private.category_for_staff('a0000000-0000-4000-8000-0000000000c3', true, %L)$$,
    (select root from ids)),
  'a caller without the read key gets no row, exactly as for a category that does not exist');

select is_empty(
  $$select * from app_private.category_for_staff('a0000000-0000-4000-8000-0000000000c1', true,
    'f0000000-0000-4000-8000-00000000ffff')$$,
  'and a category that does not exist gets no row');

-- The translation reader.
select is(
  (select count(*)::int from app_private.category_translations_for_staff(
    'a0000000-0000-4000-8000-0000000000c1', true, (select parent from tree))),
  1, 'the translation reader returns the written locales');

select is_empty(
  format($$select * from app_private.category_translations_for_staff('a0000000-0000-4000-8000-0000000000c3', true, %L)$$,
    (select parent from tree)),
  'and nothing at all without the read key');

-- ---------------------------------------------------------------------------------------------------
-- Nothing financial is touched
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like 'categor%'
      and pg_get_functiondef(p.oid) ~* 'settle_payout|transition_withdrawal|reconcile_settlement|ledger_entries|commission_rules|tax_rules|coupons|promotion'),
  0, 'no category function names a financial function or table');

select * from finish();
rollback;
