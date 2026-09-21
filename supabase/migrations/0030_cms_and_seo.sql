-- 0030 — CMS and SEO (v5.2 CMS module within Admin, SEO module; D6, D7, C11, C17).
--
-- Two modules, one migration, and a line between them that is kept on purpose.
--
--   * **CMS** is marketing and policy content the marketplace publishes about itself: static pages, the
--     blog, FAQs, the homepage composition, banners and the navigation menus. The specification files
--     the whole module under Admin, so nothing here is writable by a seller or a buyer, and no CMS row
--     ever carries a seller's words. Seller-authored content stays exactly where 0011 put it — in
--     `listings`, in its own writing language, with no translation of any kind (D7).
--   * **SEO** is how the public site describes itself to crawlers: per-entity metadata, the canonical
--     rule and the redirect map. It owns `seo_settings`, `seo_metadata` and `redirects` and nothing else.
--
-- CMS content never duplicates marketplace data. A navigation item that points at a category stores the
-- category id; a homepage section that features listings stores the listing ids in its configuration.
-- The title, the price and the image are read from the owning table at render time, so a category rename
-- can never leave a stale copy behind in the menu.
--
-- Localization follows what is already in the tree. Long-form bilingual content (pages, blog posts) has
-- a translation table keyed by `locale_code`, exactly as `category_translations` is, and the
-- specification's own module table names `page_translations` and `blog_post_translations` for that job.
-- Short administrative labels — a menu label, a tag name, a banner headline — use the `*_en` / `*_ar`
-- column pair that `locales`, `permissions` and `site_settings` already use. English is primary and is
-- required; Arabic is optional and is simply absent until someone writes it. Nothing on this migration
-- generates, copies or derives a translation: a missing Arabic row means the English one is served (D6),
-- never a machine translation (D7).
--
-- Publication is one lifecycle, shared by pages and posts and enforced by a trigger rather than by
-- convention: `draft → scheduled → published → archived`, with the edges named in
-- `app_private.tg_cms_transition()`. A row is public only when it is `published` and its `published_at`
-- has passed, and that single rule is `public.cms_content_is_public()`, used by every public policy. A
-- draft, a scheduled post whose time has not come, and an archived page are all invisible to a public
-- read — not merely unlinked, but refused by row level security. `app_private.publish_due_content()` is
-- the scheduled half, written for the pg_cron job 0032 adds.
--
-- Any change that alters what the public sees publishes an outbox event in the same transaction, which
-- is the revalidation path C11 already requires. There is no second cache-invalidation mechanism here,
-- and no event is emitted for an edit that changes nothing a visitor can observe.
--
-- SEO metadata cannot smuggle a destination off the site. `canonical_path`, a banner's `link_path` and
-- both sides of a redirect are **relative paths only**: a CHECK refuses anything starting with a scheme
-- or with `//`, so no value in this migration can become an absolute external URL. Robots directives
-- come from an allowlist. `seo_metadata` is also publication-aware: a row describing an unpublished page
-- is readable by staff and by nobody else, so the metadata table cannot leak a draft's title.
--
-- Search stays on the existing PostgreSQL foundations. Translations carry a generated `search_vector`
-- built with the same `english` and `arabic` configurations 0011 uses for listings, indexed with GIN.
-- No second search or indexing system is introduced.
--
-- `cms_media` goes in a **private** bucket. The approved storage architecture says in so many words that
-- the one public bucket holds approved listing variants only, so CMS images are reached the way every
-- other private bucket is reached: an API-issued signed URL (C15). The bucket is added to 0012's
-- contract table so `storage_bucket_problems()` still returns nothing, and it gets no `storage.objects`
-- policy, which leaves 0012's own assertions — one public bucket, one policy — true as written.
--
-- Nothing here touches payments, payouts, providers, settlement, the wallet, the ledger or withdrawals,
-- and no blocked or deferred decision is opened.

