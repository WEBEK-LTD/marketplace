-- 0008 — Site settings, email templates and the notification outboxes (v5.2 migration plan).
--
-- `site_settings` is where every admin-configurable value lives: branding (D5: brand name and domain are
-- settings, never hard-coded), the display timezone (C20), retention periods (C18 needs configurable
-- fields in Phase 2, values before production), offer and cart windows (D22, D23, D25) and the digit
-- style default (D15). Rows are seeded in 0033.
--
-- Only the Notifications module writes `notifications`, `email_outbox` and `whatsapp_outbox` (v5.2 data
-- architecture). That is enforced here the only way the database can: no application role is granted
-- anything on the outbox tables, and every write goes through a SECURITY DEFINER function.
--
-- `notifications` itself belongs to migration 0029; 0008 creates the two delivery outboxes and the
-- template store they render from.

-- ---------------------------------------------------------------------------------------------------
-- Site settings
-- ---------------------------------------------------------------------------------------------------
create table public.site_settings (
  key text primary key,
  category text not null,
  value jsonb not null,
  value_type text not null,
  is_public boolean not null default false,
  description_en text not null,
  description_ar text not null,
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint site_settings_key_format check (key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  constraint site_settings_category_format check (category ~ '^[a-z][a-z0-9_]*$'),
  constraint site_settings_value_type_allowed check (value_type in ('string', 'number', 'boolean', 'json')),
  constraint site_settings_value_matches_type check (
    case value_type
      when 'string' then jsonb_typeof(value) = 'string'
      when 'number' then jsonb_typeof(value) = 'number'
      when 'boolean' then jsonb_typeof(value) = 'boolean'
      else jsonb_typeof(value) in ('object', 'array')
    end
  ),
  constraint site_settings_descriptions_present check (length(btrim(description_en)) > 0 and length(btrim(description_ar)) > 0)
);
comment on table public.site_settings is
  'Admin-configurable values (branding D5, display timezone C20, retention C18, windows D22/D23/D25). `is_public` marks settings the public site may read.';
create index site_settings_category on public.site_settings (category, key);
create trigger site_settings_set_updated_at before update on public.site_settings
  for each row execute function app_private.tg_set_updated_at();
create trigger site_settings_audit after insert or update or delete on public.site_settings
  for each row execute function audit.tg_record_change();

create or replace function public.site_setting(p_key text) returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select s.value from public.site_settings s where s.key = p_key;
$$;
comment on function public.site_setting(text) is 'Reads one setting value regardless of the caller''s privileges; used by policies and PL/pgSQL.';

-- ---------------------------------------------------------------------------------------------------
-- Email templates
-- ---------------------------------------------------------------------------------------------------
create table public.email_templates (
  key text not null,
  locale_code text not null references public.locales (code) on delete restrict,
  subject text not null,
  body_html text not null,
  body_text text not null,
  is_active boolean not null default true,
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (key, locale_code),
  constraint email_templates_key_format check (key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),
  constraint email_templates_content_present check (
    length(btrim(subject)) > 0 and length(btrim(body_html)) > 0 and length(btrim(body_text)) > 0
  )
);
comment on table public.email_templates is 'Bilingual transactional email templates. The recipient''s profile language selects the row.';
create trigger email_templates_set_updated_at before update on public.email_templates
  for each row execute function app_private.tg_set_updated_at();

-- ---------------------------------------------------------------------------------------------------
-- Email outbox
-- ---------------------------------------------------------------------------------------------------
create table public.email_outbox (
  id uuid primary key default gen_random_uuid(),
  recipient_user_id uuid references auth.users (id) on delete set null,
  to_address extensions.citext not null,
  template_key text,
  locale_code text references public.locales (code) on delete set null,
  subject text not null,
  body_html text not null,
  body_text text not null,
  status text not null default 'queued',
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  sent_at timestamptz,
  failed_at timestamptz,
  last_error_type text,
  provider_message_id text,
  dedupe_key text,
  created_at timestamptz not null default now(),
  constraint email_outbox_status_allowed check (status in ('queued', 'sending', 'sent', 'failed', 'cancelled')),
  constraint email_outbox_attempts_positive check (attempts >= 0),
  constraint email_outbox_sent_has_time check ((status = 'sent') = (sent_at is not null)),
  constraint email_outbox_failed_has_time check ((status = 'failed') = (failed_at is not null)),
  constraint email_outbox_error_type_format check (last_error_type is null or last_error_type ~ '^[A-Za-z][A-Za-z0-9_]*$'),
  constraint email_outbox_address_shape check (position('@' in to_address) > 1)
);
comment on table public.email_outbox is
  'Queued transactional email. Rendered bodies are stored, so the retention setting in site_settings governs how long they live.';
comment on column public.email_outbox.last_error_type is 'Error class name only; provider error messages are never stored.';
create unique index email_outbox_dedupe on public.email_outbox (dedupe_key) where dedupe_key is not null;
create index email_outbox_pending on public.email_outbox (available_at, id) where status = 'queued';
create index email_outbox_recipient on public.email_outbox (recipient_user_id, created_at desc);

-- ---------------------------------------------------------------------------------------------------
-- WhatsApp outbox (C21: OTP only in V1)
-- ---------------------------------------------------------------------------------------------------
create table public.whatsapp_outbox (
  id uuid primary key default gen_random_uuid(),
  recipient_user_id uuid references auth.users (id) on delete set null,
  to_phone_e164 text not null,
  purpose text not null default 'otp',
  template_name text not null,
  template_locale text not null,
  variables jsonb not null default '{}'::jsonb,
  status text not null default 'queued',
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  sent_at timestamptz,
  failed_at timestamptz,
  last_error_type text,
  provider_message_id text,
  dedupe_key text,
  created_at timestamptz not null default now(),
  constraint whatsapp_outbox_purpose_otp_only check (purpose = 'otp'),
  constraint whatsapp_outbox_phone_format check (to_phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  constraint whatsapp_outbox_status_allowed check (status in ('queued', 'sending', 'sent', 'failed', 'cancelled')),
  constraint whatsapp_outbox_attempts_positive check (attempts >= 0),
  constraint whatsapp_outbox_sent_has_time check ((status = 'sent') = (sent_at is not null)),
  constraint whatsapp_outbox_failed_has_time check ((status = 'failed') = (failed_at is not null)),
  constraint whatsapp_outbox_error_type_format check (last_error_type is null or last_error_type ~ '^[A-Za-z][A-Za-z0-9_]*$'),
  constraint whatsapp_outbox_variables_is_object check (jsonb_typeof(variables) = 'object'),
  -- The one-time code never reaches the database: it is hashed in app_private.otp_challenges and the
  -- clear value travels only in the delivery job.
  constraint whatsapp_outbox_variables_carry_no_secret check (
    not (variables ?| array['code', 'otp', 'password', 'token', 'secret'])
  )
);
comment on table public.whatsapp_outbox is 'Queued WhatsApp messages. V1 sends OTP messages only (C21); the code itself is never stored here.';
create unique index whatsapp_outbox_dedupe on public.whatsapp_outbox (dedupe_key) where dedupe_key is not null;
create index whatsapp_outbox_pending on public.whatsapp_outbox (available_at, id) where status = 'queued';
create index whatsapp_outbox_recipient on public.whatsapp_outbox (recipient_user_id, created_at desc);

-- ---------------------------------------------------------------------------------------------------
-- Delivery functions (the Notifications module is the only writer)
-- ---------------------------------------------------------------------------------------------------
create or replace function app_private.queue_email(
  p_to_address text,
  p_subject text,
  p_body_html text,
  p_body_text text,
  p_recipient_user_id uuid default null,
  p_template_key text default null,
  p_locale_code text default null,
  p_dedupe_key text default null,
  p_available_at timestamptz default null
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  new_id uuid;
begin
  insert into public.email_outbox (to_address, subject, body_html, body_text, recipient_user_id, template_key, locale_code, dedupe_key, available_at)
  values (p_to_address, p_subject, p_body_html, p_body_text, p_recipient_user_id, p_template_key, p_locale_code, p_dedupe_key, coalesce(p_available_at, now()))
  on conflict (dedupe_key) where dedupe_key is not null do nothing
  returning id into new_id;
  return new_id;
end;
$$;
comment on function app_private.queue_email(text, text, text, text, uuid, text, text, text, timestamptz) is
  'Queues one email. Returns NULL when the dedupe key already exists, so a retried handler sends nothing twice.';

create or replace function app_private.queue_whatsapp_otp(
  p_to_phone_e164 text,
  p_template_name text,
  p_template_locale text,
  p_recipient_user_id uuid default null,
  p_variables jsonb default '{}'::jsonb,
  p_dedupe_key text default null
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  new_id uuid;
begin
  insert into public.whatsapp_outbox (to_phone_e164, template_name, template_locale, recipient_user_id, variables, dedupe_key)
  values (p_to_phone_e164, p_template_name, p_template_locale, p_recipient_user_id, coalesce(p_variables, '{}'::jsonb), p_dedupe_key)
  on conflict (dedupe_key) where dedupe_key is not null do nothing
  returning id into new_id;
  return new_id;
end;
$$;

create or replace function app_private.claim_outbox_messages(p_channel text, p_limit integer default 50)
returns table (id uuid, recipient_user_id uuid, destination text, payload jsonb, attempts integer)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_limit < 1 or p_limit > 500 then
    raise exception 'p_limit must be between 1 and 500';
  end if;
  if p_channel = 'email' then
    return query
    with claimed as (
      select e.id from public.email_outbox e
       where e.status = 'queued' and e.available_at <= now()
       order by e.available_at, e.id limit p_limit for update skip locked
    )
    update public.email_outbox e
       set status = 'sending', attempts = e.attempts + 1
      from claimed
     where e.id = claimed.id
    returning e.id, e.recipient_user_id, e.to_address::text,
              jsonb_build_object('subject', e.subject, 'body_html', e.body_html, 'body_text', e.body_text, 'template_key', e.template_key, 'locale_code', e.locale_code),
              e.attempts;
  elsif p_channel = 'whatsapp' then
    return query
    with claimed as (
      select w.id from public.whatsapp_outbox w
       where w.status = 'queued' and w.available_at <= now()
       order by w.available_at, w.id limit p_limit for update skip locked
    )
    update public.whatsapp_outbox w
       set status = 'sending', attempts = w.attempts + 1
      from claimed
     where w.id = claimed.id
    returning w.id, w.recipient_user_id, w.to_phone_e164,
              jsonb_build_object('template_name', w.template_name, 'template_locale', w.template_locale, 'variables', w.variables),
              w.attempts;
  else
    raise exception 'unknown notification channel %', p_channel;
  end if;
end;
$$;

create or replace function app_private.settle_outbox_message(
  p_channel text,
  p_id uuid,
  p_status text,
  p_provider_message_id text default null,
  p_error_type text default null,
  p_retry_at timestamptz default null
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  updated integer;
begin
  if p_status not in ('sent', 'failed', 'queued', 'cancelled') then
    raise exception 'unknown settlement status %', p_status;
  end if;
  if p_channel = 'email' then
    update public.email_outbox
       set status = p_status,
           provider_message_id = coalesce(p_provider_message_id, provider_message_id),
           last_error_type = p_error_type,
           sent_at = case when p_status = 'sent' then now() else null end,
           failed_at = case when p_status = 'failed' then now() else null end,
           available_at = case when p_status = 'queued' then coalesce(p_retry_at, now()) else available_at end
     where id = p_id and status = 'sending';
  elsif p_channel = 'whatsapp' then
    update public.whatsapp_outbox
       set status = p_status,
           provider_message_id = coalesce(p_provider_message_id, provider_message_id),
           last_error_type = p_error_type,
           sent_at = case when p_status = 'sent' then now() else null end,
           failed_at = case when p_status = 'failed' then now() else null end,
           available_at = case when p_status = 'queued' then coalesce(p_retry_at, now()) else available_at end
     where id = p_id and status = 'sending';
  else
    raise exception 'unknown notification channel %', p_channel;
  end if;
  get diagnostics updated = row_count;
  return updated = 1;
end;
$$;
comment on function app_private.settle_outbox_message(text, uuid, text, text, text, timestamptz) is
  'Records the outcome of one delivery attempt. Only a message currently being sent can be settled, so a late duplicate changes nothing.';

-- ---------------------------------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------------------------------
alter table public.site_settings enable row level security;
alter table public.email_templates enable row level security;
alter table public.email_outbox enable row level security;
alter table public.whatsapp_outbox enable row level security;

create policy site_settings_public_read on public.site_settings for select to authenticated
  using (is_public);
create policy site_settings_admin_read on public.site_settings for select to authenticated
  using (public.has_permission('settings.site.read'));
create policy site_settings_admin_update on public.site_settings for update to authenticated
  using (public.has_permission('settings.site.manage') and public.is_aal2())
  with check (public.has_permission('settings.site.manage') and public.is_aal2());

create policy email_templates_admin_read on public.email_templates for select to authenticated
  using (public.has_permission('settings.email_template.read'));
create policy email_templates_admin_write on public.email_templates for all to authenticated
  using (public.has_permission('settings.email_template.manage') and public.is_aal2())
  with check (public.has_permission('settings.email_template.manage') and public.is_aal2());

-- The two outboxes carry no policies and no grants: the Notifications module reaches them only through
-- the SECURITY DEFINER functions above.

grant select, update on public.site_settings to authenticated;
grant select, insert, update, delete on public.email_templates to authenticated;

-- ---------------------------------------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema app_private from public;

grant execute on function public.site_setting(text) to authenticated;

grant execute on function
  public.site_setting(text),
  app_private.queue_email(text, text, text, text, uuid, text, text, text, timestamptz),
  app_private.queue_whatsapp_otp(text, text, text, uuid, jsonb, text),
  app_private.claim_outbox_messages(text, integer),
  app_private.settle_outbox_message(text, uuid, text, text, text, timestamptz)
  to app_system, app_worker;
