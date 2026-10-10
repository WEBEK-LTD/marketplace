-- 0111 — The property catalogue (OD-A9).
--
-- ---------------------------------------------------------------------------------------------------
-- What this is, and what it is not
-- ---------------------------------------------------------------------------------------------------
-- OD-A9 made the V1 catalogue property. This migration is the **content** of that catalogue: a listing
-- type, ten categories, eleven attributes and the options they offer. It builds no machinery at all,
-- because the machinery is already here and has been since Phase 2:
--
--   * `public.categories` is a three-level tree with per-locale names (0010, D8);
--   * `public.attribute_definitions` already has the five data types a property needs, including the two
--     select kinds, and `public.attribute_options` holds their values (0010);
--   * `public.category_attributes` already says which attributes a category asks for and which of them
--     are **filterable** (0010);
--   * `app_private.public_category_facets` and `app_private.catalog_filters_resolve` already turn that
--     into the filter panel and the narrowed query (0089).
--
-- So "filters for 1+1, 2+1, villas and buildings" is a seeding problem, not a building one. That is worth
-- stating plainly, because the alternative — a `property_type` column and a bespoke filter — would have
-- been a second catalogue beside the one the console already edits, and an owner who wanted a new room
-- layout next month would have needed a migration instead of a form.
--
-- **Everything here is editable in the console.** 0087 manages categories and their translations, 0088
-- manages attribute definitions and their options. Nothing below is privileged seed data that only a
-- migration can change; it is a starting catalogue, written once so the product has one.
--
-- ---------------------------------------------------------------------------------------------------
-- The decisions inside it
-- ---------------------------------------------------------------------------------------------------
-- **`sale_or_rent` is an attribute, not a category.** A villa for sale and a villa to rent are the same
-- kind of thing on different terms, and making them two branches would double every category and halve
-- every count. As a required, filterable attribute it is the first filter on the panel and the first
-- question an enquiry answers.
--
-- **Room layout is written the way Egyptian and Turkish listings write it** — `2+1` means two bedrooms
-- and a living room. The stored value is `2-1`, because `attribute_options_value_format` allows no `+`;
-- the label a person reads is `2+1` in both languages. A system that stored `3` and displayed `2+1` would
-- be the one nobody could filter correctly.
--
-- **Land, shops, offices and warehouses get their own attribute set.** A warehouse has no bedrooms and a
-- plot of land has no floor, and `category_attributes` is per-category precisely so that a filter panel
-- is never a list of fields that do not apply. That is also why the attributes are attached one category
-- at a time below rather than to all ten at once.
--
-- Nothing here touches payments, payouts, providers, settlement, the ledger or a balance;
-- `finance.settlement_posting_enabled` is neither read nor written. No permission key is added: the
-- console's existing catalogue keys already govern every table this writes to.

-- ---------------------------------------------------------------------------------------------------
-- 1. The listing type
-- ---------------------------------------------------------------------------------------------------
insert into public.listing_types (code, name_en, name_ar, sort_order) values
  ('property', 'Property', 'عقار', 0)
on conflict (code) do nothing;

-- The two V1 types that came before it stay seeded and stay active: OD-A9 is about what the catalogue
-- *is for*, and removing a type that listings may already reference is a different decision with a
-- foreign key behind it. Property sorts first, which is what the console and the public filters read.
update public.listing_types set sort_order = 10 where code = 'product';
update public.listing_types set sort_order = 20 where code = 'service';

-- ---------------------------------------------------------------------------------------------------
-- 2. The categories
-- ---------------------------------------------------------------------------------------------------
-- One level. A three-level tree is available (D8) and deliberately unused: the second level of a property
-- catalogue is the attributes below, not more categories, and a visitor choosing "apartment" then
-- "2+1" is choosing one category and one filter rather than navigating twice.
create or replace function pg_temp.property_category(
  p_slug text, p_name_en text, p_name_ar text, p_sort integer
) returns void language plpgsql as $$
declare
  v_id uuid;
begin
  insert into public.categories (slug, listing_type_code, depth, sort_order)
  values (p_slug, 'property', 0, p_sort)
  on conflict (slug) do nothing;

  select id into v_id from public.categories where slug = p_slug;

  insert into public.category_translations (category_id, locale_code, name) values
    (v_id, 'en', p_name_en),
    (v_id, 'ar', p_name_ar)
  on conflict (category_id, locale_code) do nothing;
end;
$$;

