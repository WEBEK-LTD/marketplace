-- 0064 — The seller's own read-only surfaces (Phase 6-J).
--
-- Six readers. Not one of them writes: no insert, no update, no delete, no outbox event, no audit row, no
-- notification, no counter and no timestamp touched. Each is declared `stable`, which is the database's own
-- way of saying so, and the pgTAP suite proves it by snapshotting every table these functions can reach and
-- comparing it afterwards.
--
-- **Step 0 survey — what already exists, and what this migration therefore does not invent.**
--
-- Every one of the five surfaces already has an authoritative table *and* an explicit RLS policy naming what
-- the authenticated seller may read. Those policies are the ownership rule; these readers mirror them rather
-- than compose a new one:
--
--   orders               `orders_party_read`                buyer_user_id = me OR seller_user_id = me
--   order_items          `order_items_party_read`            via the parent order
--   reviews              `reviews_seller_read`               seller_user_id = me, every status
--   review_replies       `review_replies_seller_read`        seller_user_id = me
--   seller_balances      `seller_balances_owner_read`        seller_user_id = me
--   promotions           `promotions_seller_read`            seller_user_id = me
--   promotion_analytics  `promotion_analytics_read`          via the parent promotion
--
-- Two authoritative aggregates already exist and are reused rather than recomputed, which is the whole reason
-- this migration defines no metric of its own:
--
--   `public.seller_ratings`       (0026) review_count, average_rating_basis_points, the five star counts and
--                                 latest_review_at, over published reviews only. `seller_reviews_summary`
--                                 below selects from it and adds nothing: the average's rounding, the basis-
--                                 point scale and the published-only filter are that view's definition, not
--                                 this migration's opinion.
--   `public.promotion_analytics`  (0025) impressions, views and clicks per promotion per day, produced by
--                                 `app_private.rollup_promotion_analytics` on pg_cron. `seller_promotion_
--                                 analytics` reads those rows and sums nothing that the rollup did not
--                                 already define.
--
-- Both views are `security_invoker=true`, so inside a SECURITY DEFINER function their RLS is evaluated as the
-- definer and does *not* scope anything. Every reader below therefore scopes by `p_user_id` explicitly, in
-- its own where clause, exactly as every Phase 6 reader does.
--
-- **What is deliberately not read here**, each for a stated reason rather than an oversight:
--
--   `wallet_transactions` / `ledger_entries` / `ledger_journals` — the double-entry ledger. Its fields are
--       journal and entry identifiers, an account type, a direction, a payment or withdrawal id and an
--       internal memo: private ledger implementation detail and internal reconciliation metadata, which this
--       project does not disclose to a seller. `seller_balances` is the seller-facing statement of the same
--       facts, and it is what `seller_earnings` reads.
--   `payouts` / `payout_destinations` — provider payout references, provider ids, destination snapshots and
--       a vault secret id. A payout is the platform paying the seller through a provider; nothing in it is
--       presentable without disclosing provider or destination material.
--   `withdrawals` — every field that would make a history useful is staff reasoning (`reviewed_by`,
--       `approved_by`, `rejection_reason`, `failure_code`) or a ledger journal id, and no approved
--       seller-facing presentation of a withdrawal exists. Left out whole rather than half-shown.
--   `listing_events` — raw events, partitioned, with no rollup. There is no authoritative listing-level
--       aggregate anywhere in this repository (`promotion_analytics` is the only rollup), so counting them
--       into "views per listing" would be inventing a KPI definition and its de-duplication rules.
--
-- **Money.** Every amount is a `bigint` of minor units and travels outward as text beside its own
-- `currency_code` and that currency's own `decimal_places`, read from `public.currencies` rather than assumed.
-- That is the standing post-6-G rule, and no currency code is written in this file.
--
-- **Identifiers.** No reader returns a seller id, a buyer id, an order id, a listing id, a promotion id, a
-- review id, a checkout id, a ledger account or a journal. Orders and reviews are named by `order_number`,
-- the unique human reference `app_private.next_reference` already generates (uniquely indexed as
-- `orders_order_number`); a promotion is named by the slug of the listing it promotes. `order_number` is also
-- the pagination tie-breaker, so the seller cursors carry no uuid at all — `reviews` is UNIQUE(order_id), so
-- one order number identifies at most one review.
--
-- **Nothing staff-side is projected**: no `moderation_reason`, `moderated_by`, `moderated_at`,
-- `auto_hidden_reason`, `commission_snapshot`, `cancellation_policy_snapshot`, `package_snapshot` or
-- `idempotency_key` appears in any column list below.

