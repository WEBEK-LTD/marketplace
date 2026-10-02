-- 0071 — Service requests and quotes, Option 1 (Phase 7-I).
--
-- ---------------------------------------------------------------------------------------------------
-- What the survey found, and what it decided for this migration
-- ---------------------------------------------------------------------------------------------------
-- **No table, column, constraint, index, trigger, policy or setting is created or changed here.** 0015
-- owns both tables and `app_private.tg_service_quotes_rule`; 0032 owns the quote sweeper; 0070 seeded the
-- payment window. All three are read, none is rewritten, and this migration adds no data at all.
--
-- **Option 1 only.** The approved flow is `service_request → service_quote → accepted quote → Phase 8
-- checkout`, buyer to a named seller. Nothing here routes a request to staff, and nothing here reads or
-- writes `routing_mode`: every writer below supplies a seller and leaves that column to its default, so
-- every request this migration can create is a `seller` row. The column, its constraint and the D7-10
-- permission family are the approved shared foundation and are added by **0072**; Option 2 itself is 7-J's
-- and is untouched by construction — there is nothing in this file it could touch.
--
-- ---------------------------------------------------------------------------------------------------
-- The two state machines, read off 0015 rather than assumed
-- ---------------------------------------------------------------------------------------------------
-- **`service_requests`** allows `open`, `quoted`, `accepted`, `declined`, `cancelled`, `expired`, and
-- `service_requests_closed_has_time` makes the last four *closed* — `(status in ('accepted','declined',
-- 'cancelled','expired')) = (closed_at is not null)`. So `open` and `quoted` are the live states.
--
--     (none) → open          the buyer sends a brief to one seller
--     open → quoted          **0015's own `tg_service_quotes_rule`**, when the seller inserts a quote.
--                            Nothing in this file performs that transition; the trigger does, exactly as
--                            it does today
--     open|quoted → cancelled   the buyer withdraws their own request
--     open|quoted → declined    the seller declines to quote
--     quoted → accepted      in the same transaction as accepting a quote — see below
--     → expired              **unreachable, and reported rather than invented.** No sweeper covers this
--                            table (0032 schedules `service_quotes.expire` and nothing for requests), no
--                            trigger derives it, and `needed_by` is a date the buyer states rather than a
--                            deadline the schema acts on. No function here assigns it
--
-- **`service_quotes`** allows `sent`, `accepted`, `rejected`, `withdrawn`, `expired`, and
-- `service_quotes_expiring` is `where status = 'sent'`, so `sent` is the one live state.
--
--     (none) → sent          the seller quotes. 0015's trigger checks that they are the request's seller
--                            and that the request is still open to quotes, and promotes the request
--     sent → accepted        the buyer accepts. The obligation transition
--     sent → rejected        the buyer declines this quote, leaving the request open to another
--     sent → withdrawn       the seller takes their own quote back
--     sent → expired         **0032's sweeper, and nothing here**
--
-- **No function below takes a status as a parameter**, so no caller can ask for one, and the word
-- `expired` appears in none of them.
--
-- ---------------------------------------------------------------------------------------------------
-- Acceptance writes two rows, and why it must
-- ---------------------------------------------------------------------------------------------------
-- `service_quotes_one_accepted` is unique on `service_request_id where status = 'accepted'`, so a request
-- can carry exactly one accepted quote. `service_requests` has its own `accepted` status, and nothing in
-- the repository moves a request into it — no trigger, no sweeper, no function. If acceptance left the
-- request at `quoted`, that status would be unreachable for the life of the platform, which cannot be what
-- 0015 meant by defining it and by making `closed_at` mandatory for it.
--
-- So `service_quote_accept` closes both in one transaction: the quote becomes `accepted` with its
-- obligation fields, and the request becomes `accepted` with `closed_at`. Both rows are locked first, so
-- two buyers' clicks — or a buyer and a seller acting together — serialize.
--
-- **Sibling quotes are left alone.** Another `sent` quote on the same request is not rejected here: the
-- unique index already makes a second acceptance impossible, 0015's trigger already refuses *new* quotes
-- once the request is closed, and 0032's sweeper closes the leftovers when their own windows pass.
-- Rejecting them would be a workflow nobody has specified.
--
-- ---------------------------------------------------------------------------------------------------
-- The payment window — the same rule 7-H uses, and the same refusal
-- ---------------------------------------------------------------------------------------------------
-- `payment_due_at = accepted_at + finance.payment_due_hours`, read from `site_settings` at acceptance
-- time. That is the key 0070 seeded at 48 and the approved policy says is **shared** by offers and service
-- quotes, so this reads the same row and defines nothing of its own.
--
-- **`offers.default_expiry_hours` is not read here**, and neither is any quote-validity default: the two
-- are different durations with different meanings. There is **no fallback**: a setting that is absent, not
-- a number or not positive answers `payment_policy_missing`, writes nothing at all, and the API reports an
-- integrity failure.
--
-- ---------------------------------------------------------------------------------------------------
-- The one value the repository leaves to the writer, and why it is the seller's
-- ---------------------------------------------------------------------------------------------------
-- `service_quotes.expires_at` is `not null` and has **no default and no trigger that fills it** — unlike
-- `offers.expires_at`, which `tg_offers_rule` fills from `offers.default_expiry_hours`. There is also no
-- quote-validity setting anywhere in `site_settings`, and v5.2 states a default window for offers only.
--
-- So the schema requires the writer to state how long the quote stands, and the only party who can state
-- it without a policy being invented is the seller making it. `service_quote_create` therefore takes
-- `p_valid_for_days` and computes `now() + make_interval(days => …)`. Its bound is **0015's own**:
-- `service_quotes_delivery_days_range` bounds the other seller-stated duration on this table to 1–365, and
-- this uses the same window rather than a number chosen here. No admin setting is created, and
-- `finance.payment_due_hours` is untouched by it.
--
-- ---------------------------------------------------------------------------------------------------
-- Why these functions are needed, and what they refuse
-- ---------------------------------------------------------------------------------------------------
-- 0015's six policies on these two tables resolve the caller through `app_private.jwt_claims()`, and the
-- API connects as `app_system`, which carries no claims — the same structural fact behind 0066 to 0070.
-- Each function below takes the account as a parameter and applies 0015's own ownership predicate to it:
-- a buyer's function matches `buyer_user_id`, a seller's matches `seller_user_id`, and neither has a
-- branch that decides whether to scope the statement, because the scope *is* the statement.
--
-- **Every write locks its row before reading it** (`select … for update`) and guards the UPDATE with the
-- live status, so a repeated or concurrent action answers `conflict` rather than overwriting a decision.
--
-- **A lapsed quote is nobody's to act on.** `expires_at` is a fact on the row and 0032's sweeper only
-- records it, so accepting, rejecting or withdrawing a quote past its window answers `expired` and
-- **writes nothing**, leaving the status to the sweeper that owns it.
--
-- **Not here, deliberately.** No order, checkout, delivery, payment, ledger or payout: acceptance records
-- the obligation 0015 defined and stops, and Phase 8 consumes it. No notification and no outbox event —
-- the repository defines no service-request or service-quote notification event type, template key or
-- writer, and the only event that exists is 0032's own `service_quote.expired`; inventing a second would
-- be inventing user-facing semantics. No audit trigger is added: 0015 gave these tables none, which is
-- 0015's design. `service_deliveries` is untouched; it belongs to the order, not to the quote.

