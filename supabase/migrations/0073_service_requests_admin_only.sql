-- 0073 — Service requests, Option 2: Admin Only, D7-09 (Phase 7-J).
--
-- ---------------------------------------------------------------------------------------------------
-- What Option 2 is, and what it is not
-- ---------------------------------------------------------------------------------------------------
-- A buyer sends a brief that **no seller answers**. The row lands on the existing table with
-- `routing_mode = 'admin_only'` and `seller_user_id` null — both already possible, because 0072 landed
-- D7-08 — and authorized staff handle it. There is **no quote, no checkout, no order, no payment, no
-- provider call, no transaction, no payout, no ledger entry and no online payment** anywhere in this
-- migration, and no function here can reach any of them.
--
-- The foundation is not rebuilt. `routing_mode`, the nullable seller, the biconditional constraint, the
-- two request permission keys and the staff policies are 0072's and are read, not rewritten. There is no
-- second routing column, no parallel request table, and `public.service_quotes` and
-- `app_private.tg_service_quotes_rule` are untouched.
--
-- ---------------------------------------------------------------------------------------------------
-- The state machine, and the one word that means two things
-- ---------------------------------------------------------------------------------------------------
-- Option 2 uses 0015's existing statuses and adds none. It reaches exactly three:
--
--   * `open` — where the buyer's brief starts, from the column's own default;
--   * `cancelled` — the buyer withdraws it, through 0071's **unchanged** `service_request_cancel`, which is
--     keyed on `buyer_user_id` and therefore already works for a seller-less row;
--   * `declined` — **the approved staff closure**, `open → declined`, by a caller holding
--     `service_requests.request.manage` in an aal2 session, setting `closed_at` as
--     `service_requests_closed_has_time` requires.
--
-- `quoted` and `accepted` are unreachable for an admin-only request and are written nowhere here: both
-- require a quote, and a quote requires a seller to match. `expired` has no writer anywhere in the
-- repository and gains none.
--
-- **`declined` carries two meanings, deliberately, and they never overlap.**
--
--   * On a **seller-routed** request it means *the seller declines to quote*. Written only by 0071's
--     `service_request_decline`, which matches `seller_user_id = p_seller_id` — NULL never matches, so that
--     function cannot touch an admin-only row.
--   * On an **admin-only** request it means *authorized staff closed it without fulfilment*. Written only
--     by `service_request_admin_decline` below, which requires `routing_mode = 'admin_only'` — so that
--     function cannot touch a seller-routed row either.
--
-- The two writers are disjoint by their own predicates, not by convention. Neither can produce the other's
-- meaning, which is what keeps one status value honest in two flows.
--
-- **Audit.** The existing behaviour on a row update of this table is 0015's `tg_set_updated_at`, and that is
-- what the staff closure reuses. `public.service_requests` carries no `audit.tg_record_change` trigger —
-- unlike `seller_verifications`, which does — and none is added here: a second audit path is exactly what
-- this migration was told not to invent. No security event and no outbox event is written by the closure.
-- **This is a known and accepted gap**: a staff closure is recorded as a status, a `closed_at` and an
-- `updated_at`, and not as an actor. Recording the actor needs a column or an audit trigger, and both are
-- decisions this migration does not own.
--
-- ---------------------------------------------------------------------------------------------------
-- Payment information: two descriptive fields, and why they are not NOT NULL
-- ---------------------------------------------------------------------------------------------------
-- `preferred_payment_method` is **required of the writer** and bounded at 120 characters; `payment_notes`
-- is optional and bounded at 2000. Both are free text. There is no enum, no wallet or card vocabulary, and
-- nothing here collects or could store a card number, a CVV, bank credentials, a password, a provider
-- secret or an OTP — the columns are two bounded strings a buyer types to describe how they would like to
-- pay, and no function in this migration sends either value anywhere.
--
-- Neither column is `not null`, and neither is required by a table constraint, because **the approved
-- retention behaviour clears both** ninety days after a request closes. A constraint requiring the method
-- on every admin-only row would make the purge fail against the very rows it exists to clean. "Required"
-- therefore lives where it can be true: in the create writer, which refuses a brief without one, and in the
-- contract above it. The table enforces what stays true forever — the lengths, and that only an admin-only
-- row may carry payment information at all.
--
-- That last constraint is not decoration. A seller can read their own request rows through 0015's
-- `service_requests_party_read`; making it impossible for a seller-routed row to hold payment information
-- means there is no row a seller could read it from, whatever a future writer does.

