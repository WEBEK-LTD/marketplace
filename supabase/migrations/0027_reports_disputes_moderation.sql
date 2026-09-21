-- 0027 — Reports, order disputes and moderation (v5.2 Moderation and Disputes modules; D26, C10).
--
-- Three things that look similar and are deliberately kept apart:
--
--   * A **report** is what a user says about content or about somebody. It is a request for a look, not
--     a decision, and it is the only one of the three a buyer or seller can create directly.
--   * A **moderation action** is what a moderator decided, about any subject. It is append-only, always
--     carries its reason and its moderator, and a reinstatement points at the action it reverses rather
--     than editing it. `listing_moderation_actions` is the listing-shaped twin, with a real foreign key
--     and the status move recorded, because a listing's status is the thing moderation actually changes.
--   * A **dispute** is between the buyer and the seller of one order, about that order. It is not a
--     chargeback: `payment_disputes` in 0019 is what a provider raises, and D26's funds freeze hangs off
--     that one. The two never share a table, and a dispute here never claims to have frozen money.
--
-- Reports and moderation actions name their subject polymorphically, because a report may be about a
-- listing, a review, a message or a person, and a single nullable column per kind would be six columns
-- that can disagree. There is therefore no foreign key on `subject_id`; the allowed `subject_type` list
-- is the constraint, and `listing_moderation_actions` is where a real key exists because that is the
-- subject moderation acts on mechanically.
--
-- A dispute hangs off the seller order by the same composite keys a review uses (0026 added them), so it
-- cannot name a buyer who did not place the order or a seller who did not sell it. Opening one moves the
-- order to `disputed` and snapshots the status it came from, so resolving it puts the order back where
-- it was rather than guessing. One open dispute per order, by partial unique index.
--
-- Funds follow from that without anything new: 0021's `release_seller_holds()` only releases `completed`
-- orders, and a disputed order is not completed, so a marketplace dispute holds the seller's earnings in
-- `pending` for exactly as long as it is open. Nothing here posts to the ledger.
--
-- Nobody rules on a case they are party to — not a report about themselves, not a listing they sell, not
-- a dispute they opened — and every decision carries its reason. Both are refusals at the database
-- level, not conventions.

-- ---------------------------------------------------------------------------------------------------
-- Reports
-- ---------------------------------------------------------------------------------------------------
create table public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter_user_id uuid not null references auth.users (id) on delete restrict,
  subject_type text not null,
  subject_id uuid not null,
  reason_code text not null,
  details text,
  status text not null default 'open',
  priority text not null default 'normal',
  assigned_to uuid references auth.users (id) on delete set null,
  assigned_at timestamptz,
  duplicate_of_report_id uuid references public.reports (id) on delete restrict,
  resolution text,
  resolution_note text,
  resolved_at timestamptz,
  resolved_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reports_subject_type_allowed check (subject_type in (
    'listing', 'review', 'review_reply', 'message', 'conversation', 'seller', 'user', 'promotion'
  )),
  constraint reports_reason_code_allowed check (reason_code in (
    'prohibited_item', 'counterfeit', 'intellectual_property', 'fraud_or_scam', 'harassment',
    'adult_content', 'violence', 'spam', 'misleading', 'off_platform', 'other'
  )),
  constraint reports_details_length check (details is null or length(btrim(details)) between 1 and 4000),
  constraint reports_status_allowed check (status in ('open', 'triaged', 'actioned', 'dismissed', 'duplicate')),
  constraint reports_priority_allowed check (priority in ('low', 'normal', 'high')),
  constraint reports_resolution_allowed check (
    resolution is null or resolution in ('actioned', 'dismissed', 'duplicate')
  ),
  constraint reports_resolved_has_time check (
    status not in ('actioned', 'dismissed', 'duplicate') or resolved_at is not null
  ),
  constraint reports_resolved_has_resolver check (resolved_at is null or resolved_by is not null),
  constraint reports_resolved_has_note check (
    resolved_at is null or length(btrim(coalesce(resolution_note, ''))) > 0
  ),
  constraint reports_duplicate_names_the_original check (
    (status = 'duplicate') = (duplicate_of_report_id is not null)
  ),
  constraint reports_not_its_own_duplicate check (duplicate_of_report_id is null or duplicate_of_report_id <> id),
  constraint reports_assigned_has_time check ((assigned_to is null) = (assigned_at is null))
);
comment on table public.reports is
  'What a user says about content or about somebody: a request for a look, never a decision. The subject is polymorphic on purpose — a report may be about a listing, a review, a message or a person — so the allowed subject_type list is the constraint rather than a foreign key.';
