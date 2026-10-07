-- 0106 — Pagination probe-row correction and the reader limit contract.
--
-- This API answers "is there another page?" without a count: it asks the database for `limit + 1` rows and
-- treats the extra row as the answer. Nine `app_private` readers clamped `p_limit` to **exactly** the
-- contract's public maximum, so at the maximum page size the probe row was eaten by the clamp and the caller
-- was told the list had ended.
--
-- ---------------------------------------------------------------------------------------------------
-- THE DEFECT, AS IT WAS PROVED
-- ---------------------------------------------------------------------------------------------------
--
-- Sixty rows in `public.user_blocks`, one blocker, through `app_private.buyer_blocks`:
--
--     API asks reader for 51 (client max 50)  : 50 rows returned
--     API computes hasMore = rows > 50        : false     <- ten rows unreachable
--     API asks reader for 50 (client 49)      : 50 rows returned
--     API computes hasMore = rows > 49        : true
--
-- `50 + 1 = 51`, clamped back to `50`, and `rows.length (50) > 50` is false. `nextCursor` comes back null on a
-- page that has more behind it. There is no error and no log: the caller is told, confidently, that it has seen
-- everything. `limit` is client-supplied and the web BFF passes `params.get('limit')` straight through, so
-- `?limit=50` reaches this from a browser.
--
-- **This is a defect and not a design, and the codebase says so itself.** Twenty-eight readers written from
-- 0069 onward clamp to `contract maximum + 1` and accommodate the probe row explicitly. Nine written earlier
-- clamp to the maximum itself and were never revisited. The convention existed; these nine predate it.
--
-- ---------------------------------------------------------------------------------------------------
-- WHAT THIS MIGRATION DOES
-- ---------------------------------------------------------------------------------------------------
--
-- 1. **Preflight.** One assertion per reader, checking that the live ceiling is the old value this migration
--    expects to find. A reader that has already been corrected, or that somebody has changed to a third value,
--    aborts the migration naming it — so this cannot be applied twice and cannot be applied to a schema it
--    does not recognise. Nothing has been changed at that point.
-- 2. **Nine `CREATE OR REPLACE FUNCTION` definitions**, each dumped from the live catalogue rather than
--    retyped, with the ceiling raised to `contract maximum + 1` and **nothing else touched** — not the
--    default, not the floor, not the ordering, not the cursor comparison, not a column, not a grant.
-- 3. **A verification guard** asserting every one of the nine now holds its new ceiling, and that the only
--    readers left clamping at a public maximum are the three the owner deliberately exempted.
--
-- ---------------------------------------------------------------------------------------------------
-- THE NINE, AND WHERE EACH CEILING COMES FROM
-- ---------------------------------------------------------------------------------------------------
--
--   | reader                          | from | contract constant             | ceiling   |
--   | ------------------------------- | ---- | ----------------------------- | --------- |
--   | messaging_inbox                 | 0053 | MESSAGING_INBOX_MAX_LIMIT     |  50 -> 51 |
--   | messaging_conversation_messages | 0053 | MESSAGING_MESSAGES_MAX_LIMIT  | 100 -> 101|
--   | notifications_inbox             | 0066 | NOTIFICATIONS_MAX_LIMIT       |  50 -> 51 |
--   | buyer_favorites                 | 0067 | ACCOUNT_MAX_LIMIT             |  50 -> 51 |
--   | buyer_saved_searches            | 0067 | ACCOUNT_MAX_LIMIT             |  50 -> 51 |
--   | buyer_blocks                    | 0103 | BLOCKS_MAX_LIMIT              |  50 -> 51 |
--   | seller_listings                 | 0061 | SELLER_LISTINGS_MAX_LIMIT     |  50 -> 51 |
--   | seller_services                 | 0062 | SELLER_SERVICES_MAX_LIMIT     |  50 -> 51 |
--   | listing_analytics_page          | 0102 | LISTING_ANALYTICS_MAX_LIMIT   | 100 -> 101|
--
-- ---------------------------------------------------------------------------------------------------
-- WHAT IS DELIBERATELY NOT TOUCHED
-- ---------------------------------------------------------------------------------------------------
--
-- **No public maximum moves, and no default page size moves** (owner decision 5). A caller may still ask for
-- fifty. The ceiling is the database's own safety bound on a parameter it does not trust; the probe row is the
-- API's business. Raising the bound by one is what lets the API do its own job, and it changes nothing a
-- client can observe except that the page after the fiftieth row now exists.
--
-- **No response shape, no cursor format, no problem code** (owner decision 6). Every one of the nine keeps its
-- result columns, its ordering and its cursor comparison byte for byte: this migration edits one integer in
-- each body and the dumps above prove the rest came across unchanged.
--
-- **The thirty-seven readers with no upper clamp at all are correct as they are.** `blog_posts_for_public`,
-- `public_listings`, `public_search`, `cms_pages_for_staff`, the sitemap readers and the rest write
-- `limit greatest(coalesce(p_limit, 20), 1)` with no `least(...)` — they return exactly what they were asked
-- for, so the probe row was never at risk. A ceiling is not required; a ceiling equal to the public maximum is
-- the defect. The structural check added alongside this migration says exactly that and nothing stronger.
--
-- **Three readers keep a ceiling of 50, by owner decision 3.** `seller_orders`, `seller_reviews` and
-- `seller_promotions` are driven by `apps/api/src/sellers/seller-read.service.ts`, which does not send a probe
-- row at all: it sends `limit: size` and decides there is another page from `rows.length === size`. That
-- convention **loses no rows** — its cost is one wasted request when the total is an exact multiple of the
-- page size, which returns an empty page. Changing it would change when `nextCursor` is null on that boundary,
-- which is a cursor-semantics change this increment is forbidden to make. So a third pagination convention
-- exists in this platform on purpose, it is recorded here and in the README rather than left to be
-- rediscovered, and the structural check names those three as explicit exemptions rather than quietly
-- tolerating their shape.
--
-- **`dispute_messages_for_staff` keeps 201** against a maximum of 50 (owner decision 2). Its headroom is
-- already safe and inventing a reason to tighten it would be a change without a defect behind it.
--
-- Nothing financial, nothing about A2's robots policy, nothing about Unicode whitespace, and none of the other
-- corrective findings — the phone pattern, the country-code casing, the character-length refines, the
-- saved-search size bound, the analytics de-duplication key — is touched here. Each is recorded for its own
-- increment (owner decision 8).
--
-- 0105's strict `btrim(x, E' \t\r\n')` survives in every replaced body, because every body was dumped from the
-- catalogue after 0105 applied. This is also the first migration under 0105's policy gate, which refuses any
-- trim call from 0106 onward that does not name its character set.
--
-- That gate is deliberately blind to context — 0105's own suite asserts that a call inside a comment still
-- counts, because a check clever enough to skip comments is a check that can be fooled by one. The practical
-- consequence, met while writing this file: a migration cannot spell the loose form in its prose, even to
-- explain it. So this comment describes it in words instead, and the limitation is recorded rather than worked
-- around by weakening the gate.