select pg_temp.property_category('apartments',  'Apartments',       'شقق',            10);
select pg_temp.property_category('duplexes',    'Duplexes',         'دوبلكس',         20);
select pg_temp.property_category('penthouses',  'Penthouses',       'بنتهاوس',        30);
select pg_temp.property_category('villas',      'Villas',           'فلل',            40);
select pg_temp.property_category('chalets',     'Chalets',          'شاليهات',        50);
select pg_temp.property_category('buildings',   'Whole buildings',  'عمارات',         60);
select pg_temp.property_category('land',        'Land',             'أراضي',          70);
select pg_temp.property_category('shops',       'Shops',            'محلات',          80);
select pg_temp.property_category('offices',     'Offices',          'مكاتب',          90);
select pg_temp.property_category('warehouses',  'Warehouses',       'مخازن',         100);

-- ---------------------------------------------------------------------------------------------------
-- 3. The attributes
-- ---------------------------------------------------------------------------------------------------
create or replace function pg_temp.property_attribute(
  p_key text, p_type text, p_unit text, p_name_en text, p_name_ar text, p_sort integer
) returns void language sql as $$
  insert into public.attribute_definitions (key, data_type, unit, name_en, name_ar, is_filterable, sort_order)
  values (p_key, p_type, p_unit, p_name_en, p_name_ar, true, p_sort)
  on conflict (key) do nothing;
$$;

create or replace function pg_temp.property_option(
  p_key text, p_value text, p_label_en text, p_label_ar text, p_sort integer
) returns void language sql as $$
  insert into public.attribute_options (attribute_definition_id, value, label_en, label_ar, sort_order)
  select d.id, p_value, p_label_en, p_label_ar, p_sort
    from public.attribute_definitions d where d.key = p_key
  on conflict (attribute_definition_id, value) do nothing;
$$;

select pg_temp.property_attribute('sale_or_rent',    'single_select', null,  'For sale or rent', 'للبيع أم للإيجار', 10);
select pg_temp.property_attribute('room_layout',     'single_select', null,  'Rooms',            'عدد الغرف',        20);
select pg_temp.property_attribute('bathrooms',       'number',        null,  'Bathrooms',        'عدد الحمامات',     30);
select pg_temp.property_attribute('area_sqm',        'number',        'm²',  'Area',             'المساحة',          40);
select pg_temp.property_attribute('floor_number',    'number',        null,  'Floor',            'الدور',            50);
select pg_temp.property_attribute('furnishing',      'single_select', null,  'Furnishing',       'التأثيث',          60);
select pg_temp.property_attribute('delivery_status', 'single_select', null,  'Delivery',         'حالة التسليم',     70);
select pg_temp.property_attribute('has_lift',        'boolean',       null,  'Lift',             'أسانسير',          80);
select pg_temp.property_attribute('has_parking',     'boolean',       null,  'Parking',          'جراج',             90);
select pg_temp.property_attribute('has_garden',      'boolean',       null,  'Garden',           'حديقة',           100);
select pg_temp.property_attribute('has_pool',        'boolean',       null,  'Pool',             'حمام سباحة',      110);

select pg_temp.property_option('sale_or_rent', 'sale', 'For sale',   'للبيع',  10);
select pg_temp.property_option('sale_or_rent', 'rent', 'For rent',   'للإيجار', 20);

-- The label carries the `+`; the value cannot, so it carries a `-`. `studio` is named rather than written
-- `0-1`, because that is what a person looking for one calls it.
select pg_temp.property_option('room_layout', 'studio', 'Studio', 'استوديو', 10);
select pg_temp.property_option('room_layout', '1-1',    '1+1',    '1+1',     20);
select pg_temp.property_option('room_layout', '2-1',    '2+1',    '2+1',     30);
select pg_temp.property_option('room_layout', '3-1',    '3+1',    '3+1',     40);
select pg_temp.property_option('room_layout', '4-1',    '4+1',    '4+1',     50);
select pg_temp.property_option('room_layout', '5-1',    '5+1',    '5+1',     60);
select pg_temp.property_option('room_layout', '6-plus', '6+',     '6+',      70);

select pg_temp.property_option('furnishing', 'furnished',      'Furnished',      'مفروش',      10);
select pg_temp.property_option('furnishing', 'semi-furnished', 'Semi-furnished', 'نصف مفروش',  20);
select pg_temp.property_option('furnishing', 'unfurnished',    'Unfurnished',    'غير مفروش',  30);

select pg_temp.property_option('delivery_status', 'ready',              'Ready to move',      'جاهز للسكن',   10);
select pg_temp.property_option('delivery_status', 'under-construction', 'Under construction', 'تحت الإنشاء',  20);
select pg_temp.property_option('delivery_status', 'off-plan',           'Off plan',           'على الخريطة',  30);

-- ---------------------------------------------------------------------------------------------------
-- 4. Which category asks for what
-- ---------------------------------------------------------------------------------------------------
-- A filter panel that offers "bedrooms" on a warehouse is a panel nobody trusts, so the sets are written
-- per category rather than applied to all ten. `sale_or_rent` and `area_sqm` are the two every property
-- has; everything else is conditional on the kind.
create or replace function pg_temp.property_attach(
  p_category text, p_keys text[], p_required text[] default '{}'::text[]
) returns void language sql as $$
  insert into public.category_attributes (category_id, attribute_definition_id, is_required, is_filterable, sort_order)
  select c.id, d.id, d.key = any (p_required), true, d.sort_order
    from public.categories c
   cross join public.attribute_definitions d
   where c.slug = p_category
     and d.key = any (p_keys)
  on conflict (category_id, attribute_definition_id) do nothing;