comment on column public.reports.subject_id is
  'The reported row''s id, in the table `subject_type` names. Deliberately unkeyed: a report survives the subject being removed, which is exactly when it matters most.';
-- C10: the same person reporting the same thing again lands on the report already open.
create unique index reports_one_open_per_reporter on public.reports (reporter_user_id, subject_type, subject_id)
  where status in ('open', 'triaged');
create index reports_queue on public.reports (status, priority desc, created_at);
create index reports_subject on public.reports (subject_type, subject_id, created_at desc);
create index reports_assigned on public.reports (assigned_to, status) where assigned_to is not null;
create trigger reports_set_updated_at before update on public.reports
  for each row execute function app_private.tg_set_updated_at();
create trigger reports_audit after insert or update or delete on public.reports
  for each row execute function audit.tg_record_change('details', 'resolution_note');

-- ---------------------------------------------------------------------------------------------------
-- Moderation actions
-- ---------------------------------------------------------------------------------------------------
create table public.moderation_actions (
  id uuid primary key default gen_random_uuid(),
  report_id uuid references public.reports (id) on delete set null,
  subject_type text not null,
  subject_id uuid not null,
  action text not null,
  reason text not null,
  notes text,
  moderator_user_id uuid not null references auth.users (id) on delete restrict,
  expires_at timestamptz,
  reverses_action_id uuid references public.moderation_actions (id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint moderation_actions_subject_type_allowed check (subject_type in (
    'listing', 'review', 'review_reply', 'message', 'conversation', 'seller', 'user', 'promotion'
  )),
  constraint moderation_actions_action_allowed check (action in (
    'none', 'warn', 'hide', 'remove', 'restrict', 'suspend', 'reinstate', 'escalate'
  )),
  constraint moderation_actions_reason_length check (length(btrim(reason)) between 1 and 500),
  constraint moderation_actions_notes_length check (notes is null or length(btrim(notes)) between 1 and 4000),
  -- Only a temporary measure carries an expiry, and only a reinstatement reverses something.
  constraint moderation_actions_expiry_is_temporary check (
    expires_at is null or action in ('restrict', 'suspend', 'hide')
  ),
  constraint moderation_actions_reversal_is_a_reinstatement check (
    reverses_action_id is null or action = 'reinstate'
  ),
  constraint moderation_actions_not_self_reversing check (
    reverses_action_id is null or reverses_action_id <> id
  )
);
comment on table public.moderation_actions is
  'What a moderator decided, about any subject. Append-only and always with its reason and its moderator: a decision is corrected by a reinstatement that points at it, never by an edit.';
create unique index moderation_actions_one_reversal on public.moderation_actions (reverses_action_id)
  where reverses_action_id is not null;
create index moderation_actions_subject on public.moderation_actions (subject_type, subject_id, created_at desc);
create index moderation_actions_report on public.moderation_actions (report_id) where report_id is not null;
create index moderation_actions_moderator on public.moderation_actions (moderator_user_id, created_at desc);
create index moderation_actions_expiring on public.moderation_actions (expires_at) where expires_at is not null;
create trigger moderation_actions_append_only before update or delete on public.moderation_actions
  for each row execute function app_private.tg_reject_write();

create table public.listing_moderation_actions (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references public.listings (id) on delete cascade,
  moderation_action_id uuid references public.moderation_actions (id) on delete set null,
  report_id uuid references public.reports (id) on delete set null,
  action text not null,
  from_status text not null,
  to_status text not null,
  reason text not null,
  moderator_user_id uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint listing_moderation_actions_action_allowed check (
    action in ('approve', 'reject', 'suspend', 'reinstate', 'request_changes')
  ),
  constraint listing_moderation_actions_reason_length check (length(btrim(reason)) between 1 and 500),
  constraint listing_moderation_actions_status_moved check (from_status <> to_status or action = 'request_changes')
);
comment on table public.listing_moderation_actions is
  'The listing-shaped moderation trail: a real foreign key and the status move recorded, because a listing''s status is what moderation actually changes. Append-only, alongside the generic action it belongs to.';
create index listing_moderation_actions_listing on public.listing_moderation_actions (listing_id, created_at desc);
create index listing_moderation_actions_report on public.listing_moderation_actions (report_id) where report_id is not null;
create trigger listing_moderation_actions_append_only before update or delete on public.listing_moderation_actions
  for each row execute function app_private.tg_reject_write();

-- ---------------------------------------------------------------------------------------------------
-- Order disputes
-- ---------------------------------------------------------------------------------------------------
create table public.disputes (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null,
  currency_code char(3) not null,
  buyer_user_id uuid not null,
  seller_user_id uuid not null,
  opened_by uuid not null references auth.users (id) on delete restrict,
  reason_code text not null,
  details text,
  claim_amount_minor bigint,
  status text not null default 'open',
  order_status_before text not null,
  resolution text,
  resolution_amount_minor bigint,
  resolution_note text,
  assigned_to uuid references auth.users (id) on delete set null,
  due_at timestamptz,
  resolved_at timestamptz,
  resolved_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- The same keys a review uses: a dispute cannot name the wrong buyer or the wrong seller.
  foreign key (order_id, currency_code) references public.orders (id, currency_code) on delete restrict,
  foreign key (order_id, buyer_user_id) references public.orders (id, buyer_user_id) on delete restrict,
  foreign key (order_id, seller_user_id) references public.orders (id, seller_user_id) on delete restrict,
  constraint disputes_reason_code_allowed check (reason_code in (
    'not_received', 'not_as_described', 'damaged', 'incomplete', 'late_delivery',
    'service_not_delivered', 'unauthorised', 'other'
  )),
  constraint disputes_details_length check (details is null or length(btrim(details)) between 1 and 4000),
  constraint disputes_claim_positive check (claim_amount_minor is null or claim_amount_minor > 0),
  constraint disputes_status_allowed check (status in (
    'open', 'awaiting_seller', 'awaiting_buyer', 'under_review', 'resolved', 'cancelled'
  )),
  constraint disputes_opened_by_is_a_party check (opened_by in (buyer_user_id, seller_user_id)),
  constraint disputes_buyer_is_not_the_seller check (buyer_user_id <> seller_user_id),
  constraint disputes_resolution_allowed check (
    resolution is null or resolution in ('refund_buyer', 'partial_refund', 'release_seller', 'no_action')
  ),
  constraint disputes_resolved_has_resolution check ((status = 'resolved') = (resolution is not null)),
  constraint disputes_resolved_has_time check (status <> 'resolved' or resolved_at is not null),
  constraint disputes_resolved_has_resolver check (resolved_at is null or resolved_by is not null),
  constraint disputes_resolved_has_note check (
    resolved_at is null or length(btrim(coalesce(resolution_note, ''))) > 0
  ),
  constraint disputes_resolution_amount_is_for_a_refund check (
    resolution_amount_minor is null or resolution in ('refund_buyer', 'partial_refund')
  ),
  constraint disputes_resolution_amount_positive check (
    resolution_amount_minor is null or resolution_amount_minor > 0
  ),
  unique (id, currency_code)
);
comment on table public.disputes is
  'A dispute between the buyer and the seller of one order, about that order. Not a chargeback: payment_disputes in 0019 is what a provider raises, and D26''s funds freeze hangs off that one.';
comment on column public.disputes.order_status_before is
  'Where the order was when the dispute opened, so resolving it puts the order back rather than guessing.';
-- One open dispute per order.
create unique index disputes_one_open_per_order on public.disputes (order_id)
  where status in ('open', 'awaiting_seller', 'awaiting_buyer', 'under_review');
create index disputes_queue on public.disputes (status, created_at);
create index disputes_buyer on public.disputes (buyer_user_id, created_at desc);
create index disputes_seller on public.disputes (seller_user_id, created_at desc);
create index disputes_due on public.disputes (due_at) where due_at is not null and status <> 'resolved';
create trigger disputes_set_updated_at before update on public.disputes
  for each row execute function app_private.tg_set_updated_at();
create trigger disputes_audit after insert or update or delete on public.disputes
  for each row execute function audit.tg_record_change('details', 'resolution_note');

create table public.dispute_messages (
  id uuid primary key default gen_random_uuid(),
  dispute_id uuid not null references public.disputes (id) on delete cascade,
  author_user_id uuid not null references auth.users (id) on delete restrict,
  author_role text not null,
  body text not null,
  is_internal boolean not null default false,
  created_at timestamptz not null default now(),
  constraint dispute_messages_author_role_allowed check (author_role in ('buyer', 'seller', 'staff')),
  constraint dispute_messages_body_length check (length(btrim(body)) between 1 and 4000),
  -- Only staff keep private notes; a party's message is always visible to the other party.
  constraint dispute_messages_internal_is_staff check (not is_internal or author_role = 'staff')
);
comment on table public.dispute_messages is
  'The thread on a dispute, append-only. A staff note may be internal; a message from either party never is, so neither side can say something the other cannot see.';
create index dispute_messages_thread on public.dispute_messages (dispute_id, created_at);
create trigger dispute_messages_append_only before update or delete on public.dispute_messages
  for each row execute function app_private.tg_reject_write();

create table public.dispute_evidence (
  id uuid primary key default gen_random_uuid(),
  dispute_id uuid not null references public.disputes (id) on delete cascade,
  uploaded_by uuid not null references auth.users (id) on delete restrict,
  object_path text not null,
  original_filename text,
  content_type text,
  byte_size bigint,
  description text,
  created_at timestamptz not null default now(),
  constraint dispute_evidence_path_present check (length(btrim(object_path)) > 0),
  -- The bucket is private and 0012 defined it; evidence never lands anywhere else.
  constraint dispute_evidence_path_is_in_the_private_bucket check (object_path like 'dispute-evidence/%'),
  constraint dispute_evidence_size_positive check (byte_size is null or byte_size > 0),
  constraint dispute_evidence_description_length check (
    description is null or length(btrim(description)) between 1 and 500
  )
);
comment on table public.dispute_evidence is
  'Files attached to a dispute. They live in the private dispute-evidence bucket and are reached only through an API-issued signed URL; this table holds the reference, never the file.';
create index dispute_evidence_dispute on public.dispute_evidence (dispute_id, created_at);
create trigger dispute_evidence_append_only before update or delete on public.dispute_evidence
  for each row execute function app_private.tg_reject_write();

-- ---------------------------------------------------------------------------------------------------
-- Reading
-- ---------------------------------------------------------------------------------------------------
create or replace function public.order_has_open_dispute(p_order_id uuid) returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from public.disputes d
     where d.order_id = p_order_id
       and d.status in ('open', 'awaiting_seller', 'awaiting_buyer', 'under_review')
  );