-- ---------------------------------------------------------------------------------------------------
-- 1. Preflight — the schema is the one this migration was written against, or nothing happens
-- ---------------------------------------------------------------------------------------------------
do $$
declare
  v_problems text[] := array[]::text[];
  v_found text;
begin
  select (regexp_match(p.prosrc, 'least\(greatest\(coalesce\(p_limit[^)]*\),\s*1\),\s*([0-9]+)\)'))[1]
    into v_found
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app_private' and p.proname = 'messaging_inbox';
  if v_found is distinct from '50' then
    v_problems := v_problems || format('app_private.messaging_inbox: expected a ceiling of 50, found %s', coalesce(v_found, 'no clamp at all'));
  end if;

  select (regexp_match(p.prosrc, 'least\(greatest\(coalesce\(p_limit[^)]*\),\s*1\),\s*([0-9]+)\)'))[1]
    into v_found
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app_private' and p.proname = 'messaging_conversation_messages';
  if v_found is distinct from '100' then
    v_problems := v_problems || format('app_private.messaging_conversation_messages: expected a ceiling of 100, found %s', coalesce(v_found, 'no clamp at all'));
  end if;

  select (regexp_match(p.prosrc, 'least\(greatest\(coalesce\(p_limit[^)]*\),\s*1\),\s*([0-9]+)\)'))[1]
    into v_found
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app_private' and p.proname = 'notifications_inbox';
  if v_found is distinct from '50' then
    v_problems := v_problems || format('app_private.notifications_inbox: expected a ceiling of 50, found %s', coalesce(v_found, 'no clamp at all'));
  end if;

  select (regexp_match(p.prosrc, 'least\(greatest\(coalesce\(p_limit[^)]*\),\s*1\),\s*([0-9]+)\)'))[1]
    into v_found
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app_private' and p.proname = 'buyer_favorites';
  if v_found is distinct from '50' then
    v_problems := v_problems || format('app_private.buyer_favorites: expected a ceiling of 50, found %s', coalesce(v_found, 'no clamp at all'));
  end if;

  select (regexp_match(p.prosrc, 'least\(greatest\(coalesce\(p_limit[^)]*\),\s*1\),\s*([0-9]+)\)'))[1]
    into v_found
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app_private' and p.proname = 'buyer_saved_searches';
  if v_found is distinct from '50' then
    v_problems := v_problems || format('app_private.buyer_saved_searches: expected a ceiling of 50, found %s', coalesce(v_found, 'no clamp at all'));
  end if;

  select (regexp_match(p.prosrc, 'least\(greatest\(coalesce\(p_limit[^)]*\),\s*1\),\s*([0-9]+)\)'))[1]
    into v_found
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app_private' and p.proname = 'buyer_blocks';
  if v_found is distinct from '50' then
    v_problems := v_problems || format('app_private.buyer_blocks: expected a ceiling of 50, found %s', coalesce(v_found, 'no clamp at all'));
  end if;

  select (regexp_match(p.prosrc, 'least\(greatest\(coalesce\(p_limit[^)]*\),\s*1\),\s*([0-9]+)\)'))[1]
    into v_found
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app_private' and p.proname = 'seller_listings';
  if v_found is distinct from '50' then
    v_problems := v_problems || format('app_private.seller_listings: expected a ceiling of 50, found %s', coalesce(v_found, 'no clamp at all'));
  end if;

  select (regexp_match(p.prosrc, 'least\(greatest\(coalesce\(p_limit[^)]*\),\s*1\),\s*([0-9]+)\)'))[1]
    into v_found
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app_private' and p.proname = 'seller_services';
  if v_found is distinct from '50' then
    v_problems := v_problems || format('app_private.seller_services: expected a ceiling of 50, found %s', coalesce(v_found, 'no clamp at all'));
  end if;

  select (regexp_match(p.prosrc, 'least\(greatest\(coalesce\(p_limit[^)]*\),\s*1\),\s*([0-9]+)\)'))[1]
    into v_found
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app_private' and p.proname = 'listing_analytics_page';
  if v_found is distinct from '100' then
    v_problems := v_problems || format('app_private.listing_analytics_page: expected a ceiling of 100, found %s', coalesce(v_found, 'no clamp at all'));
  end if;
  if array_length(v_problems, 1) is not null then
    raise exception
      'pagination preflight failed: % reader(s) are not in the state this migration was written against. Nothing has been changed. Check whether 0106 has already been applied, or whether a later change moved a ceiling. Affected: %',
      array_length(v_problems, 1), array_to_string(v_problems, '; ')
      using errcode = 'check_violation';
  end if;

  raise notice 'pagination preflight passed: all nine readers hold the ceiling this migration expects to replace.';