-- ---------------------------------------------------------------------------------------------------
-- The two columns
-- ---------------------------------------------------------------------------------------------------
alter table public.service_requests add column preferred_payment_method text;
alter table public.service_requests add column payment_notes text;

alter table public.service_requests
  add constraint service_requests_payment_method_length
    check (preferred_payment_method is null
           or length(btrim(preferred_payment_method)) between 1 and 120);

alter table public.service_requests
  add constraint service_requests_payment_notes_length
    check (payment_notes is null or length(btrim(payment_notes)) between 1 and 2000);

-- Payment information belongs to Option 2 alone. A seller-routed row cannot hold it, so a seller reading
-- their own rows has nothing to read.
alter table public.service_requests
  add constraint service_requests_payment_info_is_admin_only
    check (routing_mode = 'admin_only'
           or (preferred_payment_method is null and payment_notes is null));

comment on column public.service_requests.preferred_payment_method is
  'How the buyer would prefer to pay, in their own words (D7-09). Descriptive only: free text, at most 120 characters, no vocabulary and no provider meaning. Required by the admin-only writer rather than by a constraint, because the approved retention job clears it ninety days after closure. Never sent anywhere.';
comment on column public.service_requests.payment_notes is
  'Anything else the buyer wants to say about paying (D7-09). Optional, at most 2000 characters, descriptive only, cleared by the retention job. Never sent anywhere.';

-- The queue index: oldest first, over Option 2 rows and nothing else.
create index service_requests_admin_queue on public.service_requests (created_at, id)
  where routing_mode = 'admin_only';
comment on index public.service_requests_admin_queue is
  'The Admin Only queue reader''s order — created_at asc, id asc — over the admin-only rows alone. Partial, because a seller-routed request is never in this queue.';

-- ---------------------------------------------------------------------------------------------------
-- D7-09's permission
-- ---------------------------------------------------------------------------------------------------
-- One key, and only a read. There is deliberately no `service_requests.payment_info.manage`: nothing in
-- this migration or above it edits either field, and a key that nothing enforces would be a promise.
insert into public.permissions (key, module, description_en, description_ar) values
  ('service_requests.payment_info.read', 'service_requests',
   'Read service request payment information in service requests',
   'عرض معلومات الدفع لطلبات الخدمة في طلبات الخدمة')
on conflict (key) do nothing;

-- The same assignment 0033 gives every key, and the same one 0072 gave the two request keys: admin and
-- super_admin, and no other role. The moderator's nine and the support agent's five are untouched, which is
-- what makes "moderator and support agent cannot read payment information" true by assignment rather than
-- by a check somewhere.
insert into public.role_permissions (role_key, permission_key)
select r.key, p.key
  from public.roles r
 cross join public.permissions p
 where r.key in ('admin', 'super_admin')
   and p.key = 'service_requests.payment_info.read'
on conflict (role_key, permission_key) do nothing;

-- ---------------------------------------------------------------------------------------------------
-- The staff predicate for the payment fields
-- ---------------------------------------------------------------------------------------------------
-- 0072's shape: the account and the assurance level are parameters because `app_system` carries no claims,
-- and the key is a literal inside the function rather than an argument.
--
-- **This key is enforced by a function and not by a policy, and that is the correct shape for it.** The
-- thing it governs is two *columns*, and a row policy cannot express a column. Rather than write a broad
-- row policy that would grant more than the key means, the fields live behind the dedicated reader below
-- and this predicate guards it. 0033's seeded-permission invariant recognises both mechanisms.
create or replace function app_private.service_requests_payment_info_can_read(
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
       and rp.permission_key = 'service_requests.payment_info.read'
       -- 0003's own rule, with the assurance level supplied instead of read from a JWT claim.
       and (not r.requires_mfa or coalesce(p_is_aal2, false))
  );
