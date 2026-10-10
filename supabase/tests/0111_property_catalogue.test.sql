-- pgTAP — migration 0111: the property catalogue (OD-A9).
--
-- This file is about **content**, because the migration is content: the machinery it seeds was built in
-- 0010 and 0089 and is proved by their own suites. What is asserted here is that the catalogue a visitor
-- meets is complete and usable:
--
--   * the ten categories exist, under the property listing type, at one level;
--   * every one of them is named in **both** languages, because D6 makes the public site bilingual and a
--     half-translated catalogue renders a slug to half its visitors;
--   * every one of them can be filtered by purpose and by size, which is where a property search starts;
--   * no category offers a filter that does not apply to it — the point of a per-category attribute set;
--   * every select attribute carries its options, and the room layouts read the way listings are written;
--   * the existing filter resolver accepts these attributes, so the panel is not a separate mechanism.
--
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(25);

-- ---------------------------------------------------------------------------------------------------
-- 1. The listing type and the shape of the tree
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::integer from public.listing_types where code = 'property' and is_active),
  1, 'the property listing type exists and is active');
select is(
  (select code from public.listing_types order by sort_order limit 1),
  'property', 'and it sorts first, which is what the console and the public filters read');
select is(
  (select count(*)::integer from public.listing_types where code in ('product', 'service') and is_active),
  2, 'the two earlier types are still active: a type with listings behind it is not removed in passing');

select is(
  (select count(*)::integer from public.categories where listing_type_code = 'property'),
  10, 'ten property categories');
select is(
  (select count(*)::integer from public.categories where listing_type_code = 'property' and depth <> 0),
  0, 'all at one level: the second level of a property catalogue is the attributes, not more categories');
select is(
  (select count(*)::integer from public.categories where listing_type_code = 'property' and not is_active),
  0, 'and all of them active');

select set_eq(
  $$select slug from public.categories where listing_type_code = 'property'$$,
  $$values ('apartments'), ('duplexes'), ('penthouses'), ('villas'), ('chalets'),
           ('buildings'), ('land'), ('shops'), ('offices'), ('warehouses')$$,
  'the ten the owner named: flats, villas, whole buildings and the rest');

-- ---------------------------------------------------------------------------------------------------
-- 2. Both languages, everywhere
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::integer from public.categories c
    where c.listing_type_code = 'property'
      and (select count(*) from public.category_translations t
            where t.category_id = c.id and t.locale_code in ('en', 'ar')) <> 2),
  0, 'every property category is named in English and in Arabic');

select is(
  (select t.name from public.categories c
     join public.category_translations t on t.category_id = c.id and t.locale_code = 'ar'
    where c.slug = 'villas'),
  'فلل', 'and the Arabic is the word a person would search for, not a transliteration');

select is(
  (select count(*)::integer from public.attribute_definitions
    where key in ('sale_or_rent', 'room_layout', 'bathrooms', 'area_sqm', 'floor_number',
                  'furnishing', 'delivery_status', 'has_lift', 'has_parking', 'has_garden', 'has_pool')
      and (length(btrim(name_en)) = 0 or length(btrim(name_ar)) = 0)),
  0, 'and every property attribute carries both names');

-- ---------------------------------------------------------------------------------------------------
-- 3. The filters a property search starts from
-- ---------------------------------------------------------------------------------------------------
create or replace function pg_temp.filters(p_slug text) returns text[] language sql stable as $$
  select coalesce(array_agg(d.key order by d.sort_order), '{}'::text[])
    from public.categories c
    join public.category_attributes ca on ca.category_id = c.id and ca.is_filterable
    join public.attribute_definitions d on d.id = ca.attribute_definition_id
   where c.slug = p_slug;
$$;

select is(
  (select count(*)::integer from public.categories c
    where c.listing_type_code = 'property'
      and not ('sale_or_rent' = any (pg_temp.filters(c.slug)))),
  0, 'every property category can be filtered by sale or rent');
select is(
  (select count(*)::integer from public.categories c
    where c.listing_type_code = 'property'
      and not ('area_sqm' = any (pg_temp.filters(c.slug)))),
  0, 'and by area');

-- Required where it has to be: a listing with no purpose and no size is not a property listing.
select is(
  (select count(*)::integer from public.categories c
     join public.category_attributes ca on ca.category_id = c.id
     join public.attribute_definitions d on d.id = ca.attribute_definition_id
    where c.listing_type_code = 'property' and d.key = 'sale_or_rent' and not ca.is_required),
  0, 'the purpose is required on every property category');

-- ---------------------------------------------------------------------------------------------------
-- 4. No category offers a filter that does not apply to it
-- ---------------------------------------------------------------------------------------------------
-- This is the whole reason the sets are written per category. A panel offering "bedrooms" on a warehouse
-- is a panel nobody trusts, and the mistake is invisible until somebody filters by it and gets nothing.
select ok(not ('room_layout' = any (pg_temp.filters('warehouses'))), 'a warehouse is not filtered by bedrooms');
select ok(not ('room_layout' = any (pg_temp.filters('land'))), 'nor is a plot of land');
select ok(not ('room_layout' = any (pg_temp.filters('buildings'))), 'nor a whole building, which is bought by the building');
select ok(not ('floor_number' = any (pg_temp.filters('villas'))), 'a villa has no floor number');
select ok(not ('floor_number' = any (pg_temp.filters('land'))), 'and neither has land');
select ok(not ('has_pool' = any (pg_temp.filters('offices'))), 'an office is not filtered by its swimming pool');
select ok('has_pool' = any (pg_temp.filters('villas')), 'a villa is');
select ok('room_layout' = any (pg_temp.filters('apartments')), 'and a flat is filtered by its layout');

-- ---------------------------------------------------------------------------------------------------
-- 5. The options
-- ---------------------------------------------------------------------------------------------------
select is(
  (select count(*)::integer from public.attribute_definitions d
    where d.data_type in ('single_select', 'multi_select')
      and d.key in ('sale_or_rent', 'room_layout', 'furnishing', 'delivery_status')
      and not exists (select 1 from public.attribute_options o where o.attribute_definition_id = d.id)),
  0, 'every property select carries options: a select with none is a filter that offers nothing');

-- The value cannot hold a `+` — `attribute_options_value_format` forbids it — so the label does, and the
-- label is what a person reads. A system storing `3` and showing `2+1` is one nobody can filter correctly.
select is(
  (select string_agg(o.label_en, ',' order by o.sort_order)
     from public.attribute_options o
     join public.attribute_definitions d on d.id = o.attribute_definition_id
    where d.key = 'room_layout'),
  'Studio,1+1,2+1,3+1,4+1,5+1,6+',
  'the room layouts read the way listings are written, in both scripts');
select is(
  (select o.label_ar from public.attribute_options o
     join public.attribute_definitions d on d.id = o.attribute_definition_id
    where d.key = 'room_layout' and o.value = '2-1'),
  '2+1', 'and 2+1 is 2+1 in Arabic too, because the notation is the notation');

-- ---------------------------------------------------------------------------------------------------
-- 6. The existing resolver, not a second mechanism
-- ---------------------------------------------------------------------------------------------------
-- 0089 built the filter resolution the public catalogue uses. If this catalogue needed anything else,
-- the console's own filter panel and the public one would be two different things.
select is(
  (select count(*)::integer from public.category_attribute_set(
     (select id from public.categories where slug = 'apartments'))
    where is_filterable),
  9, 'the existing attribute-set reader sees all nine of a flat''s filters');

select * from finish();
rollback;
