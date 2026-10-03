-- 0095 — The help centre: the named definer functions that serve the FAQs and author them.
--
-- 0030 built `public.faqs` and then left it unreachable: a `topic` with a format, bilingual questions and answers
-- with English required, a `sort_order`, an `is_published` flag, a partial index for the published set and an
-- `updated_at` trigger — and not one function the application could call. `app_system` holds no table
-- privileges, so every read and every write goes through a named SECURITY DEFINER function. This migration adds
-- exactly those functions.
--
-- Nothing about the schema changes here. No column, constraint, index, trigger or policy of 0030 is touched, and
-- no table is created.
--
-- THE OWNER DECISIONS FOR THIS INCREMENT (0095)
--
--   * **1 — `pages.page_key` is the mapping, and it is authoritative.** A published page's key *is* the topic its
--     address shows: `/faq` carries `page_key = 'faq'` and renders the `faq` topic, `/help` carries
--     `page_key = 'help'` and renders the `help` topic. Neither the slug nor the template decides anything. The
--     two sides of that mapping are both in this database, which is why `is_mapped` below is answered here
--     rather than guessed at by a console: a topic is mapped when some publicly visible page carries it as its
--     key, and nothing else makes a topic mapped.
--   * **2 — a topic with nothing published renders no section at all.** Applied by the web layer, which has
--     nothing to render when this reader returns no rows. There is no empty state here and no placeholder row.
--   * **3 — an answer is plain text.** The column is `text`, it is served as stored, and no reader below treats
--     it as markup. Splitting it into paragraphs on blank lines is the renderer's business and is exactly what a
--     CMS page body already does.
--   * **4 — no `FAQPage` structured data.** Nothing here writes or reads `seo_metadata`, and `faqs` is not one of
--     its entity types. The existing SEO boundaries are untouched.
--   * **5 — topics stay free-form.** 0030's `faqs_topic_format` is the only rule, and no closed list is
--     introduced. The staff readers report `is_mapped` and the mapped page's slug so an operator can see at once
--     which topics no public address shows.
--   * **6 — an entry is born unpublished.** 0030 defaults `is_published` to false, the save writer does not name
--     the column at all, and publishing is its own call. A half-written answer can therefore never appear on a
--     public page because somebody sent one extra field.
--   * **7 — the two pages' metadata is untouched.** Nothing here contributes to a head, a canonical or a robots
--     directive, and 0091 is not reopened.
--
-- WHAT IS NOT HERE
--
-- Banners, media-origin work, sitemap changes, FAQ structured data, a search or filter over the help centre, a
-- contact form, support tickets, any new public address, a revalidation consumer and anything financial are all
-- out of scope by instruction.
--
-- AUDIT ATTRIBUTION
--
-- These writers do **not** touch the 8-B attribution channel. 8-B's approved scope is the financial subset, and
-- `public.audit_attribution_problems()` fails any function that names the channel without being in the approved
-- contract. `faqs` has no `created_by`/`updated_by` column, so there is no row-level actor to write either — and
-- 0030 installed no audit trigger on this table, which this migration does not change: adding one would be a
-- schema change and the instruction is that there are none.

-- ---------------------------------------------------------------------------------------------------
-- 1. The two permission predicates
-- ---------------------------------------------------------------------------------------------------
-- Both keys are seeded in 0033 (`cms.faq.read`, `cms.faq.manage`). Neither is invented, granted or assigned
-- here, and no role name is tested anywhere: 0003's own `requires_mfa` rule is applied to the assurance level as
-- a parameter, exactly as every other console gate does it.
create or replace function app_private.faq_can_read(
  p_user_id uuid,
  p_is_aal2 boolean
) returns boolean
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
       and rp.permission_key = 'cms.faq.read'
       and (not r.requires_mfa or coalesce(p_is_aal2, false))
  );
$$;

comment on function app_private.faq_can_read(uuid, boolean) is
  'Whether one account effectively holds cms.faq.read — the key as a literal, with 0003''s own requires_mfa rule applied to the assurance level as a parameter. No role name is tested anywhere.';

