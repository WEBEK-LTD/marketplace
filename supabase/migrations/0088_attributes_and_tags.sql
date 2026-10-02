-- 0088 — The catalogue vocabulary, and answering it (structured listing attributes and tags).
--
-- `attribute_definitions`, `attribute_options`, `category_attributes`, `tags`, `listing_attribute_values` and
-- `listing_tags` have all existed since 0010 and 0011. The **public** half of the feature was built in 0046 and
-- 0047: `public_listing_attributes` and `public_listing_tags` already answer, the shared contract already carries
-- `attributes` and `tags` on a listing and on a service, and the public pages already render both sections.
-- They are always empty, because nothing can define an attribute, attach one to a category, or answer one.
--
-- This migration adds the missing halves: the vocabulary, the attachment, and the seller's answers.
-- `category_attributes` was referenced by no migration after 0010, and could not have been useful before —
-- an attribute attaches to a category, and until 0087 there was no way to make a category.
--
-- **No table, constraint, trigger or policy of 0010 or 0011 is changed, and nothing is created.**
--
-- ---------------------------------------------------------------------------------------------------
-- What this does not decide
-- ---------------------------------------------------------------------------------------------------
-- Every rule about what an answer may be is 0011's, and is called rather than restated:
--
--   `app_private.tg_listing_attribute_value_rule()`  the value must match the definition's `data_type`; a
--                                                    single-select takes one option; every option must belong
--                                                    to its own attribute. Each refusal has its own SQLSTATE.
--   `app_private.tg_listing_tags_usage()`            maintains `tags.usage_count`
--   `attribute_definitions_data_type_allowed`        the five data types
--   `attribute_options_attribute_definition_id_value_key`, `tags_slug_key`, the label and format constraints
--
-- So no writer here checks a value against its type: it inserts, and the trigger decides. A second copy of that
-- rule is exactly what would drift.
--
-- **`is_required` is advisory in this increment (owner decision).** It is stored, read, and shown to a seller as
-- a required field, and **nothing refuses a submission because of it**. `seller_listing_submit` and
-- `seller_service_submit` are untouched: no parameter, no call, no change. Submission-time enforcement is a
-- separate increment if it is ever wanted.
--
-- **`is_filterable` is stored and reported, and nothing filters.** Search faceting is described nowhere in the
-- specification and `/v1/search` has no attribute filter, so building one would mean inventing the facet model.
-- The flag is carried for whoever specifies it.
--
-- ---------------------------------------------------------------------------------------------------
-- What cannot be changed, and why
-- ---------------------------------------------------------------------------------------------------
-- Three values are writable once and never again, each for a reason that is in the schema rather than in taste:
--
--   `attribute_definitions.key`   the public contract exposes it as the attribute's identity (`ListingAttribute.key`),
--                                 so a client may have stored it. Same standing as a slug.
--   `attribute_definitions.data_type`  every stored answer is typed by it. Changing it would make existing rows
--                                 invalid against a trigger that only runs on write, so they would simply be
--                                 wrong and nothing would say so.
--   `attribute_options.value`     the option's machine identity, unique within its attribute.
--   `tags.slug`                   the tag's public identity.
--
-- Labels, units, ordering and the active state are all editable, which is everything a person actually edits.
--
-- ---------------------------------------------------------------------------------------------------
-- Attribution
-- ---------------------------------------------------------------------------------------------------
-- 0010's and 0011's audit triggers already record changes to these tables. As in 0087, nothing here publishes an
-- audit actor: `app.audit_actor_id` is the 8-B channel whose contract is closed and enforced by
-- `public.audit_attribution_problems()`, none of these tables has a `created_by`/`updated_by` column, and the
-- specification defines none. The audit row records the truthful `system` actor rather than an invented one.

-- ---------------------------------------------------------------------------------------------------
-- 1. The two permission predicates
-- ---------------------------------------------------------------------------------------------------
-- The keys are 0033's, seeded, and the RLS policies on these tables name exactly these two with `is_aal2()`.
-- There is deliberately **no** `catalog.attribute.read` or `catalog.tag.read` in the seed, so the manage key is
-- the only key either surface has, and reading is gated on it. Inventing a read key is not this increment's to do.
create or replace function app_private.attribute_can_manage(p_user_id uuid, p_is_aal2 boolean)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
      from public.user_roles ur
      join public.roles r on r.key = ur.role_key
      join public.role_permissions rp on rp.role_key = r.key
     where ur.user_id = p_user_id
       and ur.revoked_at is null
       and (ur.expires_at is null or ur.expires_at > now())
       and rp.permission_key = 'catalog.attribute.manage'
       and (not r.requires_mfa or coalesce(p_is_aal2, false))
  );
$$;

comment on function app_private.attribute_can_manage(uuid, boolean) is
  'Whether one account effectively holds catalog.attribute.manage — the key as a literal, with 0003''s requires_mfa rule applied to the assurance level as a parameter. The seed defines no separate read key, so this one governs reading the vocabulary as well.';

create or replace function app_private.tag_can_manage(p_user_id uuid, p_is_aal2 boolean)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
      from public.user_roles ur
      join public.roles r on r.key = ur.role_key
      join public.role_permissions rp on rp.role_key = r.key
     where ur.user_id = p_user_id
       and ur.revoked_at is null
       and (ur.expires_at is null or ur.expires_at > now())
       and rp.permission_key = 'catalog.tag.manage'
       and (not r.requires_mfa or coalesce(p_is_aal2, false))
  );
$$;

comment on function app_private.tag_can_manage(uuid, boolean) is
  'Whether one account effectively holds catalog.tag.manage, under the same rule. The seed defines no catalog.tag.read, so this key governs reading tags in the console too.';

