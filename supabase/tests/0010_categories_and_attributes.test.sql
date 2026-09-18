-- pgTAP — migration 0010: the category tree (D8), attributes, options and tags.
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(14);

insert into public.locales (code, name_en, name_native, direction, is_active, is_default)
values ('zz', 'Test locale', 'Test locale', 'ltr', true, true);

insert into public.categories (id, slug) values ('11111111-aaaa-4aaa-8aaa-111111111111', 'electronics');
insert into public.categories (id, parent_id, slug)
values ('22222222-aaaa-4aaa-8aaa-222222222222', '11111111-aaaa-4aaa-8aaa-111111111111', 'phones');
insert into public.categories (id, parent_id, slug)
values ('33333333-aaaa-4aaa-8aaa-333333333333', '22222222-aaaa-4aaa-8aaa-222222222222', 'smartphones');

-- Three levels, no more (D8) --------------------------------------------------------------------------
select is((select depth from public.categories where slug = 'electronics'), 0::smallint, 'a root category has depth 0');
select is((select depth from public.categories where slug = 'phones'), 1::smallint, 'a child is depth 1');
select is((select depth from public.categories where slug = 'smartphones'), 2::smallint, 'a grandchild is depth 2');

select throws_ok(
  $$insert into public.categories (parent_id, slug)
    values ('33333333-aaaa-4aaa-8aaa-333333333333', 'folding-smartphones')$$,
  '23001',
  null,
  'a fourth level is refused: the tree is limited to three levels'
);

select throws_ok(
  $$update public.categories set parent_id = '33333333-aaaa-4aaa-8aaa-333333333333'
     where id = '11111111-aaaa-4aaa-8aaa-111111111111'$$,
  '23001',
  null,
  'a category cannot become its own descendant'
);

select throws_ok(
  $$insert into public.categories (slug) values ('phones')$$,
  '23505',
  null,
  'slugs are unique across the whole tree, because /category/[slug] is flat'
);

select throws_ok(
  $$delete from public.categories where slug = 'phones'$$,
  '23503',
  null,
  'a category with children cannot simply be deleted'
);

-- Translations and SEO metadata ------------------------------------------------------------------------
insert into public.category_translations (category_id, locale_code, name, meta_title, meta_description)
values ('11111111-aaaa-4aaa-8aaa-111111111111', 'zz', 'Electronics', 'Electronics', 'All electronics');
select is(
  (select name from public.category_translations where category_id = '11111111-aaaa-4aaa-8aaa-111111111111'),
  'Electronics',
  'a category carries a translated name and SEO metadata'
);

select throws_ok(
  $$insert into public.category_translations (category_id, locale_code, name, meta_title)
    values ('22222222-aaaa-4aaa-8aaa-222222222222', 'zz', 'Phones', repeat('x', 71))$$,
  '23514',
  null,
  'a meta title longer than 70 characters is refused'
);

-- Attributes -------------------------------------------------------------------------------------------
insert into public.attribute_definitions (id, key, data_type, name_en, name_ar)
values ('44444444-aaaa-4aaa-8aaa-444444444444', 'brand', 'single_select', 'Brand', 'Brand'),
       ('55555555-aaaa-4aaa-8aaa-555555555555', 'screen_size', 'number', 'Screen size', 'Screen size');

insert into public.attribute_options (attribute_definition_id, value, label_en, label_ar)
values ('44444444-aaaa-4aaa-8aaa-444444444444', 'acme', 'Acme', 'Acme');

select throws_ok(
  $$insert into public.attribute_options (attribute_definition_id, value, label_en, label_ar)
    values ('55555555-aaaa-4aaa-8aaa-555555555555', 'big', 'Big', 'Big')$$,
  '23001',
  null,
  'only the select types take options'
);

select throws_ok(
  $$insert into public.attribute_definitions (key, data_type, unit, name_en, name_ar)
    values ('colour', 'text', 'cm', 'Colour', 'Colour')$$,
  '23514',
  null,
  'a unit belongs only to a number attribute'
);

-- Attributes are inherited down the tree ----------------------------------------------------------------
insert into public.category_attributes (category_id, attribute_definition_id, is_required)
values ('11111111-aaaa-4aaa-8aaa-111111111111', '44444444-aaaa-4aaa-8aaa-444444444444', true),
       ('22222222-aaaa-4aaa-8aaa-222222222222', '55555555-aaaa-4aaa-8aaa-555555555555', false);

select is(
  (select count(*) from public.category_attribute_set('33333333-aaaa-4aaa-8aaa-333333333333')),
  2::bigint,
  'a leaf category inherits the attributes of its ancestors'
);
select ok(
  (select is_required from public.category_attribute_set('33333333-aaaa-4aaa-8aaa-333333333333') where key = 'brand'),
  'a requirement set higher in the tree still applies'
);

-- Tags --------------------------------------------------------------------------------------------------
insert into public.tags (slug, name_en, name_ar) values ('vintage', 'Vintage', 'Vintage');
select throws_ok(
  $$insert into public.tags (slug, name_en, name_ar) values ('vintage', 'Vintage again', 'Vintage again')$$,
  '23505',
  null,
  'tag slugs are unique'
);

select * from finish();
rollback;