-- ---------------------------------------------------------------------------------------------------
-- Storage for CMS images
-- ---------------------------------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('cms-media', 'cms-media', false, 20971520,
        array['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/svg+xml'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

insert into app_private.storage_bucket_contract (bucket_id, must_be_public, purpose)
values ('cms-media', false, 'CMS images; served through API-issued signed URLs, never publicly listed')
on conflict (bucket_id) do nothing;

create table public.cms_media (
  id uuid primary key default gen_random_uuid(),
  object_path text not null,
  mime_type text not null,
  width integer,
  height integer,
  byte_size bigint not null,
  alt_text_en text,
  alt_text_ar text,
  uploaded_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cms_media_object_path_in_bucket check (object_path ~ '^cms-media/[A-Za-z0-9._/-]+$'),
  constraint cms_media_mime_allowed check (mime_type in (
    'image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/svg+xml')),
  constraint cms_media_dimensions_positive check (
    (width is null or width > 0) and (height is null or height > 0) and byte_size > 0),
  constraint cms_media_alt_text_en_length check (alt_text_en is null or length(alt_text_en) <= 300),
  constraint cms_media_alt_text_ar_length check (alt_text_ar is null or length(alt_text_ar) <= 300)
);
comment on table public.cms_media is
  'Images used by CMS content. Stored in the private `cms-media` bucket and served by signed URL (C15).';
create unique index cms_media_object_path on public.cms_media (object_path);
create trigger cms_media_set_updated_at before update on public.cms_media
  for each row execute function app_private.tg_set_updated_at();

-- ---------------------------------------------------------------------------------------------------
-- The shared publication rule
-- ---------------------------------------------------------------------------------------------------
create or replace function public.cms_content_is_public(p_status text, p_published_at timestamptz)
returns boolean
language sql
stable
as $$
  select p_status = 'published' and p_published_at is not null and p_published_at <= now();
$$;
comment on function public.cms_content_is_public(text, timestamptz) is
  'The one rule every public CMS policy uses: published, and the publication moment has passed.';

create or replace function app_private.tg_cms_transition() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  edge text := format('%s->%s', old.status, new.status);
begin
  if new.status <> old.status and edge not in (
    'draft->scheduled', 'draft->published', 'draft->archived',
    'scheduled->draft', 'scheduled->published', 'scheduled->archived',
    'published->draft', 'published->archived',
    'archived->draft', 'archived->published'
  ) then
    raise exception '% is not an allowed content transition', edge
      using errcode = 'check_violation';
  end if;

  if new.status = 'published' and new.published_at is null then
    new.published_at := now();
  end if;
  if new.status = 'archived' and new.archived_at is null then
    new.archived_at := now();
  end if;
  if new.status <> 'archived' then
    new.archived_at := null;
  end if;
  if new.status <> 'scheduled' then
    new.scheduled_for := null;
  end if;
  return new;
end;
$$;
comment on function app_private.tg_cms_transition() is
  'BEFORE UPDATE on pages and blog posts: the allowed lifecycle edges, and the timestamps each state owns.';

create or replace function app_private.tg_cms_announce() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  was_public boolean := false;
  is_public boolean := public.cms_content_is_public(new.status, new.published_at);
  changed boolean;
begin
  if tg_op = 'UPDATE' then
    was_public := public.cms_content_is_public(old.status, old.published_at);
    changed := was_public is distinct from is_public
      or new.slug is distinct from old.slug
      or new.is_indexable is distinct from old.is_indexable;
  else
    changed := is_public;
  end if;

  if changed then
    perform public.enqueue_outbox_event(
      tg_argv[0],
      new.id::text,
      tg_argv[0] || '.visibility_changed',
      jsonb_build_object(
        'id', new.id,
        'slug', new.slug,
        'status', new.status,
        'is_public', is_public,
        'is_indexable', new.is_indexable
      )
    );
  end if;
  return null;
end;
$$;
comment on function app_private.tg_cms_announce() is
  'AFTER trigger: publishes the revalidation event C11 requires whenever what the public sees changes.';

-- ---------------------------------------------------------------------------------------------------
-- Static pages
-- ---------------------------------------------------------------------------------------------------
create table public.pages (
  id uuid primary key default gen_random_uuid(),
  slug text not null,
  page_key text,
  status text not null default 'draft',
  is_indexable boolean not null default true,
  template text not null default 'standard',
  sort_order integer not null default 0,
  cover_media_id uuid references public.cms_media (id) on delete set null,
  scheduled_for timestamptz,
  published_at timestamptz,
  archived_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pages_slug_format check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?$'),
  constraint pages_page_key_format check (page_key is null or page_key ~ '^[a-z][a-z0-9_]*$'),
  constraint pages_status_allowed check (status in ('draft', 'scheduled', 'published', 'archived')),
  constraint pages_template_allowed check (template in ('standard', 'legal', 'help', 'landing')),
  constraint pages_scheduled_has_time check ((status = 'scheduled') = (scheduled_for is not null)),
  constraint pages_published_has_time check (status <> 'published' or published_at is not null),
  constraint pages_archived_has_time check (status <> 'archived' or archived_at is not null)
);
comment on table public.pages is 'Static marketing and policy pages. Admin-authored; never seller content.';
create unique index pages_slug on public.pages (slug);
create unique index pages_page_key on public.pages (page_key) where page_key is not null;
create index pages_public on public.pages (sort_order, slug) where status = 'published';
create index pages_due on public.pages (scheduled_for) where status = 'scheduled';
create trigger pages_set_updated_at before update on public.pages
  for each row execute function app_private.tg_set_updated_at();
create trigger pages_transition before update on public.pages
  for each row execute function app_private.tg_cms_transition();
create trigger pages_announce after insert or update on public.pages
  for each row execute function app_private.tg_cms_announce('page');
create trigger pages_audit after insert or update or delete on public.pages
  for each row execute function audit.tg_record_change();

create table public.page_slug_history (
  id bigint generated always as identity primary key,
  page_id uuid not null references public.pages (id) on delete cascade,
  slug text not null,
  replaced_at timestamptz not null default now(),
  constraint page_slug_history_slug_format check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?$')
);
comment on table public.page_slug_history is
  'Previous page slugs, served as 301 redirects. A slug here can never be reused by another page.';
create unique index page_slug_history_slug on public.page_slug_history (slug);
create index page_slug_history_page on public.page_slug_history (page_id, replaced_at desc);
create trigger page_slug_history_append_only before update or delete on public.page_slug_history
  for each row execute function app_private.tg_reject_write();

create or replace function app_private.tg_pages_slug_rule() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  owner_id uuid;
begin
  select h.page_id into owner_id from public.page_slug_history h where h.slug = new.slug;
  if owner_id is not null and owner_id <> new.id then
    raise exception 'slug % belonged to another page and is permanently redirected', new.slug
      using errcode = 'unique_violation';
  end if;

  if tg_op = 'UPDATE' and new.slug <> old.slug then
    insert into public.page_slug_history (page_id, slug) values (old.id, old.slug)
    on conflict (slug) do nothing;
  end if;
  return new;
end;
$$;
comment on function app_private.tg_pages_slug_rule() is
  'The 0011 slug rule applied to pages: the old slug is kept for its redirect and can never be taken over.';

create trigger pages_slug_rule before insert or update of slug on public.pages
  for each row execute function app_private.tg_pages_slug_rule();

create table public.page_translations (
  page_id uuid not null references public.pages (id) on delete cascade,
  locale_code text not null references public.locales (code) on delete cascade,
  title text not null,
  excerpt text,
  body text not null,
  meta_title text,
  meta_description text,
  search_vector tsvector generated always as (
    setweight(to_tsvector(
      case when locale_code = 'ar' then 'arabic'::regconfig else 'english'::regconfig end,
      coalesce(title, '')), 'A')
    || setweight(to_tsvector(
      case when locale_code = 'ar' then 'arabic'::regconfig else 'english'::regconfig end,
      coalesce(body, '')), 'B')
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (page_id, locale_code),
  constraint page_translations_title_length check (length(btrim(title)) between 1 and 200),
  constraint page_translations_body_present check (length(btrim(body)) > 0),
  constraint page_translations_excerpt_length check (excerpt is null or length(excerpt) <= 500),
  constraint page_translations_meta_title_length check (meta_title is null or length(meta_title) <= 70),
  constraint page_translations_meta_description_length check (meta_description is null or length(meta_description) <= 320)
);
comment on table public.page_translations is
  'Page text per locale. A locale with no row is simply untranslated; nothing is machine translated (D7).';
create index page_translations_search on public.page_translations using gin (search_vector);
create trigger page_translations_set_updated_at before update on public.page_translations
  for each row execute function app_private.tg_set_updated_at();

-- ---------------------------------------------------------------------------------------------------
-- Blog
-- ---------------------------------------------------------------------------------------------------
create table public.blog_categories (
  id uuid primary key default gen_random_uuid(),
  slug text not null,
  name_en text not null,
  name_ar text,
  description_en text,
  description_ar text,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint blog_categories_slug_format check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?$'),
  constraint blog_categories_name_en_length check (length(btrim(name_en)) between 1 and 120),
  constraint blog_categories_name_ar_length check (name_ar is null or length(btrim(name_ar)) between 1 and 120)
);
comment on table public.blog_categories is 'Blog taxonomy. English is required, Arabic optional (D6).';
create unique index blog_categories_slug on public.blog_categories (slug);
create trigger blog_categories_set_updated_at before update on public.blog_categories
  for each row execute function app_private.tg_set_updated_at();

create table public.blog_tags (
  id uuid primary key default gen_random_uuid(),
  slug text not null,
  name_en text not null,
  name_ar text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint blog_tags_slug_format check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?$'),
  constraint blog_tags_name_en_length check (length(btrim(name_en)) between 1 and 60),
  constraint blog_tags_name_ar_length check (name_ar is null or length(btrim(name_ar)) between 1 and 60)
);
comment on table public.blog_tags is 'Blog tags. Separate from `tags`, which belongs to the listing catalogue.';
create unique index blog_tags_slug on public.blog_tags (slug);
create trigger blog_tags_set_updated_at before update on public.blog_tags
  for each row execute function app_private.tg_set_updated_at();

create table public.blog_posts (
  id uuid primary key default gen_random_uuid(),
  slug text not null,
  blog_category_id uuid references public.blog_categories (id) on delete set null,
  author_user_id uuid references auth.users (id) on delete set null,
  status text not null default 'draft',
  is_indexable boolean not null default true,
  is_featured boolean not null default false,
  cover_media_id uuid references public.cms_media (id) on delete set null,
  scheduled_for timestamptz,
  published_at timestamptz,
  archived_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint blog_posts_slug_format check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?$'),
  constraint blog_posts_status_allowed check (status in ('draft', 'scheduled', 'published', 'archived')),
  constraint blog_posts_scheduled_has_time check ((status = 'scheduled') = (scheduled_for is not null)),
  constraint blog_posts_published_has_time check (status <> 'published' or published_at is not null),
  constraint blog_posts_archived_has_time check (status <> 'archived' or archived_at is not null),
  constraint blog_posts_featured_is_published check (not is_featured or status = 'published')
);
comment on table public.blog_posts is
  'Marketplace blog posts, authored by staff. Sellers never write here; their words stay in `listings` (D7).';
create unique index blog_posts_slug on public.blog_posts (slug);
create index blog_posts_public on public.blog_posts (published_at desc) where status = 'published';
create index blog_posts_category on public.blog_posts (blog_category_id, published_at desc);
create index blog_posts_due on public.blog_posts (scheduled_for) where status = 'scheduled';
create trigger blog_posts_set_updated_at before update on public.blog_posts
  for each row execute function app_private.tg_set_updated_at();
create trigger blog_posts_transition before update on public.blog_posts
  for each row execute function app_private.tg_cms_transition();
create trigger blog_posts_announce after insert or update on public.blog_posts
  for each row execute function app_private.tg_cms_announce('blog_post');
create trigger blog_posts_audit after insert or update or delete on public.blog_posts
  for each row execute function audit.tg_record_change();

create table public.blog_post_slug_history (
  id bigint generated always as identity primary key,
  blog_post_id uuid not null references public.blog_posts (id) on delete cascade,
  slug text not null,
  replaced_at timestamptz not null default now(),
  constraint blog_post_slug_history_slug_format check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?$')
);
comment on table public.blog_post_slug_history is
  'Previous post slugs, served as 301 redirects. A slug here can never be reused by another post.';
create unique index blog_post_slug_history_slug on public.blog_post_slug_history (slug);
create index blog_post_slug_history_post on public.blog_post_slug_history (blog_post_id, replaced_at desc);
create trigger blog_post_slug_history_append_only before update or delete on public.blog_post_slug_history
  for each row execute function app_private.tg_reject_write();

create or replace function app_private.tg_blog_posts_slug_rule() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  owner_id uuid;
begin
  select h.blog_post_id into owner_id from public.blog_post_slug_history h where h.slug = new.slug;
  if owner_id is not null and owner_id <> new.id then
    raise exception 'slug % belonged to another post and is permanently redirected', new.slug
      using errcode = 'unique_violation';
  end if;

  if tg_op = 'UPDATE' and new.slug <> old.slug then
    insert into public.blog_post_slug_history (blog_post_id, slug) values (old.id, old.slug)
    on conflict (slug) do nothing;
  end if;
  return new;
end;
$$;

create trigger blog_posts_slug_rule before insert or update of slug on public.blog_posts
  for each row execute function app_private.tg_blog_posts_slug_rule();

create table public.blog_post_translations (
  blog_post_id uuid not null references public.blog_posts (id) on delete cascade,
  locale_code text not null references public.locales (code) on delete cascade,
  title text not null,
  excerpt text,
  body text not null,
  meta_title text,
  meta_description text,
  search_vector tsvector generated always as (
    setweight(to_tsvector(
      case when locale_code = 'ar' then 'arabic'::regconfig else 'english'::regconfig end,
      coalesce(title, '')), 'A')
    || setweight(to_tsvector(
      case when locale_code = 'ar' then 'arabic'::regconfig else 'english'::regconfig end,
      coalesce(body, '')), 'B')
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (blog_post_id, locale_code),
  constraint blog_post_translations_title_length check (length(btrim(title)) between 1 and 200),
  constraint blog_post_translations_body_present check (length(btrim(body)) > 0),
  constraint blog_post_translations_excerpt_length check (excerpt is null or length(excerpt) <= 500),
  constraint blog_post_translations_meta_title_length check (meta_title is null or length(meta_title) <= 70),
  constraint blog_post_translations_meta_description_length check (meta_description is null or length(meta_description) <= 320)
);
comment on table public.blog_post_translations is 'Post text per locale; untranslated locales simply have no row (D7).';
create index blog_post_translations_search on public.blog_post_translations using gin (search_vector);
create trigger blog_post_translations_set_updated_at before update on public.blog_post_translations
  for each row execute function app_private.tg_set_updated_at();

create table public.blog_post_tags (
  blog_post_id uuid not null references public.blog_posts (id) on delete cascade,
  blog_tag_id uuid not null references public.blog_tags (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blog_post_id, blog_tag_id)
);
comment on table public.blog_post_tags is 'Which tags a post carries.';
create index blog_post_tags_by_tag on public.blog_post_tags (blog_tag_id, blog_post_id);

-- ---------------------------------------------------------------------------------------------------
-- FAQs
-- ---------------------------------------------------------------------------------------------------
create table public.faqs (
  id uuid primary key default gen_random_uuid(),
  topic text not null default 'general',
  question_en text not null,
  question_ar text,
  answer_en text not null,
  answer_ar text,
  sort_order integer not null default 0,
  is_published boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint faqs_topic_format check (topic ~ '^[a-z][a-z0-9_]*$'),
  constraint faqs_question_en_length check (length(btrim(question_en)) between 1 and 300),
  constraint faqs_question_ar_length check (question_ar is null or length(btrim(question_ar)) between 1 and 300),
  constraint faqs_answer_en_present check (length(btrim(answer_en)) > 0),
  constraint faqs_answer_ar_present check (answer_ar is null or length(btrim(answer_ar)) > 0)
);
comment on table public.faqs is 'Help-centre questions and answers, bilingual with English required (D6).';
create index faqs_public on public.faqs (topic, sort_order) where is_published;
create trigger faqs_set_updated_at before update on public.faqs
  for each row execute function app_private.tg_set_updated_at();

-- ---------------------------------------------------------------------------------------------------
-- Homepage composition and banners
-- ---------------------------------------------------------------------------------------------------
create table public.homepage_sections (
  id uuid primary key default gen_random_uuid(),
  section_key text not null,
  section_type text not null,
  title_en text,
  title_ar text,
  subtitle_en text,
  subtitle_ar text,
  config jsonb not null default '{}'::jsonb,
  sort_order integer not null default 0,
  is_active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint homepage_sections_key_format check (section_key ~ '^[a-z][a-z0-9_]*$'),
  constraint homepage_sections_type_allowed check (section_type in (
    'hero', 'banner_strip', 'featured_listings', 'featured_categories', 'featured_sellers',
    'latest_listings', 'blog_highlights', 'value_props', 'rich_text')),
  constraint homepage_sections_config_is_object check (jsonb_typeof(config) = 'object'),
  constraint homepage_sections_title_en_length check (title_en is null or length(title_en) <= 160),
  constraint homepage_sections_title_ar_length check (title_ar is null or length(title_ar) <= 160)
);
comment on table public.homepage_sections is
  'What the homepage is made of, in order. `config` holds ids of marketplace rows, never copies of them.';
create unique index homepage_sections_key on public.homepage_sections (section_key);
create index homepage_sections_active on public.homepage_sections (sort_order) where is_active;
create trigger homepage_sections_set_updated_at before update on public.homepage_sections
  for each row execute function app_private.tg_set_updated_at();
create trigger homepage_sections_audit after insert or update or delete on public.homepage_sections
  for each row execute function audit.tg_record_change();

create table public.banners (
  id uuid primary key default gen_random_uuid(),
  banner_key text not null,
  placement text not null,
  media_id uuid references public.cms_media (id) on delete set null,
  media_ar_id uuid references public.cms_media (id) on delete set null,
  headline_en text,
  headline_ar text,
  link_path text,
  starts_at timestamptz,
  ends_at timestamptz,
  sort_order integer not null default 0,
  is_active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint banners_key_format check (banner_key ~ '^[a-z][a-z0-9_]*$'),
  constraint banners_placement_allowed check (placement in (
    'home_hero', 'home_strip', 'category_top', 'search_top', 'sidebar', 'blog_top')),
  constraint banners_headline_en_length check (headline_en is null or length(headline_en) <= 160),
  constraint banners_headline_ar_length check (headline_ar is null or length(headline_ar) <= 160),
  constraint banners_link_path_is_relative check (
    link_path is null or (link_path ~ '^/[A-Za-z0-9/_\-?=&.%]*$' and link_path !~ '^//')),
  constraint banners_window_is_ordered check (starts_at is null or ends_at is null or ends_at > starts_at)
);
comment on table public.banners is
  'Promotional banners. `link_path` is relative on purpose: a banner can never point off the site.';
create unique index banners_key on public.banners (banner_key);
create index banners_placement on public.banners (placement, sort_order) where is_active;
create trigger banners_set_updated_at before update on public.banners
  for each row execute function app_private.tg_set_updated_at();
create trigger banners_audit after insert or update or delete on public.banners
  for each row execute function audit.tg_record_change();

create or replace function public.banner_is_live(p_is_active boolean, p_starts_at timestamptz, p_ends_at timestamptz)
returns boolean
language sql
stable
as $$
  select p_is_active
     and (p_starts_at is null or p_starts_at <= now())
     and (p_ends_at is null or p_ends_at > now());
$$;
comment on function public.banner_is_live(boolean, timestamptz, timestamptz) is
  'A banner is live when it is active and the current moment is inside its window.';

-- ---------------------------------------------------------------------------------------------------
-- Navigation
-- ---------------------------------------------------------------------------------------------------
create table public.navigation_menus (
  id uuid primary key default gen_random_uuid(),
  menu_key text not null,
  label_en text not null,
  label_ar text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint navigation_menus_key_format check (menu_key ~ '^[a-z][a-z0-9_]*$'),
  constraint navigation_menus_label_en_length check (length(btrim(label_en)) between 1 and 120),
  constraint navigation_menus_label_ar_length check (label_ar is null or length(btrim(label_ar)) between 1 and 120)
);
comment on table public.navigation_menus is 'Named menus: header, footer columns, mobile drawer.';
create unique index navigation_menus_key on public.navigation_menus (menu_key);
create trigger navigation_menus_set_updated_at before update on public.navigation_menus
  for each row execute function app_private.tg_set_updated_at();
create trigger navigation_menus_audit after insert or update or delete on public.navigation_menus
  for each row execute function audit.tg_record_change();

create table public.navigation_items (
  id uuid primary key default gen_random_uuid(),
  menu_id uuid not null references public.navigation_menus (id) on delete cascade,
  parent_id uuid references public.navigation_items (id) on delete cascade,
  label_en text not null,
  label_ar text,
  target_kind text not null,
  page_id uuid references public.pages (id) on delete cascade,
  blog_post_id uuid references public.blog_posts (id) on delete cascade,
  category_id uuid references public.categories (id) on delete cascade,
  path text,
  opens_in_new_tab boolean not null default false,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint navigation_items_label_en_length check (length(btrim(label_en)) between 1 and 120),
  constraint navigation_items_label_ar_length check (label_ar is null or length(btrim(label_ar)) between 1 and 120),
  constraint navigation_items_target_kind_allowed check (target_kind in ('page', 'blog_post', 'category', 'path')),
  constraint navigation_items_path_is_relative check (
    path is null or (path ~ '^/[A-Za-z0-9/_\-?=&.%]*$' and path !~ '^//')),
  constraint navigation_items_target_matches_kind check (
    case target_kind
      when 'page' then page_id is not null and blog_post_id is null and category_id is null and path is null
      when 'blog_post' then blog_post_id is not null and page_id is null and category_id is null and path is null
      when 'category' then category_id is not null and page_id is null and blog_post_id is null and path is null
      else path is not null and page_id is null and blog_post_id is null and category_id is null
    end),
  constraint navigation_items_is_not_its_own_parent check (parent_id is null or parent_id <> id)
);
comment on table public.navigation_items is
  'Menu entries. A menu entry points at a row by id; it never copies that row''s title or URL.';
create index navigation_items_menu on public.navigation_items (menu_id, sort_order);
create index navigation_items_parent on public.navigation_items (parent_id, sort_order) where parent_id is not null;
create trigger navigation_items_set_updated_at before update on public.navigation_items
  for each row execute function app_private.tg_set_updated_at();
create trigger navigation_items_audit after insert or update or delete on public.navigation_items
  for each row execute function audit.tg_record_change();

-- A menu is two levels deep at most, and a child always sits in its parent's menu.
create or replace function app_private.tg_navigation_items_depth() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  parent_menu uuid;
  grandparent uuid;
begin
  if new.parent_id is null then
    return new;
  end if;
  select i.menu_id, i.parent_id into parent_menu, grandparent
    from public.navigation_items i where i.id = new.parent_id;
  if parent_menu is distinct from new.menu_id then
    raise exception 'a navigation item must sit in the same menu as its parent'
      using errcode = 'check_violation';
  end if;
  if grandparent is not null then
    raise exception 'navigation menus are two levels deep at most'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger navigation_items_depth before insert or update on public.navigation_items
  for each row execute function app_private.tg_navigation_items_depth();

-- ---------------------------------------------------------------------------------------------------
-- SEO settings
-- ---------------------------------------------------------------------------------------------------
create table public.seo_settings (
  locale_code text primary key references public.locales (code) on delete cascade,
  site_name text not null,
  default_meta_title text,
  default_meta_description text,
  default_share_media_id uuid references public.cms_media (id) on delete set null,
  twitter_site text,
  robots_txt_body text,
  organization_structured_data jsonb not null default '{}'::jsonb,
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint seo_settings_site_name_length check (length(btrim(site_name)) between 1 and 120),
  constraint seo_settings_default_meta_title_length check (
    default_meta_title is null or length(default_meta_title) <= 70),
  constraint seo_settings_default_meta_description_length check (
    default_meta_description is null or length(default_meta_description) <= 320),
  constraint seo_settings_twitter_site_format check (twitter_site is null or twitter_site ~ '^@[A-Za-z0-9_]{1,15}$'),
  constraint seo_settings_structured_data_is_object check (jsonb_typeof(organization_structured_data) = 'object')
);
comment on table public.seo_settings is
  'Per-locale public SEO defaults. Everything here is meant to be served to crawlers; nothing private belongs in it.';
create trigger seo_settings_set_updated_at before update on public.seo_settings
  for each row execute function app_private.tg_set_updated_at();
create trigger seo_settings_audit after insert or update or delete on public.seo_settings
  for each row execute function audit.tg_record_change();

-- ---------------------------------------------------------------------------------------------------
-- SEO metadata
-- ---------------------------------------------------------------------------------------------------
create table public.seo_metadata (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_id uuid,
  route_path text,
  locale_code text not null references public.locales (code) on delete cascade,
  meta_title text,
  meta_description text,
  canonical_path text,
  robots_directives text[] not null default array['index', 'follow'],
  og_title text,
  og_description text,
  share_media_id uuid references public.cms_media (id) on delete set null,
  structured_data jsonb not null default '{}'::jsonb,
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint seo_metadata_entity_type_allowed check (entity_type in (
    'page', 'blog_post', 'blog_category', 'blog_tag', 'category', 'listing', 'seller', 'route')),
  constraint seo_metadata_target_is_exclusive check (
    (entity_type = 'route') = (route_path is not null)
    and (entity_type = 'route') = (entity_id is null)),
  constraint seo_metadata_route_path_is_relative check (
    route_path is null or (route_path ~ '^/[A-Za-z0-9/_\-.%]*$' and route_path !~ '^//')),
  constraint seo_metadata_canonical_path_is_relative check (
    canonical_path is null
    or (canonical_path ~ '^/[A-Za-z0-9/_\-?=&.%]*$' and canonical_path !~ '^//')),
  constraint seo_metadata_meta_title_length check (meta_title is null or length(meta_title) <= 70),
  constraint seo_metadata_meta_description_length check (meta_description is null or length(meta_description) <= 320),
  constraint seo_metadata_og_title_length check (og_title is null or length(og_title) <= 120),
  constraint seo_metadata_og_description_length check (og_description is null or length(og_description) <= 320),
  constraint seo_metadata_directives_present check (cardinality(robots_directives) > 0),
  constraint seo_metadata_directives_allowed check (
    robots_directives <@ array['index', 'noindex', 'follow', 'nofollow',
                               'noarchive', 'nosnippet', 'noimageindex', 'max-snippet:-1']),
  constraint seo_metadata_directives_are_consistent check (
    not (robots_directives @> array['index'] and robots_directives @> array['noindex'])
    and not (robots_directives @> array['follow'] and robots_directives @> array['nofollow'])),
  constraint seo_metadata_structured_data_is_object check (jsonb_typeof(structured_data) = 'object')
);
comment on table public.seo_metadata is
  'Crawler-facing metadata per entity and locale. Canonical values are relative paths, so no external URL can be injected.';
create unique index seo_metadata_entity on public.seo_metadata (entity_type, entity_id, locale_code)
  where entity_id is not null;
create unique index seo_metadata_route on public.seo_metadata (route_path, locale_code)
  where route_path is not null;
create trigger seo_metadata_set_updated_at before update on public.seo_metadata
  for each row execute function app_private.tg_set_updated_at();
create trigger seo_metadata_audit after insert or update or delete on public.seo_metadata
  for each row execute function audit.tg_record_change();

-- Metadata about a CMS row is only as public as that row. A draft page's title never leaks through here.
create or replace function public.seo_metadata_is_public(p_entity_type text, p_entity_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select case p_entity_type
    when 'page' then exists (
      select 1 from public.pages p
       where p.id = p_entity_id and public.cms_content_is_public(p.status, p.published_at))
    when 'blog_post' then exists (
      select 1 from public.blog_posts b
       where b.id = p_entity_id and public.cms_content_is_public(b.status, b.published_at))
    when 'blog_category' then exists (
      select 1 from public.blog_categories c where c.id = p_entity_id and c.is_active)
    when 'blog_tag' then exists (
      select 1 from public.blog_tags t where t.id = p_entity_id and t.is_active)
    when 'category' then exists (
      select 1 from public.categories c where c.id = p_entity_id and c.is_active)
    when 'listing' then exists (
      select 1 from public.listings l where l.id = p_entity_id and l.status in ('active', 'sold', 'expired', 'archived'))
    when 'seller' then exists (
      select 1 from public.seller_profiles s where s.user_id = p_entity_id and s.status = 'active')
    when 'route' then true
    else false
  end;
$$;
comment on function public.seo_metadata_is_public(text, uuid) is
  'Whether a metadata row describes something the public can already see. Used by the public read policy.';

-- ---------------------------------------------------------------------------------------------------
-- Redirects
-- ---------------------------------------------------------------------------------------------------
create table public.redirects (
  id uuid primary key default gen_random_uuid(),
  from_path text not null,
  to_path text not null,
  status_code integer not null default 301,
  is_active boolean not null default true,
  note text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint redirects_from_path_is_relative check (
    from_path ~ '^/[A-Za-z0-9/_\-.%]*$' and from_path !~ '^//'),
  constraint redirects_to_path_is_relative check (
    to_path ~ '^/[A-Za-z0-9/_\-?=&.%]*$' and to_path !~ '^//'),
  constraint redirects_do_not_point_at_themselves check (from_path <> to_path),
  constraint redirects_status_code_allowed check (status_code in (301, 302, 307, 308))
);
comment on table public.redirects is
  'The admin redirect map the API publishes to the edge. Both sides are relative paths: a redirect can never leave the site.';
create unique index redirects_from_path on public.redirects (from_path);
create index redirects_active on public.redirects (from_path) where is_active;
create trigger redirects_set_updated_at before update on public.redirects
  for each row execute function app_private.tg_set_updated_at();
create trigger redirects_audit after insert or update or delete on public.redirects
  for each row execute function audit.tg_record_change();

create or replace function app_private.tg_redirects_announce() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  perform public.enqueue_outbox_event(
    'redirect',
    coalesce(new.id, old.id)::text,
    'redirect.map_changed',
    jsonb_build_object('from_path', coalesce(new.from_path, old.from_path))
  );
  return null;
end;
$$;
comment on function app_private.tg_redirects_announce() is
  'Republishes the cached redirect map through the outbox whenever an entry changes.';

create trigger redirects_announce after insert or update or delete on public.redirects
  for each row execute function app_private.tg_redirects_announce();

create or replace function public.resolve_redirect(p_path text)
returns table (to_path text, status_code integer)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  current_path text := p_path;
  next_row public.redirects%rowtype;
  seen text[] := array[]::text[];
  final_status integer;
  hops integer := 0;
begin
  loop
    exit when hops >= 5;
    select * into next_row from public.redirects r
     where r.from_path = current_path and r.is_active;
    exit when not found;
    exit when current_path = any (seen);
    seen := seen || current_path;
    current_path := next_row.to_path;
    final_status := next_row.status_code;
    hops := hops + 1;
  end loop;

  if final_status is null then
    return;
  end if;
  to_path := current_path;
  status_code := final_status;
  return next;
end;
$$;
comment on function public.resolve_redirect(text) is
  'Follows the redirect map to its destination, at most five hops, stopping rather than looping.';

-- ---------------------------------------------------------------------------------------------------
-- Scheduled publication
-- ---------------------------------------------------------------------------------------------------
create or replace function app_private.publish_due_content()
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  moved integer := 0;
  touched integer;
begin
  update public.pages
     set status = 'published', published_at = coalesce(published_at, now())
   where status = 'scheduled' and scheduled_for <= now();
  get diagnostics touched = row_count;
  moved := moved + touched;

  update public.blog_posts
     set status = 'published', published_at = coalesce(published_at, now())
   where status = 'scheduled' and scheduled_for <= now();
  get diagnostics touched = row_count;
  moved := moved + touched;

  return moved;
end;
$$;
comment on function app_private.publish_due_content() is
  'Publishes scheduled pages and posts whose moment has arrived. Called by the pg_cron job 0032 adds.';

-- ---------------------------------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------------------------------
alter table public.cms_media enable row level security;
alter table public.pages enable row level security;
alter table public.page_slug_history enable row level security;
alter table public.page_translations enable row level security;
alter table public.blog_categories enable row level security;
alter table public.blog_tags enable row level security;
alter table public.blog_posts enable row level security;
alter table public.blog_post_slug_history enable row level security;
alter table public.blog_post_translations enable row level security;
alter table public.blog_post_tags enable row level security;
alter table public.faqs enable row level security;
alter table public.homepage_sections enable row level security;
alter table public.banners enable row level security;
alter table public.navigation_menus enable row level security;
alter table public.navigation_items enable row level security;
alter table public.seo_settings enable row level security;
alter table public.seo_metadata enable row level security;
alter table public.redirects enable row level security;

-- Media: referenced from public pages, but the objects themselves stay behind signed URLs.
create policy cms_media_public_read on public.cms_media for select to authenticated using (true);
create policy cms_media_admin_write on public.cms_media for all to authenticated
  using (public.has_permission('cms.media.manage') and public.is_aal2())
  with check (public.has_permission('cms.media.manage') and public.is_aal2());

-- Pages.
create policy pages_public_read on public.pages for select to authenticated
  using (public.cms_content_is_public(status, published_at));
create policy pages_admin_read on public.pages for select to authenticated
  using (public.has_permission('cms.page.read'));
create policy pages_admin_write on public.pages for all to authenticated
  using (public.has_permission('cms.page.manage') and public.is_aal2())
  with check (public.has_permission('cms.page.manage') and public.is_aal2());

create policy page_slug_history_public_read on public.page_slug_history for select to authenticated
  using (exists (select 1 from public.pages p
                  where p.id = page_id and public.cms_content_is_public(p.status, p.published_at)));
create policy page_slug_history_admin_read on public.page_slug_history for select to authenticated
  using (public.has_permission('cms.page.read'));
create policy page_slug_history_admin_write on public.page_slug_history for insert to authenticated
  with check (public.has_permission('cms.page.manage') and public.is_aal2());

create policy page_translations_public_read on public.page_translations for select to authenticated
  using (exists (select 1 from public.pages p
                  where p.id = page_id and public.cms_content_is_public(p.status, p.published_at)));
create policy page_translations_admin_read on public.page_translations for select to authenticated
  using (public.has_permission('cms.page.read'));
create policy page_translations_admin_write on public.page_translations for all to authenticated
  using (public.has_permission('cms.page.manage') and public.is_aal2())
  with check (public.has_permission('cms.page.manage') and public.is_aal2());

-- Blog.
create policy blog_categories_public_read on public.blog_categories for select to authenticated using (is_active);
create policy blog_categories_admin_write on public.blog_categories for all to authenticated
  using (public.has_permission('cms.blog.manage') and public.is_aal2())
  with check (public.has_permission('cms.blog.manage') and public.is_aal2());

create policy blog_tags_public_read on public.blog_tags for select to authenticated using (is_active);
create policy blog_tags_admin_write on public.blog_tags for all to authenticated
  using (public.has_permission('cms.blog.manage') and public.is_aal2())
  with check (public.has_permission('cms.blog.manage') and public.is_aal2());

create policy blog_posts_public_read on public.blog_posts for select to authenticated
  using (public.cms_content_is_public(status, published_at));
create policy blog_posts_admin_read on public.blog_posts for select to authenticated
  using (public.has_permission('cms.blog.read'));
create policy blog_posts_admin_write on public.blog_posts for all to authenticated
  using (public.has_permission('cms.blog.manage') and public.is_aal2())
  with check (public.has_permission('cms.blog.manage') and public.is_aal2());

create policy blog_post_slug_history_public_read on public.blog_post_slug_history for select to authenticated
  using (exists (select 1 from public.blog_posts b
                  where b.id = blog_post_id and public.cms_content_is_public(b.status, b.published_at)));
create policy blog_post_slug_history_admin_read on public.blog_post_slug_history for select to authenticated
  using (public.has_permission('cms.blog.read'));
create policy blog_post_slug_history_admin_write on public.blog_post_slug_history for insert to authenticated
  with check (public.has_permission('cms.blog.manage') and public.is_aal2());

create policy blog_post_translations_public_read on public.blog_post_translations for select to authenticated
  using (exists (select 1 from public.blog_posts b
                  where b.id = blog_post_id and public.cms_content_is_public(b.status, b.published_at)));
create policy blog_post_translations_admin_read on public.blog_post_translations for select to authenticated
  using (public.has_permission('cms.blog.read'));
create policy blog_post_translations_admin_write on public.blog_post_translations for all to authenticated
  using (public.has_permission('cms.blog.manage') and public.is_aal2())
  with check (public.has_permission('cms.blog.manage') and public.is_aal2());

create policy blog_post_tags_public_read on public.blog_post_tags for select to authenticated
  using (exists (select 1 from public.blog_posts b
                  where b.id = blog_post_id and public.cms_content_is_public(b.status, b.published_at)));
create policy blog_post_tags_admin_read on public.blog_post_tags for select to authenticated
  using (public.has_permission('cms.blog.read'));
create policy blog_post_tags_admin_write on public.blog_post_tags for all to authenticated
  using (public.has_permission('cms.blog.manage') and public.is_aal2())
  with check (public.has_permission('cms.blog.manage') and public.is_aal2());

-- FAQs, homepage, banners, navigation.
create policy faqs_public_read on public.faqs for select to authenticated using (is_published);
create policy faqs_admin_read on public.faqs for select to authenticated
  using (public.has_permission('cms.faq.read'));
create policy faqs_admin_write on public.faqs for all to authenticated
  using (public.has_permission('cms.faq.manage') and public.is_aal2())
  with check (public.has_permission('cms.faq.manage') and public.is_aal2());

create policy homepage_sections_public_read on public.homepage_sections for select to authenticated
  using (is_active);
create policy homepage_sections_admin_read on public.homepage_sections for select to authenticated
  using (public.has_permission('cms.homepage.read'));
create policy homepage_sections_admin_write on public.homepage_sections for all to authenticated
  using (public.has_permission('cms.homepage.manage') and public.is_aal2())
  with check (public.has_permission('cms.homepage.manage') and public.is_aal2());

create policy banners_public_read on public.banners for select to authenticated
  using (public.banner_is_live(is_active, starts_at, ends_at));
create policy banners_admin_read on public.banners for select to authenticated
  using (public.has_permission('cms.banner.read'));
create policy banners_admin_write on public.banners for all to authenticated
  using (public.has_permission('cms.banner.manage') and public.is_aal2())
  with check (public.has_permission('cms.banner.manage') and public.is_aal2());

create policy navigation_menus_public_read on public.navigation_menus for select to authenticated
  using (is_active);
create policy navigation_menus_admin_write on public.navigation_menus for all to authenticated
  using (public.has_permission('cms.navigation.manage') and public.is_aal2())
  with check (public.has_permission('cms.navigation.manage') and public.is_aal2());

create policy navigation_items_public_read on public.navigation_items for select to authenticated
  using (is_active and exists (select 1 from public.navigation_menus m where m.id = menu_id and m.is_active));
create policy navigation_items_admin_read on public.navigation_items for select to authenticated
  using (public.has_permission('cms.navigation.read'));
create policy navigation_items_admin_write on public.navigation_items for all to authenticated
  using (public.has_permission('cms.navigation.manage') and public.is_aal2())
  with check (public.has_permission('cms.navigation.manage') and public.is_aal2());

-- SEO. Settings are crawler-facing by definition; metadata is only as public as what it describes.
create policy seo_settings_public_read on public.seo_settings for select to authenticated using (true);
create policy seo_settings_admin_write on public.seo_settings for all to authenticated
  using (public.has_permission('seo.settings.manage') and public.is_aal2())
  with check (public.has_permission('seo.settings.manage') and public.is_aal2());

create policy seo_metadata_public_read on public.seo_metadata for select to authenticated
  using (public.seo_metadata_is_public(entity_type, entity_id));
create policy seo_metadata_admin_read on public.seo_metadata for select to authenticated
  using (public.has_permission('seo.metadata.read'));
create policy seo_metadata_admin_write on public.seo_metadata for all to authenticated
  using (public.has_permission('seo.metadata.manage') and public.is_aal2())
  with check (public.has_permission('seo.metadata.manage') and public.is_aal2());

create policy redirects_public_read on public.redirects for select to authenticated using (is_active);
create policy redirects_admin_read on public.redirects for select to authenticated
  using (public.has_permission('seo.redirect.read'));
create policy redirects_admin_write on public.redirects for all to authenticated
  using (public.has_permission('seo.redirect.manage') and public.is_aal2())
  with check (public.has_permission('seo.redirect.manage') and public.is_aal2());

-- ---------------------------------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------------------------------
grant select, insert, update, delete on
  public.cms_media, public.pages, public.page_translations, public.blog_categories, public.blog_tags,
  public.blog_posts, public.blog_post_translations, public.blog_post_tags, public.faqs,
  public.homepage_sections, public.banners, public.navigation_menus, public.navigation_items,
  public.seo_settings, public.seo_metadata, public.redirects
  to authenticated;

-- Slug history is written by the slug triggers and never edited afterwards.
grant select, insert on public.page_slug_history, public.blog_post_slug_history to authenticated;

revoke execute on all functions in schema public from public;
revoke execute on all functions in schema app_private from public;

grant execute on function
  public.cms_content_is_public(text, timestamptz),
  public.banner_is_live(boolean, timestamptz, timestamptz),
  public.seo_metadata_is_public(text, uuid),
  public.resolve_redirect(text)
  to authenticated;

grant execute on function
  public.cms_content_is_public(text, timestamptz),
  public.banner_is_live(boolean, timestamptz, timestamptz),
  public.seo_metadata_is_public(text, uuid),
  public.resolve_redirect(text),
  app_private.publish_due_content()
  to app_system, app_worker;
