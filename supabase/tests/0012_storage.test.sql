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
-- because storage.objects belongs to supabase_storage_admin and the migration role is not that owner.
select ok(
  (select c.relrowsecurity
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'storage' and c.relname = 'objects'),
  'row level security is enabled on storage.objects, which is what keeps every private bucket private (C15)'
);

-- The revoke in 0012 must have taken effect, not merely returned without error.
select is(
  (select count(*)
     from (values ('anon'), ('authenticated')) as r(role)
    cross join (values ('storage.objects'), ('storage.buckets')) as t(relation)
    cross join (values ('select'), ('insert'), ('update'), ('delete'), ('truncate'), ('references'), ('trigger')) as p(privilege)
    where has_table_privilege(r.role, t.relation, p.privilege)),
  0::bigint,
  'anon and authenticated hold no privilege of their own on the storage tables: a private bucket is reached only by signed URL (C15)'
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