-- ---------------------------------------------------------------------------------------------------
-- 2. The attribute definitions
-- ---------------------------------------------------------------------------------------------------
-- The whole vocabulary, including the inactive: a console that hid those could not bring one back.
--
-- `option_count` and `category_count` travel with each row because both decide what a person may safely do: an
-- attribute attached to categories cannot be removed (0010's foreign key restricts it), and a select type with no
-- options is one nobody can answer.
drop function if exists app_private.attribute_definitions_for_staff(uuid, boolean);
create or replace function app_private.attribute_definitions_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean
) returns table (
  definition_id uuid,
  key text,
  data_type text,
  unit text,
  name_en text,
  name_ar text,
  is_filterable boolean,
  is_active boolean,
  sort_order integer,
  option_count integer,
  category_count integer,
  answer_count integer,
  created_at timestamptz,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    d.id,
    d.key,
    d.data_type,
    d.unit,
    d.name_en,
    d.name_ar,
    d.is_filterable,
    d.is_active,
    d.sort_order,
    (select count(*)::integer from public.attribute_options o where o.attribute_definition_id = d.id),
    (select count(*)::integer from public.category_attributes ca where ca.attribute_definition_id = d.id),
    (select count(*)::integer from public.listing_attribute_values v where v.attribute_definition_id = d.id),
    d.created_at,
    d.updated_at
    from public.attribute_definitions d
   where app_private.attribute_can_manage(p_user_id, p_is_aal2)
   order by d.sort_order, d.key;
$$;

comment on function app_private.attribute_definitions_for_staff(uuid, boolean) is
  'Every attribute definition for the console, including the inactive, in the order they are presented. Carries how many options it has, how many categories use it and how many listings have answered it. Empty for a caller without catalog.attribute.manage.';

create or replace function app_private.attribute_definition_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_definition_id uuid
) returns table (
  definition_id uuid,
  key text,
  data_type text,
  unit text,
  name_en text,
  name_ar text,
  is_filterable boolean,
  is_active boolean,
  sort_order integer,
  option_count integer,
  category_count integer,
  answer_count integer,
  created_at timestamptz,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    d.id, d.key, d.data_type, d.unit, d.name_en, d.name_ar, d.is_filterable, d.is_active, d.sort_order,
    (select count(*)::integer from public.attribute_options o where o.attribute_definition_id = d.id),
    (select count(*)::integer from public.category_attributes ca where ca.attribute_definition_id = d.id),
    (select count(*)::integer from public.listing_attribute_values v where v.attribute_definition_id = d.id),
    d.created_at,
    d.updated_at
    from public.attribute_definitions d
   where d.id = p_definition_id
     and app_private.attribute_can_manage(p_user_id, p_is_aal2);
$$;

comment on function app_private.attribute_definition_for_staff(uuid, boolean, uuid) is
  'One attribute definition for the console. No row for a caller without the key, which is the same answer as a definition that does not exist.';

create or replace function app_private.attribute_options_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_definition_id uuid
) returns table (
  option_id uuid,
  value text,
  label_en text,
  label_ar text,
  sort_order integer,
  is_active boolean,
  answer_count integer,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    o.id, o.value, o.label_en, o.label_ar, o.sort_order, o.is_active,
    (select count(*)::integer from public.listing_attribute_values v where o.id = any(v.option_ids)),
    o.updated_at
    from public.attribute_options o
   where o.attribute_definition_id = p_definition_id
     and app_private.attribute_can_manage(p_user_id, p_is_aal2)
   order by o.sort_order, o.value;
$$;

comment on function app_private.attribute_options_for_staff(uuid, boolean, uuid) is
  'The options of one attribute definition, including the inactive, with how many listings chose each. Empty without the key.';

-- The key and the data type are given once. Both are explained in the header: the key is the attribute's public
-- identity, and the data type is what every stored answer is typed by.
create or replace function app_private.attribute_definition_create_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_key text,
  p_data_type text,
  p_name_en text,
  p_name_ar text,
  p_unit text default null,
  p_is_filterable boolean default true,
  p_sort_order integer default 0
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  new_id uuid;
begin
  if not app_private.attribute_can_manage(p_user_id, p_is_aal2) then
    raise exception 'managing the attribute vocabulary requires catalog.attribute.manage at aal2'
      using errcode = 'insufficient_privilege';
  end if;

  -- Created inactive, for the same reason a category is: a select type with no options yet is one nobody can
  -- answer, and an attribute reaches a seller's form the moment it is attached to their category.
  insert into public.attribute_definitions
    (key, data_type, unit, name_en, name_ar, is_filterable, is_active, sort_order)
  values (
    p_key,
    p_data_type,
    nullif(btrim(coalesce(p_unit, '')), ''),
    p_name_en,
    p_name_ar,
    coalesce(p_is_filterable, true),
    false,
    coalesce(p_sort_order, 0)
  )
  returning id into new_id;

  return new_id;
end;
$$;

comment on function app_private.attribute_definition_create_for_staff(uuid, boolean, text, text, text, text, text, boolean, integer) is
  'Creates one attribute definition, always inactive, at the key and data type given — neither of which can change afterwards. Raises insufficient_privilege (42501) without the manage key.';

-- Labels, unit, filterability and ordering. `key`, `data_type` and `is_active` are absent: the first two can
-- never change, and the active state is its own call so that a relabel never makes an attribute appear.
create or replace function app_private.attribute_definition_update_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_definition_id uuid,
  p_name_en text,
  p_name_ar text,
  p_unit text,
  p_is_filterable boolean,
  p_sort_order integer
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  changed integer;
begin
  if not app_private.attribute_can_manage(p_user_id, p_is_aal2) then
    raise exception 'managing the attribute vocabulary requires catalog.attribute.manage at aal2'
      using errcode = 'insufficient_privilege';
  end if;

  update public.attribute_definitions d
     set name_en = p_name_en,
         name_ar = p_name_ar,
         unit = nullif(btrim(coalesce(p_unit, '')), ''),
         is_filterable = coalesce(p_is_filterable, d.is_filterable),
         sort_order = coalesce(p_sort_order, d.sort_order)
   where d.id = p_definition_id;

  get diagnostics changed = row_count;
  return changed > 0;
end;
$$;

comment on function app_private.attribute_definition_update_for_staff(uuid, boolean, uuid, text, text, text, boolean, integer) is
  'Changes an attribute''s labels, unit, filterability and ordering. The key, the data type and the active state are not parameters, so none of the three can change here.';

-- Showing a select type with no options would put an unanswerable field on a seller's form, so it is refused.
create or replace function app_private.attribute_definition_state_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_definition_id uuid,
  p_is_active boolean
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  kind text;
  live_options integer;
  changed integer;
begin
  if not app_private.attribute_can_manage(p_user_id, p_is_aal2) then
    raise exception 'managing the attribute vocabulary requires catalog.attribute.manage at aal2'
      using errcode = 'insufficient_privilege';
  end if;

  select d.data_type into kind from public.attribute_definitions d where d.id = p_definition_id;
  if kind is null then
    return false;
  end if;

  if p_is_active and kind in ('single_select', 'multi_select') then
    select count(*) into live_options
      from public.attribute_options o
     where o.attribute_definition_id = p_definition_id and o.is_active;
    if live_options = 0 then
      raise exception 'a select attribute needs at least one active option before it is shown'
        using errcode = 'restrict_violation';
    end if;
  end if;

  update public.attribute_definitions d set is_active = p_is_active where d.id = p_definition_id;
  get diagnostics changed = row_count;
  return changed > 0;
end;
$$;

comment on function app_private.attribute_definition_state_for_staff(uuid, boolean, uuid, boolean) is
  'Shows or hides one attribute definition. Showing a select type with no active option is refused (restrict_violation), because it would put a field nobody can answer on a seller''s form.';

-- ---------------------------------------------------------------------------------------------------
-- 3. The options of a select attribute
-- ---------------------------------------------------------------------------------------------------
-- Only a select type has options. Adding one to a text or number attribute is refused rather than stored and
-- ignored, because a stored option nobody can ever choose is a thing somebody will later try to explain.
create or replace function app_private.attribute_option_create_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_definition_id uuid,
  p_value text,
  p_label_en text,
  p_label_ar text,
  p_sort_order integer default 0
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  kind text;
  new_id uuid;
begin
  if not app_private.attribute_can_manage(p_user_id, p_is_aal2) then
    raise exception 'managing the attribute vocabulary requires catalog.attribute.manage at aal2'
      using errcode = 'insufficient_privilege';
  end if;

  select d.data_type into kind from public.attribute_definitions d where d.id = p_definition_id;
  if kind is null then
    raise exception 'attribute % does not exist', p_definition_id using errcode = 'foreign_key_violation';
  end if;
  if kind not in ('single_select', 'multi_select') then
    raise exception 'only a select attribute has options' using errcode = 'restrict_violation';
  end if;

  insert into public.attribute_options
    (attribute_definition_id, value, label_en, label_ar, sort_order, is_active)
  values (p_definition_id, p_value, p_label_en, p_label_ar, coalesce(p_sort_order, 0), true)
  returning id into new_id;

  update public.attribute_definitions d set updated_at = now() where d.id = p_definition_id;
  return new_id;
end;
$$;

comment on function app_private.attribute_option_create_for_staff(uuid, boolean, uuid, text, text, text, integer) is
  'Adds one option to a select attribute, active. Refused for a text, number or boolean attribute (restrict_violation), and the value is unique within the attribute (0010).';

create or replace function app_private.attribute_option_update_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_option_id uuid,
  p_label_en text,
  p_label_ar text,
  p_sort_order integer
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  changed integer;
begin
  if not app_private.attribute_can_manage(p_user_id, p_is_aal2) then
    raise exception 'managing the attribute vocabulary requires catalog.attribute.manage at aal2'
      using errcode = 'insufficient_privilege';
  end if;

  update public.attribute_options o
     set label_en = p_label_en,
         label_ar = p_label_ar,
         sort_order = coalesce(p_sort_order, o.sort_order)
   where o.id = p_option_id;

  get diagnostics changed = row_count;
  return changed > 0;
end;
$$;

comment on function app_private.attribute_option_update_for_staff(uuid, boolean, uuid, text, text, integer) is
  'Changes one option''s labels and ordering. The value is not a parameter: it is the option''s machine identity, unique within its attribute.';

-- Hiding an option leaves every answer that chose it exactly as it is. The public reader joins active options,
-- so the answer stops being shown without being rewritten — which is what lets a vocabulary change be undone.
create or replace function app_private.attribute_option_state_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_option_id uuid,
  p_is_active boolean
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  changed integer;
begin
  if not app_private.attribute_can_manage(p_user_id, p_is_aal2) then
    raise exception 'managing the attribute vocabulary requires catalog.attribute.manage at aal2'
      using errcode = 'insufficient_privilege';
  end if;

  update public.attribute_options o set is_active = p_is_active where o.id = p_option_id;
  get diagnostics changed = row_count;
  return changed > 0;
end;
$$;

comment on function app_private.attribute_option_state_for_staff(uuid, boolean, uuid, boolean) is
  'Shows or hides one option. Answers that chose it are left untouched, so hiding is reversible.';

-- ---------------------------------------------------------------------------------------------------
-- 4. Tags
-- ---------------------------------------------------------------------------------------------------
drop function if exists app_private.tags_for_staff(uuid, boolean);
create or replace function app_private.tags_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean
) returns table (
  tag_id uuid,
  slug text,
  name_en text,
  name_ar text,
  is_active boolean,
  usage_count integer,
  created_at timestamptz,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select t.id, t.slug, t.name_en, t.name_ar, t.is_active, t.usage_count, t.created_at, t.updated_at
    from public.tags t
   where app_private.tag_can_manage(p_user_id, p_is_aal2)
   order by t.slug;
$$;

comment on function app_private.tags_for_staff(uuid, boolean) is
  'Every tag for the console, including the inactive, in slug order. `usage_count` is 0010''s own, maintained by its trigger. Empty for a caller without catalog.tag.manage.';

create or replace function app_private.tag_create_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_slug text,
  p_name_en text,
  p_name_ar text
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  new_id uuid;
begin
  if not app_private.tag_can_manage(p_user_id, p_is_aal2) then
    raise exception 'managing tags requires catalog.tag.manage at aal2'
      using errcode = 'insufficient_privilege';
  end if;

  -- A tag is created active: unlike a category or an attribute it has nothing to be filled in first, and a
  -- seller choosing it is the only way it is ever used.
  insert into public.tags (slug, name_en, name_ar, is_active)
  values (p_slug, p_name_en, p_name_ar, true)
  returning id into new_id;

  return new_id;
end;
$$;

comment on function app_private.tag_create_for_staff(uuid, boolean, text, text, text) is
  'Creates one tag, active, at the slug given, which cannot change afterwards: it is the tag''s public identity. The slug is unique (0010).';

create or replace function app_private.tag_update_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_tag_id uuid,
  p_name_en text,
  p_name_ar text
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  changed integer;
begin
  if not app_private.tag_can_manage(p_user_id, p_is_aal2) then
    raise exception 'managing tags requires catalog.tag.manage at aal2'
      using errcode = 'insufficient_privilege';
  end if;

  update public.tags t set name_en = p_name_en, name_ar = p_name_ar where t.id = p_tag_id;
  get diagnostics changed = row_count;
  return changed > 0;
end;
$$;

comment on function app_private.tag_update_for_staff(uuid, boolean, uuid, text, text) is
  'Changes one tag''s names. The slug is not a parameter and `usage_count` is the trigger''s, so neither can be written here.';

create or replace function app_private.tag_state_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_tag_id uuid,
  p_is_active boolean
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  changed integer;
begin
  if not app_private.tag_can_manage(p_user_id, p_is_aal2) then
    raise exception 'managing tags requires catalog.tag.manage at aal2'
      using errcode = 'insufficient_privilege';
  end if;

  update public.tags t set is_active = p_is_active where t.id = p_tag_id;
  get diagnostics changed = row_count;
  return changed > 0;
end;
$$;

comment on function app_private.tag_state_for_staff(uuid, boolean, uuid, boolean) is
  'Shows or hides one tag. A hidden tag can no longer be chosen; listings that already carry it keep it, and the public reader joins active tags, so it stops being shown without being removed.';

-- ---------------------------------------------------------------------------------------------------
-- 5. Attaching an attribute to a category
-- ---------------------------------------------------------------------------------------------------
-- Governed by `catalog.category.manage`, which is what `category_attributes`' own RLS write policy names — not
-- by the attribute key. Deciding which attributes a category asks for is a decision about the category.
--
-- The read is gated on `catalog.category.read`, 0087's predicate, for the same reason: this is the category's
-- panel. So a colleague who may read the catalogue tree can see what a category asks for without holding the
-- vocabulary key.
create or replace function app_private.category_attributes_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_category_id uuid
) returns table (
  definition_id uuid,
  key text,
  data_type text,
  unit text,
  name_en text,
  name_ar text,
  definition_is_active boolean,
  is_required boolean,
  is_filterable boolean,
  sort_order integer,
  option_count integer
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    d.id, d.key, d.data_type, d.unit, d.name_en, d.name_ar, d.is_active,
    ca.is_required, ca.is_filterable, ca.sort_order,
    (select count(*)::integer from public.attribute_options o
      where o.attribute_definition_id = d.id and o.is_active)
    from public.category_attributes ca
    join public.attribute_definitions d on d.id = ca.attribute_definition_id
   where ca.category_id = p_category_id
     and app_private.category_can_read(p_user_id, p_is_aal2)
   order by ca.sort_order, d.key;
$$;

comment on function app_private.category_attributes_for_staff(uuid, boolean, uuid) is
  'What one category asks a seller for, in the order it asks. Carries whether the definition itself is active, because an inactive attribute still attached is one no seller is shown. Gated on catalog.category.read: this is the category''s panel.';

create or replace function app_private.category_attribute_attach_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_category_id uuid,
  p_definition_id uuid,
  p_is_required boolean default false,
  p_is_filterable boolean default true,
  p_sort_order integer default 0
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if not app_private.category_can_manage(p_user_id, p_is_aal2) then
    raise exception 'attaching an attribute requires catalog.category.manage at aal2'
      using errcode = 'insufficient_privilege';
  end if;

  -- An upsert, so attaching something already attached updates how it is asked rather than failing. The two
  -- foreign keys decide whether the category and the attribute exist.
  insert into public.category_attributes
    (category_id, attribute_definition_id, is_required, is_filterable, sort_order)
  values (
    p_category_id,
    p_definition_id,
    coalesce(p_is_required, false),
    coalesce(p_is_filterable, true),
    coalesce(p_sort_order, 0)
  )
  on conflict (category_id, attribute_definition_id) do update
     set is_required = excluded.is_required,
         is_filterable = excluded.is_filterable,
         sort_order = excluded.sort_order;

  update public.categories c set updated_at = now() where c.id = p_category_id;
  return true;
end;
$$;

comment on function app_private.category_attribute_attach_for_staff(uuid, boolean, uuid, uuid, boolean, boolean, integer) is
  'Attaches one attribute to one category, or updates how it is asked. `is_required` is advisory in this increment: it is stored and shown, and no writer refuses a submission because of it.';

create or replace function app_private.category_attribute_detach_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_category_id uuid,
  p_definition_id uuid
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  changed integer;
begin
  if not app_private.category_can_manage(p_user_id, p_is_aal2) then
    raise exception 'detaching an attribute requires catalog.category.manage at aal2'
      using errcode = 'insufficient_privilege';
  end if;

  delete from public.category_attributes ca
   where ca.category_id = p_category_id and ca.attribute_definition_id = p_definition_id;

  get diagnostics changed = row_count;
  if changed > 0 then
    update public.categories c set updated_at = now() where c.id = p_category_id;
  end if;
  -- Answers already given are deliberately left alone. A category that stops asking a question has not made the
  -- answers wrong, and the public reader shows an answer whether or not the category still asks for it.
  return changed > 0;
end;
$$;

comment on function app_private.category_attribute_detach_for_staff(uuid, boolean, uuid, uuid) is
  'Stops one category asking for one attribute. Answers already given are left untouched: a category that stops asking has not made them wrong.';

-- ---------------------------------------------------------------------------------------------------
-- 6. What a seller is asked, and what they answered
-- ---------------------------------------------------------------------------------------------------
-- One read for the whole panel: the attributes the listing's category asks for, each with the seller's own
-- current answer and, for a select type, the options to choose from. The outcome column follows 0061's and
-- 0062's convention — these functions return an outcome rather than raising, because a seller surface answers
-- `not_found` for somebody else's listing and must not distinguish that from one that does not exist.
--
-- `p_expected_type` keeps the two seller surfaces apart exactly as 0047 keeps the public ones apart: asking the
-- listings surface about a service answers `not_found`.
/**
 * Whether one of the calling seller's own listings exists on a surface, and whether its vocabulary may be edited.
 *
 * The readers below answer with rows, and a row-shaped answer cannot tell "this listing is not yours" from "this
 * listing's category asks nothing" — both are no rows. An API that guessed between those two would either report
 * a listing absent when it is merely unasked, or report an empty form for a listing belonging to somebody else,
 * which is the more dangerous of the two. So existence and editability are their own answer, and the editability
 * rule is 0061's own, read from the same two columns rather than restated.
 */
create or replace function app_private.seller_listing_vocabulary_context(
  p_user_id uuid,
  p_slug text,
  p_expected_type text
) returns table (
  outcome text,
  is_editable boolean
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    case when l.id is null then 'not_found' else 'found' end,
    coalesce(s.status in ('pending', 'active') and l.status = 'draft', false)
    from (select 1) as always
    left join public.seller_profiles s on s.user_id = p_user_id
    left join public.listings l
      on l.slug = p_slug
     and l.seller_user_id = p_user_id
     and l.deleted_at is null
     and (p_expected_type is null or l.listing_type_code = p_expected_type);
$$;

comment on function app_private.seller_listing_vocabulary_context(uuid, text, text) is
  'Whether one of the calling seller''s own listings exists on the named surface, and whether its attributes and tags may be edited. The editability rule is 0061''s: the seller must be in a state that may edit, and the listing must still be a draft.';

create or replace function app_private.seller_listing_attributes(
  p_user_id uuid,
  p_slug text,
  p_expected_type text,
  p_locale text
) returns table (
  outcome text,
  definition_id uuid,
  key text,
  data_type text,
  unit text,
  label text,
  is_required boolean,
  sort_order integer,
  value_text text,
  value_number numeric,
  value_boolean boolean,
  option_ids uuid[]
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with wanted as (
    select coalesce(
      (select l.code from public.locales l
        where l.code = lower(btrim(coalesce(p_locale, ''))) and l.is_active),
      (select l.code from public.locales l where l.is_default limit 1)
    ) as code
  ), target as (
    select l.id, l.category_id
      from public.listings l
     where l.slug = p_slug
       and l.seller_user_id = p_user_id
       and l.deleted_at is null
       and (p_expected_type is null or l.listing_type_code = p_expected_type)
  )
  select
    'found'::text,
    d.id,
    d.key,
    d.data_type,
    d.unit,
    case when (select code from wanted) = 'ar' then d.name_ar else d.name_en end,
    ca.is_required,
    ca.sort_order,
    v.value_text,
    v.value_number,
    v.value_boolean,
    coalesce(v.option_ids, array[]::uuid[])
    from target t
    join public.category_attributes ca on ca.category_id = t.category_id
    join public.attribute_definitions d on d.id = ca.attribute_definition_id and d.is_active
    left join public.listing_attribute_values v
      on v.listing_id = t.id and v.attribute_definition_id = d.id
   order by ca.sort_order, d.key;
$$;

comment on function app_private.seller_listing_attributes(uuid, text, text, text) is
  'What one of the calling seller''s own listings is asked, with the answers already given. Only active definitions appear, so hiding an attribute removes the field. Scoped to the caller''s own rows by the where clause; an empty result also means no such listing on that surface.';

-- The options a seller may choose from, for the select attributes of one listing's category. A separate reader
-- rather than an array on the row above, because options are per attribute and a row-shaped result cannot nest.
create or replace function app_private.seller_listing_attribute_options(
  p_user_id uuid,
  p_slug text,
  p_expected_type text,
  p_locale text
) returns table (
  definition_id uuid,
  option_id uuid,
  value text,
  label text,
  sort_order integer
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with wanted as (
    select coalesce(
      (select l.code from public.locales l
        where l.code = lower(btrim(coalesce(p_locale, ''))) and l.is_active),
      (select l.code from public.locales l where l.is_default limit 1)
    ) as code
  ), target as (
    select l.category_id
      from public.listings l
     where l.slug = p_slug
       and l.seller_user_id = p_user_id
       and l.deleted_at is null
       and (p_expected_type is null or l.listing_type_code = p_expected_type)
  )
  select
    o.attribute_definition_id,
    o.id,
    o.value,
    case when (select code from wanted) = 'ar' then o.label_ar else o.label_en end,
    o.sort_order
    from target t
    join public.category_attributes ca on ca.category_id = t.category_id
    join public.attribute_definitions d on d.id = ca.attribute_definition_id and d.is_active
    join public.attribute_options o on o.attribute_definition_id = d.id and o.is_active
   order by o.attribute_definition_id, o.sort_order, o.value;
$$;

comment on function app_private.seller_listing_attribute_options(uuid, text, text, text) is
  'The active options a seller may choose from, for the select attributes of one of their own listings. Inactive options are absent, so a withdrawn option cannot be chosen again while an existing answer keeps it.';

/**
 * Saves the answers to one listing's attributes.
 *
 * Replaces the whole set: an attribute absent from `p_answers` has its answer removed, which is how a seller
 * clears one. Editing is **draft only** and the seller must be in a state that may edit — both rules are
 * 0061's, read from the same columns, so this surface cannot be a way around them.
 *
 * Nothing here checks a value against its type. `tg_listing_attribute_value_rule` does that on every row, and a
 * second copy of the rule is what would drift.
 *
 * `p_answers` is a jsonb array of objects: `key`, and then `text`, `number`, `boolean` or `options` (an array of
 * option values) according to the attribute's own data type.
 */
create or replace function app_private.seller_listing_attributes_save(
  p_user_id uuid,
  p_slug text,
  p_expected_type text,
  p_answers jsonb
) returns table (outcome text)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_seller_status text;
  v_listing_id uuid;
  v_listing_status text;
  v_category_id uuid;
  v_answer jsonb;
  v_definition public.attribute_definitions;
  v_option_ids uuid[];
  v_answered uuid[] := array[]::uuid[];
begin
  if p_user_id is null then
    return query select 'not_found'::text;
    return;
  end if;

  select s.status into v_seller_status from public.seller_profiles s where s.user_id = p_user_id;
  if v_seller_status is null then
    return query select 'not_found'::text;
    return;
  end if;
  -- 0061's own rule, read from the same column.
  if v_seller_status not in ('pending', 'active') then
    return query select 'not_editable'::text;
    return;
  end if;

  select l.id, l.status, l.category_id into v_listing_id, v_listing_status, v_category_id
    from public.listings l
   where l.slug = p_slug
     and l.seller_user_id = p_user_id
     and l.deleted_at is null
     and (p_expected_type is null or l.listing_type_code = p_expected_type);

  if v_listing_id is null then
    return query select 'not_found'::text;
    return;
  end if;
  if v_listing_status <> 'draft' then
    return query select 'not_editable'::text;
    return;
  end if;

  if p_answers is null or jsonb_typeof(p_answers) <> 'array' then
    return query select 'invalid'::text;
    return;
  end if;

  -- Every answer is applied inside one nested block, for two reasons. The first is that a refusal must leave
  -- the listing exactly as it was rather than half re-answered: the block is a subtransaction, so an abort
  -- anywhere undoes the answers already written in this call. The second is that **0011's trigger is the only
  -- judge of a type rule**, and it judges by raising: a wrong type and a bad option set arrive here as
  -- check_violation, an attribute the trigger does not know as foreign_key_violation, and a number or boolean
  -- that is not one as 22P02 from the cast. None of them is restated above, and all of them mean the one thing
  -- a seller needs to be told — the answer was not acceptable.
  begin
  for v_answer in select * from jsonb_array_elements(p_answers) loop
    if jsonb_typeof(v_answer) <> 'object' then
      raise exception 'an answer must be an object' using errcode = 'data_exception';
    end if;

    -- The attribute must be one this category actually asks for, and still active. Anything else is a request
    -- to answer a question nobody asked.
    select d.* into v_definition
      from public.category_attributes ca
      join public.attribute_definitions d on d.id = ca.attribute_definition_id and d.is_active
     where ca.category_id = v_category_id
       and d.key = (v_answer ->> 'key');

    if v_definition.id is null then
      raise exception 'this category does not ask for %', v_answer ->> 'key' using errcode = 'data_exception';
    end if;

    -- Options arrive as values, which is what a form holds, and are resolved to ids here. An inactive option
    -- cannot be chosen; an unknown one makes the whole save invalid rather than being dropped silently.
    v_option_ids := array[]::uuid[];
    if v_definition.data_type in ('single_select', 'multi_select') then
      if jsonb_typeof(v_answer -> 'options') <> 'array' then
        raise exception 'a select answer carries an array of option values' using errcode = 'data_exception';
      end if;
      select coalesce(array_agg(o.id order by o.sort_order, o.value), array[]::uuid[])
        into v_option_ids
        from jsonb_array_elements_text(v_answer -> 'options') as chosen(value)
        join public.attribute_options o
          on o.attribute_definition_id = v_definition.id and o.value = chosen.value and o.is_active;

      if cardinality(v_option_ids)
         <> (select count(*) from jsonb_array_elements_text(v_answer -> 'options')) then
        raise exception 'an option is unknown, inactive or not this attribute''s'
          using errcode = 'data_exception';
      end if;
    end if;

    insert into public.listing_attribute_values
      (listing_id, attribute_definition_id, value_text, value_number, value_boolean, option_ids)
    values (
      v_listing_id,
      v_definition.id,
      case when v_definition.data_type = 'text' then nullif(btrim(coalesce(v_answer ->> 'text', '')), '') end,
      case when v_definition.data_type = 'number' then (v_answer ->> 'number')::numeric end,
      case when v_definition.data_type = 'boolean' then (v_answer ->> 'boolean')::boolean end,
      v_option_ids
    )
    on conflict (listing_id, attribute_definition_id) do update
       set value_text = excluded.value_text,
           value_number = excluded.value_number,
           value_boolean = excluded.value_boolean,
           option_ids = excluded.option_ids;

    v_answered := v_answered || v_definition.id;
  end loop;

  -- Whatever was not answered this time is no longer answered. This is how a seller clears a field.
  delete from public.listing_attribute_values v
   where v.listing_id = v_listing_id
     and not (v.attribute_definition_id = any(v_answered));

  update public.listings l set updated_at = now() where l.id = v_listing_id;
  exception
    when check_violation or foreign_key_violation or data_exception then
      return query select 'invalid'::text;
      return;
  end;

  return query select 'saved'::text;
end;
$$;

comment on function app_private.seller_listing_attributes_save(uuid, text, text, jsonb) is
  'Replaces the answers to one of the calling seller''s own draft listings. Only attributes the category asks for and only active definitions and options may be answered; every type rule is 0011''s trigger. Draft only, and the seller must be in a state that may edit — both 0061''s rules. is_required is not enforced here: it is advisory in this increment.';

/** Replaces the tags on one of the calling seller's own draft listings. Only active tags, chosen by slug. */
create or replace function app_private.seller_listing_tags_save(
  p_user_id uuid,
  p_slug text,
  p_expected_type text,
  p_tag_slugs text[]
) returns table (outcome text)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_seller_status text;
  v_listing_id uuid;
  v_listing_status text;
  v_tag_ids uuid[];
begin
  if p_user_id is null then
    return query select 'not_found'::text;
    return;
  end if;

  select s.status into v_seller_status from public.seller_profiles s where s.user_id = p_user_id;
  if v_seller_status is null then
    return query select 'not_found'::text;
    return;
  end if;
  if v_seller_status not in ('pending', 'active') then
    return query select 'not_editable'::text;
    return;
  end if;

  select l.id, l.status into v_listing_id, v_listing_status
    from public.listings l
   where l.slug = p_slug
     and l.seller_user_id = p_user_id
     and l.deleted_at is null
     and (p_expected_type is null or l.listing_type_code = p_expected_type);

  if v_listing_id is null then
    return query select 'not_found'::text;
    return;
  end if;
  if v_listing_status <> 'draft' then
    return query select 'not_editable'::text;
    return;
  end if;

  select coalesce(array_agg(distinct t.id), array[]::uuid[]) into v_tag_ids
    from unnest(coalesce(p_tag_slugs, array[]::text[])) as s(slug)
    join public.tags t on t.slug = btrim(s.slug) and t.is_active;

  -- An unknown or hidden tag makes the whole selection invalid rather than being dropped, so a seller is never
  -- told their tags were saved when one of them was not.
  if cardinality(v_tag_ids) <> (
       select count(distinct btrim(s.slug))
         from unnest(coalesce(p_tag_slugs, array[]::text[])) as s(slug)
        where btrim(s.slug) <> ''
     ) then
    return query select 'invalid'::text;
    return;
  end if;
  -- Replace the set. `tg_listing_tags_usage` keeps `tags.usage_count` right on both sides of this.
  delete from public.listing_tags lt
   where lt.listing_id = v_listing_id
     and not (lt.tag_id = any(v_tag_ids));

  insert into public.listing_tags (listing_id, tag_id)
  select v_listing_id, id from unnest(v_tag_ids) as chosen(id)
  on conflict (listing_id, tag_id) do nothing;

  update public.listings l set updated_at = now() where l.id = v_listing_id;
  return query select 'saved'::text;
end;
$$;

comment on function app_private.seller_listing_tags_save(uuid, text, text, text[]) is
  'Replaces the tags on one of the calling seller''s own draft listings, by slug. An unknown or hidden tag makes the whole selection invalid. usage_count is 0010''s trigger''s. Draft only, and the seller must be in a state that may edit.';

/** The tags one of the calling seller's own listings carries, and the ones they may choose from. */
create or replace function app_private.seller_listing_tag_choices(
  p_user_id uuid,
  p_slug text,
  p_expected_type text,
  p_locale text
) returns table (
  slug text,
  label text,
  is_selected boolean
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with wanted as (
    select coalesce(
      (select l.code from public.locales l
        where l.code = lower(btrim(coalesce(p_locale, ''))) and l.is_active),
      (select l.code from public.locales l where l.is_default limit 1)
    ) as code
  ), target as (
    select l.id
      from public.listings l
     where l.slug = p_slug
       and l.seller_user_id = p_user_id
       and l.deleted_at is null
       and (p_expected_type is null or l.listing_type_code = p_expected_type)
  )
  select
    t.slug,
    case when (select code from wanted) = 'ar' then t.name_ar else t.name_en end,
    exists (select 1 from public.listing_tags lt, target g where lt.tag_id = t.id and lt.listing_id = g.id)
    from public.tags t
   where t.is_active
     and exists (select 1 from target)
   order by t.slug;
$$;

comment on function app_private.seller_listing_tag_choices(uuid, text, text, text) is
  'Every active tag, with whether this listing carries it. Empty when the slug names no listing of the caller''s on that surface, so a seller learns nothing about anybody else''s.';

-- ---------------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on function app_private.attribute_can_manage(uuid, boolean) from public;
revoke execute on function app_private.tag_can_manage(uuid, boolean) from public;
revoke execute on function app_private.attribute_definitions_for_staff(uuid, boolean) from public;
revoke execute on function app_private.attribute_definition_for_staff(uuid, boolean, uuid) from public;
revoke execute on function app_private.attribute_options_for_staff(uuid, boolean, uuid) from public;
revoke execute on function app_private.attribute_definition_create_for_staff(uuid, boolean, text, text, text, text, text, boolean, integer) from public;
revoke execute on function app_private.attribute_definition_update_for_staff(uuid, boolean, uuid, text, text, text, boolean, integer) from public;
revoke execute on function app_private.attribute_definition_state_for_staff(uuid, boolean, uuid, boolean) from public;
revoke execute on function app_private.attribute_option_create_for_staff(uuid, boolean, uuid, text, text, text, integer) from public;
revoke execute on function app_private.attribute_option_update_for_staff(uuid, boolean, uuid, text, text, integer) from public;
revoke execute on function app_private.attribute_option_state_for_staff(uuid, boolean, uuid, boolean) from public;
revoke execute on function app_private.tags_for_staff(uuid, boolean) from public;
revoke execute on function app_private.tag_create_for_staff(uuid, boolean, text, text, text) from public;
revoke execute on function app_private.tag_update_for_staff(uuid, boolean, uuid, text, text) from public;
revoke execute on function app_private.tag_state_for_staff(uuid, boolean, uuid, boolean) from public;
revoke execute on function app_private.category_attributes_for_staff(uuid, boolean, uuid) from public;
revoke execute on function app_private.category_attribute_attach_for_staff(uuid, boolean, uuid, uuid, boolean, boolean, integer) from public;
revoke execute on function app_private.category_attribute_detach_for_staff(uuid, boolean, uuid, uuid) from public;
revoke execute on function app_private.seller_listing_vocabulary_context(uuid, text, text) from public;
revoke execute on function app_private.seller_listing_attributes(uuid, text, text, text) from public;
revoke execute on function app_private.seller_listing_attribute_options(uuid, text, text, text) from public;
revoke execute on function app_private.seller_listing_attributes_save(uuid, text, text, jsonb) from public;
revoke execute on function app_private.seller_listing_tags_save(uuid, text, text, text[]) from public;
revoke execute on function app_private.seller_listing_tag_choices(uuid, text, text, text) from public;

-- `app_system` only. The worker neither edits the vocabulary nor answers it.
grant execute on function app_private.attribute_can_manage(uuid, boolean) to app_system;
grant execute on function app_private.tag_can_manage(uuid, boolean) to app_system;
grant execute on function app_private.attribute_definitions_for_staff(uuid, boolean) to app_system;
grant execute on function app_private.attribute_definition_for_staff(uuid, boolean, uuid) to app_system;
grant execute on function app_private.attribute_options_for_staff(uuid, boolean, uuid) to app_system;
grant execute on function app_private.attribute_definition_create_for_staff(uuid, boolean, text, text, text, text, text, boolean, integer) to app_system;
grant execute on function app_private.attribute_definition_update_for_staff(uuid, boolean, uuid, text, text, text, boolean, integer) to app_system;
grant execute on function app_private.attribute_definition_state_for_staff(uuid, boolean, uuid, boolean) to app_system;
grant execute on function app_private.attribute_option_create_for_staff(uuid, boolean, uuid, text, text, text, integer) to app_system;
grant execute on function app_private.attribute_option_update_for_staff(uuid, boolean, uuid, text, text, integer) to app_system;
grant execute on function app_private.attribute_option_state_for_staff(uuid, boolean, uuid, boolean) to app_system;
grant execute on function app_private.tags_for_staff(uuid, boolean) to app_system;
grant execute on function app_private.tag_create_for_staff(uuid, boolean, text, text, text) to app_system;
grant execute on function app_private.tag_update_for_staff(uuid, boolean, uuid, text, text) to app_system;
grant execute on function app_private.tag_state_for_staff(uuid, boolean, uuid, boolean) to app_system;
grant execute on function app_private.category_attributes_for_staff(uuid, boolean, uuid) to app_system;
grant execute on function app_private.category_attribute_attach_for_staff(uuid, boolean, uuid, uuid, boolean, boolean, integer) to app_system;
grant execute on function app_private.category_attribute_detach_for_staff(uuid, boolean, uuid, uuid) to app_system;
grant execute on function app_private.seller_listing_vocabulary_context(uuid, text, text) to app_system;
grant execute on function app_private.seller_listing_attributes(uuid, text, text, text) to app_system;
grant execute on function app_private.seller_listing_attribute_options(uuid, text, text, text) to app_system;
grant execute on function app_private.seller_listing_attributes_save(uuid, text, text, jsonb) to app_system;
grant execute on function app_private.seller_listing_tags_save(uuid, text, text, text[]) to app_system;
grant execute on function app_private.seller_listing_tag_choices(uuid, text, text, text) to app_system;

select app_private.assert_security_contract();
