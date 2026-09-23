-- pgTAP — migration 0012: storage buckets and their policies.
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(10);

select is((select count(*) from public.storage_bucket_problems()), 0::bigint,
  'every bucket exists with the privacy the contract requires');

select ok((select public from storage.buckets where id = 'listing-variants'),
  'the listing variants bucket is the one public bucket');

select is(
  (select count(*) from storage.buckets where public and id <> 'listing-variants'),
  0::bigint,
  'no other bucket is public'
);

select ok(not (select public from storage.buckets where id = 'listing-originals'),
  'uploaded originals stay private and are never served publicly');
select ok(not (select public from storage.buckets where id = 'verification-documents'),
  'verification documents stay private');
select ok(not (select public from storage.buckets where id = 'message-attachments'),
  'message attachments stay private');

-- Row level security is what makes a private bucket private. 0012 verifies it rather than enabling it,
-- because both storage tables belong to supabase_storage_admin and the migration role is not that
-- owner. The Data API roles keep table privileges here that no migration can revoke, so row level
-- security plus the absence of a policy is the whole boundary — a privilege reaches no row that no
-- policy allows.
select is(
  (select count(*)
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'storage' and c.relname in ('objects', 'buckets') and c.relrowsecurity),
  2::bigint,
  'row level security is enabled on both storage.objects and storage.buckets (C15)'
);

-- No policy names a private bucket, so nothing opens one through the table.
select is(
  (select coalesce(string_agg(distinct c.bucket_id, ', '), '')
     from app_private.storage_bucket_contract c
    where not c.must_be_public
      and exists (
        select 1
          from pg_policy p
          join pg_class t on t.oid = p.polrelid
          join pg_namespace n on n.oid = t.relnamespace
         where n.nspname = 'storage'
           and t.relname = 'objects'
           and pg_get_expr(p.polqual, p.polrelid) like '%' || c.bucket_id || '%')),
  '',
  'no storage.objects policy names a private bucket: every one of them is reached only by signed URL (C15)'
);

-- Only the public bucket has a read policy; private buckets are reached solely by signed URLs (C15).
select is(
  (select coalesce(string_agg(polname, ', ' order by polname), '')
     from pg_policy where polrelid = 'storage.objects'::regclass),
  'listing_variants_public_read',
  'storage.objects carries exactly one policy, for the public bucket'
);

-- The guard notices if a sensitive bucket is ever made public.
update storage.buckets set public = true where id = 'verification-documents';
select is(
  (select problem from public.storage_bucket_problems() where bucket_id = 'verification-documents'),
  'the bucket must be private',
  'making a sensitive bucket public is detected'
);

select * from finish();
rollback;
