-- 0072 — Service request routing mode and staff permissions, D7-08 and D7-10 (Phase 7-I).
--
-- ---------------------------------------------------------------------------------------------------
-- What this migration is, and what it deliberately is not
-- ---------------------------------------------------------------------------------------------------
-- The owner-approved decisions **D7-08** and **D7-10** are the *shared foundation* two request-routing
-- modes are built on. 7-I implements Option 1 only, in 0071; this migration lands the foundation on the
-- existing table so that 7-J can add Option 2 without a second migration against the same base schema.
--
-- **This migration adds no behaviour.** There is no admin-only writer here, no staff reader, no admin
-- surface, no Option 2 flow, and no change to `public.service_quotes`. Every application-visible Option 1
-- path behaves exactly as it did in 0071: the create writer supplies a seller and never mentions
-- `routing_mode`, so every request it writes takes the column's default and is a `seller` row.
--
-- D7-08 — on the existing `public.service_requests`, with no parallel table:
--
--   * `seller_user_id` becomes nullable;
--   * `routing_mode` is added, in the repository's own convention for a closed vocabulary — `text not
--     null default` plus a named `check (col in (...))`, exactly as `status` is declared in 0015 — rather
--     than a PostgreSQL enum type, which this schema uses nowhere;
--   * the two are tied together by one biconditional check, written in the same shape as 0015's own
--     `service_requests_closed_has_time`: `(routing_mode = 'seller') = (seller_user_id is not null)`.
--     That single constraint enforces **both** approved directions at once — seller routing requires a
--     seller, admin-only routing requires the absence of one — and, being a biconditional, it cannot be
--     satisfied by a half-populated row in either direction.
--
-- D7-10 — the permission family `service_requests.request.read` and `service_requests.request.manage`.
--
-- ---------------------------------------------------------------------------------------------------
-- Why the RLS policies below exist, and why they are the minimum
-- ---------------------------------------------------------------------------------------------------
-- 0033's seed test asserts an invariant of this schema: **the set of seeded permission keys equals the set
-- of keys enforced by a live policy** — it reads both out of the catalogue, one from `public.permissions`
-- and one by scanning `pg_policy` for `has_permission('…')`. A key that nothing enforces is a failure, and
-- so is a key enforced by a policy but never seeded. Landing the D7-10 keys therefore *requires* that each
-- one be enforced somewhere, and the place this schema enforces staff access to a table's rows is a policy
-- on that table. So two policies are added, one per key, and they are the whole of what is added.
--
-- They use the existing permission/AAL2 model unchanged: `public.has_permission` already refuses a
-- privileged role outside an `aal2` session, because 0003 wrote `(not r.requires_mfa or public.is_aal2())`
-- into it and every console role carries `requires_mfa`. The write policy states `public.is_aal2()` a
-- second time, which is what 0003 itself does for `users.role.manage` — belt and braces on a write.
--
-- **The three existing policies are untouched**, and that is what keeps Option 1 exactly as it was and
-- makes an admin-only row invisible to sellers *without a line being written for it*:
-- `service_requests_party_read` matches on `seller_user_id = public.current_user_id()`, and for a row whose
-- `seller_user_id` is null that comparison is NULL rather than true — so no seller can see such a row
-- through it, while the buyer still matches on their own side. Absence of a seller is not a weaker
-- predicate; it is an unsatisfiable one.
--
-- ---------------------------------------------------------------------------------------------------
-- The two functions replaced, and why that is not a behaviour change
-- ---------------------------------------------------------------------------------------------------
-- Two of 0071's readers would have read a seller-less row wrongly once one could exist. Both are replaced
-- here with the null-safe form, and for a `seller` row — the only kind 7-I can create — each returns
-- exactly what it returned before:
--
--   * `service_requests_for_buyer` joined `seller_profiles` inline, so a buyer's own admin-only request
--     would have vanished from the buyer's own list. It is a left join now, and `counterparty_name` is
--     already nullable in the contract.
--   * `service_request_detail` derived `is_seller` as `seller_user_id = p_user_id`, which is NULL for a
--     seller-less row, and the contract's `isSeller` is a boolean that is not null. It is null-safe now.
--
-- Nothing else in 0071 needs it: every other writer and reader matches `seller_user_id` against an
-- account, and NULL never matches — which is also why `service_quote_create` refuses a seller-less request
-- on its own, with no line added for it. Quotes gain no support for such a request here, by construction.

-- ---------------------------------------------------------------------------------------------------
-- D7-08 — routing mode on the existing table
-- ---------------------------------------------------------------------------------------------------
alter table public.service_requests alter column seller_user_id drop not null;

alter table public.service_requests
  add column routing_mode text not null default 'seller';

alter table public.service_requests
  add constraint service_requests_routing_mode_allowed
    check (routing_mode in ('seller', 'admin_only'));

-- One biconditional, both approved directions: seller routing => a seller, admin-only routing => none.
alter table public.service_requests
  add constraint service_requests_routing_has_seller
    check ((routing_mode = 'seller') = (seller_user_id is not null));

comment on column public.service_requests.routing_mode is
  'Which party answers this brief (D7-08): ''seller'' for a named storefront, ''admin_only'' for a brief the platform answers. Tied to seller_user_id by service_requests_routing_has_seller. Defaults to ''seller'', which is what every Option 1 request is.';
comment on column public.service_requests.seller_user_id is
  'The storefront the brief was sent to, or null on an ''admin_only'' brief (D7-08). Never null on a ''seller'' brief.';

-- ---------------------------------------------------------------------------------------------------
-- D7-10 — the permission family
-- ---------------------------------------------------------------------------------------------------
-- Descriptions follow the seeded wording of 0033 — "<verb> <subject> in <module>" — in both languages,
-- which `permissions_descriptions_present` requires and 0033's test checks for sameness.
insert into public.permissions (key, module, description_en, description_ar) values
  ('service_requests.request.read', 'service_requests',
   'Read service requests in service requests', 'عرض طلبات الخدمة في طلبات الخدمة'),
  ('service_requests.request.manage', 'service_requests',
   'Manage service requests in service requests', 'إدارة طلبات الخدمة في طلبات الخدمة')
on conflict (key) do nothing;

-- The assignment is not a choice made here: 0033 seeds `admin` and `super_admin` with the whole permission
-- table by cross join, and its test asserts each of them holds `count(*) from public.permissions` rows,
-- that `guest`, `buyer` and `seller` hold nothing at all, and that the moderator's nine and the support
-- agent's five are exactly the keys named one by one. A new key therefore has exactly one assignment
-- consistent with the seeded schema — admin and super_admin, and no other role — and no existing role's
-- set is touched.
insert into public.role_permissions (role_key, permission_key)
select r.key, p.key
  from public.roles r
 cross join public.permissions p
 where r.key in ('admin', 'super_admin')
   and p.key in ('service_requests.request.read', 'service_requests.request.manage')
on conflict (role_key, permission_key) do nothing;

-- ---------------------------------------------------------------------------------------------------
-- Staff access, through the existing permission/AAL2 model
-- ---------------------------------------------------------------------------------------------------
-- One policy per key, which is what makes each key enforced. Neither policy grants a seller or a buyer
-- anything: a `guest`, `buyer` or `seller` role holds no permission at all, so `has_permission` is false
-- for them and these policies contribute nothing to what they can see.
create policy service_requests_staff_read on public.service_requests for select to authenticated
  using (public.has_permission('service_requests.request.read'));

create policy service_requests_staff_manage on public.service_requests for update to authenticated
  using (public.has_permission('service_requests.request.manage') and public.is_aal2())
  with check (public.has_permission('service_requests.request.manage') and public.is_aal2());

-- The `app_system` counterparts, in the shape 0069 established: the connection carries no claims, so the
-- account and the assurance level are parameters, and the permission key is a **literal** inside each
-- function rather than an argument — a function that took the key would be a function that could be asked
-- about any key. Predicates only: neither reads a row, writes one, or names a surface. Nothing in 7-I
-- calls them; they are the foundation 7-J's reader and writer will be gated on.
create or replace function app_private.service_requests_staff_can_read(
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
       and rp.permission_key = 'service_requests.request.read'
       -- 0003's own rule, with the assurance level supplied instead of read from a JWT claim.
       and (not r.requires_mfa or coalesce(p_is_aal2, false))
  );
$$;

comment on function app_private.service_requests_staff_can_read(uuid, boolean) is
  'True when the account holds service_requests.request.read (D7-10) in a session strong enough for the role that grants it. The key is a literal, and the assurance level is a parameter because app_system carries no claims. A predicate: it reads no request and writes nothing.';

create or replace function app_private.service_requests_staff_can_manage(
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
       and rp.permission_key = 'service_requests.request.manage'
       and (not r.requires_mfa or coalesce(p_is_aal2, false))
  );
$$;

comment on function app_private.service_requests_staff_can_manage(uuid, boolean) is
  'True when the account holds service_requests.request.manage (D7-10) in a session strong enough for the role that grants it. A predicate: it reads no request and writes nothing, and no writer in 7-I calls it.';

-- ---------------------------------------------------------------------------------------------------
-- The two 0071 readers, made null-safe
-- ---------------------------------------------------------------------------------------------------
-- Identical output for a `seller` row. Only the seller join and the `is_seller` derivation change.
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
  'One page of the service requests an account has sent, newest first, over 0015''s own service_requests_buyer index. Scoped to buyer_user_id in the statement. `counterparty_name` is the storefront the request went to, and is null when there is none (D7-08); no account identifier is returned.';

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

  -- Scoped in the statement: a request the caller is not a party to is never matched. A seller-less brief
  -- matches its buyer and nobody else, because `null = p_user_id` is NULL rather than true.
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
  'One service request and its quotes, for either party and nobody else — 0015''s two party-read policies for a caller the connection cannot see. is_buyer and is_seller are derived from the account the API established, so a browser cannot claim a side, and is_seller is false rather than unknown on a seller-less brief (D7-08). Returns no account identifier and no seller-private field.';

-- ---------------------------------------------------------------------------------------------------
-- Least privilege
-- ---------------------------------------------------------------------------------------------------
revoke all on function app_private.service_requests_staff_can_read(uuid, boolean) from public;
revoke all on function app_private.service_requests_staff_can_manage(uuid, boolean) from public;
revoke all on function app_private.service_requests_for_buyer(uuid, integer, timestamptz, uuid) from public;
revoke all on function app_private.service_request_detail(uuid, uuid) from public;

grant execute on function app_private.service_requests_staff_can_read(uuid, boolean) to app_system;
grant execute on function app_private.service_requests_staff_can_manage(uuid, boolean) to app_system;
grant execute on function app_private.service_requests_for_buyer(uuid, integer, timestamptz, uuid) to app_system;
grant execute on function app_private.service_request_detail(uuid, uuid) to app_system;

-- ---------------------------------------------------------------------------------------------------
-- The security contract still holds
-- ---------------------------------------------------------------------------------------------------
do $$
begin
  perform app_private.assert_security_contract();
end;
$$;