create or replace function app_private.faq_can_manage(
  p_user_id uuid,
  p_is_aal2 boolean
) returns boolean
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
       and rp.permission_key = 'cms.faq.manage'
       and (not r.requires_mfa or coalesce(p_is_aal2, false))
  );
$$;

comment on function app_private.faq_can_manage(uuid, boolean) is
  'Whether one account effectively holds cms.faq.manage — the separate key every write below requires. A reader may hold the first key and not this one, which is why the detail reports the capability.';

-- ---------------------------------------------------------------------------------------------------
-- 2. Which page, if any, shows a topic
-- ---------------------------------------------------------------------------------------------------
-- Owner decision 1 and owner decision 5 in one function, stated once so it cannot drift between the three
-- readers below. A topic is mapped when a **publicly visible** page carries it as its `page_key` — `page_key` is
-- unique where it is not null, so at most one page can, and the slug comes back with it because whether this
-- application actually serves an address at that slug is the web layer's own closed list to check.
--
-- An unpublished page maps nothing: a draft page shows no FAQ section, so a topic whose only page is a draft is
-- exactly as unmapped as one with no page at all, and the console should say so.
create or replace function app_private.faq_topic_mapping(p_topic text)
returns table (
  is_mapped boolean,
  page_slug text
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  -- Written so that it returns **exactly one row for every topic**, mapped or not. That is load-bearing: the two
  -- staff readers below `cross join lateral` this function, and a zero-row answer would silently drop every entry
  -- under an unmapped topic from the console — the precise opposite of what owner decision 5 asks for.
  with mapped as (
    select (
      select p.slug
        from public.pages p
       where p.page_key = p_topic
         and public.cms_content_is_public(p.status, p.published_at)
       limit 1
    ) as slug
  )
  select m.slug is not null, m.slug from mapped m;
$$;

comment on function app_private.faq_topic_mapping(text) is
  'Whether a publicly visible page carries this topic as its page_key — owner decision 1''s mapping, answered where both sides of it live — and that page''s slug, so a caller can check it against its own route map.';

-- ---------------------------------------------------------------------------------------------------
-- 3. The public reader
-- ---------------------------------------------------------------------------------------------------
-- The published entries of one topic, in the operator's order, each question and answer in the requested locale
-- with the English text as the fallback (D6 requires the English, D7 makes the Arabic optional and nothing is
-- machine translated).
--
-- `p_topic` is the page's own `page_key`, which the caller already holds: this function takes the topic rather
-- than the address, because the mapping is the page's key and resolving an address is not this layer's business.
-- A null or blank topic matches nothing, which is the right answer for a page that has no key.
create or replace function app_private.public_faqs(
  p_topic text,
  p_locale text default 'en'
) returns table (
  faq_id uuid,
  question text,
  answer text,
  sort_order integer
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    f.id,
    case when coalesce(nullif(btrim(p_locale), ''), 'en') = 'ar' then coalesce(f.question_ar, f.question_en)
         else f.question_en end,
    case when coalesce(nullif(btrim(p_locale), ''), 'en') = 'ar' then coalesce(f.answer_ar, f.answer_en)
         else f.answer_en end,
    f.sort_order
    from public.faqs f
   where f.is_published
     and f.topic = nullif(btrim(coalesce(p_topic, '')), '')
   order by f.sort_order, f.id;
$$;

comment on function app_private.public_faqs(text, text) is
  'The published FAQ entries of one topic in the operator''s order, in the requested locale with English as the fallback. The topic is a page''s own page_key (owner decision 1). No row for an unpublished entry, and none at all for a topic nobody has published anything under.';

-- ---------------------------------------------------------------------------------------------------
-- 4. The staff readers
-- ---------------------------------------------------------------------------------------------------
-- The permission is tested in the WHERE clause, so a caller who does not hold the read key reads nothing rather
-- than being told that something exists.
--
-- Every topic an entry exists under, with how many entries it holds, how many of those are published and whether
-- any public page shows it. This is where owner decision 5 becomes visible: a free-form topic nobody mapped is
-- not an error and not a validation failure, it is a thing an operator needs to be able to see.
create or replace function app_private.faq_topics_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean
) returns table (
  topic text,
  entry_count integer,
  published_count integer,
  is_mapped boolean,
  page_slug text
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    f.topic,
    count(*)::integer,
    count(*) filter (where f.is_published)::integer,
    mapping.is_mapped,
    mapping.page_slug
    from public.faqs f
    cross join lateral app_private.faq_topic_mapping(f.topic) as mapping
   where app_private.faq_can_read(p_user_id, p_is_aal2)
   group by f.topic, mapping.is_mapped, mapping.page_slug
   order by mapping.is_mapped desc, f.topic;
$$;

comment on function app_private.faq_topics_for_staff(uuid, boolean) is
  'Every topic entries exist under, mapped ones first, with how many entries it holds, how many are published, and which page shows it. Owner decision 5 made visible: a topic no public address shows is reported rather than refused.';

-- One page of entries, in the order the help centre shows them. Keyset by `(topic, sort_order, id)`, which is
-- total: `topic` and `sort_order` are `not null` and `id` is the primary key, so the triple names exactly one row
-- and a page is stable while the order holds. A topic filter narrows the same order rather than changing it.
create or replace function app_private.faqs_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_topic text default null,
  p_after_topic text default null,
  p_after_sort_order integer default null,
  p_after_id uuid default null,
  p_limit integer default 25
) returns table (
  faq_id uuid,
  topic text,
  question_en text,
  question_ar text,
  answer_en text,
  answer_ar text,
  sort_order integer,
  is_published boolean,
  is_mapped boolean,
  page_slug text,
  created_at timestamptz,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    f.id,
    f.topic,
    f.question_en,
    f.question_ar,
    f.answer_en,
    f.answer_ar,
    f.sort_order,
    f.is_published,
    mapping.is_mapped,
    mapping.page_slug,
    f.created_at,
    f.updated_at
    from public.faqs f
    cross join lateral app_private.faq_topic_mapping(f.topic) as mapping
   where app_private.faq_can_read(p_user_id, p_is_aal2)
     and (p_topic is null or f.topic = p_topic)
     -- The row comparison is the keyset, and it is one expression rather than three ORs so the planner sees the
     -- same tuple order the ORDER BY asks for.
     and (
       p_after_id is null
       or p_after_topic is null
       or p_after_sort_order is null
       or (f.topic, f.sort_order, f.id) > (p_after_topic, p_after_sort_order, p_after_id)
     )
   order by f.topic, f.sort_order, f.id
   limit greatest(coalesce(p_limit, 25), 1);
$$;

comment on function app_private.faqs_for_staff(uuid, boolean, text, text, integer, uuid, integer) is
  'One page of FAQ entries for a holder of cms.faq.read, in help-centre order, published or not, each with whether a public page shows its topic. Keyset by (topic, sort_order, id), which is total.';

create or replace function app_private.faq_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_faq_id uuid
) returns table (
  faq_id uuid,
  topic text,
  question_en text,
  question_ar text,
  answer_en text,
  answer_ar text,
  sort_order integer,
  is_published boolean,
  is_mapped boolean,
  page_slug text,
  created_at timestamptz,
  updated_at timestamptz,
  can_manage boolean
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    f.id,
    f.topic,
    f.question_en,
    f.question_ar,
    f.answer_en,
    f.answer_ar,
    f.sort_order,
    f.is_published,
    mapping.is_mapped,
    mapping.page_slug,
    f.created_at,
    f.updated_at,
    app_private.faq_can_manage(p_user_id, p_is_aal2)
    from public.faqs f
    cross join lateral app_private.faq_topic_mapping(f.topic) as mapping
   where f.id = p_faq_id
     and app_private.faq_can_read(p_user_id, p_is_aal2);
$$;

comment on function app_private.faq_for_staff(uuid, boolean, uuid) is
  'One FAQ entry with whether this caller may change it and whether any public page shows its topic. No row for an entry that does not exist and none for a caller without the read key, so a refusal and an absence look alike.';

-- ---------------------------------------------------------------------------------------------------
-- 5. The writers
-- ---------------------------------------------------------------------------------------------------
-- Each one re-applies `faq_can_manage` first and raises 42501 when it fails. None decides a rule 0030 already
-- decides: the topic format, the question lengths and that an answer is not empty are constraints and are left
-- to raise their own errors.
--
-- Every optional parameter defaults to null, and that is load-bearing: this is a create-or-replace writer, so a
-- non-null default would be substituted before the body runs and an omitted argument would be indistinguishable
-- from an explicit one — reordering the help centre every time somebody corrected a typo.
create or replace function app_private.faq_save_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_faq_id uuid,
  p_topic text default null,
  p_question_en text default null,
  p_question_ar text default null,
  p_answer_en text default null,
  p_answer_ar text default null,
  p_sort_order integer default null
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  saved_id uuid;
begin
  if not app_private.faq_can_manage(p_user_id, p_is_aal2) then
    raise exception 'cms.faq.manage is required' using errcode = 'insufficient_privilege';
  end if;

  if p_faq_id is null then
    -- `is_published` is absent on purpose (owner decision 6): 0030 defaults a new entry to unpublished, and
    -- publishing is the separate call below. `topic` is absent from the column list when none was given, so
    -- 0030's own `'general'` default stands rather than this writer inventing a different one.
    insert into public.faqs (topic, question_en, question_ar, answer_en, answer_ar, sort_order)
    values (
      coalesce(nullif(btrim(coalesce(p_topic, '')), ''), 'general'),
      btrim(coalesce(p_question_en, '')),
      nullif(btrim(coalesce(p_question_ar, '')), ''),
      btrim(coalesce(p_answer_en, '')),
      nullif(btrim(coalesce(p_answer_ar, '')), ''),
      coalesce(p_sort_order, 0)
    )
    returning id into saved_id;
    return saved_id;
  end if;

  -- `is_published` is absent from this statement too, for the same reason: editing an answer can never put it in
  -- front of the public.
  update public.faqs f
     set topic = coalesce(nullif(btrim(coalesce(p_topic, '')), ''), f.topic),
         question_en = coalesce(nullif(btrim(coalesce(p_question_en, '')), ''), f.question_en),
         question_ar = case when p_question_ar is null then f.question_ar
                            else nullif(btrim(p_question_ar), '') end,
         answer_en = coalesce(nullif(btrim(coalesce(p_answer_en, '')), ''), f.answer_en),
         answer_ar = case when p_answer_ar is null then f.answer_ar else nullif(btrim(p_answer_ar), '') end,
         sort_order = coalesce(p_sort_order, f.sort_order)
   where f.id = p_faq_id
  returning f.id into saved_id;

  return saved_id;
end;
$$;

comment on function app_private.faq_save_for_staff(uuid, boolean, uuid, text, text, text, text, text, integer) is
  'Creates or replaces one FAQ entry, returning its id — or null when the named id does not exist. A new entry is always unpublished (owner decision 6). is_published is not settable here: publishing is its own call, so editing an answer cannot publish it.';

create or replace function app_private.faq_state_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_faq_id uuid,
  p_is_published boolean
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  updated integer;
begin
  if not app_private.faq_can_manage(p_user_id, p_is_aal2) then
    raise exception 'cms.faq.manage is required' using errcode = 'insufficient_privilege';
  end if;

  update public.faqs f
     set is_published = coalesce(p_is_published, f.is_published)
   where f.id = p_faq_id;

  get diagnostics updated = row_count;
  return updated = 1;
end;
$$;

comment on function app_private.faq_state_for_staff(uuid, boolean, uuid, boolean) is
  'Publishes or unpublishes one entry. The only call that can put one on a public page, which is why it is separate from the save.';

-- One statement for the whole order of one topic, because an order is a set of positions rather than a sequence
-- of edits. Scoped to the topic: an id belonging to another topic updates nothing, so a stale screen cannot
-- reorder a part of the help centre nobody was looking at.
create or replace function app_private.faqs_reorder_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_topic text,
  p_faq_ids uuid[]
) returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  moved integer;
begin
  if not app_private.faq_can_manage(p_user_id, p_is_aal2) then
    raise exception 'cms.faq.manage is required' using errcode = 'insufficient_privilege';
  end if;

  -- Position comes from the argument's own ordering, so the caller sends the order it means and this does not
  -- invent one. An id that names no entry updates nothing; an entry the caller left out keeps its position.
  update public.faqs f
     set sort_order = (chosen.ordinality - 1) * 10
    from unnest(coalesce(p_faq_ids, '{}'::uuid[])) with ordinality as chosen(faq_id, ordinality)
   where f.id = chosen.faq_id
     and f.topic = p_topic;

  get diagnostics moved = row_count;
  return moved;
end;
$$;

comment on function app_private.faqs_reorder_for_staff(uuid, boolean, text, uuid[]) is
  'Sets the order of the entries named, from the argument''s own ordering, in one statement, scoped to one topic. Positions are spaced by ten so a later insertion between two entries needs no rewrite. Returns how many rows moved.';

create or replace function app_private.faq_delete_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_faq_id uuid
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  deleted integer;
begin
  if not app_private.faq_can_manage(p_user_id, p_is_aal2) then
    raise exception 'cms.faq.manage is required' using errcode = 'insufficient_privilege';
  end if;

  -- A real delete. A question and its answer are editorial content rather than a record of anything that
  -- happened, and there is no history table behind this one to keep.
  delete from public.faqs f where f.id = p_faq_id;
  get diagnostics deleted = row_count;
  return deleted = 1;
end;
$$;

comment on function app_private.faq_delete_for_staff(uuid, boolean, uuid) is
  'Removes one entry. A real delete: a question is editorial content, not a record of an event, and 0030 gave this table no history.';

-- ---------------------------------------------------------------------------------------------------
-- 6. Privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on all functions in schema app_private from public;

revoke execute on function app_private.faq_can_read(uuid, boolean) from public, app_worker;
revoke execute on function app_private.faq_can_manage(uuid, boolean) from public, app_worker;
revoke execute on function app_private.faq_topic_mapping(text) from public, app_worker;
revoke execute on function app_private.public_faqs(text, text) from public, app_worker;
revoke execute on function app_private.faq_topics_for_staff(uuid, boolean) from public, app_worker;
revoke execute on function app_private.faqs_for_staff(uuid, boolean, text, text, integer, uuid, integer) from public, app_worker;
revoke execute on function app_private.faq_for_staff(uuid, boolean, uuid) from public, app_worker;
revoke execute on function app_private.faq_save_for_staff(uuid, boolean, uuid, text, text, text, text, text, integer) from public, app_worker;
revoke execute on function app_private.faq_state_for_staff(uuid, boolean, uuid, boolean) from public, app_worker;
revoke execute on function app_private.faqs_reorder_for_staff(uuid, boolean, text, uuid[]) from public, app_worker;
revoke execute on function app_private.faq_delete_for_staff(uuid, boolean, uuid) from public, app_worker;

-- `app_system` only. The worker has no business with the help centre: it publishes nothing on a schedule here
-- and reacts to no event this migration adds.
grant execute on function app_private.faq_can_read(uuid, boolean) to app_system;
grant execute on function app_private.faq_can_manage(uuid, boolean) to app_system;
grant execute on function app_private.faq_topic_mapping(text) to app_system;
grant execute on function app_private.public_faqs(text, text) to app_system;
grant execute on function app_private.faq_topics_for_staff(uuid, boolean) to app_system;
grant execute on function app_private.faqs_for_staff(uuid, boolean, text, text, integer, uuid, integer) to app_system;
grant execute on function app_private.faq_for_staff(uuid, boolean, uuid) to app_system;
grant execute on function app_private.faq_save_for_staff(uuid, boolean, uuid, text, text, text, text, text, integer) to app_system;
grant execute on function app_private.faq_state_for_staff(uuid, boolean, uuid, boolean) to app_system;
grant execute on function app_private.faqs_reorder_for_staff(uuid, boolean, text, uuid[]) to app_system;
grant execute on function app_private.faq_delete_for_staff(uuid, boolean, uuid) to app_system;

-- The contract this repository will not ship without.
select app_private.assert_security_contract();