$$;
comment on function public.order_has_open_dispute(uuid) is
  'True while a marketplace dispute is running on this order. It is not the chargeback freeze — payment_has_open_dispute() is that one (D26).';

create or replace function public.is_dispute_party(p_dispute_id uuid, p_user_id uuid) returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from public.disputes d
     where d.id = p_dispute_id and p_user_id in (d.buyer_user_id, d.seller_user_id)
  );
$$;
comment on function public.is_dispute_party(uuid, uuid) is
  'Whether this user is the buyer or the seller of the disputed order. Staff are not parties, which is what lets them rule on it.';

-- ---------------------------------------------------------------------------------------------------
-- Reporting
-- ---------------------------------------------------------------------------------------------------
create or replace function app_private.file_report(
  p_reporter_user_id uuid,
  p_subject_type text,
  p_subject_id uuid,
  p_reason_code text,
  p_details text default null
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  existing_id uuid;
  new_report_id uuid;
begin
  -- C10: the same person reporting the same thing again lands on the report already open.
  select r.id into existing_id
    from public.reports r
   where r.reporter_user_id = p_reporter_user_id
     and r.subject_type = p_subject_type
     and r.subject_id = p_subject_id
     and r.status in ('open', 'triaged');
  if existing_id is not null then
    return existing_id;
  end if;

  -- Nobody reports themselves into the queue.
  if p_subject_type in ('seller', 'user') and p_subject_id = p_reporter_user_id then
    raise exception 'a report cannot be about its own reporter' using errcode = 'check_violation';
  end if;

  insert into public.reports (reporter_user_id, subject_type, subject_id, reason_code, details)
  values (p_reporter_user_id, p_subject_type, p_subject_id, p_reason_code, p_details)
  returning id into new_report_id;

  perform public.enqueue_outbox_event(
    'report', new_report_id::text, 'report.filed',
    jsonb_build_object('report_id', new_report_id, 'subject_type', p_subject_type,
                       'subject_id', p_subject_id, 'reason_code', p_reason_code)
  );
  return new_report_id;
end;
$$;
comment on function app_private.file_report(uuid, text, uuid, text, text) is
  'Files a report, or returns the one this reporter already has open on the same subject. A report is a request for a look; it decides nothing.';

create or replace function app_private.resolve_report(
  p_report_id uuid,
  p_status text,
  p_moderator_user_id uuid,
  p_resolution_note text,
  p_duplicate_of_report_id uuid default null
) returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  report public.reports;
begin
  if p_status not in ('triaged', 'actioned', 'dismissed', 'duplicate') then
    raise exception 'unknown report status %', p_status using errcode = 'invalid_parameter_value';
  end if;
  if p_status <> 'triaged' and length(btrim(coalesce(p_resolution_note, ''))) = 0 then
    raise exception 'a report is never closed without a reason' using errcode = 'check_violation';
  end if;

  select * into report from public.reports r where r.id = p_report_id for update;
  if report.id is null then
    raise exception 'report % does not exist', p_report_id using errcode = 'no_data_found';
  end if;
  if report.reporter_user_id = p_moderator_user_id then
    raise exception 'nobody rules on their own report' using errcode = 'insufficient_privilege';
  end if;
  if report.status in ('actioned', 'dismissed', 'duplicate') then
    raise exception 'report % is already %', p_report_id, report.status using errcode = 'restrict_violation';
  end if;

  update public.reports
     set status = p_status,
         resolution = case when p_status = 'triaged' then null else p_status end,
         resolution_note = case when p_status = 'triaged' then resolution_note else p_resolution_note end,
         resolved_at = case when p_status = 'triaged' then null else now() end,
         resolved_by = case when p_status = 'triaged' then resolved_by else p_moderator_user_id end,
         duplicate_of_report_id = case when p_status = 'duplicate' then p_duplicate_of_report_id else null end
   where id = p_report_id;

  return p_status;
end;
$$;
comment on function app_private.resolve_report(uuid, text, uuid, text, uuid) is
  'Moves a report through triage to a close, always with a reason and never by the person who filed it. A closed report cannot be reopened by this path.';

-- ---------------------------------------------------------------------------------------------------
-- Moderating
-- ---------------------------------------------------------------------------------------------------
create or replace function app_private.record_moderation_action(
  p_subject_type text,
  p_subject_id uuid,
  p_action text,
  p_moderator_user_id uuid,
  p_reason text,
  p_report_id uuid default null,
  p_notes text default null,
  p_expires_at timestamptz default null,
  p_reverses_action_id uuid default null
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  new_action_id uuid;
begin
  if p_subject_type in ('seller', 'user') and p_subject_id = p_moderator_user_id then
    raise exception 'nobody moderates themselves' using errcode = 'insufficient_privilege';
  end if;

  insert into public.moderation_actions (
    report_id, subject_type, subject_id, action, reason, notes, moderator_user_id, expires_at,
    reverses_action_id
  )
  values (
    p_report_id, p_subject_type, p_subject_id, p_action, p_reason, p_notes, p_moderator_user_id,
    p_expires_at, p_reverses_action_id
  )
  returning id into new_action_id;

  perform public.enqueue_outbox_event(
    'moderation', new_action_id::text, 'moderation.action_recorded',
    jsonb_build_object('moderation_action_id', new_action_id, 'subject_type', p_subject_type,
                       'subject_id', p_subject_id, 'action', p_action)
  );
  return new_action_id;
end;
$$;
comment on function app_private.record_moderation_action(text, uuid, text, uuid, text, uuid, text, timestamptz, uuid) is
  'Writes one moderator decision. The table refuses an action without a reason and an expiry on anything that is not temporary; this refuses a moderator acting on themselves.';

create or replace function app_private.moderate_listing(
  p_listing_id uuid,
  p_action text,
  p_moderator_user_id uuid,
  p_reason text,
  p_report_id uuid default null
) returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  listing public.listings;
  target_status text;
  action_id uuid;
begin
  if p_action not in ('approve', 'reject', 'suspend', 'reinstate', 'request_changes') then
    raise exception 'unknown listing moderation action %', p_action using errcode = 'invalid_parameter_value';
  end if;
  if length(btrim(coalesce(p_reason, ''))) = 0 then
    raise exception 'a moderation decision is always recorded with its reason' using errcode = 'check_violation';
  end if;

  select * into listing from public.listings l where l.id = p_listing_id for update;
  if listing.id is null then
    raise exception 'listing % does not exist', p_listing_id using errcode = 'no_data_found';
  end if;
  if listing.seller_user_id = p_moderator_user_id then
    raise exception 'nobody moderates their own listing' using errcode = 'insufficient_privilege';
  end if;

  target_status := case p_action
    when 'approve' then 'approved'
    when 'reject' then 'rejected'
    when 'suspend' then 'suspended'
    when 'reinstate' then 'active'
    else listing.status -- request_changes leaves the listing where it is and asks the seller to act
  end;

  if target_status <> listing.status then
    update public.listings
       set status = target_status,
           approved_at = case when target_status = 'approved' then coalesce(approved_at, now()) else approved_at end
     where id = p_listing_id;
  end if;

  action_id := app_private.record_moderation_action(
    'listing', p_listing_id,
    case p_action
      when 'approve' then 'none'
      when 'reject' then 'remove'
      when 'suspend' then 'suspend'
      when 'reinstate' then 'reinstate'
      else 'warn'
    end,
    p_moderator_user_id, p_reason, p_report_id
  );

  insert into public.listing_moderation_actions (
    listing_id, moderation_action_id, report_id, action, from_status, to_status, reason, moderator_user_id
  )
  values (
    p_listing_id, action_id, p_report_id, p_action, listing.status, target_status, p_reason,
    p_moderator_user_id
  );

  return target_status;
end;
$$;
comment on function app_private.moderate_listing(uuid, text, uuid, text, uuid) is
  'Moves a listing''s status and writes both trails — the generic action and the listing-shaped one — in one transaction, refusing a moderator who owns the listing. 0011''s status trigger still records the move and withdraws the public variants.';

-- ---------------------------------------------------------------------------------------------------
-- Disputes
-- ---------------------------------------------------------------------------------------------------
create or replace function app_private.open_dispute(
  p_order_id uuid,
  p_opened_by uuid,
  p_reason_code text,
  p_details text default null,
  p_claim_amount_minor bigint default null,
  p_due_at timestamptz default null
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  order_row public.orders;
  existing_id uuid;
  new_dispute_id uuid;
begin
  select * into order_row from public.orders o where o.id = p_order_id for update;
  if order_row.id is null then
    raise exception 'order % does not exist', p_order_id using errcode = 'no_data_found';
  end if;

  -- C10: an order already in dispute answers with the dispute it is in.
  select d.id into existing_id
    from public.disputes d
   where d.order_id = p_order_id
     and d.status in ('open', 'awaiting_seller', 'awaiting_buyer', 'under_review');
  if existing_id is not null then
    return existing_id;
  end if;

  if p_opened_by not in (order_row.buyer_user_id, order_row.seller_user_id) then
    raise exception 'only the buyer or the seller of an order may dispute it' using errcode = 'insufficient_privilege';
  end if;
  if order_row.status in ('pending_payment', 'cancelled', 'refunded') then
    raise exception 'order % is % and cannot be disputed', p_order_id, order_row.status
      using errcode = 'restrict_violation';
  end if;
  if p_claim_amount_minor is not null and p_claim_amount_minor > order_row.grand_total_minor then
    raise exception 'a claim can never exceed the order' using errcode = 'check_violation';
  end if;

  insert into public.disputes (
    order_id, currency_code, buyer_user_id, seller_user_id, opened_by, reason_code, details,
    claim_amount_minor, order_status_before, due_at
  )
  values (
    p_order_id, order_row.currency_code, order_row.buyer_user_id, order_row.seller_user_id, p_opened_by,
    p_reason_code, p_details, p_claim_amount_minor, order_row.status, p_due_at
  )
  returning id into new_dispute_id;

  -- The order says it is in dispute, which is also what keeps its earnings in `pending`: 0021 only
  -- releases completed orders.
  update public.orders set status = 'disputed' where id = p_order_id;

  if p_details is not null then
    insert into public.dispute_messages (dispute_id, author_user_id, author_role, body)
    values (
      new_dispute_id, p_opened_by,
      case when p_opened_by = order_row.buyer_user_id then 'buyer' else 'seller' end,
      p_details
    );
  end if;

  perform public.enqueue_outbox_event(
    'dispute', new_dispute_id::text, 'dispute.opened',
    jsonb_build_object('dispute_id', new_dispute_id, 'order_id', p_order_id, 'opened_by', p_opened_by,
                       'reason_code', p_reason_code)
  );
  return new_dispute_id;
end;
$$;
comment on function app_private.open_dispute(uuid, uuid, text, text, bigint, timestamptz) is
  'Opens the one dispute an order may have, moves the order to disputed and snapshots where it came from. Only a party may open one, and only on an order that can still be argued about.';

create or replace function app_private.post_dispute_message(
  p_dispute_id uuid,
  p_author_user_id uuid,
  p_body text,
  p_is_internal boolean default false
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  dispute public.disputes;
  role_name text;
  new_message_id uuid;
begin
  select * into dispute from public.disputes d where d.id = p_dispute_id;
  if dispute.id is null then
    raise exception 'dispute % does not exist', p_dispute_id using errcode = 'no_data_found';
  end if;
  if dispute.status in ('resolved', 'cancelled') then
    raise exception 'dispute % is % and its thread is closed', p_dispute_id, dispute.status
      using errcode = 'restrict_violation';
  end if;

  role_name := case
    when p_author_user_id = dispute.buyer_user_id then 'buyer'
    when p_author_user_id = dispute.seller_user_id then 'seller'
    else 'staff'
  end;
  if p_is_internal and role_name <> 'staff' then
    raise exception 'only staff keep internal notes' using errcode = 'insufficient_privilege';
  end if;

  insert into public.dispute_messages (dispute_id, author_user_id, author_role, body, is_internal)
  values (p_dispute_id, p_author_user_id, role_name, p_body, p_is_internal)
  returning id into new_message_id;

  perform public.enqueue_outbox_event(
    'dispute', p_dispute_id::text, 'dispute.message_posted',
    jsonb_build_object('dispute_id', p_dispute_id, 'dispute_message_id', new_message_id,
                       'author_role', role_name, 'is_internal', p_is_internal)
  );
  return new_message_id;
end;
$$;
comment on function app_private.post_dispute_message(uuid, uuid, text, boolean) is
  'Adds one message to a dispute, working out the author''s role from the dispute itself rather than trusting an argument, and refusing an internal note from a party.';

create or replace function app_private.resolve_dispute(
  p_dispute_id uuid,
  p_resolution text,
  p_resolver_user_id uuid,
  p_resolution_note text,
  p_resolution_amount_minor bigint default null
) returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  dispute public.disputes;
begin
  if p_resolution not in ('refund_buyer', 'partial_refund', 'release_seller', 'no_action') then
    raise exception 'unknown dispute resolution %', p_resolution using errcode = 'invalid_parameter_value';
  end if;
  if length(btrim(coalesce(p_resolution_note, ''))) = 0 then
    raise exception 'a dispute is never resolved without a reason' using errcode = 'check_violation';
  end if;

  select * into dispute from public.disputes d where d.id = p_dispute_id for update;
  if dispute.id is null then
    raise exception 'dispute % does not exist', p_dispute_id using errcode = 'no_data_found';
  end if;
  if dispute.status in ('resolved', 'cancelled') then
    raise exception 'dispute % is already %', p_dispute_id, dispute.status using errcode = 'restrict_violation';
  end if;
  if p_resolver_user_id in (dispute.buyer_user_id, dispute.seller_user_id) then
    raise exception 'nobody resolves a dispute they are a party to' using errcode = 'insufficient_privilege';
  end if;

  update public.disputes
     set status = 'resolved',
         resolution = p_resolution,
         resolution_amount_minor = case
           when p_resolution in ('refund_buyer', 'partial_refund') then p_resolution_amount_minor
         end,
         resolution_note = p_resolution_note,
         resolved_at = now(),
         resolved_by = p_resolver_user_id
   where id = p_dispute_id;

  -- The order goes back where it was. Any money that has to move is a refund, which is the Refunds
  -- module's job and its own record; a resolution decides, it does not pay.
  update public.orders set status = dispute.order_status_before where id = dispute.order_id;

  perform public.enqueue_outbox_event(
    'dispute', p_dispute_id::text, 'dispute.resolved',
    jsonb_build_object('dispute_id', p_dispute_id, 'order_id', dispute.order_id,
                       'resolution', p_resolution, 'amount_minor', p_resolution_amount_minor)
  );
  return p_resolution;
end;
$$;
comment on function app_private.resolve_dispute(uuid, text, uuid, text, bigint) is
  'Records the decision and puts the order back where it was. A resolution decides; any money it implies moves through the Refunds module, with its own record and its own capability checks.';

-- ---------------------------------------------------------------------------------------------------
-- Currency dependencies (D16)
-- ---------------------------------------------------------------------------------------------------
select app_private.register_currency_dependency(
  'disputes.currency_code', 'public', 'disputes', 'currency_code',
  'open disputes in the currency',
  $$status in ('open', 'awaiting_seller', 'awaiting_buyer', 'under_review')$$
);

-- ---------------------------------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------------------------------
alter table public.reports enable row level security;
alter table public.moderation_actions enable row level security;
alter table public.listing_moderation_actions enable row level security;
alter table public.disputes enable row level security;
alter table public.dispute_messages enable row level security;
alter table public.dispute_evidence enable row level security;

create policy reports_reporter_read on public.reports for select to authenticated
  using (reporter_user_id = public.current_user_id());
create policy reports_staff_read on public.reports for select to authenticated
  using (public.has_permission('moderation.report.read'));
create policy reports_staff_write on public.reports for update to authenticated
  using (public.has_permission('moderation.report.manage') and public.is_aal2())
  with check (public.has_permission('moderation.report.manage') and public.is_aal2());

-- Moderation decisions are staff-visible only; what a seller sees is the effect on their listing.
create policy moderation_actions_staff_read on public.moderation_actions for select to authenticated
  using (public.has_permission('moderation.action.read'));

create policy listing_moderation_actions_seller_read on public.listing_moderation_actions for select to authenticated
  using (exists (
    select 1 from public.listings l
     where l.id = listing_id and l.seller_user_id = public.current_user_id()
  ));
create policy listing_moderation_actions_staff_read on public.listing_moderation_actions for select to authenticated
  using (public.has_permission('moderation.action.read'));

create policy disputes_party_read on public.disputes for select to authenticated
  using (public.current_user_id() in (buyer_user_id, seller_user_id));
create policy disputes_staff_read on public.disputes for select to authenticated
  using (public.has_permission('disputes.dispute.read'));
create policy disputes_staff_write on public.disputes for update to authenticated
  using (public.has_permission('disputes.dispute.manage') and public.is_aal2())
  with check (public.has_permission('disputes.dispute.manage') and public.is_aal2());

-- A party reads the thread except the staff notes; staff read everything.
create policy dispute_messages_party_read on public.dispute_messages for select to authenticated
  using (not is_internal and public.is_dispute_party(dispute_id, public.current_user_id()));
create policy dispute_messages_staff_read on public.dispute_messages for select to authenticated
  using (public.has_permission('disputes.dispute.read'));

create policy dispute_evidence_party_read on public.dispute_evidence for select to authenticated
  using (public.is_dispute_party(dispute_id, public.current_user_id()));
create policy dispute_evidence_staff_read on public.dispute_evidence for select to authenticated
  using (public.has_permission('disputes.dispute.read'));

-- Every write goes through a SECURITY DEFINER function, so nobody holds INSERT.
grant select, update on public.reports to authenticated;
grant select on public.moderation_actions to authenticated;
grant select on public.listing_moderation_actions to authenticated;
grant select, update on public.disputes to authenticated;
grant select on public.dispute_messages to authenticated;
grant select on public.dispute_evidence to authenticated;

-- ---------------------------------------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema app_private from public;

grant execute on function
  public.order_has_open_dispute(uuid),
  public.is_dispute_party(uuid, uuid)
  to authenticated;

grant execute on function
  public.order_has_open_dispute(uuid),
  public.is_dispute_party(uuid, uuid),
  app_private.file_report(uuid, text, uuid, text, text),
  app_private.resolve_report(uuid, text, uuid, text, uuid),
  app_private.record_moderation_action(text, uuid, text, uuid, text, uuid, text, timestamptz, uuid),
  app_private.moderate_listing(uuid, text, uuid, text, uuid),
  app_private.open_dispute(uuid, uuid, text, text, bigint, timestamptz),
  app_private.post_dispute_message(uuid, uuid, text, boolean),
  app_private.resolve_dispute(uuid, text, uuid, text, bigint)
  to app_system, app_worker;
