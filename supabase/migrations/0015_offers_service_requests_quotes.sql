-- 0015 — Service details, offers, service requests and quotes (v5.2 migration plan).
--
-- Services come in two shapes (business decisions): a fixed-price service is bought through the cart
-- like a product, and a custom service runs request → quote → accepted quote → single-item checkout.
-- There is no calendar booking in V1. `listing_service_details` lands here, next to the request and
-- quote tables it governs, rather than in 0011 with the product details.
--
-- Offers expire after a configurable window (48 hours by default, from site_settings). An accepted offer
-- snapshots its terms and records when payment is due (D25); the checkout it opens belongs to 0017.
--
-- Money follows the currency rules throughout: integer minor units, a `currency_code` per record, and
-- composite `(id, currency_code)` foreign keys so an offer can never disagree with its listing and a
-- quote can never disagree with its request.

-- ---------------------------------------------------------------------------------------------------
-- Service details
-- ---------------------------------------------------------------------------------------------------
create table public.listing_service_details (
  listing_id uuid primary key references public.listings (id) on delete cascade,
  pricing_model text not null default 'fixed',
  delivery_days smallint,
  revisions_included smallint not null default 0,
  requires_brief boolean not null default false,
  scope text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint listing_service_details_pricing_model_allowed check (pricing_model in ('fixed', 'custom')),
  constraint listing_service_details_fixed_needs_delivery check (pricing_model <> 'fixed' or delivery_days is not null),
  constraint listing_service_details_delivery_days_range check (delivery_days is null or delivery_days between 1 and 365),
  constraint listing_service_details_revisions_positive check (revisions_included >= 0),
  constraint listing_service_details_scope_length check (scope is null or length(scope) <= 5000)
);
comment on table public.listing_service_details is
  'Service-specific fields. `fixed` services are bought through the cart; `custom` services go through a request and a quote.';
create trigger listing_service_details_set_updated_at before update on public.listing_service_details
  for each row execute function app_private.tg_set_updated_at();

-- ---------------------------------------------------------------------------------------------------
-- Offers
-- ---------------------------------------------------------------------------------------------------
create table public.offers (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null,
  currency_code char(3) not null,
  buyer_user_id uuid not null references auth.users (id) on delete cascade,
  seller_user_id uuid not null references public.seller_profiles (user_id) on delete cascade,
  parent_offer_id uuid references public.offers (id) on delete set null,
  amount_minor bigint not null,
  quantity integer not null default 1,
  message text,
  status text not null default 'pending',
  expires_at timestamptz not null,
  responded_at timestamptz,
  accepted_at timestamptz,
  accepted_terms jsonb,
  payment_due_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (listing_id, currency_code) references public.listings (id, currency_code) on delete cascade,
  constraint offers_status_allowed check (status in ('pending', 'accepted', 'rejected', 'countered', 'withdrawn', 'expired')),
  constraint offers_amount_positive check (amount_minor > 0),
  constraint offers_quantity_positive check (quantity >= 1),
  constraint offers_message_length check (message is null or length(message) <= 2000),
  constraint offers_not_self check (buyer_user_id <> seller_user_id),
  constraint offers_responded_when_decided check ((status in ('pending')) = (responded_at is null)),
  constraint offers_accepted_has_time check ((status = 'accepted') = (accepted_at is not null)),
  -- D25: an accepted offer snapshots its terms and carries the payment window.
  constraint offers_accepted_is_snapshotted check (
    status <> 'accepted' or (accepted_terms is not null and jsonb_typeof(accepted_terms) = 'object' and payment_due_at is not null)
  ),
  constraint offers_not_own_parent check (parent_offer_id is null or parent_offer_id <> id),
  unique (id, currency_code)
);
comment on table public.offers is
  'A buyer''s offer on a listing, in the listing''s currency. Counters chain through parent_offer_id; an accepted offer snapshots its terms (D25).';
create unique index offers_one_open_per_buyer on public.offers (listing_id, buyer_user_id) where status = 'pending';
create index offers_seller_queue on public.offers (seller_user_id, status, created_at desc);
create index offers_buyer on public.offers (buyer_user_id, created_at desc);
create index offers_expiring on public.offers (expires_at) where status = 'pending';
create trigger offers_set_updated_at before update on public.offers
  for each row execute function app_private.tg_set_updated_at();

