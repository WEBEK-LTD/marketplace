-- 0110 — The buyer↔seller paths are closed (owner amendment to v5.2, OD-A4).
--
-- ---------------------------------------------------------------------------------------------------
-- What OD-A4 decided
-- ---------------------------------------------------------------------------------------------------
-- A buyer deals with the office and never with a seller. There is no buyer↔seller offer, no seller
-- quote, and no request that a seller answers. 0109 built what replaces them — an enquiry routed to the
-- office and a receipt recorded there — and this migration closes what they replace.
--
-- ---------------------------------------------------------------------------------------------------
-- Closed by revocation, not by dropping
-- ---------------------------------------------------------------------------------------------------
-- Fourteen functions lose `app_system`'s execute privilege. `app_system` is the only role that held it,
-- and it is the role the API connects as, so after this migration **the API cannot call them at all** —
-- not because a route was deleted but because the database refuses. The routes go too, in the same
-- increment, which is why the two halves move together: revoking a function while an endpoint still
-- called it would turn a removal into a 500.
--
-- Nothing is dropped, and that is deliberate rather than timid:
--
--   * `public.offers`, `public.offer_messages`, `public.service_quotes` and their constraints, triggers,
--     policies and indexes are 0015's, and 0070 and 0071 are closed increments. A `drop function` would
--     rewrite their history; a `revoke` records a decision on top of it.
--   * The rows those tables hold, wherever this schema is already deployed, stay readable. OD-A6 puts
--     corrections at the office, and an office cannot look up what the database deleted.
--   * 0070's and 0071's own pgTAP suites still exercise the functions directly as the owner, so their
--     proofs about offer and quote behaviour keep running. What changes is who may reach them, which is
--     exactly what those suites' grant assertions measure — narrowed there, not deleted.
--
-- The revocation is driven from a named list, so the set is auditable at a glance, and the signature of
-- each one comes from the catalogue rather than being retyped: `regprocedure` renders the identity
-- PostgreSQL actually holds, so this cannot drift from a function whose arguments changed.
--
-- ---------------------------------------------------------------------------------------------------
-- What a buyer keeps
-- ---------------------------------------------------------------------------------------------------
--   * `service_requests_for_buyer` — their own requests, which now means their enquiries.
--   * `service_request_detail` — one of them. It answers for either party and returns nothing at all to
--     an account that is neither, so it needs no change to be safe in a one-party model.
--   * `service_request_cancel` — withdrawing their own request. OD-A3 says nothing expires it; the buyer
--     is still the one who can close it.
--   * `service_request_create_admin_only` and 0109's `listing_enquiry_create` — the two ways to reach the
--     office: a free-form brief, and an enquiry about one listing.
--
-- And the office keeps its whole queue: `service_requests_admin_only_queue`,
-- `service_request_admin_only_detail`, `service_request_admin_decline` and
-- `service_request_payment_information` are untouched.
--
-- Nothing here touches payments, payouts, providers, settlement, the ledger or a balance;
-- `finance.settlement_posting_enabled` is neither read nor written.

do $$
declare
  v_closed text[] := array[
    -- The offers path, all seven (0070).
    'offer_create', 'offer_counter', 'offer_accept', 'offer_reject', 'offer_withdraw',
    'offers_for_buyer', 'offers_for_seller',
    -- The quote path, all four (0071): a quote needs a seller to write it.
    'service_quote_create', 'service_quote_withdraw', 'service_quote_reject', 'service_quote_accept',
    -- The seller-routed request path (0071): the writer that names a seller, the seller's own queue, and
    -- the seller's refusal to quote.
    'service_request_create', 'service_requests_for_seller', 'service_request_decline'
  ];
  v_function record;
  v_revoked integer := 0;
begin
  for v_function in
    select p.oid::regprocedure as identity
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app_private'
       and p.proname = any (v_closed)
     order by 1
  loop
    execute format('revoke execute on function %s from app_system', v_function.identity);
    v_revoked := v_revoked + 1;
  end loop;

  -- Fourteen names, one function each. A name that matched nothing would mean this migration had been
  -- written against a function that no longer exists, which is worth failing for rather than ignoring.
  if v_revoked <> array_length(v_closed, 1) then
    raise exception 'OD-A4: expected to revoke % functions, revoked %',
      array_length(v_closed, 1), v_revoked;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------------------------------
-- What this migration asserts about itself
-- ---------------------------------------------------------------------------------------------------
do $$
declare
  v_reachable text;
  v_missing text;
begin
  -- 1. No role at all can reach the closed set. `app_system` has just lost it; PUBLIC, authenticated and
  --    app_worker never held it, and this says so rather than assuming it.
  select string_agg(format('%s/%s', r.rolname, p.proname), ', ' order by p.proname)
    into v_reachable
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   cross join (values ('public'), ('anon'), ('authenticated'), ('app_api'), ('app_system'), ('app_worker'))
          as r(rolname)
   where n.nspname = 'app_private'
     and p.proname in (
       'offer_create', 'offer_counter', 'offer_accept', 'offer_reject', 'offer_withdraw',
       'offers_for_buyer', 'offers_for_seller',
       'service_quote_create', 'service_quote_withdraw', 'service_quote_reject', 'service_quote_accept',
       'service_request_create', 'service_requests_for_seller', 'service_request_decline')
     and has_function_privilege(r.rolname, p.oid, 'execute');
  if v_reachable is not null then
    raise exception 'OD-A4: the closed paths are still reachable: %', v_reachable;
  end if;

  -- 2. The buyer's own way through is intact. A migration that closed one path too many would pass the
  --    assertion above and leave a buyer unable to reach the office at all, which is the failure worth
  --    guarding against here.
  select string_agg(p.proname, ', ' order by p.proname)
    into v_missing
    from (values
      ('service_requests_for_buyer'), ('service_request_detail'), ('service_request_cancel'),
      ('service_request_create_admin_only'), ('listing_enquiry_create'),
      ('service_requests_admin_only_queue'), ('service_request_admin_only_detail'),
      ('service_request_admin_decline'), ('office_receipt_record'), ('office_receipts_for_staff')
    ) as kept(proname)
    join pg_proc p on p.proname = kept.proname
    join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'app_private'
   where not has_function_privilege('app_system', p.oid, 'execute');
  if v_missing is not null then
    raise exception 'OD-A4: the office path lost functions it needs: %', v_missing;
  end if;

  -- 3. Nothing was dropped. The tables, and the functions themselves, are all still here — this
  --    migration is a decision about reach, and an accidental `drop` would be a different change.
  if to_regclass('public.offers') is null
     or to_regclass('public.offer_messages') is null
     or to_regclass('public.service_quotes') is null then
    raise exception 'OD-A4: a table was dropped; this migration only revokes';
  end if;
end;
$$;

select app_private.assert_security_contract();