end $$;

-- ---------------------------------------------------------------------------------------------------
-- 2. The nine readers, dumped from the live catalogue with one integer changed
-- ---------------------------------------------------------------------------------------------------
-- messaging_inbox (0053) — ceiling 50 -> 51, which is MESSAGING_INBOX_MAX_LIMIT + 1
-- (`messaging.ts`). The default of 20 and the floor of 1 are unchanged.
CREATE OR REPLACE FUNCTION app_private.messaging_inbox(p_user_id uuid, p_limit integer DEFAULT 20, p_cursor_last_message_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_cursor_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(conversation_id uuid, subject_type text, listing_id uuid, listing_title_snapshot text, membership_state text, is_muted boolean, is_closed boolean, closed_at timestamp with time zone, unread_count bigint, last_message_id uuid, last_message_seq bigint, last_message_at timestamp with time zone, last_message_type text, last_message_body text, last_message_sender_user_id uuid, last_message_deleted_at timestamp with time zone, created_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
  with bounded as (
    -- Default 20, maximum 50, and never zero: a page of nothing is a request the API rejects rather
    -- than a result this reader invents.
    select least(greatest(coalesce(p_limit, 20), 1), 51) as row_limit
  )
  select c.id,
         c.subject_type,
         c.listing_id,
         c.listing_title_snapshot,
         -- Always 'active' while the filter below stands. It is computed from `left_at` rather than
         -- written as a literal so the column keeps telling the truth if that ever changes.
         case when p.left_at is null then 'active' else 'left' end,
         p.is_muted,
         c.closed_at is not null,
         c.closed_at,
         -- Own messages are never unread. A message with no sender is a system message: it is not the
         -- caller's own, so it counts. `last_read_seq` null means nothing has been read yet.
         (select count(*)
            from public.messages m
           where m.conversation_id = c.id
             and m.sender_user_id is distinct from p_user_id
             and m.seq > coalesce(p.last_read_seq, 0)),
         last_message.id,
         last_message.seq,
         last_message.created_at,
         last_message.message_type,
         last_message.body,
         last_message.sender_user_id,
         last_message.deleted_at,
         c.created_at
    from public.conversations c
    join public.conversation_participants p
      on p.conversation_id = c.id
     and p.user_id = p_user_id
     -- Current membership only. A conversation the caller has left is still readable by id; it is not
     -- in their inbox, because the inbox is a list of conversations they are in.
     and p.left_at is null
   cross join bounded b
   -- The summary of the newest message, or nothing at all for a conversation that has none.
   left join lateral (
     select m.id, m.seq, m.created_at, m.message_type, m.body, m.sender_user_id, m.deleted_at
       from public.messages m
      where m.conversation_id = c.id
      order by m.seq desc
      limit 1
   ) last_message on true
   where (
     -- No cursor: the first page.
     (p_cursor_id is null)
     -- A dated cursor: older dated rows, then the whole undated tail.
     or (p_cursor_last_message_at is not null
         and ((c.last_message_at is not null
               and (c.last_message_at, c.id) < (p_cursor_last_message_at, p_cursor_id))
              or c.last_message_at is null))
     -- An undated cursor: already in the tail, where only the id separates rows.
     or (p_cursor_last_message_at is null
         and c.last_message_at is null
         and c.id < p_cursor_id)
   )
   order by c.last_message_at desc nulls last, c.id desc
   limit (select row_limit from bounded);
$function$;

-- messaging_conversation_messages (0053) — ceiling 100 -> 101, which is MESSAGING_MESSAGES_MAX_LIMIT + 1
-- (`messaging.ts`). The default of 50 and the floor of 1 are unchanged.
CREATE OR REPLACE FUNCTION app_private.messaging_conversation_messages(p_user_id uuid, p_conversation_id uuid, p_limit integer DEFAULT 50, p_cursor_seq bigint DEFAULT NULL::bigint)
 RETURNS TABLE(id uuid, seq bigint, conversation_id uuid, sender_user_id uuid, is_own_message boolean, message_type text, body text, reference_type text, reference_id uuid, created_at timestamp with time zone, edited_at timestamp with time zone, deleted_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
  with allowed as (
    select exists (
      select 1
        from public.conversation_participants p
       where p.conversation_id = p_conversation_id
         and p.user_id = p_user_id
    ) as may_read
  ),
  bounded as (
    select least(greatest(coalesce(p_limit, 50), 1), 101) as row_limit
  ),
  page as (
    select m.id, m.seq, m.conversation_id, m.sender_user_id, m.message_type, m.body,
           m.reference_type, m.reference_id, m.created_at, m.edited_at, m.deleted_at
      from public.messages m
     cross join allowed a
     cross join bounded b
     where a.may_read
       and m.conversation_id = p_conversation_id
       -- Strictly before the cursor, in the same total order, so a page never repeats a message.
       and (p_cursor_seq is null or m.seq < p_cursor_seq)
     order by m.seq desc
     limit (select row_limit from bounded)
  )
  select page.id,
         page.seq,
         page.conversation_id,
         page.sender_user_id,
         -- Saves every caller from re-deriving it, and keeps "whose message is this" one answer.
         page.sender_user_id is not distinct from p_user_id,
         page.message_type,
         page.body,
         page.reference_type,
         page.reference_id,
         page.created_at,
         page.edited_at,
         -- Reported, never acted on. 0014 records that a message was deleted; what a surface does with
         -- that is a decision this reader does not own and does not pre-empt by masking anything.
         page.deleted_at
    from page
   order by page.seq asc;
$function$;

-- notifications_inbox (0066) — ceiling 50 -> 51, which is NOTIFICATIONS_MAX_LIMIT + 1
-- (`notifications.ts`). The default of 20 and the floor of 1 are unchanged.
CREATE OR REPLACE FUNCTION app_private.notifications_inbox(p_user_id uuid, p_limit integer DEFAULT 20, p_cursor_created_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_cursor_id uuid DEFAULT NULL::uuid, p_archived boolean DEFAULT false)
 RETURNS TABLE(id uuid, category text, event_type text, subject_type text, subject_id uuid, action_path text, created_at timestamp with time zone, read_at timestamp with time zone, archived_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
  select
    n.id,
    n.category,
    n.event_type,
    n.subject_type,
    n.subject_id,
    n.action_path,
    n.created_at,
    n.read_at,
    n.archived_at
    from public.notifications n
   where n.user_id = p_user_id
     and (case when coalesce(p_archived, false) then n.archived_at is not null else n.archived_at is null end)
     -- The keyset. Both halves of the cursor must be present for it to mean a position; a half-supplied
     -- cursor reads as no cursor at all rather than as an arbitrary one.
     and (
       p_cursor_created_at is null
       or p_cursor_id is null
       or (n.created_at, n.id) < (p_cursor_created_at, p_cursor_id)
     )
   order by n.created_at desc, n.id desc
   limit least(greatest(coalesce(p_limit, 20), 1), 51)
$function$;

-- buyer_favorites (0067) — ceiling 50 -> 51, which is ACCOUNT_MAX_LIMIT + 1
-- (`buyer-account.ts`). The default of 20 and the floor of 1 are unchanged.
CREATE OR REPLACE FUNCTION app_private.buyer_favorites(p_user_id uuid, p_limit integer DEFAULT 20, p_cursor_created_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_cursor_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(listing_id uuid, created_at timestamp with time zone, is_available boolean, slug text, title text, city text, price_minor bigint, currency_code text, currency_minor_unit smallint, is_negotiable boolean, listing_type_code text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
  select f.listing_id,
         f.created_at,
         public.listing_is_visible(f.listing_id) as is_available,
         case when public.listing_is_visible(f.listing_id) then l.slug end,
         case when public.listing_is_visible(f.listing_id) then l.title end,
         case when public.listing_is_visible(f.listing_id) then l.city end,
         case when public.listing_is_visible(f.listing_id) then l.price_minor end,
         case when public.listing_is_visible(f.listing_id) then l.currency_code::text end,
         case when public.listing_is_visible(f.listing_id) then c.decimal_places end,
         case when public.listing_is_visible(f.listing_id) then l.is_negotiable end,
         case when public.listing_is_visible(f.listing_id) then l.listing_type_code end
    from public.favorites f
    join public.listings l on l.id = f.listing_id
    join public.currencies c on c.code = l.currency_code
   where f.user_id = p_user_id
     and (
       p_cursor_created_at is null
       or p_cursor_id is null
       or (f.created_at, f.listing_id) < (p_cursor_created_at, p_cursor_id)
     )
   order by f.created_at desc, f.listing_id desc
   limit least(greatest(coalesce(p_limit, 20), 1), 51);
$function$;

-- buyer_saved_searches (0067) — ceiling 50 -> 51, which is ACCOUNT_MAX_LIMIT + 1
-- (`buyer-account.ts`). The default of 20 and the floor of 1 are unchanged.
CREATE OR REPLACE FUNCTION app_private.buyer_saved_searches(p_user_id uuid, p_limit integer DEFAULT 20, p_cursor_created_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_cursor_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(id uuid, name text, query jsonb, notify boolean, last_matched_at timestamp with time zone, last_notified_at timestamp with time zone, created_at timestamp with time zone, updated_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
  select s.id, s.name, s.query, s.notify, s.last_matched_at, s.last_notified_at, s.created_at, s.updated_at
    from public.saved_searches s
   where s.user_id = p_user_id
     and (
       p_cursor_created_at is null
       or p_cursor_id is null
       or (s.created_at, s.id) < (p_cursor_created_at, p_cursor_id)
     )
   order by s.created_at desc, s.id desc
   limit least(greatest(coalesce(p_limit, 20), 1), 51);
$function$;

-- buyer_blocks (0103) — ceiling 50 -> 51, which is BLOCKS_MAX_LIMIT + 1
-- (`blocks.ts`). The default of 20 and the floor of 1 are unchanged.
CREATE OR REPLACE FUNCTION app_private.buyer_blocks(p_user_id uuid, p_limit integer DEFAULT 20, p_cursor_created_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_cursor_blocked_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(blocked_user_id uuid, display_name text, seller_slug text, reason text, created_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
  select b.blocked_id,
         p.display_name,
         sp.slug,
         b.reason,
         b.created_at
    from public.user_blocks b
    left join public.profiles p on p.id = b.blocked_id
    left join public.seller_profiles sp on sp.user_id = b.blocked_id
   where b.blocker_id = p_user_id
     and (
       p_cursor_created_at is null
       or p_cursor_blocked_id is null
       or (b.created_at, b.blocked_id) < (p_cursor_created_at, p_cursor_blocked_id)
     )
   order by b.created_at desc, b.blocked_id desc
   limit least(greatest(coalesce(p_limit, 20), 1), 51);
$function$;

-- seller_listings (0061) — ceiling 50 -> 51, which is SELLER_LISTINGS_MAX_LIMIT + 1
-- (`sellers.ts`). The default of 20 and the floor of 1 are unchanged.
CREATE OR REPLACE FUNCTION app_private.seller_listings(p_user_id uuid, p_limit integer, p_cursor_created_at timestamp with time zone, p_cursor_slug text)
 RETURNS TABLE(slug text, title text, description text, listing_type_code text, category_slug text, status text, currency_code character, price_minor bigint, is_negotiable boolean, content_language text, country_code character, governorate text, city text, media_count integer, created_at timestamp with time zone, updated_at timestamp with time zone, submitted_at timestamp with time zone, archived_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
  select l.slug, l.title, l.description, l.listing_type_code, c.slug, l.status, l.currency_code,
         l.price_minor, l.is_negotiable, l.content_language, l.country_code, l.governorate, l.city,
         (select count(*)::integer from public.listing_media m where m.listing_id = l.id),
         l.created_at, l.updated_at, l.submitted_at, l.archived_at
    from public.listings l
    join public.categories c on c.id = l.category_id
   where l.seller_user_id = p_user_id
     and l.status <> 'deleted'
     and (
       p_cursor_created_at is null
       or (l.created_at, l.slug) < (p_cursor_created_at, coalesce(p_cursor_slug, ''))
     )
   order by l.created_at desc, l.slug desc
   limit least(greatest(coalesce(p_limit, 20), 1), 51);
$function$;

-- seller_services (0062) — ceiling 50 -> 51, which is SELLER_SERVICES_MAX_LIMIT + 1
-- (`sellers.ts`). The default of 20 and the floor of 1 are unchanged.
CREATE OR REPLACE FUNCTION app_private.seller_services(p_user_id uuid, p_limit integer, p_cursor_created_at timestamp with time zone, p_cursor_slug text)
 RETURNS TABLE(slug text, title text, description text, category_slug text, status text, currency_code character, currency_minor_unit smallint, price_minor bigint, is_negotiable boolean, content_language text, country_code character, governorate text, city text, pricing_model text, delivery_days smallint, revisions_included smallint, requires_brief boolean, scope text, media_count integer, created_at timestamp with time zone, updated_at timestamp with time zone, submitted_at timestamp with time zone, archived_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
  select l.slug, l.title, l.description, c.slug, l.status, l.currency_code, cur.decimal_places,
         l.price_minor, l.is_negotiable, l.content_language, l.country_code, l.governorate, l.city,
         d.pricing_model, d.delivery_days, d.revisions_included, d.requires_brief, d.scope,
         (select count(*)::integer from public.listing_media m where m.listing_id = l.id),
         l.created_at, l.updated_at, l.submitted_at, l.archived_at
    from public.listings l
    join public.categories c on c.id = l.category_id
    join public.currencies cur on cur.code = l.currency_code
    left join public.listing_service_details d on d.listing_id = l.id
   where l.seller_user_id = p_user_id
     and l.listing_type_code = 'service'
     and l.status <> 'deleted'
     and (
       p_cursor_created_at is null
       or (l.created_at, l.slug) < (p_cursor_created_at, coalesce(p_cursor_slug, ''))
     )
   order by l.created_at desc, l.slug desc
   limit least(greatest(coalesce(p_limit, 20), 1), 51);
$function$;

-- listing_analytics_page (0102) — ceiling 100 -> 101, which is LISTING_ANALYTICS_MAX_LIMIT + 1
-- (`analytics.ts`). The default of 25 and the floor of 1 are unchanged.
CREATE OR REPLACE FUNCTION app_private.listing_analytics_page(p_user_id uuid, p_is_aal2 boolean, p_days integer, p_limit integer, p_cursor_day date DEFAULT NULL::date, p_cursor_listing_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(day date, listing_slug text, listing_title text, listing_status text, seller_slug text, clicks text, contacts text, favorites text, shares text, computed_at timestamp with time zone, cursor_day date, cursor_listing_id uuid)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 set search_path = pg_catalog, public
AS $function$
declare
  v_days integer := least(greatest(coalesce(p_days, 30), 1), 365);
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 101);
begin
  if not app_private.listing_analytics_can_read(p_user_id, p_is_aal2) then
    return;
  end if;

  return query
    select
      a.day,
      l.slug,
      l.title,
      l.status,
      -- The storefront's public address, which is how staff identify a seller everywhere in this console.
      -- Never the account identifier.
      s.slug,
      a.clicks::text,
      a.contacts::text,
      a.favorites::text,
      a.shares::text,
      a.computed_at,
      a.day,
      a.listing_id
      from public.listing_analytics a
      join public.listings l on l.id = a.listing_id
      left join public.seller_profiles s on s.user_id = a.seller_user_id
     where a.day >= (current_date - v_days)
       and (
         p_cursor_day is null
         or p_cursor_listing_id is null
         or (a.day, a.listing_id) < (p_cursor_day, p_cursor_listing_id)
       )
     order by a.day desc, a.listing_id desc
     limit v_limit;
end;
$function$;

-- ---------------------------------------------------------------------------------------------------
-- 3. Verification — this migration proves its own work before it finishes
-- ---------------------------------------------------------------------------------------------------
--
-- Two claims. The nine now hold the ceiling they were given; and no reader anywhere is left clamping at a
-- public maximum except the three owner decision 3 exempts. The second is the one that matters in a year's
-- time, because it is the claim a tenth reader could break.
do $$
declare
  v_problems text[] := array[]::text[];
  v_expected jsonb := jsonb_build_object(
    'messaging_inbox', 51, 'messaging_conversation_messages', 101, 'notifications_inbox', 51,
    'buyer_favorites', 51, 'buyer_saved_searches', 51, 'buyer_blocks', 51,
    'seller_listings', 51, 'seller_services', 51, 'listing_analytics_page', 101);
  v_exempt text[] := array['seller_orders', 'seller_reviews', 'seller_promotions'];
  r record;
begin
  for r in select key as name, value::text as want from jsonb_each(v_expected) loop
    if (select (regexp_match(p.prosrc, 'least\(greatest\(coalesce\(p_limit[^)]*\),\s*1\),\s*([0-9]+)\)'))[1]
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'app_private' and p.proname = r.name) is distinct from r.want then
      v_problems := v_problems || format('app_private.%s did not take the ceiling %s', r.name, r.want);
    end if;
  end loop;

  -- A ceiling of 50 or 100 is a ceiling equal to a declared public maximum, which is the defect itself.
  for r in
    select p.proname,
           (regexp_match(p.prosrc, 'least\(greatest\(coalesce\(p_limit[^)]*\),\s*1\),\s*([0-9]+)\)'))[1] as ceiling
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app_private' and p.prosrc ~ 'least\(greatest\(coalesce\(p_limit'
       and not (p.proname = any (v_exempt))
  loop
    if r.ceiling in ('48', '50', '96', '100', '200') then
      v_problems := v_problems || format('app_private.%s still clamps at %s, which is a public maximum', r.proname, r.ceiling);
    end if;
  end loop;

  if array_length(v_problems, 1) is not null then
    raise exception 'pagination correction incomplete: %', array_to_string(v_problems, '; ')
      using errcode = 'check_violation';
  end if;

  raise notice 'pagination correction verified: every reader in scope leaves room for the probe row.';
end $$;

-- The contract this repository will not ship without.
select app_private.assert_security_contract();
