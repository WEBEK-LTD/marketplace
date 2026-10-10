-- 0109 — The office settlement model (owner amendment to v5.2, OD-A1 … OD-A9).
--
-- ---------------------------------------------------------------------------------------------------
-- What the owner decided, and what that makes this migration
-- ---------------------------------------------------------------------------------------------------
-- No payment, payout or settlement provider is used at all. Money changes hands at the office, in
-- person, and this system's job is to **record that it did**:
--
--   * OD-A1 — the buyer pays the full amount at the office; the seller takes their share there.
--   * OD-A2 — the admin records it.
--   * OD-A3 — a request never expires and is never auto-cancelled: the subject matter is property and a
--     conversation with a client runs for days or weeks.
--   * OD-A4 — the buyer deals with the admin, never with a seller.
--   * OD-A5 — seller balances and withdrawals are out of V1.
--   * OD-A6 — refunds are the office's business, outside this system.
--   * OD-A7 — commission is computed when the money is paid, by the admin.
--   * OD-A8 — one new permission key, `payments.office_receipt.manage`.
--   * OD-A9 — the V1 catalogue is property.
--
-- So this migration adds exactly two capabilities and nothing else: **a buyer can enquire about a
-- listing**, and **a staff member can record that the office received the money for that enquiry**.
--
-- ---------------------------------------------------------------------------------------------------
-- What it does not do, deliberately
-- ---------------------------------------------------------------------------------------------------
--   * **No provider is named, created, seeded or reached.** `payment_providers` and
--     `payout_providers` stay empty, `finance.settlement_posting_enabled` is neither read nor written,
--     and no function here can reach a payment, payout, settlement, refund or provider row.
--   * **Nothing is posted to the ledger** and no seller balance is touched. OD-A1 has the office hold
--     and hand over cash physically; this records amounts and moves none. `seller_balances`,
--     `withdrawals`, `ledger_journals` and `ledger_entries` are not written, not read and not altered.
--   * **`public.commissions` is not written.** That table is append-only and keyed to an order item at
--     checkout fulfilment (D11, D27) — a checkout that no longer exists in this model. Writing a row
--     there would require inventing an order and a checkout to hang it on. The commission computed at
--     the office is recorded on the receipt itself, with the rule set snapshotted beside it.
--   * **Nothing closed is reopened.** No existing table, column, constraint, trigger, policy, grant or
--     function is altered or dropped. The buyer↔seller offer, quote and seller-routed request paths are
--     still present and still reachable: OD-A4 removes them, but revoking a function while the API still
--     calls it would turn an endpoint into a 500 rather than a removal. That removal is its own
--     increment, which takes out the API routes, the contracts and the pages in the same change.
--   * **No request table is added.** 0072 and 0073 already made `public.service_requests` carry an
--     admin-routed request with no seller, and the rule there was that a second request table would be
--     the wrong answer. That still holds: the enquiry below is an `admin_only` row on that table.
--
-- ---------------------------------------------------------------------------------------------------
-- Why a request never expires, with nothing added to make that true
-- ---------------------------------------------------------------------------------------------------
-- OD-A3 asks for no expiry. Nothing has to be built for it and nothing has to be disabled: 0032's
-- sweeper expires `public.offers` and `public.service_quotes` and **no request**, and 0073 recorded that
-- the `expired` status has no writer anywhere in the repository. The guarantee is the absence of a
-- writer, which is stronger than a flag. The verification block at the end asserts it so that a future
-- sweeper cannot quietly acquire one.

-- ---------------------------------------------------------------------------------------------------
-- 1. OD-A8's permission, and only that one
-- ---------------------------------------------------------------------------------------------------
-- `payments.payment.read` and `finance.commission.read` already exist and are reads. There is no write
-- key anywhere in the payments or finance modules, because until this amendment nothing in the schema
-- wrote one by hand. Recording that money arrived is the most consequential write in the system, so it
-- gets a key of its own rather than borrowing `orders.order.manage`: it can then be granted to the one
-- person who sits at the office desk without also handing them order management.
insert into public.permissions (key, module, description_en, description_ar) values
  ('payments.office_receipt.manage', 'payments',
   'Record money received at the office in payments',
   'تسجيل المبالغ المستلمة في المكتب في المدفوعات')