create table public.offer_messages (
  id uuid primary key default gen_random_uuid(),
  offer_id uuid not null references public.offers (id) on delete cascade,
  sender_user_id uuid not null references auth.users (id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now(),
  constraint offer_messages_body_length check (length(btrim(body)) between 1 and 2000)
);
create index offer_messages_offer on public.offer_messages (offer_id, created_at);

-- The default offer window is an admin setting; the seller of the listing is the seller of the offer;
-- and only a purchasable listing can receive one.
create or replace function app_private.tg_offers_rule() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  listing_seller uuid;
  listing_status text;
  window_hours integer;
begin
  select l.seller_user_id, l.status into listing_seller, listing_status
    from public.listings l where l.id = new.listing_id;

  if tg_op = 'INSERT' then
    if not public.listing_status_is_purchasable(listing_status) then
      raise exception 'offers can only be made on a live listing' using errcode = 'restrict_violation';
    end if;
    if new.seller_user_id is distinct from listing_seller then
      raise exception 'the offer must name the listing''s seller' using errcode = 'restrict_violation';
    end if;
    if new.expires_at is null then
      window_hours := coalesce((public.site_setting('offers.default_expiry_hours'))::integer, 48);
      new.expires_at := now() + make_interval(hours => window_hours);
    end if;
  end if;
  return new;
end;
$$;

-- `expires_at` is NOT NULL, so the default has to be applied before the constraint is checked.
alter table public.offers alter column expires_at drop not null;
create trigger offers_rule before insert or update on public.offers
  for each row execute function app_private.tg_offers_rule();
alter table public.offers add constraint offers_expiry_present check (expires_at is not null) not valid;
alter table public.offers validate constraint offers_expiry_present;

select app_private.register_currency_dependency(
  'offers.currency_code', 'public', 'offers', 'currency_code',
  'open or accepted offers in the currency',
  $$status in ('pending', 'accepted')$$
);

-- ---------------------------------------------------------------------------------------------------
-- Custom services: requests and quotes
-- ---------------------------------------------------------------------------------------------------
create table public.service_requests (
  id uuid primary key default gen_random_uuid(),
  currency_code char(3) not null references public.currencies (code) on delete restrict,
  listing_id uuid references public.listings (id) on delete set null,
  buyer_user_id uuid not null references auth.users (id) on delete cascade,
  seller_user_id uuid not null references public.seller_profiles (user_id) on delete cascade,
  title text not null,
  brief text not null,
  budget_minor bigint,
  needed_by date,
  status text not null default 'open',
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint service_requests_title_length check (length(btrim(title)) between 3 and 140),
  constraint service_requests_brief_length check (length(btrim(brief)) between 10 and 10000),
  constraint service_requests_budget_positive check (budget_minor is null or budget_minor > 0),
  constraint service_requests_status_allowed check (status in ('open', 'quoted', 'accepted', 'declined', 'cancelled', 'expired')),
  constraint service_requests_not_self check (buyer_user_id <> seller_user_id),
  constraint service_requests_closed_has_time check ((status in ('accepted', 'declined', 'cancelled', 'expired')) = (closed_at is not null)),
  unique (id, currency_code)
);
comment on table public.service_requests is 'A buyer''s brief for a custom service. The seller answers with one or more quotes.';
create index service_requests_seller_queue on public.service_requests (seller_user_id, status, created_at desc);
create index service_requests_buyer on public.service_requests (buyer_user_id, created_at desc);
create trigger service_requests_set_updated_at before update on public.service_requests
  for each row execute function app_private.tg_set_updated_at();

create table public.service_quotes (
  id uuid primary key default gen_random_uuid(),
  service_request_id uuid not null,
  currency_code char(3) not null,
  seller_user_id uuid not null references public.seller_profiles (user_id) on delete cascade,
  amount_minor bigint not null,
  delivery_days smallint not null,
  revisions_included smallint not null default 0,
  scope text not null,
  status text not null default 'sent',
  expires_at timestamptz not null,
  responded_at timestamptz,
  accepted_at timestamptz,
  accepted_terms jsonb,
  payment_due_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (service_request_id, currency_code) references public.service_requests (id, currency_code) on delete cascade,
  constraint service_quotes_amount_positive check (amount_minor > 0),
  constraint service_quotes_delivery_days_range check (delivery_days between 1 and 365),
  constraint service_quotes_revisions_positive check (revisions_included >= 0),
  constraint service_quotes_scope_length check (length(btrim(scope)) between 10 and 10000),
  constraint service_quotes_status_allowed check (status in ('sent', 'accepted', 'rejected', 'withdrawn', 'expired')),
  constraint service_quotes_accepted_has_time check ((status = 'accepted') = (accepted_at is not null)),
  constraint service_quotes_accepted_is_snapshotted check (
    status <> 'accepted' or (accepted_terms is not null and jsonb_typeof(accepted_terms) = 'object' and payment_due_at is not null)
  ),
  unique (id, currency_code)
);
comment on table public.service_quotes is
  'A seller''s priced answer to a request, in the request''s currency. An accepted quote snapshots its terms and opens a single-item checkout.';
-- Exactly one quote per request can be accepted, so only one checkout can ever open from it.
create unique index service_quotes_one_accepted on public.service_quotes (service_request_id) where status = 'accepted';
create index service_quotes_request on public.service_quotes (service_request_id, created_at desc);
create index service_quotes_expiring on public.service_quotes (expires_at) where status = 'sent';
create trigger service_quotes_set_updated_at before update on public.service_quotes
  for each row execute function app_private.tg_set_updated_at();

create or replace function app_private.tg_service_quotes_rule() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  request_seller uuid;
  request_status text;
begin
  select r.seller_user_id, r.status into request_seller, request_status
    from public.service_requests r where r.id = new.service_request_id;
  if tg_op = 'INSERT' then
    if new.seller_user_id is distinct from request_seller then
      raise exception 'only the seller the request was sent to may quote' using errcode = 'restrict_violation';
    end if;
    if request_status not in ('open', 'quoted') then
      raise exception 'this request is no longer open for quotes' using errcode = 'restrict_violation';
    end if;
    update public.service_requests set status = 'quoted' where id = new.service_request_id and status = 'open';
  end if;
  return new;
end;
$$;

create trigger service_quotes_rule before insert or update on public.service_quotes
  for each row execute function app_private.tg_service_quotes_rule();

select app_private.register_currency_dependency(
  'service_requests.currency_code', 'public', 'service_requests', 'currency_code',
  'open service requests in the currency',
  $$status in ('open', 'quoted', 'accepted')$$
);
select app_private.register_currency_dependency(
  'service_quotes.currency_code', 'public', 'service_quotes', 'currency_code',
  'open or accepted service quotes in the currency',
  $$status in ('sent', 'accepted')$$
);

-- ---------------------------------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------------------------------
alter table public.listing_service_details enable row level security;
alter table public.offers enable row level security;
alter table public.offer_messages enable row level security;
alter table public.service_requests enable row level security;
alter table public.service_quotes enable row level security;

create policy listing_service_details_public_read on public.listing_service_details for select to authenticated
  using (public.listing_is_visible(listing_id));
create policy listing_service_details_owner_all on public.listing_service_details for all to authenticated
  using (exists (select 1 from public.listings l where l.id = listing_id and l.seller_user_id = public.current_user_id()))
  with check (exists (select 1 from public.listings l where l.id = listing_id and l.seller_user_id = public.current_user_id()));

create policy offers_party_read on public.offers for select to authenticated
  using (buyer_user_id = public.current_user_id() or seller_user_id = public.current_user_id());
create policy offers_buyer_insert on public.offers for insert to authenticated
  with check (buyer_user_id = public.current_user_id() and not public.is_blocked_between(buyer_user_id, seller_user_id));
create policy offers_party_update on public.offers for update to authenticated
  using (buyer_user_id = public.current_user_id() or seller_user_id = public.current_user_id())
  with check (buyer_user_id = public.current_user_id() or seller_user_id = public.current_user_id());

create policy offer_messages_party_read on public.offer_messages for select to authenticated
  using (exists (
    select 1 from public.offers o
    where o.id = offer_id and (o.buyer_user_id = public.current_user_id() or o.seller_user_id = public.current_user_id())
  ));
create policy offer_messages_party_insert on public.offer_messages for insert to authenticated
  with check (sender_user_id = public.current_user_id() and exists (
    select 1 from public.offers o
    where o.id = offer_id and (o.buyer_user_id = public.current_user_id() or o.seller_user_id = public.current_user_id())
  ));

create policy service_requests_party_read on public.service_requests for select to authenticated
  using (buyer_user_id = public.current_user_id() or seller_user_id = public.current_user_id());
create policy service_requests_buyer_insert on public.service_requests for insert to authenticated
  with check (buyer_user_id = public.current_user_id() and not public.is_blocked_between(buyer_user_id, seller_user_id));
create policy service_requests_party_update on public.service_requests for update to authenticated
  using (buyer_user_id = public.current_user_id() or seller_user_id = public.current_user_id())
  with check (buyer_user_id = public.current_user_id() or seller_user_id = public.current_user_id());

create policy service_quotes_party_read on public.service_quotes for select to authenticated
  using (
    seller_user_id = public.current_user_id()
    or exists (select 1 from public.service_requests r where r.id = service_request_id and r.buyer_user_id = public.current_user_id())
  );
create policy service_quotes_seller_insert on public.service_quotes for insert to authenticated
  with check (seller_user_id = public.current_user_id());
create policy service_quotes_party_update on public.service_quotes for update to authenticated
  using (
    seller_user_id = public.current_user_id()
    or exists (select 1 from public.service_requests r where r.id = service_request_id and r.buyer_user_id = public.current_user_id())
  )
  with check (
    seller_user_id = public.current_user_id()
    or exists (select 1 from public.service_requests r where r.id = service_request_id and r.buyer_user_id = public.current_user_id())
  );

grant select, insert, update, delete on public.listing_service_details to authenticated;
grant select, insert, update on public.offers to authenticated;
grant select, insert on public.offer_messages to authenticated;
grant select, insert, update on public.service_requests to authenticated;
grant select, insert, update on public.service_quotes to authenticated;

-- ---------------------------------------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema app_private from public;