-- ---------------------------------------------------------------------------------------------------
-- The buyer's own requests
-- ---------------------------------------------------------------------------------------------------
-- `service_requests_party_read`, for a caller the connection cannot see, narrowed to the buyer's side so
-- the two dashboards never show each other's rows. Keyset paging on `(created_at, id)`, newest first, over
-- 0015's own `service_requests_buyer` index.
create or replace function app_private.service_requests_for_buyer(
  p_user_id uuid,
  p_limit integer default 20,
  p_cursor_created_at timestamptz default null,
  p_cursor_id uuid default null
) returns table (
  id uuid,
  status text,
  title text,
  budget_minor bigint,
  currency_code text,
  currency_minor_unit smallint,
  needed_by date,
  listing_slug text,
  listing_title text,
  counterparty_name text,
  quote_count integer,
  live_quote_count integer,
  accepted_payment_due_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select r.id,
         r.status,
         r.title,
         r.budget_minor,
         r.currency_code::text,
         c.decimal_places,
         r.needed_by,
         l.slug,
         l.title,
         s.display_name,
         (select count(*)::integer from public.service_quotes q where q.service_request_id = r.id),
         (select count(*)::integer from public.service_quotes q
           where q.service_request_id = r.id and q.status = 'sent' and q.expires_at > now()),
         (select q.payment_due_at from public.service_quotes q
           where q.service_request_id = r.id and q.status = 'accepted'),
         r.closed_at,
         r.created_at
    from public.service_requests r
    join public.seller_profiles s on s.user_id = r.seller_user_id
    join public.currencies c on c.code = r.currency_code
    left join public.listings l on l.id = r.listing_id
   where r.buyer_user_id = p_user_id
     and (
       p_cursor_created_at is null
       or p_cursor_id is null
       or (r.created_at, r.id) < (p_cursor_created_at, p_cursor_id)
     )
   order by r.created_at desc, r.id desc
   limit least(greatest(coalesce(p_limit, 20), 1), 51);
$$;

comment on function app_private.service_requests_for_buyer(uuid, integer, timestamptz, uuid) is
  'One page of the service requests an account has sent, newest first, over 0015''s own service_requests_buyer index. Scoped to buyer_user_id in the statement. `counterparty_name` is the storefront the request went to; no account identifier is returned.';

-- ---------------------------------------------------------------------------------------------------
-- The seller's request inbox
-- ---------------------------------------------------------------------------------------------------
-- The same page from the other side, over 0015's `service_requests_seller_queue`. A separate function
-- rather than a role parameter: each predicate is fixed in the statement, so there is no argument a caller
-- could supply that would show them the wrong side.
create or replace function app_private.service_requests_for_seller(
  p_user_id uuid,
  p_limit integer default 20,
  p_cursor_created_at timestamptz default null,
  p_cursor_id uuid default null
) returns table (
  id uuid,
  status text,
  title text,
  budget_minor bigint,
  currency_code text,
  currency_minor_unit smallint,
  needed_by date,
  listing_slug text,
  listing_title text,
  counterparty_name text,
  quote_count integer,
  live_quote_count integer,
  accepted_payment_due_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select r.id,
         r.status,
         r.title,
         r.budget_minor,
         r.currency_code::text,
         c.decimal_places,
         r.needed_by,
         l.slug,
         l.title,
         -- The buyer's own display name, which the seller already has from the request. No account
         -- identifier, no email and no telephone number: a seller answering a brief needs none of them.
         p.display_name,
         (select count(*)::integer from public.service_quotes q where q.service_request_id = r.id),
         (select count(*)::integer from public.service_quotes q
           where q.service_request_id = r.id and q.status = 'sent' and q.expires_at > now()),
         (select q.payment_due_at from public.service_quotes q
           where q.service_request_id = r.id and q.status = 'accepted'),
         r.closed_at,
         r.created_at
    from public.service_requests r
    join public.profiles p on p.id = r.buyer_user_id
    join public.currencies c on c.code = r.currency_code
    left join public.listings l on l.id = r.listing_id
   where r.seller_user_id = p_user_id
     and (
       p_cursor_created_at is null
       or p_cursor_id is null
       or (r.created_at, r.id) < (p_cursor_created_at, p_cursor_id)
     )
   order by r.created_at desc, r.id desc
   limit least(greatest(coalesce(p_limit, 20), 1), 51);
$$;

comment on function app_private.service_requests_for_seller(uuid, integer, timestamptz, uuid) is
  'One page of the service requests sent to an account''s storefront, newest first, over 0015''s own service_requests_seller_queue index. Scoped to seller_user_id in the statement. Returns the buyer''s display name and no other fact about them.';

-- ---------------------------------------------------------------------------------------------------
-- One request, with its quotes
-- ---------------------------------------------------------------------------------------------------
-- The one reader both parties share, which is 0015's `service_requests_party_read` and
-- `service_quotes_party_read` read literally: either the buyer or the seller, and nobody else.
--
-- **`is_buyer` and `is_seller` are derived here, from the account the API established.** A surface needs
-- to know which side it is showing in order to offer the right actions, and deriving it in the statement
-- means a browser cannot claim a side — there is no parameter for one, and the two booleans cannot both be
-- true because `service_requests_not_self` forbids it.
--
-- `not_found` covers a request that does not exist *and* one the caller is not a party to, deliberately
-- identically.
create or replace function app_private.service_request_detail(
  p_user_id uuid,
  p_request_id uuid
) returns table (
  outcome text,
  id uuid,
  status text,
  is_buyer boolean,
  is_seller boolean,
  title text,
  brief text,
  budget_minor bigint,
  currency_code text,
  currency_minor_unit smallint,
  needed_by date,
  listing_slug text,
  listing_title text,
  buyer_name text,
  seller_slug text,
  seller_name text,
  closed_at timestamptz,
  created_at timestamptz,
  quotes jsonb
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_row public.service_requests;
  v_minor smallint;
  v_listing_slug text;
  v_listing_title text;
  v_buyer text;
  v_seller_slug text;
  v_seller text;
begin
  if p_user_id is null or p_request_id is null then
    return query select 'not_found'::text, null::uuid, null::text, null::boolean, null::boolean,
      null::text, null::text, null::bigint, null::text, null::smallint, null::date, null::text,
      null::text, null::text, null::text, null::text, null::timestamptz, null::timestamptz, null::jsonb;
    return;
  end if;

  -- Scoped in the statement: a request the caller is not a party to is never matched.
  select * into v_row
    from public.service_requests r
   where r.id = p_request_id
     and (r.buyer_user_id = p_user_id or r.seller_user_id = p_user_id);

  if v_row.id is null then
    return query select 'not_found'::text, null::uuid, null::text, null::boolean, null::boolean,
      null::text, null::text, null::bigint, null::text, null::smallint, null::date, null::text,
      null::text, null::text, null::text, null::text, null::timestamptz, null::timestamptz, null::jsonb;
    return;
  end if;

  select c.decimal_places into v_minor from public.currencies c where c.code = v_row.currency_code;
  select l.slug, l.title into v_listing_slug, v_listing_title
    from public.listings l where l.id = v_row.listing_id;
  select p.display_name into v_buyer from public.profiles p where p.id = v_row.buyer_user_id;
  select s.slug, s.display_name into v_seller_slug, v_seller
    from public.seller_profiles s where s.user_id = v_row.seller_user_id;

  return query select
    'found'::text,
    v_row.id,
    v_row.status,
    v_row.buyer_user_id = p_user_id,
    v_row.seller_user_id = p_user_id,
    v_row.title,
    v_row.brief,
    v_row.budget_minor,
    v_row.currency_code::text,
    v_minor,
    v_row.needed_by,
    v_listing_slug,
    v_listing_title,
    v_buyer,
    v_seller_slug,
    v_seller,
    v_row.closed_at,
    v_row.created_at,
    coalesce(
      (select jsonb_agg(
                jsonb_build_object(
                  'id', q.id,
                  'status', q.status,
                  -- `bigint` as a string: a JSON number would be a precision decision nobody made.
                  'amountMinor', q.amount_minor::text,
                  'deliveryDays', q.delivery_days,
                  'revisionsIncluded', q.revisions_included,
                  'scope', q.scope,
                  'isLapsed', q.status = 'sent' and q.expires_at <= now(),
                  'expiresAt', q.expires_at,
                  'respondedAt', q.responded_at,
                  'acceptedAt', q.accepted_at,
                  'paymentDueAt', q.payment_due_at,
                  'createdAt', q.created_at
                )
                order by q.created_at desc, q.id desc)
         from public.service_quotes q
        where q.service_request_id = v_row.id),
      '[]'::jsonb
    );
end;
$$;

comment on function app_private.service_request_detail(uuid, uuid) is
  'One service request and its quotes, for either party and nobody else — 0015''s two party-read policies for a caller the connection cannot see. is_buyer and is_seller are derived from the account the API established, so a browser cannot claim a side. Returns no account identifier and no seller-private field.';

-- ---------------------------------------------------------------------------------------------------
-- Sending a request
-- ---------------------------------------------------------------------------------------------------
-- The buyer supplies a listing, a title, a brief and optionally a budget and a date. **They do not supply
-- the seller or the currency**: both come out of the listing row, which is what makes it impossible to
-- send a brief to somebody who does not own the service being asked about.
--
-- Only a **custom** service can receive one, which is v5.2's own division: a fixed-price service is bought
-- through the cart and a custom one runs request → quote. The listing must also be purchasable, by the
-- same test its own purchase path uses.
create or replace function app_private.service_request_create(
  p_buyer_id uuid,
  p_listing_id uuid,
  p_title text,
  p_brief text,
  p_budget_minor bigint default null,
  p_needed_by date default null
) returns table (
  outcome text,
  request_id uuid,
  status text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_seller uuid;
  v_currency char(3);
  v_listing_status text;
  v_pricing text;
  v_title text := nullif(btrim(coalesce(p_title, '')), '');
  v_brief text := nullif(btrim(coalesce(p_brief, '')), '');
  v_request_id uuid;
begin
  if p_buyer_id is null or p_listing_id is null then
    return query select 'not_found'::text, null::uuid, null::text;
    return;
  end if;
  -- 0015's own length and budget rules, answered as an outcome rather than as a constraint violation.
  if v_title is null or length(v_title) < 3 or length(v_title) > 140
     or v_brief is null or length(v_brief) < 10 or length(v_brief) > 10000
     or (p_budget_minor is not null and p_budget_minor <= 0) then
    return query select 'invalid'::text, null::uuid, null::text;
    return;
  end if;

  select l.seller_user_id, l.currency_code, l.status
    into v_seller, v_currency, v_listing_status
    from public.listings l where l.id = p_listing_id;

  if v_seller is null then
    return query select 'not_found'::text, null::uuid, null::text;
    return;
  end if;
  if not public.listing_status_is_purchasable(v_listing_status) then
    return query select 'not_available'::text, null::uuid, null::text;
    return;
  end if;

  -- v5.2: fixed-price services go through the cart; only a custom service runs request → quote.
  select d.pricing_model into v_pricing
    from public.listing_service_details d where d.listing_id = p_listing_id;
  if v_pricing is distinct from 'custom' then
    return query select 'not_custom'::text, null::uuid, null::text;
    return;
  end if;

  -- `service_requests_not_self`, as an outcome.
  if v_seller = p_buyer_id then
    return query select 'own_listing'::text, null::uuid, null::text;
    return;
  end if;
  -- 0015's `service_requests_buyer_insert` also refuses a blocked pair; `app_system` is not bound by that
  -- policy, so the rule is applied here instead of being lost.
  if public.is_blocked_between(p_buyer_id, v_seller) then
    return query select 'blocked'::text, null::uuid, null::text;
    return;
  end if;

  insert into public.service_requests (
    currency_code, listing_id, buyer_user_id, seller_user_id, title, brief, budget_minor, needed_by
  )
  values (v_currency, p_listing_id, p_buyer_id, v_seller, v_title, v_brief, p_budget_minor, p_needed_by)
  returning id into v_request_id;

  return query select 'created'::text, v_request_id, 'open'::text;
end;
$$;

comment on function app_private.service_request_create(uuid, uuid, text, text, bigint, date) is
  'Sends one service request for a buyer. The seller and the currency come out of the listing row, so a caller supplies neither. Only a purchasable, custom-priced service can receive one — v5.2''s own division between cart-bought and quoted services. Applies 0015''s length, budget, not-self and not-blocked rules as outcomes. Writes no status other than the table''s own default.';

-- ---------------------------------------------------------------------------------------------------
-- Closing a request
-- ---------------------------------------------------------------------------------------------------
-- Two transitions, one shape: the buyer cancels their own request and the seller declines it. Both are
-- reachable while the request is `open` or `quoted` — the two live states — and both set `closed_at`,
-- which `service_requests_closed_has_time` requires.
create or replace function app_private.service_request_cancel(
  p_buyer_id uuid,
  p_request_id uuid
) returns table (
  outcome text,
  status text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_row public.service_requests;
  v_now timestamptz := now();
  v_status text;
begin
  if p_buyer_id is null or p_request_id is null then
    return query select 'not_found'::text, null::text;
    return;
  end if;

  select * into v_row
    from public.service_requests r
   where r.id = p_request_id and r.buyer_user_id = p_buyer_id
     for update;

  if v_row.id is null then
    return query select 'not_found'::text, null::text;
    return;
  end if;
  if v_row.status not in ('open', 'quoted') then
    return query select 'conflict'::text, v_row.status;
    return;
  end if;

  update public.service_requests r
     set status = 'cancelled', closed_at = v_now
   where r.id = v_row.id and r.status in ('open', 'quoted');

  if not found then
    select r.status into v_status from public.service_requests r where r.id = v_row.id;
    return query select 'conflict'::text, v_status;
    return;
  end if;

  return query select 'cancelled'::text, 'cancelled'::text;
end;
$$;

comment on function app_private.service_request_cancel(uuid, uuid) is
  'The buyer withdraws their own service request while it is still open or quoted. Scoped to buyer_user_id in the statement and guarded by the live statuses in the UPDATE, so a repeated or concurrent close answers conflict. Sets closed_at, which 0015''s constraint requires.';

create or replace function app_private.service_request_decline(
  p_seller_id uuid,
  p_request_id uuid
) returns table (
  outcome text,
  status text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_row public.service_requests;
  v_now timestamptz := now();
  v_status text;
begin
  if p_seller_id is null or p_request_id is null then
    return query select 'not_found'::text, null::text;
    return;
  end if;

  select * into v_row
    from public.service_requests r
   where r.id = p_request_id and r.seller_user_id = p_seller_id
     for update;

  if v_row.id is null then
    return query select 'not_found'::text, null::text;
    return;
  end if;
  if v_row.status not in ('open', 'quoted') then
    return query select 'conflict'::text, v_row.status;
    return;
  end if;

  update public.service_requests r
     set status = 'declined', closed_at = v_now
   where r.id = v_row.id and r.status in ('open', 'quoted');

  if not found then
    select r.status into v_status from public.service_requests r where r.id = v_row.id;
    return query select 'conflict'::text, v_status;
    return;
  end if;

  return query select 'declined'::text, 'declined'::text;
end;
$$;

comment on function app_private.service_request_decline(uuid, uuid) is
  'The seller declines to quote on a request sent to their own storefront. Scoped to seller_user_id in the statement; a buyer cannot reach this transition and a seller cannot reach another storefront''s request.';

-- ---------------------------------------------------------------------------------------------------
-- Quoting
-- ---------------------------------------------------------------------------------------------------
-- **0015's trigger is the authority here and is not duplicated.** `tg_service_quotes_rule` checks on
-- insert that the quoting seller is the request's seller and that the request is still open to quotes, and
-- it is what moves the request from `open` to `quoted`. The checks below exist to produce a usable answer
-- instead of a raised exception; they are the same checks, not extra ones, and the trigger still runs.
--
-- The currency is copied from the request, because 0015's composite foreign key
-- `(service_request_id, currency_code) → service_requests (id, currency_code)` means a quote can never
-- disagree with the brief it answers. There is no currency parameter.
--
-- `p_valid_for_days` is the one duration the repository leaves to the writer — see the preamble. Its bound
-- is 0015's own `service_quotes_delivery_days_range`, reused rather than reinvented.
create or replace function app_private.service_quote_create(
  p_seller_id uuid,
  p_request_id uuid,
  p_amount_minor bigint,
  p_delivery_days smallint,
  p_revisions_included smallint,
  p_scope text,
  p_valid_for_days smallint
) returns table (
  outcome text,
  quote_id uuid,
  status text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_row public.service_requests;
  v_scope text := nullif(btrim(coalesce(p_scope, '')), '');
  v_quote_id uuid;
begin
  if p_seller_id is null or p_request_id is null then
    return query select 'not_found'::text, null::uuid, null::text;
    return;
  end if;
  -- 0015's own column rules, answered as outcomes. The validity window shares `delivery_days`'s bound.
  if p_amount_minor is null or p_amount_minor <= 0
     or p_delivery_days is null or p_delivery_days < 1 or p_delivery_days > 365
     or p_revisions_included is null or p_revisions_included < 0
     or v_scope is null or length(v_scope) < 10 or length(v_scope) > 10000
     or p_valid_for_days is null or p_valid_for_days < 1 or p_valid_for_days > 365 then
    return query select 'invalid'::text, null::uuid, null::text;
    return;
  end if;

  -- Locked and scoped in one statement: another storefront's request is never matched.
  select * into v_row
    from public.service_requests r
   where r.id = p_request_id and r.seller_user_id = p_seller_id
     for update;

  if v_row.id is null then
    return query select 'not_found'::text, null::uuid, null::text;
    return;
  end if;
  -- The same window 0015's trigger enforces, reported rather than raised.
  if v_row.status not in ('open', 'quoted') then
    return query select 'conflict'::text, null::uuid, v_row.status;
    return;
  end if;
  if public.is_blocked_between(v_row.buyer_user_id, v_row.seller_user_id) then
    return query select 'blocked'::text, null::uuid, v_row.status;
    return;
  end if;

  insert into public.service_quotes (
    service_request_id, currency_code, seller_user_id, amount_minor, delivery_days,
    revisions_included, scope, expires_at
  )
  values (
    v_row.id, v_row.currency_code, p_seller_id, p_amount_minor, p_delivery_days,
    p_revisions_included, v_scope, now() + make_interval(days => p_valid_for_days)
  )
  returning id into v_quote_id;

  return query select 'created'::text, v_quote_id, 'sent'::text;
end;
$$;

comment on function app_private.service_quote_create(uuid, uuid, bigint, smallint, smallint, text, smallint) is
  'The seller quotes on a request sent to their own storefront. The currency is copied from the request, so 0015''s composite foreign key can never be violated, and there is no currency parameter. 0015''s tg_service_quotes_rule still runs and is what promotes the request from open to quoted. p_valid_for_days is the validity window the schema leaves to the writer — expires_at has no default — bounded by 0015''s own 1..365.';

-- ---------------------------------------------------------------------------------------------------
-- Withdrawing a quote
-- ---------------------------------------------------------------------------------------------------
create or replace function app_private.service_quote_withdraw(
  p_seller_id uuid,
  p_quote_id uuid
) returns table (
  outcome text,
  status text,
  request_id uuid
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_row public.service_quotes;
  v_now timestamptz := now();
  v_status text;
begin
  if p_seller_id is null or p_quote_id is null then
    return query select 'not_found'::text, null::text, null::uuid;
    return;
  end if;

  select * into v_row
    from public.service_quotes q
   where q.id = p_quote_id and q.seller_user_id = p_seller_id
     for update;

  if v_row.id is null then
    return query select 'not_found'::text, null::text, null::uuid;
    return;
  end if;
  if v_row.status <> 'sent' then
    return query select 'conflict'::text, v_row.status, v_row.service_request_id;
    return;
  end if;
  if v_row.expires_at <= v_now then
    -- Lapsed. 0032's sweeper owns writing `expired`, so nothing is written here.
    return query select 'expired'::text, v_row.status, v_row.service_request_id;
    return;
  end if;

  update public.service_quotes q
     set status = 'withdrawn', responded_at = v_now
   where q.id = v_row.id and q.status = 'sent';

  if not found then
    select q.status into v_status from public.service_quotes q where q.id = v_row.id;
    return query select 'conflict'::text, v_status, v_row.service_request_id;
    return;
  end if;

  return query select 'withdrawn'::text, 'withdrawn'::text, v_row.service_request_id;
end;
$$;

comment on function app_private.service_quote_withdraw(uuid, uuid) is
  'The seller takes their own live quote back. Scoped to seller_user_id in the statement; the buyer cannot reach this transition. A quote past its window answers expired and is left for 0032''s sweeper. Returns the request the quote belongs to, so the API can refuse a quote id spent against a different request.';

-- ---------------------------------------------------------------------------------------------------
-- Rejecting a quote
-- ---------------------------------------------------------------------------------------------------
-- The buyer declines this quote and **the request stays open to another**: nothing here closes it, because
-- 0015's trigger admits further quotes while the request is `open` or `quoted`, and closing it would take
-- that away.
create or replace function app_private.service_quote_reject(
  p_buyer_id uuid,
  p_quote_id uuid
) returns table (
  outcome text,
  status text,
  request_id uuid
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_row public.service_quotes;
  v_now timestamptz := now();
  v_status text;
begin
  if p_buyer_id is null or p_quote_id is null then
    return query select 'not_found'::text, null::text, null::uuid;
    return;
  end if;

  -- 0015's `service_quotes_party_read` reaches a quote through its request's buyer, and so does this.
  select q.* into v_row
    from public.service_quotes q
    join public.service_requests r on r.id = q.service_request_id
   where q.id = p_quote_id and r.buyer_user_id = p_buyer_id
     for update of q;

  if v_row.id is null then
    return query select 'not_found'::text, null::text, null::uuid;
    return;
  end if;
  if v_row.status <> 'sent' then
    return query select 'conflict'::text, v_row.status, v_row.service_request_id;
    return;
  end if;
  if v_row.expires_at <= v_now then
    return query select 'expired'::text, v_row.status, v_row.service_request_id;
    return;
  end if;

  update public.service_quotes q
     set status = 'rejected', responded_at = v_now
   where q.id = v_row.id and q.status = 'sent';

  if not found then
    select q.status into v_status from public.service_quotes q where q.id = v_row.id;
    return query select 'conflict'::text, v_status, v_row.service_request_id;
    return;
  end if;

  return query select 'rejected'::text, 'rejected'::text, v_row.service_request_id;
end;
$$;

comment on function app_private.service_quote_reject(uuid, uuid) is
  'The buyer declines one live quote. Reached through the quote''s own request, exactly as 0015''s party-read policy reaches it. The request is deliberately left open, because 0015''s trigger still admits further quotes while it is open or quoted. Returns the request the quote belongs to, so the API can refuse a quote id spent against a different request.';

-- ---------------------------------------------------------------------------------------------------
-- Accepting a quote — the obligation transition
-- ---------------------------------------------------------------------------------------------------
-- **Two rows, one transaction, one timestamp.** The quote takes `status`, `responded_at`, `accepted_at`,
-- `accepted_terms` and `payment_due_at` together — which is what `service_quotes_accepted_has_time` and
-- `service_quotes_accepted_is_snapshotted` require, neither being satisfiable by a sequence of writes —
-- and the request is closed as `accepted` with `closed_at`, which is the only way that status is reachable
-- at all (see the preamble).
--
-- `v_now` is captured once and used for every one of those columns and as the base of the deadline, so the
-- acceptance time and the payment deadline cannot disagree.
--
-- **`payment_due_at = accepted_at + finance.payment_due_hours`, and nothing else.** No duration is
-- hard-coded, `offers.default_expiry_hours` is not read, the quote's own validity window is not reused, and
-- there is no fallback: an absent or unusable setting answers `payment_policy_missing` and writes nothing.
-- The browser has no way to influence it — `payment_due_at` is not a parameter of this function.
--
-- **What acceptance does not do.** No order, no checkout, no delivery row, no payment, no ledger entry, no
-- payout, no provider call, and no event. It records the payable obligation; Phase 8 consumes it.
create or replace function app_private.service_quote_accept(
  p_buyer_id uuid,
  p_quote_id uuid
) returns table (
  outcome text,
  status text,
  request_id uuid,
  accepted_at timestamptz,
  payment_due_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_row public.service_quotes;
  v_request public.service_requests;
  v_now timestamptz := now();
  v_hours integer;
  v_raw jsonb;
  v_due timestamptz;
  v_status text;
begin
  if p_buyer_id is null or p_quote_id is null then
    return query select 'not_found'::text, null::text, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;

  select q.* into v_row
    from public.service_quotes q
    join public.service_requests r on r.id = q.service_request_id
   where q.id = p_quote_id and r.buyer_user_id = p_buyer_id
     for update of q;

  if v_row.id is null then
    return query select 'not_found'::text, null::text, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;
  if v_row.status <> 'sent' then
    return query select 'conflict'::text, v_row.status, v_row.service_request_id,
      null::timestamptz, null::timestamptz;
    return;
  end if;
  if v_row.expires_at <= v_now then
    return query select 'expired'::text, v_row.status, v_row.service_request_id,
      null::timestamptz, null::timestamptz;
    return;
  end if;

  -- The request is locked too, because acceptance closes it as well and the two must not diverge.
  select * into v_request
    from public.service_requests r where r.id = v_row.service_request_id
     for update;

  if v_request.status not in ('open', 'quoted') then
    -- Already closed — cancelled, declined, or another quote accepted. `service_quotes_one_accepted`
    -- would refuse the second acceptance anyway; this reports it instead of raising.
    return query select 'conflict'::text, v_row.status, v_row.service_request_id,
      null::timestamptz, null::timestamptz;
    return;
  end if;

  -- D25's window. Read, never assumed, and never defaulted.
  v_raw := public.site_setting('finance.payment_due_hours');
  if v_raw is null or jsonb_typeof(v_raw) <> 'number' then
    return query select 'payment_policy_missing'::text, v_row.status, v_row.service_request_id,
      null::timestamptz, null::timestamptz;
    return;
  end if;
  v_hours := (v_raw #>> '{}')::numeric::integer;
  if v_hours is null or v_hours <= 0 then
    return query select 'payment_policy_missing'::text, v_row.status, v_row.service_request_id,
      null::timestamptz, null::timestamptz;
    return;
  end if;

  v_due := v_now + make_interval(hours => v_hours);

  update public.service_quotes q
     set status = 'accepted',
         responded_at = v_now,
         accepted_at = v_now,
         -- The snapshot is the quote's own authoritative fields plus the window that was applied. It
         -- restates nothing the row does not already hold and invents no term.
         accepted_terms = jsonb_build_object(
           'service_request_id', v_row.service_request_id,
           'currency_code', v_row.currency_code,
           'amount_minor', v_row.amount_minor::text,
           'delivery_days', v_row.delivery_days,
           'revisions_included', v_row.revisions_included,
           'payment_due_hours', v_hours
         ),
         payment_due_at = v_due
   where q.id = v_row.id and q.status = 'sent';

  if not found then
    select q.status into v_status from public.service_quotes q where q.id = v_row.id;
    return query select 'conflict'::text, v_status, v_row.service_request_id,
      null::timestamptz, null::timestamptz;
    return;
  end if;

  -- And the brief this answers is done. The only way `service_requests.accepted` is ever reached.
  update public.service_requests r
     set status = 'accepted', closed_at = v_now
   where r.id = v_request.id and r.status in ('open', 'quoted');

  return query select 'accepted'::text, 'accepted'::text, v_row.service_request_id, v_now, v_due;
end;
$$;

comment on function app_private.service_quote_accept(uuid, uuid) is
  'The buyer accepts one live quote, in a single transaction: the quote takes 0015''s obligation fields — status, responded_at, accepted_at, accepted_terms and payment_due_at — from one timestamp, and the request is closed as accepted, which is the only way that status is reachable. payment_due_at is accepted_at plus finance.payment_due_hours, read from site_settings with no fallback; a missing or unusable setting answers payment_policy_missing and writes nothing. Creates no order, checkout, delivery, payment, ledger entry, payout or event. Returns the request the quote belongs to, so the API can refuse a quote id spent against a different request.';

-- ---------------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------------
-- The API role alone. `authenticated` gains nothing: it already has 0015's six policies, which resolve the
-- caller from its own verified session, and a function that takes an account as a parameter must never be
-- callable by something that could choose it.
revoke all on function app_private.service_requests_for_buyer(uuid, integer, timestamptz, uuid) from public;
revoke all on function app_private.service_requests_for_seller(uuid, integer, timestamptz, uuid) from public;
revoke all on function app_private.service_request_detail(uuid, uuid) from public;
revoke all on function app_private.service_request_create(uuid, uuid, text, text, bigint, date) from public;
revoke all on function app_private.service_request_cancel(uuid, uuid) from public;
revoke all on function app_private.service_request_decline(uuid, uuid) from public;
revoke all on function app_private.service_quote_create(uuid, uuid, bigint, smallint, smallint, text, smallint) from public;
revoke all on function app_private.service_quote_withdraw(uuid, uuid) from public;
revoke all on function app_private.service_quote_reject(uuid, uuid) from public;
revoke all on function app_private.service_quote_accept(uuid, uuid) from public;

grant execute on function app_private.service_requests_for_buyer(uuid, integer, timestamptz, uuid) to app_system;
grant execute on function app_private.service_requests_for_seller(uuid, integer, timestamptz, uuid) to app_system;
grant execute on function app_private.service_request_detail(uuid, uuid) to app_system;
grant execute on function app_private.service_request_create(uuid, uuid, text, text, bigint, date) to app_system;
grant execute on function app_private.service_request_cancel(uuid, uuid) to app_system;
grant execute on function app_private.service_request_decline(uuid, uuid) to app_system;
grant execute on function app_private.service_quote_create(uuid, uuid, bigint, smallint, smallint, text, smallint) to app_system;
grant execute on function app_private.service_quote_withdraw(uuid, uuid) to app_system;
grant execute on function app_private.service_quote_reject(uuid, uuid) to app_system;
grant execute on function app_private.service_quote_accept(uuid, uuid) to app_system;

-- ---------------------------------------------------------------------------------------------------
-- The security contract still holds
-- ---------------------------------------------------------------------------------------------------
do $$
begin
  perform app_private.assert_security_contract();
end;
$$;