on conflict (key) do nothing;

-- The assignment 0033 gives every key and 0072/0073 gave the request keys: admin and super_admin, and no
-- other role. The moderator and the support agent are untouched, which is what makes "a moderator cannot
-- record money" true by assignment rather than by a check somewhere.
insert into public.role_permissions (role_key, permission_key)
select r.key, p.key
  from public.roles r
 cross join public.permissions p
 where r.key in ('admin', 'super_admin')
   and p.key = 'payments.office_receipt.manage'
on conflict (role_key, permission_key) do nothing;

-- ---------------------------------------------------------------------------------------------------
-- 2. The staff predicate
-- ---------------------------------------------------------------------------------------------------
-- 0073's shape exactly: the account and the assurance level are parameters because `app_system` carries
-- no claims, and the key is a literal inside the function rather than an argument. A predicate — it
-- reads no receipt and writes nothing.
create or replace function app_private.office_receipt_can_manage(
  p_user_id uuid,
  p_is_aal2 boolean
) returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
      from public.user_roles ur
      join public.roles r on r.key = ur.role_key
      join public.role_permissions rp on rp.role_key = r.key
     where ur.user_id = p_user_id
       and ur.revoked_at is null
       and (ur.expires_at is null or ur.expires_at > now())
       and rp.permission_key = 'payments.office_receipt.manage'
       -- 0003's own rule, with the assurance level supplied instead of read from a JWT claim.
       and (not r.requires_mfa or coalesce(p_is_aal2, false))
  );
$$;

comment on function app_private.office_receipt_can_manage(uuid, boolean) is
  'True when the account holds payments.office_receipt.manage (OD-A8) in a session strong enough for the role that grants it. The key is a literal; the assurance level is a parameter.';