$$;

comment on function app_private.service_requests_payment_info_can_read(uuid, boolean) is
  'True when the account holds service_requests.payment_info.read (D7-09) in a session strong enough for the role that grants it. The key is a literal; the assurance level is a parameter. A predicate: it reads no request and writes nothing.';

-- ---------------------------------------------------------------------------------------------------
-- The buyer's Option 2 writer
-- ---------------------------------------------------------------------------------------------------
-- Separate from 0071's `service_request_create` rather than a mode parameter on it, for the same reason the
-- two list readers are separate functions: every predicate is fixed in the statement, so there is no
-- argument a caller could supply that would move a request between the two flows. **The caller does not
-- choose the routing mode** — this function writes `'admin_only'` as a literal and `seller_user_id` as
-- NULL, and 0071's writer writes a seller and leaves the mode to its `'seller'` default. Neither can
-- produce the other's row.
--
-- There is no listing and no seller, so the currency cannot come from a listing row. It comes from the
-- existing authoritative default — `public.currencies.is_default`, which `currencies_one_default` makes
-- unique — and never from a caller. A platform with no default currency is an outcome, not a guess.
--
-- **No quote is created and none is invoked.** No notification is created: the repository defines exactly
-- one notification writer, for conversation messages, and there is no service-request event type, template
-- key or writer to call. The absence is structural — there is no call site — rather than a suppression flag.
create or replace function app_private.service_request_create_admin_only(
  p_buyer_id uuid,
  p_title text,
  p_brief text,
  p_preferred_payment_method text,
  p_payment_notes text default null,
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
  v_currency char(3);
  v_title text := nullif(btrim(coalesce(p_title, '')), '');
  v_brief text := nullif(btrim(coalesce(p_brief, '')), '');
  v_method text := nullif(btrim(coalesce(p_preferred_payment_method, '')), '');
  v_notes text := nullif(btrim(coalesce(p_payment_notes, '')), '');
  v_request_id uuid;
begin
  if p_buyer_id is null then
    return query select 'not_found'::text, null::uuid, null::text;
    return;
  end if;

  -- 0015's own length and budget rules, plus D7-09's two bounds, answered as an outcome rather than as a
  -- constraint violation. The payment method is required here because the table cannot require it: the
  -- retention job clears it.
  if v_title is null or length(v_title) < 3 or length(v_title) > 140
     or v_brief is null or length(v_brief) < 10 or length(v_brief) > 10000
     or v_method is null or length(v_method) > 120
     or (v_notes is not null and length(v_notes) > 2000)
     or (p_budget_minor is not null and p_budget_minor <= 0) then
    return query select 'invalid'::text, null::uuid, null::text;
    return;
  end if;

  -- The existing authoritative default. Never a parameter, never a literal.
  select c.code into v_currency from public.currencies c where c.is_default;
  if v_currency is null then
    return query select 'no_currency'::text, null::uuid, null::text;
    return;
  end if;

  insert into public.service_requests (
    currency_code, listing_id, buyer_user_id, seller_user_id, routing_mode,
    title, brief, budget_minor, needed_by, preferred_payment_method, payment_notes
  )
  values (
    v_currency, null, p_buyer_id, null, 'admin_only',
    v_title, v_brief, p_budget_minor, p_needed_by, v_method, v_notes
  )
  returning id into v_request_id;

  return query select 'created'::text, v_request_id, 'open'::text;
end;
$$;

comment on function app_private.service_request_create_admin_only(uuid, text, text, text, text, bigint, date) is
  'Sends one Admin Only service request for a buyer (D7-09). Writes routing_mode = admin_only and seller_user_id = null as literals, so a caller cannot choose the flow; takes the currency from the existing default currency and never from a parameter; requires a preferred payment method because the table cannot. Creates no quote, invokes no quote path, and writes no notification.';

-- ---------------------------------------------------------------------------------------------------
-- The staff queue
-- ---------------------------------------------------------------------------------------------------
-- 0069's shape: an unauthorized caller gets **zero rows**, not an exception. That is the second wall, not the
-- answer a browser sees — the API refuses such a caller with its own neutral not-found before reaching here —
-- and it matters because a function that raised would turn a permission question into a distinguishable
-- failure if anything ever called it directly. Ordered oldest first over the partial index, clamped in the
-- statement.
--
-- **No payment column is selected here.** Not nulled, not masked — absent. A queue does not need them, and
-- a column a function does not select cannot be returned by a mistake above it.
create or replace function app_private.service_requests_admin_only_queue(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_status text default null,
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
  buyer_name text,
  has_payment_notes boolean,
  closed_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz
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
         p.display_name,
         -- Whether there is more to read, without reading it. A boolean is not payment information.
         r.payment_notes is not null,
         r.closed_at,
         r.created_at,
         r.updated_at
    from public.service_requests r
    join public.currencies c on c.code = r.currency_code
    left join public.profiles p on p.id = r.buyer_user_id
   where r.routing_mode = 'admin_only'
     and app_private.service_requests_staff_can_read(p_user_id, p_is_aal2)
     and (p_status is null or r.status = p_status)
     and (
       p_cursor_created_at is null
       or p_cursor_id is null
       or (r.created_at, r.id) > (p_cursor_created_at, p_cursor_id)
     )
   order by r.created_at, r.id
   limit least(greatest(coalesce(p_limit, 20), 1), 51);
$$;

comment on function app_private.service_requests_admin_only_queue(uuid, boolean, text, integer, timestamptz, uuid) is
  'One page of the Admin Only request queue, oldest first, over service_requests_admin_queue. Requires service_requests.request.read in a strong enough session; an unauthorized caller gets zero rows rather than an error. Selects neither payment column: has_payment_notes says only whether there is one.';

-- ---------------------------------------------------------------------------------------------------
-- The staff detail
-- ---------------------------------------------------------------------------------------------------
-- Again no payment column, and again zero rows rather than an exception for a caller without the key: a
-- request that is not theirs to see and one that does not exist answer identically.
create or replace function app_private.service_request_admin_only_detail(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_request_id uuid
) returns table (
  outcome text,
  id uuid,
  status text,
  title text,
  brief text,
  budget_minor bigint,
  currency_code text,
  currency_minor_unit smallint,
  needed_by date,
  buyer_name text,
  has_payment_notes boolean,
  closed_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_row public.service_requests;
  v_minor smallint;
  v_buyer text;
begin
  if p_user_id is null or p_request_id is null
     or not app_private.service_requests_staff_can_read(p_user_id, p_is_aal2) then
    return query select 'not_found'::text, null::uuid, null::text, null::text, null::text, null::bigint,
      null::text, null::smallint, null::date, null::text, null::boolean, null::timestamptz,
      null::timestamptz, null::timestamptz;
    return;
  end if;

  -- Admin-only rows and nothing else: this reader cannot be pointed at a seller-routed request.
  select * into v_row
    from public.service_requests r
   where r.id = p_request_id and r.routing_mode = 'admin_only';

  if v_row.id is null then
    return query select 'not_found'::text, null::uuid, null::text, null::text, null::text, null::bigint,
      null::text, null::smallint, null::date, null::text, null::boolean, null::timestamptz,
      null::timestamptz, null::timestamptz;
    return;
  end if;

  select c.decimal_places into v_minor from public.currencies c where c.code = v_row.currency_code;
  select p.display_name into v_buyer from public.profiles p where p.id = v_row.buyer_user_id;

  return query select
    'found'::text,
    v_row.id,
    v_row.status,
    v_row.title,
    v_row.brief,
    v_row.budget_minor,
    v_row.currency_code::text,
    v_minor,
    v_row.needed_by,
    v_buyer,
    v_row.payment_notes is not null,
    v_row.closed_at,
    v_row.created_at,
    v_row.updated_at;
end;
$$;

comment on function app_private.service_request_admin_only_detail(uuid, boolean, uuid) is
  'One Admin Only request for staff holding service_requests.request.read in a strong enough session. Matches admin-only rows only, so it cannot read a seller-routed request. Returns neither payment column; has_payment_notes says only whether there is one.';

-- ---------------------------------------------------------------------------------------------------
-- The payment information, behind its own key
-- ---------------------------------------------------------------------------------------------------
-- A separate function, not a flag on the detail: the two columns are selected in exactly one place in the
-- database, and that place requires `service_requests.payment_info.read`. A caller holding only
-- `service_requests.request.read` never reaches a statement that mentions them.
create or replace function app_private.service_request_payment_information(
  p_user_id uuid,
  p_is_aal2 boolean,
  p_request_id uuid
) returns table (
  outcome text,
  preferred_payment_method text,
  payment_notes text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_row public.service_requests;
begin
  if p_user_id is null or p_request_id is null
     or not app_private.service_requests_payment_info_can_read(p_user_id, p_is_aal2) then
    return query select 'not_found'::text, null::text, null::text;
    return;
  end if;

  select * into v_row
    from public.service_requests r
   where r.id = p_request_id and r.routing_mode = 'admin_only';

  if v_row.id is null then
    return query select 'not_found'::text, null::text, null::text;
    return;
  end if;

  return query select 'found'::text, v_row.preferred_payment_method, v_row.payment_notes;
end;
$$;

comment on function app_private.service_request_payment_information(uuid, boolean, uuid) is
  'The two descriptive payment fields of one Admin Only request, for a caller holding service_requests.payment_info.read (D7-09) in a strong enough session. The only statement in the database that selects either column outside the retention job. A caller without the key, or a seller-routed request, is a neutral not-found. After the retention job has run, both fields are null and the request is unaffected.';

-- ---------------------------------------------------------------------------------------------------
-- The approved staff closure: open → declined
-- ---------------------------------------------------------------------------------------------------
-- Requires `service_requests.request.manage` in an aal2 session, and `routing_mode = 'admin_only'` — so it
-- cannot close a seller-routed request, which keeps `declined` honest in both flows. The row is locked
-- before it is read, and the update repeats the status predicate, so two staff pressing at the same moment
-- produce one closure and one `conflict`.
--
-- It writes a status and a `closed_at` and nothing else: no payment deadline, no accepted terms, no quote,
-- no order, no outbox event and no notification. `updated_at` moves because 0015's trigger moves it, which
-- is the existing audit behaviour for this table and the only one reused.
create or replace function app_private.service_request_admin_decline(
  p_user_id uuid,
  p_is_aal2 boolean,
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
  if p_user_id is null or p_request_id is null then
    return query select 'not_found'::text, null::text;
    return;
  end if;
  -- The manage key, not the read key, and not a role name.
  if not app_private.service_requests_staff_can_manage(p_user_id, p_is_aal2) then
    return query select 'not_found'::text, null::text;
    return;
  end if;

  select * into v_row
    from public.service_requests r
   where r.id = p_request_id and r.routing_mode = 'admin_only'
     for update;

  if v_row.id is null then
    return query select 'not_found'::text, null::text;
    return;
  end if;
  -- `open` is the only state an Admin Only request can be closed from by staff: a request the buyer has
  -- already cancelled, or one already declined, is finished.
  if v_row.status <> 'open' then
    return query select 'conflict'::text, v_row.status;
    return;
  end if;

  update public.service_requests r
     set status = 'declined', closed_at = v_now
   where r.id = v_row.id and r.status = 'open' and r.routing_mode = 'admin_only';

  if not found then
    select r.status into v_status from public.service_requests r where r.id = v_row.id;
    return query select 'conflict'::text, v_status;
    return;
  end if;

  return query select 'declined'::text, 'declined'::text;
end;
$$;

comment on function app_private.service_request_admin_decline(uuid, boolean, uuid) is
  'The approved staff closure of an Admin Only request: open → declined, with closed_at. Requires service_requests.request.manage in a strong enough session and matches admin-only rows only, so it cannot decline a seller-routed request — on which `declined` means the seller declined, which is 0071''s writer''s meaning and not this one. Writes no quote, no payment deadline, no obligation, no event and no notification.';

-- ---------------------------------------------------------------------------------------------------
-- Retention: clear the payment information ninety days after closure
-- ---------------------------------------------------------------------------------------------------
-- The established sweep shape of 0032: select what is due, bounded by `p_limit`, transition it, publish one
-- count-only outbox event, return how many moved. A second run finds nothing and returns zero.
--
-- **Terminal rows only**, which the schema itself defines: `service_requests_closed_has_time` makes
-- `closed_at is not null` exactly equivalent to a status in `accepted`, `declined`, `cancelled`, `expired`.
-- The predicate is written on `closed_at` because that is the column the ninety days are measured from, and
-- a row with a `closed_at` is a terminal row by that constraint.
--
-- It clears the two payment columns and **touches nothing else**: no status, no `closed_at`, no other table.
-- It is not a retention framework and knows about nothing but these two fields.
create or replace function app_private.purge_due_payment_information(p_limit integer default 500)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  cleared integer;
begin
  with due as (
    select r.id
      from public.service_requests r
     where r.closed_at is not null
       and r.closed_at <= now() - interval '90 days'
       -- Already-cleared rows are not due again: this is what makes a second run return zero.
       and (r.preferred_payment_method is not null or r.payment_notes is not null)
     order by r.closed_at, r.id
     limit greatest(coalesce(p_limit, 500), 0)
  )
  update public.service_requests r
     set preferred_payment_method = null,
         payment_notes = null
    from due
   where r.id = due.id;
  get diagnostics cleared = row_count;

  if cleared > 0 then
    -- A count and nothing else: no request identifier and no payment value leaves this function.
    perform public.enqueue_outbox_event('service_request', 'batch',
      'service_request.payment_information_purged', jsonb_build_object('count', cleared));
  end if;
  return cleared;
end;
$$;

comment on function app_private.purge_due_payment_information(integer) is
  'Clears preferred_payment_method and payment_notes on requests that closed more than ninety days ago (D7-09 retention), a bounded batch at a time, oldest closure first. Leaves every other column and every other table untouched. Idempotent: a cleared row is no longer due, so a second run clears nothing. Publishes one count-only event carrying no identifier and no value.';

-- The contract row, and the dispatcher branch it is reached through. A cron command is never business
-- logic: it is `select app_private.run_scheduled_job('<key>')` and nothing else.
insert into app_private.scheduled_job_contract (job_key, cron_schedule, target_signature, purpose) values
  ('service_requests.payment_info_purge', '5 4 * * *',
   'app_private.purge_due_payment_information(500)',
   'D7-09: clears the two descriptive payment fields ninety days after a service request closed')
on conflict (job_key) do nothing;

create or replace function app_private.run_scheduled_job(p_job_key text) returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  run_id uuid;
  processed integer;
begin
  if not exists (select 1 from app_private.scheduled_job_contract k where k.job_key = p_job_key) then
    raise exception '% is not a scheduled job', p_job_key using errcode = 'invalid_parameter_value';
  end if;

  run_id := app_private.start_job_run(p_job_key);
  if run_id is null then
    return 0;
  end if;

  begin
    processed := case p_job_key
      when 'promotions.start'        then app_private.start_due_promotions(500)
      when 'promotions.expire'       then app_private.expire_due_promotions(500)
      when 'reservations.release'    then app_private.release_expired_reservations(500)
      when 'payment_attempts.expire' then app_private.expire_due_payment_attempts(200)
      when 'offers.expire'           then app_private.expire_due_offers(500)
      when 'service_quotes.expire'   then app_private.expire_due_service_quotes(500)
      when 'cms.publish_due'         then app_private.publish_due_content()
      when 'service_orders.complete' then app_private.complete_due_service_orders(200)
      when 'seller_balances.release' then app_private.release_seller_holds(500)
      when 'promotions.rollup'       then app_private.rollup_promotion_analytics(null)
      when 'partitions.ensure'       then app_private.ensure_event_partitions(3)
      when 'security.assert_contract' then app_private.assert_security_contract()
      -- 7-J, D7-09.
      when 'service_requests.payment_info_purge'
        then app_private.purge_due_payment_information(500)
    end;
  exception when others then
    -- pg_cron gives each command its own transaction, so re-raising would roll back the very row that
    -- records the failure. The durable record is the job_runs row; the schedule carries on.
    --
    -- `error_type` is prefixed because 0007 constrains it to `^[A-Za-z][A-Za-z0-9_]*$` and a SQLSTATE
    -- such as `22023` starts with a digit: writing the bare code makes the failure record itself fail,
    -- which would lose the very thing it is meant to keep. The unprefixed code is in `details`.
    perform app_private.finish_job_run(run_id, 'failed', null, format('sqlstate_%s', sqlstate),
      jsonb_build_object('job_key', p_job_key, 'sqlstate', sqlstate, 'message', left(sqlerrm, 500)));
    return -1;
  end;

  perform app_private.finish_job_run(run_id, 'succeeded', processed,
    null, jsonb_build_object('job_key', p_job_key));
  return coalesce(processed, 0);
end;
$$;
comment on function app_private.run_scheduled_job(text) is
  'The one entry point every cron command uses. Records the run in job_runs, and records a failure rather than losing it.';

-- Scheduled the way 0032 schedules: `cron.schedule` upserts on the name, anything the contract no longer
-- names is unscheduled first, and the command is the dispatcher call and nothing else.
do $$
declare
  stale text;
  entry app_private.scheduled_job_contract%rowtype;
begin
  for stale in
    select j.jobname from cron.job j
     where j.jobname like 'marketplace.%'
       and not exists (select 1 from app_private.scheduled_job_contract k
                        where 'marketplace.' || k.job_key = j.jobname)
  loop
    perform cron.unschedule(stale);
  end loop;

  for entry in select * from app_private.scheduled_job_contract order by job_key loop
    perform cron.schedule(
      'marketplace.' || entry.job_key,
      entry.cron_schedule,
      format('select app_private.run_scheduled_job(%L)', entry.job_key)
    );
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------------------------------
-- The buyer's own readers learn which flow a brief is in
-- ---------------------------------------------------------------------------------------------------
-- A buyer can now hold briefs of both kinds, and a surface that could not tell them apart would say "no
-- quote yet, the seller will answer" about one no seller ever sees. So the three readers a buyer's own pages
-- use return `routing_mode`. **Nothing else about them changes**: same predicates, same order, same joins,
-- same values for a seller-routed row, which is what keeps Option 1 identical.
--
-- `drop` then `create` rather than `create or replace`, because PostgreSQL will not widen a function's result
-- type in place. The grants are reissued at the end of this migration, as they are for everything here.
--
-- The seller's inbox reader takes the column too, even though an admin-only row can never appear in it: the
-- API maps both lists through one mapper, and a mapper that filled the field in for one of them would be
-- asserting something rather than reading it.
drop function if exists app_private.service_requests_for_buyer(uuid, integer, timestamptz, uuid);
drop function if exists app_private.service_requests_for_seller(uuid, integer, timestamptz, uuid);
drop function if exists app_private.service_request_detail(uuid, uuid);

create function app_private.service_requests_for_buyer(
  p_user_id uuid,
  p_limit integer default 20,
  p_cursor_created_at timestamptz default null,
  p_cursor_id uuid default null
) returns table (
  id uuid,
  status text,
  routing_mode text,
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
         r.routing_mode,
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
    -- Left, since D7-08: a brief the buyer sent is theirs to see whether or not a storefront answers it.
    left join public.seller_profiles s on s.user_id = r.seller_user_id
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
  'One page of the service requests an account has sent, of either routing mode, newest first, over 0015''s own service_requests_buyer index. Scoped to buyer_user_id in the statement. `counterparty_name` is the storefront the request went to, and is null when there is none (D7-08). Returns no account identifier and neither payment field.';

create function app_private.service_requests_for_seller(
  p_user_id uuid,
  p_limit integer default 20,
  p_cursor_created_at timestamptz default null,
  p_cursor_id uuid default null
) returns table (
  id uuid,
  status text,
  routing_mode text,
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
         r.routing_mode,
         r.title,
         r.budget_minor,
         r.currency_code::text,
         c.decimal_places,
         r.needed_by,
         l.slug,
         l.title,
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
  'One page of the service requests sent to an account''s storefront, newest first, over 0015''s own service_requests_seller_queue. Scoped to seller_user_id in the statement, which an admin-only request can never match because its seller is null — so Option 2 has no seller inbox entry, by the predicate rather than by a filter. `counterparty_name` is the buyer''s display name.';

create function app_private.service_request_detail(
  p_user_id uuid,
  p_request_id uuid
) returns table (
  outcome text,
  id uuid,
  status text,
  routing_mode text,
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
    return query select 'not_found'::text, null::uuid, null::text, null::text, null::boolean, null::boolean,
      null::text, null::text, null::bigint, null::text, null::smallint, null::date, null::text,
      null::text, null::text, null::text, null::text, null::timestamptz, null::timestamptz, null::jsonb;
    return;
  end if;

  -- Scoped in the statement: a request the caller is not a party to is never matched. A seller-less brief
  -- matches its buyer and nobody else, because `null = p_user_id` is NULL rather than true.
  select * into v_row
    from public.service_requests r
   where r.id = p_request_id
     and (r.buyer_user_id = p_user_id or r.seller_user_id = p_user_id);

  if v_row.id is null then
    return query select 'not_found'::text, null::uuid, null::text, null::text, null::boolean, null::boolean,
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
    v_row.routing_mode,
    v_row.buyer_user_id = p_user_id,
    -- Null-safe since D7-08: the contract's `isSeller` is a boolean that is not null, and a seller-less
    -- brief has nobody on that side rather than an unknown somebody.
    v_row.seller_user_id is not null and v_row.seller_user_id = p_user_id,
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
  'One service request and its quotes, for either party and nobody else — 0015''s two party-read policies for a caller the connection cannot see. is_buyer and is_seller are derived from the account the API established, so a browser cannot claim a side, and is_seller is false rather than unknown on a seller-less brief (D7-08). Returns routing_mode so a surface can tell the truth about which flow the brief is in, and returns no account identifier and neither payment field — the buyer''s own payment information is not read back to them here, and no reader outside service_request_payment_information selects it.';

-- ---------------------------------------------------------------------------------------------------
-- Least privilege
-- ---------------------------------------------------------------------------------------------------
revoke all on function app_private.service_requests_payment_info_can_read(uuid, boolean) from public;
revoke all on function app_private.service_request_create_admin_only(uuid, text, text, text, text, bigint, date) from public;
revoke all on function app_private.service_requests_admin_only_queue(uuid, boolean, text, integer, timestamptz, uuid) from public;
revoke all on function app_private.service_request_admin_only_detail(uuid, boolean, uuid) from public;
revoke all on function app_private.service_request_payment_information(uuid, boolean, uuid) from public;
revoke all on function app_private.service_request_admin_decline(uuid, boolean, uuid) from public;
revoke all on function app_private.purge_due_payment_information(integer) from public;
revoke all on function app_private.service_requests_for_buyer(uuid, integer, timestamptz, uuid) from public;
revoke all on function app_private.service_requests_for_seller(uuid, integer, timestamptz, uuid) from public;
revoke all on function app_private.service_request_detail(uuid, uuid) from public;

grant execute on function app_private.service_requests_payment_info_can_read(uuid, boolean) to app_system;
grant execute on function app_private.service_request_create_admin_only(uuid, text, text, text, text, bigint, date) to app_system;
grant execute on function app_private.service_requests_admin_only_queue(uuid, boolean, text, integer, timestamptz, uuid) to app_system;
grant execute on function app_private.service_request_admin_only_detail(uuid, boolean, uuid) to app_system;
grant execute on function app_private.service_request_payment_information(uuid, boolean, uuid) to app_system;
grant execute on function app_private.service_request_admin_decline(uuid, boolean, uuid) to app_system;
grant execute on function app_private.service_requests_for_buyer(uuid, integer, timestamptz, uuid) to app_system;
grant execute on function app_private.service_requests_for_seller(uuid, integer, timestamptz, uuid) to app_system;
grant execute on function app_private.service_request_detail(uuid, uuid) to app_system;
-- The purge is the scheduler's, not the API's: it is reached through `run_scheduled_job` and nothing above
-- the database calls it.

-- ---------------------------------------------------------------------------------------------------
-- The security contract still holds
-- ---------------------------------------------------------------------------------------------------
do $$
begin
  perform app_private.assert_security_contract();
end;
$$;