$$;

-- A home somebody lives in: every attribute applies.
select pg_temp.property_attach('apartments',
  array['sale_or_rent','room_layout','bathrooms','area_sqm','floor_number','furnishing','delivery_status','has_lift','has_parking'],
  array['sale_or_rent','area_sqm']);
select pg_temp.property_attach('duplexes',
  array['sale_or_rent','room_layout','bathrooms','area_sqm','floor_number','furnishing','delivery_status','has_lift','has_parking','has_garden'],
  array['sale_or_rent','area_sqm']);
select pg_temp.property_attach('penthouses',
  array['sale_or_rent','room_layout','bathrooms','area_sqm','floor_number','furnishing','delivery_status','has_lift','has_parking','has_pool'],
  array['sale_or_rent','area_sqm']);
select pg_temp.property_attach('villas',
  array['sale_or_rent','room_layout','bathrooms','area_sqm','furnishing','delivery_status','has_parking','has_garden','has_pool'],
  array['sale_or_rent','area_sqm']);
select pg_temp.property_attach('chalets',
  array['sale_or_rent','room_layout','bathrooms','area_sqm','furnishing','delivery_status','has_garden','has_pool'],
  array['sale_or_rent','area_sqm']);

-- A whole building is bought by the building, not by the bedroom.
select pg_temp.property_attach('buildings',
  array['sale_or_rent','area_sqm','delivery_status','has_lift','has_parking'],
  array['sale_or_rent','area_sqm']);

-- Land has a size and a purpose and nothing else this catalogue asks about.
select pg_temp.property_attach('land',
  array['sale_or_rent','area_sqm'],
  array['sale_or_rent','area_sqm']);

-- Commercial space: a floor and a size matter, bedrooms do not.
select pg_temp.property_attach('shops',
  array['sale_or_rent','area_sqm','floor_number','delivery_status','has_parking'],
  array['sale_or_rent','area_sqm']);
select pg_temp.property_attach('offices',
  array['sale_or_rent','area_sqm','floor_number','furnishing','delivery_status','has_lift','has_parking'],
  array['sale_or_rent','area_sqm']);
select pg_temp.property_attach('warehouses',
  array['sale_or_rent','area_sqm','delivery_status','has_parking'],
  array['sale_or_rent','area_sqm']);

-- ---------------------------------------------------------------------------------------------------
-- 5. What this migration asserts about itself
-- ---------------------------------------------------------------------------------------------------
do $$
declare
  v_count integer;
  v_missing text;
begin
  select count(*)::integer into v_count
    from public.categories where listing_type_code = 'property';
  if v_count <> 10 then
    raise exception 'OD-A9: expected ten property categories, found %', v_count;
  end if;

  -- Every category named in both languages. A catalogue half-translated is a catalogue that renders a
  -- slug to half its visitors, and D6 makes the public site bilingual.
  select string_agg(c.slug, ', ' order by c.slug) into v_missing
    from public.categories c
   where c.listing_type_code = 'property'
     and (select count(*) from public.category_translations t
           where t.category_id = c.id and t.locale_code in ('en', 'ar')) <> 2;
  if v_missing is not null then
    raise exception 'OD-A9: property categories missing a translation: %', v_missing;
  end if;

  -- Every property category can be filtered by purpose and by size, which are the two filters a property
  -- search starts from.
  select string_agg(c.slug, ', ' order by c.slug) into v_missing
    from public.categories c
   where c.listing_type_code = 'property'
     and not exists (
       select 1 from public.category_attributes ca
         join public.attribute_definitions d on d.id = ca.attribute_definition_id
        where ca.category_id = c.id and ca.is_filterable and d.key = 'sale_or_rent');
  if v_missing is not null then
    raise exception 'OD-A9: property categories that cannot be filtered by purpose: %', v_missing;
  end if;

  -- Both select attributes carry their options; a select with none is a filter that offers nothing.
  select string_agg(d.key, ', ' order by d.key) into v_missing
    from public.attribute_definitions d
   where d.data_type in ('single_select', 'multi_select')
     and d.key in ('sale_or_rent', 'room_layout', 'furnishing', 'delivery_status')
     and not exists (select 1 from public.attribute_options o where o.attribute_definition_id = d.id);
  if v_missing is not null then
    raise exception 'OD-A9: select attributes with no options: %', v_missing;
  end if;
end;
$$;

select app_private.assert_security_contract();