-- ---------------------------------------------------------------------------------------------------
-- The caller's own orders, one page
-- ---------------------------------------------------------------------------------------------------
--
-- Keyset on `(placed_at desc, order_number desc)`, which is the order `orders_seller` already indexes for
-- this seller. `p_limit` is clamped in the function so a caller cannot ask for the whole table.
--
-- The items travel as `jsonb`, built from the snapshot columns `order_items` already stores — the title and
-- slug as they were at purchase — so nothing here joins `listings` and nothing depends on a listing that has
-- since been edited or archived.
create or replace function app_private.seller_orders(
  p_user_id uuid,
  p_limit integer,
  p_cursor_placed_at timestamptz,
  p_cursor_order_number text
) returns table (
  outcome text,
  order_number text,
  order_type text,
  status text,
  currency_code text,
  currency_decimal_places integer,
  subtotal_minor text,
  shipping_total_minor text,
  tax_total_minor text,
  discount_total_minor text,
  commission_total_minor text,
  grand_total_minor text,
  seller_net_minor text,
  item_count integer,
  placed_at timestamptz,
  paid_at timestamptz,
  shipped_at timestamptz,
  delivered_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  items jsonb
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_seller_exists boolean;
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
begin
  select true into v_seller_exists
    from public.seller_profiles s
   where s.user_id = p_user_id;

  -- No storefront is not an empty page: the two are different answers and the surface above tells them apart.
  if v_seller_exists is not true then
    return query select 'not_found'::text, null::text, null::text, null::text, null::text, null::integer,
      null::text, null::text, null::text, null::text, null::text, null::text, null::text, null::integer,
      null::timestamptz, null::timestamptz, null::timestamptz, null::timestamptz, null::timestamptz,
      null::timestamptz, null::jsonb;
    return;
  end if;

  return query
    select
      'found'::text,
      o.order_number,
      o.order_type,
      o.status,
      trim(o.currency_code),
      c.decimal_places::integer,
      o.subtotal_minor::text,
      o.shipping_total_minor::text,
      o.tax_total_minor::text,
      o.discount_total_minor::text,
      o.commission_total_minor::text,
      o.grand_total_minor::text,
      o.seller_net_minor::text,
      (select count(*)::integer from public.order_items i where i.order_id = o.id),
      o.placed_at,
      o.paid_at,
      o.shipped_at,
      o.delivered_at,
      o.completed_at,
      o.cancelled_at,
      coalesce(
        (
          select jsonb_agg(
                   jsonb_build_object(
                     'title', i.listing_title_snapshot,
                     'slug', i.listing_slug_snapshot,
                     'listingTypeCode', i.listing_type_code,
                     'quantity', i.quantity,
                     'cancelledQuantity', i.cancelled_quantity,
                     'unitPriceMinor', i.unit_price_minor::text,
                     'lineTotalMinor', i.line_total_minor::text
                   )
                   order by i.created_at, i.listing_slug_snapshot
                 )
            from public.order_items i
           where i.order_id = o.id
        ),
        '[]'::jsonb
      )
      from public.orders o
      join public.currencies c on c.code = o.currency_code
     -- The ownership rule, and the only one: `orders_party_read` also admits the buyer, and this surface is
     -- the seller's, so the buyer half is deliberately absent. Nothing about the buyer is selected either.
     where o.seller_user_id = p_user_id
       and (
         p_cursor_placed_at is null
         or p_cursor_order_number is null
         or (o.placed_at, o.order_number) < (p_cursor_placed_at, p_cursor_order_number)
       )
     order by o.placed_at desc, o.order_number desc
     limit v_limit;
end;
$$;

comment on function app_private.seller_orders(uuid, integer, timestamptz, text) is
  'One page of the calling seller''s own orders, newest first, with each order''s items from the snapshots order_items stores. Takes no seller parameter: the storefront comes from the caller. Returns no order id, buyer id, checkout id, listing id or commission snapshot, and nothing about the buyer at all — an order is named by its own order_number. Amounts are minor units as text beside the currency and its own decimal places. Read-only and side-effect free.';

revoke all on function app_private.seller_orders(uuid, integer, timestamptz, text) from public;
grant execute on function app_private.seller_orders(uuid, integer, timestamptz, text) to app_system;

-- ---------------------------------------------------------------------------------------------------
-- The caller's own reviews, one page
-- ---------------------------------------------------------------------------------------------------
--
-- `reviews_seller_read` puts no status condition on the seller, so a seller reads their own reviews in every
-- status — which is the point of the surface: a review that is hidden or awaiting moderation is a fact about
-- their storefront they are entitled to see.
--
-- What they do not read is *why*: `moderation_reason`, `moderated_by`, `moderated_at` and
-- `auto_hidden_reason` appear in no column list here. The same holds for the reply's own moderation fields.
-- Nothing identifies the buyer — no id, no name — because a review is about the storefront, and this reader
-- has no need to say who wrote it.
create or replace function app_private.seller_reviews(
  p_user_id uuid,
  p_limit integer,
  p_cursor_created_at timestamptz,
  p_cursor_order_number text
) returns table (
  outcome text,
  order_number text,
  rating integer,
  title text,
  body text,
  status text,
  published_at timestamptz,
  created_at timestamptz,
  reply_body text,
  reply_status text,
  reply_created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_seller_exists boolean;
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
begin
  select true into v_seller_exists
    from public.seller_profiles s
   where s.user_id = p_user_id;

  if v_seller_exists is not true then
    return query select 'not_found'::text, null::text, null::integer, null::text, null::text, null::text,
      null::timestamptz, null::timestamptz, null::text, null::text, null::timestamptz;
    return;
  end if;

  return query
    select
      'found'::text,
      o.order_number,
      r.rating::integer,
      r.title,
      r.body,
      r.status,
      r.published_at,
      r.created_at,
      p.body,
      p.status,
      p.created_at
      from public.reviews r
      join public.orders o on o.id = r.order_id
      -- The seller's own reply, when there is one. `review_replies_seller_read` scopes it to them as well,
      -- and it is restated here so the join cannot pick up a reply that is not theirs.
      left join public.review_replies p
        on p.review_id = r.id
       and p.seller_user_id = p_user_id
     where r.seller_user_id = p_user_id
       and (
         p_cursor_created_at is null
         or p_cursor_order_number is null
         or (r.created_at, o.order_number) < (p_cursor_created_at, p_cursor_order_number)
       )
     order by r.created_at desc, o.order_number desc
     limit v_limit;
end;
$$;

comment on function app_private.seller_reviews(uuid, integer, timestamptz, text) is
  'One page of the reviews left on the calling seller''s own storefront, newest first, in every status, each with the seller''s own reply when there is one. Takes no seller parameter. Returns no review id, buyer id, order id or seller id, and nothing identifying whoever wrote the review; no moderation reason, moderator or moderation time for either the review or the reply. A review is named by its order''s own order_number, which identifies it because reviews are unique per order. Read-only and side-effect free.';

revoke all on function app_private.seller_reviews(uuid, integer, timestamptz, text) from public;
grant execute on function app_private.seller_reviews(uuid, integer, timestamptz, text) to app_system;

-- ---------------------------------------------------------------------------------------------------
-- The caller's own rating summary
-- ---------------------------------------------------------------------------------------------------
--
-- Straight from `public.seller_ratings`, 0026's own aggregate. This function computes nothing: it selects
-- that view's columns for one seller and renames none of the numbers. The average is in basis points because
-- that is the unit the view produces, and converting it here would be this migration inventing a rounding
-- rule the view already settled.
--
-- The view counts published reviews only, so the summary and the list above can legitimately disagree — a
-- seller with one hidden review has a list of one and a summary of none. That is the view's definition, and
-- the surface says so rather than reconciling them.
create or replace function app_private.seller_reviews_summary(p_user_id uuid) returns table (
  outcome text,
  review_count integer,
  average_rating_basis_points integer,
  five_star_count integer,
  four_star_count integer,
  three_star_count integer,
  two_star_count integer,
  one_star_count integer,
  latest_review_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_seller_exists boolean;
begin
  select true into v_seller_exists
    from public.seller_profiles s
   where s.user_id = p_user_id;

  if v_seller_exists is not true then
    return query select 'not_found'::text, null::integer, null::integer, null::integer, null::integer,
      null::integer, null::integer, null::integer, null::timestamptz;
    return;
  end if;

  -- A storefront with no published review has no row in the view at all. That is `none`, not a row of zeros:
  -- "no reviews yet" and "an average of zero" are different things, and only the first one is true.
  if not exists (select 1 from public.seller_ratings v where v.seller_user_id = p_user_id) then
    return query select 'none'::text, null::integer, null::integer, null::integer, null::integer,
      null::integer, null::integer, null::integer, null::timestamptz;
    return;
  end if;

  return query
    select
      'found'::text,
      v.review_count::integer,
      v.average_rating_basis_points,
      v.five_star_count::integer,
      v.four_star_count::integer,
      v.three_star_count::integer,
      v.two_star_count::integer,
      v.one_star_count::integer,
      v.latest_review_at
      from public.seller_ratings v
     where v.seller_user_id = p_user_id;
end;
$$;

comment on function app_private.seller_reviews_summary(uuid) is
  'The calling seller''s own rating summary, read straight from the seller_ratings view (0026) without recomputing any of it: the average stays in basis points because that is the unit the view defines. Published reviews only, which is the view''s own filter. Answers none when the storefront has no published review, rather than a row of zeros. Read-only and side-effect free.';

revoke all on function app_private.seller_reviews_summary(uuid) from public;
grant execute on function app_private.seller_reviews_summary(uuid) to app_system;

-- ---------------------------------------------------------------------------------------------------
-- The caller's own balances
-- ---------------------------------------------------------------------------------------------------
--
-- `seller_balances` is keyed `(seller_user_id, currency_code)`, so a seller has one row per currency they
-- have earned in — a handful at most. There is no pagination and no cursor, because there is nothing to page.
--
-- The three amounts are the table's own: pending, available and reserved. No total is computed here, because
-- adding them is a business statement about what a seller is owed, and no such formula is established
-- anywhere in this repository. The surface shows the three the ledger keeps.
create or replace function app_private.seller_earnings(p_user_id uuid) returns table (
  outcome text,
  currency_code text,
  currency_decimal_places integer,
  pending_minor text,
  available_minor text,
  reserved_minor text,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_seller_exists boolean;
begin
  select true into v_seller_exists
    from public.seller_profiles s
   where s.user_id = p_user_id;

  if v_seller_exists is not true then
    return query select 'not_found'::text, null::text, null::integer, null::text, null::text, null::text,
      null::timestamptz;
    return;
  end if;

  return query
    select
      'found'::text,
      trim(b.currency_code),
      c.decimal_places::integer,
      b.pending_minor::text,
      b.available_minor::text,
      b.reserved_minor::text,
      b.updated_at
      from public.seller_balances b
      join public.currencies c on c.code = b.currency_code
     where b.seller_user_id = p_user_id
     order by b.currency_code;
end;
$$;

comment on function app_private.seller_earnings(uuid) is
  'The calling seller''s own balances, one row per currency: the pending, available and reserved minor amounts seller_balances keeps, as text, beside each currency and its own decimal places. Takes no seller parameter. Reads no ledger entry, journal, payout, payout destination or withdrawal, so it carries no ledger account, journal id, provider reference or destination material, and it computes no total. Read-only and side-effect free.';

revoke all on function app_private.seller_earnings(uuid) from public;
grant execute on function app_private.seller_earnings(uuid) to app_system;

-- ---------------------------------------------------------------------------------------------------
-- The caller's own promotions, one page
-- ---------------------------------------------------------------------------------------------------
--
-- Read-only: this function starts, pays for, cancels and refunds nothing. `app_private.create_promotion`,
-- `cancel_promotion`, `pay_promotion_from_wallet` and `spend_wallet_on_promotion` already exist and are not
-- called, referenced or imitated here.
--
-- Keyset on `(created_at desc, id desc)`. This is the one cursor in this migration whose tie-breaker is a
-- uuid, because `promotions` has no human reference and no unique non-uuid column; it is the same tie-breaker
-- the public catalogue cursor has used since 4-B, so it is an established convention rather than a new one,
-- and it is used here on a private surface rather than a public one. The uuid lives inside the opaque cursor
-- and is projected as no field.
create or replace function app_private.seller_promotions(
  p_user_id uuid,
  p_limit integer,
  p_cursor_created_at timestamptz,
  p_cursor_id uuid
) returns table (
  outcome text,
  listing_slug text,
  listing_title text,
  status text,
  currency_code text,
  currency_decimal_places integer,
  price_minor text,
  refunded_amount_minor text,
  priority integer,
  duration_days integer,
  starts_at timestamptz,
  ends_at timestamptz,
  activated_at timestamptz,
  paused_at timestamptz,
  expired_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz,
  cursor_id uuid
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_seller_exists boolean;
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
begin
  select true into v_seller_exists
    from public.seller_profiles s
   where s.user_id = p_user_id;

  if v_seller_exists is not true then
    return query select 'not_found'::text, null::text, null::text, null::text, null::text, null::integer,
      null::text, null::text, null::integer, null::integer, null::timestamptz, null::timestamptz,
      null::timestamptz, null::timestamptz, null::timestamptz, null::timestamptz, null::timestamptz,
      null::uuid;
    return;
  end if;

  return query
    select
      'found'::text,
      l.slug,
      l.title,
      pr.status,
      trim(pr.currency_code),
      c.decimal_places::integer,
      pr.price_minor::text,
      pr.refunded_amount_minor::text,
      pr.priority,
      pr.duration_days,
      pr.starts_at,
      pr.ends_at,
      pr.activated_at,
      pr.paused_at,
      pr.expired_at,
      pr.cancelled_at,
      pr.created_at,
      -- Returned so the layer above can build the next cursor, and stripped from the response there. It is
      -- the promotion's own id and identifies nothing else.
      pr.id
      from public.promotions pr
      join public.listings l on l.id = pr.listing_id
      join public.currencies c on c.code = pr.currency_code
     where pr.seller_user_id = p_user_id
       and (
         p_cursor_created_at is null
         or p_cursor_id is null
         or (pr.created_at, pr.id) < (p_cursor_created_at, p_cursor_id)
       )
     order by pr.created_at desc, pr.id desc
     limit v_limit;
end;
$$;

comment on function app_private.seller_promotions(uuid, integer, timestamptz, uuid) is
  'One page of the calling seller''s own promotions, newest first, each named by the slug and title of the listing it promotes. Takes no seller parameter. Returns no promotion package id, no package snapshot, no idempotency key, no payment method and no cancellation reason. Strictly read-only: it starts, pays for, cancels and refunds nothing, and calls none of the promotion writers. Read-only and side-effect free.';

revoke all on function app_private.seller_promotions(uuid, integer, timestamptz, uuid) from public;
grant execute on function app_private.seller_promotions(uuid, integer, timestamptz, uuid) to app_system;

-- ---------------------------------------------------------------------------------------------------
-- The caller's own promotion performance
-- ---------------------------------------------------------------------------------------------------
--
-- `promotion_analytics` is the only authoritative rollup in this repository, produced by
-- `app_private.rollup_promotion_analytics` on pg_cron, and this reader does not add to its definition: the
-- impressions, views and clicks are that rollup's, summed per promotion across the requested window and
-- nothing more. No rate, no ratio, no click-through and no trend is computed, because none of those has an
-- established business definition here and inventing one would be inventing a KPI.
--
-- There is deliberately no listing-level analytics reader. `listing_events` holds the raw events and no
-- rollup covers them, so counting them into "views per listing" would mean deciding what a view is and how
-- to de-duplicate a session — a business rule this increment does not have.
create or replace function app_private.seller_promotion_analytics(
  p_user_id uuid,
  p_days integer
) returns table (
  outcome text,
  listing_slug text,
  listing_title text,
  status text,
  first_day date,
  last_day date,
  impressions text,
  views text,
  clicks text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_seller_exists boolean;
  -- A window, clamped: a day at least, a year at most. It selects rows and decides nothing about them.
  v_days integer := least(greatest(coalesce(p_days, 30), 1), 365);
begin
  select true into v_seller_exists
    from public.seller_profiles s
   where s.user_id = p_user_id;

  if v_seller_exists is not true then
    return query select 'not_found'::text, null::text, null::text, null::text, null::date, null::date,
      null::text, null::text, null::text;
    return;
  end if;

  return query
    select
      'found'::text,
      l.slug,
      l.title,
      pr.status,
      min(a.day),
      max(a.day),
      sum(a.impressions)::text,
      sum(a.views)::text,
      sum(a.clicks)::text
      from public.promotion_analytics a
      join public.promotions pr on pr.id = a.promotion_id
      join public.listings l on l.id = pr.listing_id
     -- `promotion_analytics_read` reaches the rows through the parent promotion, and so does this.
     where pr.seller_user_id = p_user_id
       and a.day >= (current_date - v_days)
     group by l.slug, l.title, pr.status, pr.created_at, pr.id
     order by max(a.day) desc, l.slug;
end;
$$;

comment on function app_private.seller_promotion_analytics(uuid, integer) is
  'The calling seller''s own promotion performance over a recent window: the impressions, views and clicks the promotion_analytics rollup (0025) already computed, summed per promotion and named by the promoted listing''s slug. Takes no seller parameter and returns no promotion id. Defines no metric of its own — no rate, ratio or click-through — and reads no listing_events, because no authoritative listing-level rollup exists. Read-only and side-effect free.';

revoke all on function app_private.seller_promotion_analytics(uuid, integer) from public;
grant execute on function app_private.seller_promotion_analytics(uuid, integer) to app_system;

-- ---------------------------------------------------------------------------------------------------
-- The security contract still holds
-- ---------------------------------------------------------------------------------------------------
do $$
begin
  perform app_private.assert_security_contract();
end;
$$;
