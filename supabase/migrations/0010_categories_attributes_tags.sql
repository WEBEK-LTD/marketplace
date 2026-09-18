-- 0010 — Categories, attributes, tags and their translations (v5.2 migration plan; D8).
--
-- D8: one category table with `parent_id`, at most three levels, unique slug rules, an active state,
-- ordering and SEO metadata. There is no separate subcategory table. The public route is
-- `/category/[slug]`, so slugs are unique across the whole tree.
--
-- Depth and cycles are enforced by a trigger: a CHECK cannot look at the parent row.
--
-- Attributes are defined once (`attribute_definitions`, with `attribute_options` for the select types)
-- and attached to categories (`category_attributes`), which decides whether each one is required and
-- filterable for that category. Listings store their values in 0011.
--
-- Names and SEO metadata are translated per locale in `category_translations`; the bilingual attribute
-- and tag labels are columns, matching the rest of the reference data.

-- ---------------------------------------------------------------------------------------------------
-- Categories
-- ---------------------------------------------------------------------------------------------------
create table public.categories (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid references public.categories (id) on delete restrict,
  depth smallint not null default 0,
  slug text not null,
  listing_type_code text references public.listing_types (code) on delete restrict,
  icon text,
  image_object_path text,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint categories_slug_format check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$'),
  constraint categories_depth_range check (depth between 0 and 2),
  constraint categories_root_has_no_parent check ((depth = 0) = (parent_id is null)),
  constraint categories_not_self_parent check (parent_id is null or parent_id <> id)
);
comment on table public.categories is
  'Single category tree, at most three levels (depth 0-2), D8. Slugs are unique across the tree because /category/[slug] is a flat route.';
create unique index categories_slug on public.categories (slug);
create index categories_parent on public.categories (parent_id, sort_order, id);
create index categories_active on public.categories (is_active, depth, sort_order);
create trigger categories_set_updated_at before update on public.categories
  for each row execute function app_private.tg_set_updated_at();
create trigger categories_audit after insert or update or delete on public.categories
  for each row execute function audit.tg_record_change();

create or replace function app_private.tg_categories_tree_rule() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  parent_depth smallint;
  parent_active boolean;
  walker uuid;
  steps integer := 0;
begin
  if new.parent_id is null then
    new.depth := 0;
  else
    select c.depth, c.is_active into parent_depth, parent_active from public.categories c where c.id = new.parent_id;
    if parent_depth is null then
      raise exception 'parent category % does not exist', new.parent_id using errcode = 'foreign_key_violation';
    end if;
    if parent_depth >= 2 then
      raise exception 'the category tree is limited to three levels (D8)' using errcode = 'restrict_violation';
    end if;
    new.depth := (parent_depth + 1)::smallint;

    -- A move must not create a cycle; the tree is shallow, so walking up is cheap.
    walker := new.parent_id;
    while walker is not null loop
      if walker = new.id then
        raise exception 'a category cannot be its own ancestor' using errcode = 'restrict_violation';
      end if;
      steps := steps + 1;
      if steps > 8 then
        raise exception 'category ancestry is unexpectedly deep' using errcode = 'restrict_violation';
      end if;
      select c.parent_id into walker from public.categories c where c.id = walker;
    end loop;
  end if;

  if tg_op = 'UPDATE' and new.depth is distinct from old.depth
     and exists (select 1 from public.categories c where c.parent_id = new.id) then
    raise exception 'move the children first: changing the depth of a category that has children would break the three-level limit'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

create trigger categories_tree_rule before insert or update of parent_id on public.categories
  for each row execute function app_private.tg_categories_tree_rule();