-- ---------------------------------------------------------------------------------------------------
-- 3. The buyer's enquiry about a listing
-- ---------------------------------------------------------------------------------------------------
-- 0073's `service_request_create_admin_only` writes a brief with **no listing**, because Option 2 was a
-- free-form request for a custom service. A property enquiry is the other shape: it is always about one
-- listing, and the listing is what tells the office which seller is owed a share when the money arrives.
-- Hence a second writer rather than a parameter on the first — the same reason 0073 gave for not adding a
-- mode argument to 0071's writer. **The caller chooses nothing about routing**: `'admin_only'` and a null
-- seller are literals here, so no argument can move an enquiry into the seller-routed flow.
--
-- The currency comes from the **listing** and never from a caller, which is also what makes the receipt's
-- currency agree with the listing's by construction rather than by a check.
--
-- No payment method and no payment notes are written. 0073 required a `preferred_payment_method` because
-- a buyer there had to say how they would like to pay; under OD-A1 there is one way and the question is
-- meaningless, so both of 0073's columns stay null — which `service_requests_payment_info_is_admin_only`
-- permits, as it only forbids them on a seller-routed row.
create or replace function app_private.listing_enquiry_create(
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
  v_title text := nullif(btrim(coalesce(p_title, ''), E' \t\r\n'), '');
  v_brief text := nullif(btrim(coalesce(p_brief, ''), E' \t\r\n'), '');
  v_currency char(3);
  v_seller uuid;
  v_request_id uuid;
begin
  if p_buyer_id is null or p_listing_id is null then
    return query select 'not_found'::text, null::uuid, null::text;
    return;
  end if;

  -- Only a publicly visible listing can be enquired about, and `approved`/`active` is what 0011's own
  -- partial indexes and price rule treat as live. A listing in any other state answers `not_found`: the
  -- same answer an absent one gets, so the refusal cannot be used to ask whether a draft exists.
  select l.currency_code, l.seller_user_id
    into v_currency, v_seller
    from public.listings l
   where l.id = p_listing_id
     and l.status in ('approved', 'active');
  if v_currency is null then
    return query select 'not_found'::text, null::uuid, null::text;
    return;
  end if;

  -- 0015's own bounds, answered as an outcome rather than as a constraint violation.
  if v_title is null or length(v_title) < 3 or length(v_title) > 140
     or v_brief is null or length(v_brief) < 10 or length(v_brief) > 10000
     or (p_budget_minor is not null and p_budget_minor <= 0) then
    return query select 'invalid'::text, null::uuid, null::text;
    return;
  end if;

  -- A seller enquiring about their own listing is refused rather than recorded: the office would have one
  -- person on both sides of the receipt. `service_requests_not_self` cannot express this, because the
  -- seller column on an admin-routed row is null by construction.
  if v_seller = p_buyer_id then
    return query select 'invalid'::text, null::uuid, null::text;
    return;
  end if;

  insert into public.service_requests (
    currency_code, listing_id, buyer_user_id, seller_user_id, routing_mode,
    title, brief, budget_minor, needed_by
  ) values (
    v_currency, p_listing_id, p_buyer_id, null, 'admin_only',
    v_title, v_brief, p_budget_minor, p_needed_by
  )
  returning id into v_request_id;

  return query select 'created'::text, v_request_id, 'open'::text;
end;
$$;

comment on function app_private.listing_enquiry_create(uuid, uuid, text, text, bigint, date) is
  'A buyer''s enquiry about one live listing, routed to the office (OD-A4). Writes an admin_only request with no seller; the currency comes from the listing. Never expires: nothing in the repository writes the expired status.';

-- ---------------------------------------------------------------------------------------------------
-- 4. The record itself
-- ---------------------------------------------------------------------------------------------------
-- One row per enquiry whose money arrived. Everything a later reader needs is **snapshotted** here: the
-- amount, the commission, the seller's share and the rule set the commission came from. A commission rule
-- edited next month must not change what the office recorded last month, and the snapshot is what makes
-- that true without the rules being frozen.
--
-- The two composite foreign keys are the reason there is no currency check anywhere below: the receipt's
-- currency has to be a currency the request **and** the listing already carry, so the three can never
-- disagree. 0015 and 0011 both expose `unique (id, currency_code)` for exactly this use.
create table public.office_receipts (
  id uuid primary key default gen_random_uuid(),
  service_request_id uuid not null,
  currency_code char(3) not null references public.currencies (code) on delete restrict,
  listing_id uuid not null,
  seller_user_id uuid not null references public.seller_profiles (user_id) on delete restrict,
  amount_received_minor bigint not null,
  commission_minor bigint not null,
  seller_share_minor bigint not null,
  commission_snapshot jsonb not null default '{}'::jsonb,
  receipt_reference text not null,
  notes text,
  recorded_by uuid not null references auth.users (id) on delete restrict,
  recorded_at timestamptz not null default now(),
  foreign key (service_request_id, currency_code)
    references public.service_requests (id, currency_code) on delete restrict,
  foreign key (listing_id, currency_code)
    references public.listings (id, currency_code) on delete restrict,
  constraint office_receipts_amount_positive check (amount_received_minor > 0),
  constraint office_receipts_commission_not_negative check (commission_minor >= 0),
  constraint office_receipts_commission_within_amount check (commission_minor <= amount_received_minor),
  constraint office_receipts_share_is_the_remainder
    check (seller_share_minor = amount_received_minor - commission_minor),
  constraint office_receipts_snapshot_is_object check (jsonb_typeof(commission_snapshot) = 'object'),
  constraint office_receipts_reference_length
    check (length(btrim(receipt_reference, E' \t\r\n')) between 1 and 64),
  constraint office_receipts_notes_length
    check (notes is null or length(btrim(notes, E' \t\r\n')) between 1 and 2000)
);

comment on table public.office_receipts is
  'Money the office received in person for one enquiry (OD-A1, OD-A2, OD-A7). A record, not a movement: nothing here reaches a provider, the ledger, a balance or a payout. Append-only.';
comment on column public.office_receipts.amount_received_minor is
  'The full amount the buyer handed over, in minor units of currency_code — OD-A1''s "the buyer pays the full amount at the office".';
comment on column public.office_receipts.commission_minor is
  'The platform''s commission, computed from the rules in force at the moment of recording (OD-A7) and never recomputed afterwards.';
comment on column public.office_receipts.seller_share_minor is
  'What the office hands the seller. Stored rather than derived so a reader and a printed receipt cannot disagree, and constrained to the remainder so it cannot drift.';
comment on column public.office_receipts.commission_snapshot is
  'The resolved commission components, their type, rate or amount, and what each contributed. The audit trail for a figure that a later rule change must not alter.';
comment on column public.office_receipts.receipt_reference is
  'The office''s own reference for the paper it issued — whatever the desk writes on the receipt. Free text, deliberately: this system does not own the office''s numbering.';

-- One receipt per enquiry. The money for an enquiry arrives once; a correction is the office's business
-- (OD-A6), not a second row, and this index is what stops a double entry from a retried request.
create unique index office_receipts_one_per_request on public.office_receipts (service_request_id);
create index office_receipts_recorded on public.office_receipts (recorded_at desc, id);
create index office_receipts_seller on public.office_receipts (seller_user_id, recorded_at desc);
create index office_receipts_listing on public.office_receipts (listing_id);

alter table public.office_receipts enable row level security;

-- Append-only, and entered in the contract that 0031 checks in both directions: a table that refuses
-- writes but is missing from the contract is itself a violation, so the trigger and the row below are one
-- change. No column is updatable — a financial record that can be edited is not a record.
create trigger office_receipts_append_only before update or delete on public.office_receipts
  for each row execute function app_private.tg_reject_write();
create trigger office_receipts_audit after insert or update or delete on public.office_receipts
  for each row execute function audit.tg_record_change();

insert into app_private.append_only_contract (table_schema, table_name, updatable_columns, reason) values
  ('public', 'office_receipts', '{}'::text[],
   'money the office received, recorded once: a correction is the office''s business (OD-A6), not an edit')
on conflict do nothing;

-- ---------------------------------------------------------------------------------------------------
-- 5. The writer, and where its commission figure comes from
-- ---------------------------------------------------------------------------------------------------
-- `public.resolve_commission_components` is 0016's own resolver and is used as it stands: every active
-- component matching the platform, the listing's category, the listing's seller or the listing's type, in
-- 0016's own priority order, with a fixed component that has no amount in this currency coming back
-- already marked skipped (D27). Nothing about the rule model is reinterpreted here.
--
-- **The arithmetic is exact.** A percentage is `round(amount * bps / 10000)` in `numeric`, not in a float:
-- money rounded through binary floating point is money that disagrees with the paper receipt. A fixed
-- component is its own amount, clamped to the component's own `min`/`max` when it has them. A skipped
-- component contributes nothing and still appears in the snapshot, so a later reader can see that it was
-- considered. The total is capped at the amount received, because a commission larger than the money in
-- the drawer is not a number the office can act on; the cap is recorded in the snapshot when it bites.
--
-- **The actor is published for the duration of this call**, which is 0084's writer pattern and the reason
-- this function is registered in `app_private.audit_attribution_contract` below. It is the same class of
-- action as `transition_withdrawal`: a human financial decision taken by a named staff member, not a
-- system one. The previous actor is saved first and restored on the way out, by any path.
create or replace function app_private.office_receipt_record(
  p_actor_user_id uuid,
  p_is_aal2 boolean,
  p_request_id uuid,
  p_amount_received_minor bigint,
  p_receipt_reference text,
  p_notes text default null
) returns table (
  outcome text,
  receipt_id uuid,
  commission_minor bigint,
  seller_share_minor bigint
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_reference text := nullif(btrim(coalesce(p_receipt_reference, ''), E' \t\r\n'), '');
  v_notes text := nullif(btrim(coalesce(p_notes, ''), E' \t\r\n'), '');
  v_request public.service_requests;
  v_listing public.listings;
  v_component record;
  v_commission bigint := 0;
  v_part bigint;
  v_components jsonb := '[]'::jsonb;
  v_capped boolean := false;
  v_receipt_id uuid;
  audit_scope_saved uuid;
  v_outcome text;
begin
  -- Authorization first, and a refusal that says nothing. A caller without the key gets `not_found`,
  -- which is the answer an absent request gets, so the refusal cannot be used to discover that an
  -- enquiry exists.
  if p_actor_user_id is null
     or not app_private.office_receipt_can_manage(p_actor_user_id, p_is_aal2) then
    return query select 'not_found'::text, null::uuid, null::bigint, null::bigint;
    return;
  end if;

  if v_reference is null or length(v_reference) > 64
     or (v_notes is not null and length(v_notes) > 2000)
     or p_amount_received_minor is null or p_amount_received_minor <= 0 then
    return query select 'invalid'::text, null::uuid, null::bigint, null::bigint;
    return;
  end if;

  audit_scope_saved := app_private.audit_actor();
  perform app_private.set_audit_actor(p_actor_user_id);
  <<actor_scope>>
  begin
    -- `for update` because the one-receipt-per-request index is the only thing standing between a retried
    -- request and a double entry, and a lock here turns a race into a wait rather than a unique violation.
    select * into v_request
      from public.service_requests
     where id = p_request_id
     for update;

    if v_request.id is null or v_request.routing_mode <> 'admin_only' or v_request.listing_id is null then
      v_outcome := 'not_found'; exit actor_scope;
    end if;
    if v_request.status <> 'open' then
      -- Already closed: accepted by an earlier receipt, cancelled by the buyer, or declined by staff.
      v_outcome := 'not_open'; exit actor_scope;
    end if;

    select * into v_listing from public.listings where id = v_request.listing_id;
    if v_listing.id is null then
      v_outcome := 'not_found'; exit actor_scope;
    end if;

    -- The commission, from 0016's resolver, snapshotted component by component as it is summed.
    for v_component in
      select *
        from public.resolve_commission_components(
          v_request.currency_code, v_listing.category_id, v_listing.seller_user_id,
          v_listing.listing_type_code, current_date)
    loop
      if v_component.is_skipped then
        v_part := 0;
      elsif v_component.component_type = 'percentage' then
        v_part := round(
          (p_amount_received_minor::numeric * coalesce(v_component.percentage_basis_points, 0)) / 10000
        )::bigint;
      else
        v_part := coalesce(v_component.amount_minor, 0);
        if v_component.min_amount_minor is not null and v_part < v_component.min_amount_minor then
          v_part := v_component.min_amount_minor;
        end if;
        if v_component.max_amount_minor is not null and v_part > v_component.max_amount_minor then
          v_part := v_component.max_amount_minor;
        end if;
      end if;

      v_commission := v_commission + v_part;
      v_components := v_components || jsonb_build_object(
        'commission_rule_id', v_component.commission_rule_id,
        'name', v_component.name,
        'scope', v_component.scope,
        'component_type', v_component.component_type,
        'percentage_basis_points', v_component.percentage_basis_points,
        'amount_minor', v_component.amount_minor,
        'is_skipped', v_component.is_skipped,
        'skip_reason', v_component.skip_reason,
        'contributed_minor', v_part
      );
    end loop;

    if v_commission > p_amount_received_minor then
      v_commission := p_amount_received_minor;
      v_capped := true;
    end if;

    insert into public.office_receipts (
      service_request_id, currency_code, listing_id, seller_user_id,
      amount_received_minor, commission_minor, seller_share_minor,
      commission_snapshot, receipt_reference, notes, recorded_by
    ) values (
      v_request.id, v_request.currency_code, v_listing.id, v_listing.seller_user_id,
      p_amount_received_minor, v_commission, p_amount_received_minor - v_commission,
      jsonb_build_object(
        'resolved_on', current_date,
        'capped_at_amount_received', v_capped,
        'components', v_components
      ),
      v_reference, v_notes, p_actor_user_id
    )
    returning id into v_receipt_id;

    -- The enquiry is settled, so it closes. `accepted` is 0015's own status for a request that was
    -- carried out, and `service_requests_closed_has_time` requires the time alongside it. 0073 recorded
    -- that `accepted` was unreachable for an admin-routed row because it needed a quote; under OD-A1 the
    -- office is what carries the request out, so this is the writer that reaches it, and it is the only
    -- one — a quote still cannot be created for a seller-less row.
    update public.service_requests
       set status = 'accepted', closed_at = now()
     where id = v_request.id;

    v_outcome := 'recorded'; exit actor_scope;
  end;
  perform app_private.restore_audit_actor(audit_scope_saved);

  if v_outcome = 'recorded' then
    return query
      select 'recorded'::text, r.id, r.commission_minor, r.seller_share_minor
        from public.office_receipts r where r.id = v_receipt_id;
  else
    return query select v_outcome, null::uuid, null::bigint, null::bigint;
  end if;
end;
$$;

comment on function app_private.office_receipt_record(uuid, boolean, uuid, bigint, text, text) is
  'Records money the office received for one enquiry and closes it (OD-A1, OD-A2, OD-A7). Computes commission from 0016''s resolver and snapshots it. Posts nothing, reaches no provider and touches no balance. Outcomes: recorded, not_open, invalid, not_found.';

insert into app_private.audit_attribution_contract
  (function_schema, function_name, role, actor_parameter, reason) values
  ('app_private', 'office_receipt_record', 'writer', 'p_actor_user_id',
   'a staff member recording money the office received: a human financial action, not a system one')
on conflict do nothing;

-- ---------------------------------------------------------------------------------------------------
-- 6. The console's reader
-- ---------------------------------------------------------------------------------------------------
-- One page of receipts, newest first, behind the same key as the writer. A seek cursor on
-- `(recorded_at, id)` rather than an offset, which is the repository's own paging shape and what
-- `office_receipts_recorded` indexes; 0106's probe-row rule applies, so the caller asks for one more than
-- it will show and the reader returns what it was asked for without inventing a total.
create or replace function app_private.office_receipts_for_staff(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_limit integer default 25,
  p_before_recorded_at timestamptz default null,
  p_before_id uuid default null
) returns table (
  receipt_id uuid,
  recorded_at timestamptz,
  request_id uuid,
  listing_id uuid,
  listing_title text,
  seller_user_id uuid,
  seller_display_name text,
  currency_code char(3),
  amount_received_minor bigint,
  commission_minor bigint,
  seller_share_minor bigint,
  receipt_reference text
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select r.id, r.recorded_at, r.service_request_id, r.listing_id, l.title,
         r.seller_user_id, s.display_name, r.currency_code,
         r.amount_received_minor, r.commission_minor, r.seller_share_minor, r.receipt_reference
    from public.office_receipts r
    join public.listings l on l.id = r.listing_id
    join public.seller_profiles s on s.user_id = r.seller_user_id
   where app_private.office_receipt_can_manage(p_user_id, p_is_aal2)
     and (p_before_recorded_at is null
          or (r.recorded_at, r.id) < (p_before_recorded_at, coalesce(p_before_id, r.id)))
   order by r.recorded_at desc, r.id desc
   limit greatest(coalesce(p_limit, 25), 1);
$$;

comment on function app_private.office_receipts_for_staff(uuid, boolean, integer, timestamptz, uuid) is
  'A page of office receipts for the console, newest first, behind payments.office_receipt.manage. Returns nothing at all to a caller without the key rather than refusing differently.';

-- ---------------------------------------------------------------------------------------------------
-- 7. Privileges
-- ---------------------------------------------------------------------------------------------------
-- No role is granted anything on `public.office_receipts`. The table is reachable only through the three
-- functions above, which is the shape every financial table in this schema already has. PostgreSQL grants
-- EXECUTE on a new function to PUBLIC, so each one is swept and then granted to the one server role that
-- calls it.
revoke execute on function app_private.office_receipt_can_manage(uuid, boolean) from public;
revoke execute on function app_private.listing_enquiry_create(uuid, uuid, text, text, bigint, date) from public;
revoke execute on function app_private.office_receipt_record(uuid, boolean, uuid, bigint, text, text) from public;
revoke execute on function app_private.office_receipts_for_staff(uuid, boolean, integer, timestamptz, uuid) from public;

grant execute on function app_private.office_receipt_can_manage(uuid, boolean) to app_system;
grant execute on function app_private.listing_enquiry_create(uuid, uuid, text, text, bigint, date) to app_system;
grant execute on function app_private.office_receipt_record(uuid, boolean, uuid, bigint, text, text) to app_system;
grant execute on function app_private.office_receipts_for_staff(uuid, boolean, integer, timestamptz, uuid) to app_system;

-- ---------------------------------------------------------------------------------------------------
-- 8. What this migration asserts about itself
-- ---------------------------------------------------------------------------------------------------
do $$
declare
  v_count integer;
begin
  -- OD-A3: no request expires, because nothing writes the status. Asserted rather than described, so a
  -- sweeper that acquires one in future fails here instead of silently closing a property enquiry.
  --
  -- The test is an **UPDATE that sets the status**, not the appearance of the word. The first version of
  -- this check asked for any function naming both `service_requests` and `'expired'` and caught
  -- `service_quote_accept` and `service_quote_reject`, where `'expired'` is the *outcome string* a caller
  -- gets when a quote's window has passed — nothing to do with a request's status. That is the same
  -- false-positive class that has now broken six detectors in this repository: a detector has to read the
  -- statement, not the vocabulary.
  select count(*)::integer into v_count
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'app_private')
     and p.prosrc ~* 'update\s+(public\.)?service_requests[^;]*set[^;]*status\s*=\s*''expired''';
  if v_count > 0 then
    raise exception 'OD-A3: % function(s) can write the expired status to a request', v_count;
  end if;

  -- Nothing here reaches the money machinery. The four new functions are checked by name against the
  -- tables and functions this amendment says they must not touch.
  select count(*)::integer into v_count
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app_private'
     and p.proname in ('office_receipt_record', 'office_receipts_for_staff',
                       'listing_enquiry_create', 'office_receipt_can_manage')
     and (p.prosrc like '%ledger_%' or p.prosrc like '%seller_balances%'
          or p.prosrc like '%withdrawal%' or p.prosrc like '%payout%'
          or p.prosrc like '%payment_provider%' or p.prosrc like '%settlement%'
          or p.prosrc like '%refund%');
  if v_count > 0 then
    raise exception '% new function(s) reach the payment, payout, settlement or ledger machinery', v_count;
  end if;

  -- The receipt is reachable only through functions: no role holds a privilege on the table.
  select count(*)::integer into v_count
    from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'office_receipts'
     and grantee not in ('postgres', current_user);
  if v_count > 0 then
    raise exception 'office_receipts has % table privilege(s) granted', v_count;
  end if;
end;
$$;

select app_private.assert_security_contract();
