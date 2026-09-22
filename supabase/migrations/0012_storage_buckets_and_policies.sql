-- 0012 — Storage buckets and storage.objects policies (v5.2 migration plan; C15, Supabase exposure).
--
-- Buckets and their public/private flag are defined only here, never in a dashboard. One public bucket
-- holds approved listing variants; everything else is private. Private objects are reachable only
-- through short-lived API-signed URLs (C15), so `authenticated` gets no read policy on them at all —
-- the signing path runs with service credentials and does not go through row level security.
--
-- The originals bucket is private and the original is never served publicly, including as a fallback
-- (media lifecycle, enforced on the database side by the variant rules in 0011).

do $$
begin
  if to_regclass('storage.buckets') is null or to_regclass('storage.objects') is null then
    raise exception 'Supabase Storage is not installed in this database'
      using hint = 'Migration 0012 defines the buckets and their policies; it needs the storage schema.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------------------------------
-- Buckets
-- ---------------------------------------------------------------------------------------------------
-- The one public bucket. Nothing reaches it until a listing is approved (0011 variant rules).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('listing-variants', 'listing-variants', true, 10485760, array['image/webp', 'image/avif', 'image/jpeg'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Private buckets.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('listing-originals', 'listing-originals', false, 26214400, array['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/heic']),
  ('verification-documents', 'verification-documents', false, 20971520, array['image/jpeg', 'image/png', 'application/pdf']),
  ('dispute-evidence', 'dispute-evidence', false, 20971520, array['image/jpeg', 'image/png', 'application/pdf']),
  ('recovery-evidence', 'recovery-evidence', false, 20971520, array['image/jpeg', 'image/png', 'application/pdf']),
  ('message-attachments', 'message-attachments', false, 20971520, array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']),
  ('support-attachments', 'support-attachments', false, 20971520, array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------------------------------------
-- The bucket contract, checkable from CI and pgTAP
-- ---------------------------------------------------------------------------------------------------
create table app_private.storage_bucket_contract (
  bucket_id text primary key,
  must_be_public boolean not null,
  purpose text not null,
  constraint storage_bucket_contract_purpose_present check (length(btrim(purpose)) > 0)
);
comment on table app_private.storage_bucket_contract is
  'What each bucket''s public flag must be. `storage_bucket_problems()` compares it with reality and is asserted by pgTAP.';
alter table app_private.storage_bucket_contract enable row level security;

insert into app_private.storage_bucket_contract (bucket_id, must_be_public, purpose) values
  ('listing-variants', true, 'approved listing image variants, served publicly'),
  ('listing-originals', false, 'uploaded originals; never served publicly, not even as a fallback'),
  ('verification-documents', false, 'seller identity and business documents'),
  ('dispute-evidence', false, 'evidence attached to disputes'),
  ('recovery-evidence', false, 'evidence attached to account recovery requests'),
  ('message-attachments', false, 'conversation attachments'),
  ('support-attachments', false, 'support ticket attachments');

create or replace function public.storage_bucket_problems()
returns table (bucket_id text, problem text)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select c.bucket_id, 'the bucket does not exist'
    from app_private.storage_bucket_contract c
   where not exists (select 1 from storage.buckets b where b.id = c.bucket_id)
  union all
  select c.bucket_id,
         case when c.must_be_public then 'the bucket must be public' else 'the bucket must be private' end
    from app_private.storage_bucket_contract c
    join storage.buckets b on b.id = c.bucket_id
   where b.public is distinct from c.must_be_public
  union all
  select b.id, 'a bucket exists that the contract does not describe'
    from storage.buckets b
   where not exists (select 1 from app_private.storage_bucket_contract c where c.bucket_id = b.id);
$$;
comment on function public.storage_bucket_problems() is
  'Empty when every bucket exists with the privacy the contract requires. CI fails if a sensitive bucket is public.';

-- ---------------------------------------------------------------------------------------------------
-- storage.objects policies
-- ---------------------------------------------------------------------------------------------------
-- Supabase Storage creates storage.objects and storage.buckets, and owns them as
-- `supabase_storage_admin`, before this migration runs. The migrating role is not that owner and is not
-- a member of it, so `alter table storage.objects …` is owner-only and unreachable from here:
-- PostgreSQL offers no GRANT that confers ownership, and granting the membership or moving the owner
-- would be a privilege escalation this project does not accept. Everything else this section needs —
-- revoking the Data API roles' direct grants, and defining the one read policy — is permitted and is
-- kept exactly as before.
--
-- Each part below carries its own diagnostics. The previous single handler collapsed five statements
-- into one opaque code and discarded SQLSTATE and the message, which hid for days that only the first
-- statement was ever the problem.

-- 1. Row level security: verified, not set.
-- Supabase enables it when it creates the table. This migration refuses to continue without it, because
-- every private bucket's protection rests on it (C15) and nothing else in the repository asserts it.
do $$
declare
  enabled boolean;
begin
  select c.relrowsecurity into enabled
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'storage' and c.relname = 'objects';
  if enabled is null then
    raise exception 'storage.objects disappeared between the check above and here';
  end if;
  if not enabled then
    raise exception 'row level security is not enabled on storage.objects'
      using hint = 'Supabase Storage enables it when it creates the table. Without it every private bucket is readable by anyone who can reach the table, and the migration role does not own storage.objects, so it cannot enable it here (C15).';
  end if;
end;
$$;

-- 2. The Data API roles hold no direct grants on the storage tables.
-- A REVOKE removes only what the current role may revoke, so returning without error is not proof. The
-- post-condition below is the proof.
do $$
declare
  failed_state text;
  failed_message text;
  remaining text;
begin
  begin
    execute 'revoke all on storage.objects from anon, authenticated';
    execute 'revoke all on storage.buckets from anon, authenticated';
  exception
    when others then
      get stacked diagnostics failed_state = returned_sqlstate, failed_message = message_text;
      raise exception 'cannot revoke storage privileges from anon and authenticated (SQLSTATE %): %', failed_state, failed_message
        using hint = 'Supabase grants these roles privileges on storage.objects and storage.buckets when it creates them; 0012 takes them back so that reaching a private bucket always goes through a signed URL (C15).';
  end;

  select string_agg(format('%s holds %s on %s', r.role, p.privilege, t.relation), ', ' order by r.role, t.relation, p.privilege)
    into remaining
    from (values ('anon'), ('authenticated')) as r(role)
   cross join (values ('storage.objects'), ('storage.buckets')) as t(relation)
   cross join (values ('select'), ('insert'), ('update'), ('delete'), ('truncate'), ('references'), ('trigger')) as p(privilege)
   where has_table_privilege(r.role, t.relation, p.privilege);

  if remaining is not null then
    raise exception 'the revoke did not take effect: %', remaining
      using hint = 'The migration role may revoke only privileges it is entitled to revoke. A privilege that survives here is reachable without a signed URL, which C15 does not allow.';
  end if;
end;
$$;

-- 3. The one read policy.
-- The only readable bucket. Private buckets deliberately have no policy at all: a signed URL issued by
-- the API is the one way in (C15).
do $$
declare
  failed_state text;
  failed_message text;
begin
  execute 'drop policy if exists listing_variants_public_read on storage.objects';
  execute $p$
    create policy listing_variants_public_read on storage.objects
      for select to authenticated, anon
      using (bucket_id = 'listing-variants')
  $p$;
exception
  when others then
    get stacked diagnostics failed_state = returned_sqlstate, failed_message = message_text;
    raise exception 'cannot define the listing-variants read policy on storage.objects (SQLSTATE %): %', failed_state, failed_message
      using hint = 'Bucket access stays defined in migrations, never in a dashboard. If this is a privilege error, the migration role lost a capability it had when 0012 was written.';
end;
$$;

-- ---------------------------------------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema app_private from public;

grant execute on function public.storage_bucket_problems() to app_system, app_worker;