create table public.category_translations (
  category_id uuid not null references public.categories (id) on delete cascade,
  locale_code text not null references public.locales (code) on delete cascade,
  name text not null,
  description text,
  meta_title text,
  meta_description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (category_id, locale_code),
  constraint category_translations_name_length check (length(btrim(name)) between 1 and 120),
  constraint category_translations_meta_title_length check (meta_title is null or length(meta_title) <= 70),
  constraint category_translations_meta_description_length check (meta_description is null or length(meta_description) <= 320)
);
comment on table public.category_translations is 'Category name and SEO metadata per locale (D8 SEO metadata, D6 bilingual public site).';
create trigger category_translations_set_updated_at before update on public.category_translations
  for each row execute function app_private.tg_set_updated_at();

-- ---------------------------------------------------------------------------------------------------
-- Attributes
-- ---------------------------------------------------------------------------------------------------
create table public.attribute_definitions (
  id uuid primary key default gen_random_uuid(),
  key text not null,
  data_type text not null,
  unit text,
  name_en text not null,
  name_ar text not null,
  is_filterable boolean not null default true,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint attribute_definitions_key_format check (key ~ '^[a-z][a-z0-9_]*$'),
  constraint attribute_definitions_data_type_allowed check (data_type in ('text', 'number', 'boolean', 'single_select', 'multi_select')),
  constraint attribute_definitions_names_present check (length(btrim(name_en)) > 0 and length(btrim(name_ar)) > 0),
  constraint attribute_definitions_unit_only_for_number check (unit is null or data_type = 'number')
);
comment on table public.attribute_definitions is 'Attributes a category can ask a listing for. Select types draw their values from attribute_options.';
create unique index attribute_definitions_key on public.attribute_definitions (key);
create trigger attribute_definitions_set_updated_at before update on public.attribute_definitions
  for each row execute function app_private.tg_set_updated_at();

create table public.attribute_options (
  id uuid primary key default gen_random_uuid(),
  attribute_definition_id uuid not null references public.attribute_definitions (id) on delete cascade,
  value text not null,
  label_en text not null,
  label_ar text not null,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint attribute_options_value_format check (value ~ '^[a-z0-9][a-z0-9_-]*$'),
  constraint attribute_options_labels_present check (length(btrim(label_en)) > 0 and length(btrim(label_ar)) > 0),
  unique (attribute_definition_id, value)
);
create index attribute_options_by_definition on public.attribute_options (attribute_definition_id, sort_order) where is_active;
create trigger attribute_options_set_updated_at before update on public.attribute_options
  for each row execute function app_private.tg_set_updated_at();

-- Options belong only to the select types.
create or replace function app_private.tg_attribute_options_type_rule() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  kind text;
begin
  select d.data_type into kind from public.attribute_definitions d where d.id = new.attribute_definition_id;
  if kind not in ('single_select', 'multi_select') then
    raise exception 'attribute % is a % attribute and takes no options', new.attribute_definition_id, kind
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

create trigger attribute_options_type_rule before insert or update on public.attribute_options
  for each row execute function app_private.tg_attribute_options_type_rule();

create table public.category_attributes (
  category_id uuid not null references public.categories (id) on delete cascade,
  attribute_definition_id uuid not null references public.attribute_definitions (id) on delete restrict,
  is_required boolean not null default false,
  is_filterable boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  primary key (category_id, attribute_definition_id)
);
comment on table public.category_attributes is 'Which attributes a category asks for, and whether each one is required and filterable there.';
create index category_attributes_by_attribute on public.category_attributes (attribute_definition_id, category_id);

