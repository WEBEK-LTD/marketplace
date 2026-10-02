-- 0048 — The live-listing price rule, widened for custom-priced services (Phase 4-C follow-up).
--
-- 0011 shipped this, as a single-table CHECK:
--
--   constraint listings_live_needs_price
--     check (status not in ('approved', 'active') or price_minor is not null)
--
-- It is right for everything it was written for and wrong for one case Phase 4-C introduced. A service
-- priced `custom` is quoted per engagement: it has no amount until someone asks, and its public page is
-- supposed to say "Contact for price". Under the old CHECK such a service could never be **live** — only
-- sold, expired or archived, the states the CHECK does not cover — so the page existed and the listing
-- that would reach it did not.
--
-- The rule the owner settled on, for `approved` and `active` only:
--
--   product                          price_minor must not be null
--   service, pricing_model = fixed   price_minor must not be null
--   service, pricing_model = custom  price_minor may be null
--
-- **Why a CHECK cannot express it.** `pricing_model` lives in `listing_service_details`, a different
-- table. A CHECK constraint sees one row of one table, so the rule is not expressible as one — and
-- writing it as a CHECK that consults another table through a function would be worse than a trigger,
-- because PostgreSQL does not re-evaluate a CHECK when the *other* table changes. Turning a service from
-- `custom` to `fixed` would then leave a live, priceless, fixed-price listing that nothing ever
-- re-examined.
--
-- **Why the trigger is deferred.** A listing and its service details are two rows, written by two
-- statements. Whichever goes first, the pair is momentarily inconsistent: insert the listing first and it
-- is a live service with no pricing model yet; insert the details first and there is no listing to attach
-- them to. An immediate trigger would therefore force an ordering that makes one of the two legitimate
-- orders impossible. `DEFERRABLE INITIALLY DEFERRED` moves the check to COMMIT, by which time the
-- transaction has finished saying what it means. Nothing that violates the rule can be committed; only
-- the intermediate states inside a transaction are allowed to.
--
-- **Both tables carry the trigger**, because either side can break the invariant: changing a listing's
-- status or price, and changing or removing its pricing model, are both ways to arrive at a live,
-- priceless, non-custom listing.
--
-- A service with no `listing_service_details` row at all states no pricing model, so it is not `custom`
-- and the rule holds it to a price like anything else. That is deliberate: "no row" is an absence of
-- information, not a declaration that the work is quoted per engagement.

-- ---------------------------------------------------------------------------------------------------
-- The rule
-- ---------------------------------------------------------------------------------------------------
create or replace function app_private.live_listing_price_is_valid(p_listing_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  -- `coalesce` makes the answer total. Without it a service with no `listing_service_details` row
  -- compares `null = 'custom'`, the predicate is NULL rather than false, and `not null` is NULL — so the
  -- caller's `if not ...` would simply not fire and a live priceless listing would slip through. Three-
  -- valued logic is exactly how a rule like this fails open.
  select coalesce(
           case
             -- The listing is gone: there is nothing left to be invalid.
             when l.id is null then true
             -- Only the two live states are constrained. Draft, sold, expired and archived are not.
             when l.status not in ('approved', 'active') then true
             when l.price_minor is not null then true
             -- Priceless and live: allowed for a custom-priced service, and for nothing else.
             else l.listing_type_code = 'service' and d.pricing_model = 'custom'
           end,
           false)
    from (select 1) one
    left join public.listings l on l.id = p_listing_id
    left join public.listing_service_details d on d.listing_id = l.id;
$$;

comment on function app_private.live_listing_price_is_valid(uuid) is
  'Whether one listing satisfies the live-price rule: an approved or active listing needs a price unless it is a service priced per engagement (pricing_model = custom).';

create or replace function app_private.enforce_live_listing_price()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_listing_id uuid;
begin
  -- The trigger is on two tables, so the listing is named differently depending on which one fired.
  -- This has to branch rather than pick with a CASE expression: PL/pgSQL resolves every field reference
  -- in an expression it evaluates, so a CASE naming both `new.id` and `new.listing_id` fails on whichever
  -- table lacks the other's column. For the same reason DELETE is separated out — `new` is unassigned
  -- there, and reading it raises rather than yielding null.
  if tg_table_name = 'listings' then
    if tg_op = 'DELETE' then
      v_listing_id := old.id;
    else
      v_listing_id := new.id;
    end if;
  else
    if tg_op = 'DELETE' then
      v_listing_id := old.listing_id;
    else
      v_listing_id := new.listing_id;
    end if;
  end if;

  if v_listing_id is null then
    return null;
  end if;

  if not app_private.live_listing_price_is_valid(v_listing_id) then
    raise exception
      'A live listing must have a price unless it is a service priced per engagement.'
      using errcode = '23514',
            detail = 'listing id ' || v_listing_id::text,
            hint = 'Set price_minor, or give the service a listing_service_details row with pricing_model = custom.';
  end if;

  return null;
end;
$$;

comment on function app_private.enforce_live_listing_price() is
  'Constraint trigger for the live-price rule. Deferred to COMMIT so a listing and its service details may be written in either order within one transaction.';

revoke execute on function app_private.live_listing_price_is_valid(uuid) from public;
revoke execute on function app_private.enforce_live_listing_price() from public;

grant execute on function app_private.live_listing_price_is_valid(uuid) to app_system;

-- ---------------------------------------------------------------------------------------------------
-- Superseding the old constraint
-- ---------------------------------------------------------------------------------------------------
-- 0011 is frozen and is not edited. The constraint it created is dropped here and replaced by the
-- triggers below, which enforce strictly more than it did for products and fixed-price services and
-- exactly one case less for custom-priced ones.
alter table public.listings drop constraint if exists listings_live_needs_price;

drop trigger if exists listings_live_price_rule on public.listings;
create constraint trigger listings_live_price_rule
  after insert or update on public.listings
  deferrable initially deferred
  for each row execute function app_private.enforce_live_listing_price();

drop trigger if exists listing_service_details_live_price_rule on public.listing_service_details;
create constraint trigger listing_service_details_live_price_rule
  after insert or update or delete on public.listing_service_details
  deferrable initially deferred
  for each row execute function app_private.enforce_live_listing_price();

-- ---------------------------------------------------------------------------------------------------
-- Nothing already stored may violate the new rule
-- ---------------------------------------------------------------------------------------------------
-- A deferred trigger only sees writes made after it exists, so the rows already in the table are checked
-- once, here. The old CHECK was stricter, so this can only pass — and it fails the migration rather than
-- leaving a violation behind if that assumption is ever wrong.
do $$
declare
  v_bad bigint;
begin
  select count(*) into v_bad
    from public.listings l
   where not app_private.live_listing_price_is_valid(l.id);

  if v_bad > 0 then
    raise exception 'The live-price rule is violated by % existing listing(s).', v_bad;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------------------------------
-- The security contract still holds
-- ---------------------------------------------------------------------------------------------------
do $$
begin
  perform app_private.assert_security_contract();
end;
$$;