-- Every attribute a listing must satisfy, walking up the category tree.
create or replace function public.category_attribute_set(p_category_id uuid)
returns table (
  attribute_definition_id uuid,
  key text,
  data_type text,
  unit text,
  is_required boolean,
  is_filterable boolean,
  from_category_id uuid
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with recursive ancestry as (
    select c.id, c.parent_id from public.categories c where c.id = p_category_id
    union all
    select c.id, c.parent_id from public.categories c join ancestry a on c.id = a.parent_id
  )
  select distinct on (d.id)
    d.id, d.key, d.data_type, d.unit, ca.is_required, ca.is_filterable, ca.category_id
  from ancestry a
  join public.category_attributes ca on ca.category_id = a.id
  join public.attribute_definitions d on d.id = ca.attribute_definition_id
  where d.is_active
  order by d.id, ca.is_required desc, ca.sort_order;
$$;
comment on function public.category_attribute_set(uuid) is
  'The attributes that apply to a category, inherited from its ancestors. A requirement set anywhere on the path wins.';

-- ---------------------------------------------------------------------------------------------------
-- Tags
-- ---------------------------------------------------------------------------------------------------
create table public.tags (
  id uuid primary key default gen_random_uuid(),
  slug text not null,
  name_en text not null,
  name_ar text not null,
  is_active boolean not null default true,
  usage_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tags_slug_format check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$'),
  constraint tags_names_present check (length(btrim(name_en)) > 0 and length(btrim(name_ar)) > 0),
  constraint tags_usage_count_positive check (usage_count >= 0)
);
comment on table public.tags is 'Free tags applied to listings. `usage_count` is maintained by the listing_tags trigger in 0011.';
create unique index tags_slug on public.tags (slug);
create index tags_active on public.tags (is_active, usage_count desc);
create trigger tags_set_updated_at before update on public.tags
  for each row execute function app_private.tg_set_updated_at();

-- ---------------------------------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------------------------------
alter table public.categories enable row level security;
alter table public.category_translations enable row level security;
alter table public.attribute_definitions enable row level security;
alter table public.attribute_options enable row level security;
alter table public.category_attributes enable row level security;
alter table public.tags enable row level security;

-- The taxonomy is public catalogue data; only administrators change it.
create policy categories_public_read on public.categories for select to authenticated using (is_active);
create policy categories_admin_read on public.categories for select to authenticated
  using (public.has_permission('catalog.category.read'));
create policy categories_admin_write on public.categories for all to authenticated
  using (public.has_permission('catalog.category.manage') and public.is_aal2())
  with check (public.has_permission('catalog.category.manage') and public.is_aal2());

create policy category_translations_public_read on public.category_translations for select to authenticated
  using (exists (select 1 from public.categories c where c.id = category_id and c.is_active));
create policy category_translations_admin_write on public.category_translations for all to authenticated
  using (public.has_permission('catalog.category.manage') and public.is_aal2())
  with check (public.has_permission('catalog.category.manage') and public.is_aal2());

create policy attribute_definitions_public_read on public.attribute_definitions for select to authenticated using (is_active);
create policy attribute_definitions_admin_write on public.attribute_definitions for all to authenticated
  using (public.has_permission('catalog.attribute.manage') and public.is_aal2())
  with check (public.has_permission('catalog.attribute.manage') and public.is_aal2());

create policy attribute_options_public_read on public.attribute_options for select to authenticated using (is_active);
create policy attribute_options_admin_write on public.attribute_options for all to authenticated
  using (public.has_permission('catalog.attribute.manage') and public.is_aal2())
  with check (public.has_permission('catalog.attribute.manage') and public.is_aal2());

create policy category_attributes_public_read on public.category_attributes for select to authenticated using (true);
create policy category_attributes_admin_write on public.category_attributes for all to authenticated
  using (public.has_permission('catalog.category.manage') and public.is_aal2())
  with check (public.has_permission('catalog.category.manage') and public.is_aal2());

create policy tags_public_read on public.tags for select to authenticated using (is_active);
create policy tags_admin_write on public.tags for all to authenticated
  using (public.has_permission('catalog.tag.manage') and public.is_aal2())
  with check (public.has_permission('catalog.tag.manage') and public.is_aal2());

grant select, insert, update, delete on
  public.categories, public.category_translations, public.attribute_definitions,
  public.attribute_options, public.category_attributes, public.tags
  to authenticated;

-- ---------------------------------------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema app_private from public;

grant execute on function public.category_attribute_set(uuid) to authenticated;
