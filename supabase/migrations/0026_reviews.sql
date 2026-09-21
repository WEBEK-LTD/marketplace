-- 0026 — Reviews and seller replies (v5.2 Reviews module; D13).
--
-- D13 in one line: one review per completed seller order per buyer, tied to the seller order, with
-- duplicates impossible at database level. That is done with keys rather than with checks in code.
-- `orders` gains two additive unique keys here — `(id, buyer_user_id)` and `(id, seller_user_id)` —
-- purely so a review can carry a composite foreign key to each. A review therefore cannot name an order
-- that is not the buyer's, cannot name a seller who did not sell it, and cannot be written twice,
-- because `reviews.order_id` is unique. No behaviour of 0018 changes; the keys are indexes only.
--
-- Eligibility is the other half: the order must have reached `completed`. A trigger checks that at
-- insert, because a CHECK cannot look at another table, and the rating itself is bounded 1 to 5.
--
-- Publication is separate from existence. A review is a durable record of what a buyer said; whether it
-- is shown is a status that refunds, chargebacks and moderation may all move, exactly as the
-- specification says. `reassess_review_publication()` is what the worker calls when an order is refunded
-- or a dispute opens on its payment: it hides the review without destroying it, and puts it back when
-- the reason goes away. Moderator decisions are recorded on the row with who made them and why, and are
-- never overridden by the automatic reassessment — a moderator's `removed` stays removed.
--
-- A seller may reply once to a review about them, and that reply carries its own publication status, so
-- a reply can be moderated without touching the review it answers.
--
-- `seller_ratings` is a view, not a table: the aggregate is always derived from published reviews, so it
-- can never drift from them. The Reviews module still owns exactly the two tables the specification
-- gives it.

-- ---------------------------------------------------------------------------------------------------
-- The keys a review hangs from (additive; 0018's behaviour is untouched)
-- ---------------------------------------------------------------------------------------------------
alter table public.orders add constraint orders_id_buyer_key unique (id, buyer_user_id);
alter table public.orders add constraint orders_id_seller_key unique (id, seller_user_id);

-- A genuine dependency this migration surfaces: 0018 tied `completed_at` to the status both ways, so a
-- completed order could never move on to `refunded` without erasing the moment it completed — and a
-- review exists precisely because an order completed. The constraint becomes one-way, the same shape
-- 0019 already uses for a late payment success: reaching `completed` still stamps the time, and the time
-- stays on the record afterwards.
alter table public.orders drop constraint orders_completed_has_time;
alter table public.orders add constraint orders_completed_has_time
  check (status <> 'completed' or completed_at is not null);

-- ---------------------------------------------------------------------------------------------------
-- Reviews
-- ---------------------------------------------------------------------------------------------------
create table public.reviews (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null,
  seller_user_id uuid not null,
  buyer_user_id uuid not null,
  rating smallint not null,
  title text,
  body text,
  status text not null default 'published',
  auto_hidden_reason text,
  moderation_reason text,
  moderated_at timestamptz,
  moderated_by uuid references auth.users (id) on delete set null,
  published_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- D13: the review is tied to the seller order, to that order's buyer and to that order's seller.
  foreign key (order_id, buyer_user_id) references public.orders (id, buyer_user_id) on delete restrict,
  foreign key (order_id, seller_user_id) references public.orders (id, seller_user_id) on delete restrict,
  constraint reviews_rating_range check (rating between 1 and 5),
  constraint reviews_title_length check (title is null or length(btrim(title)) between 1 and 120),
  constraint reviews_body_length check (body is null or length(btrim(body)) between 1 and 4000),
  constraint reviews_status_allowed check (status in ('published', 'pending_moderation', 'hidden', 'removed')),
  constraint reviews_moderated_has_moderator check (moderated_at is null or moderated_by is not null),
  constraint reviews_moderated_has_reason check (
    moderated_at is null or length(btrim(moderation_reason)) > 0
  ),
  constraint reviews_buyer_is_not_the_seller check (buyer_user_id <> seller_user_id),
  -- Duplicates are impossible at database level, which is what D13 asks for.
  unique (order_id)
);
comment on table public.reviews is
  'One review per completed seller order per buyer (D13). The unique key on order_id is what makes a duplicate impossible; the composite foreign keys are what make a review about the wrong buyer or the wrong seller impossible.';
comment on column public.reviews.status is
  'Whether the review is shown. Existence and publication are separate: a refund, a chargeback or a moderator may hide a review, and none of them destroys what the buyer said.';
comment on column public.reviews.auto_hidden_reason is
  'Set by the automatic reassessment (a refunded order, a disputed payment) and cleared when the reason goes away. A moderator decision is recorded separately and outranks it.';
create index reviews_seller on public.reviews (seller_user_id, status, published_at desc);
create index reviews_buyer on public.reviews (buyer_user_id, created_at desc);
create index reviews_moderation_queue on public.reviews (created_at) where status = 'pending_moderation';
create trigger reviews_set_updated_at before update on public.reviews
  for each row execute function app_private.tg_set_updated_at();
create trigger reviews_audit after insert or update or delete on public.reviews
  for each row execute function audit.tg_record_change('body', 'moderation_reason');

-- Only a completed order earns a review, and only its own buyer may write it.
create or replace function app_private.tg_reviews_eligible() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  order_row public.orders;
begin
  select * into order_row from public.orders o where o.id = new.order_id;
  if order_row.id is null then
    raise exception 'order % does not exist', new.order_id using errcode = 'no_data_found';
  end if;
  if order_row.status <> 'completed' then
    raise exception 'order % is % and cannot be reviewed yet', new.order_id, order_row.status
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;
comment on function app_private.tg_reviews_eligible() is
  'The eligibility rule a CHECK cannot express: a review needs a completed order behind it. The composite keys already guarantee the buyer and the seller are that order''s.';

create trigger reviews_eligible before insert on public.reviews
  for each row execute function app_private.tg_reviews_eligible();

-- ---------------------------------------------------------------------------------------------------
-- Seller replies
-- ---------------------------------------------------------------------------------------------------
create table public.review_replies (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references public.reviews (id) on delete cascade,
  seller_user_id uuid not null references public.seller_profiles (user_id) on delete restrict,
  body text not null,
  status text not null default 'published',
  moderation_reason text,
  moderated_at timestamptz,
  moderated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint review_replies_body_length check (length(btrim(body)) between 1 and 2000),
  constraint review_replies_status_allowed check (status in ('published', 'pending_moderation', 'hidden', 'removed')),
  constraint review_replies_moderated_has_moderator check (moderated_at is null or moderated_by is not null),
  constraint review_replies_moderated_has_reason check (
    moderated_at is null or length(btrim(moderation_reason)) > 0
  ),
  -- One reply per review: a seller answers once.
  unique (review_id)
);
comment on table public.review_replies is
  'The seller''s one answer to a review about them. It carries its own publication status, so a reply can be moderated without touching the review it answers.';
create index review_replies_seller on public.review_replies (seller_user_id, created_at desc);
create trigger review_replies_set_updated_at before update on public.review_replies
  for each row execute function app_private.tg_set_updated_at();
create trigger review_replies_audit after insert or update or delete on public.review_replies
  for each row execute function audit.tg_record_change('body', 'moderation_reason');

-- A reply only ever comes from the seller the review is about.
create or replace function app_private.tg_review_replies_author() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  review public.reviews;
begin
  select * into review from public.reviews r where r.id = new.review_id;
  if review.id is null then
    raise exception 'review % does not exist', new.review_id using errcode = 'no_data_found';
  end if;
  if review.seller_user_id <> new.seller_user_id then
    raise exception 'only the seller a review is about may reply to it' using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

create trigger review_replies_author before insert or update on public.review_replies
  for each row execute function app_private.tg_review_replies_author();

-- ---------------------------------------------------------------------------------------------------
-- Eligibility, publication and the aggregate
-- ---------------------------------------------------------------------------------------------------
create or replace function public.can_review_order(
  p_order_id uuid,
  p_buyer_user_id uuid
) returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from public.orders o
     where o.id = p_order_id
       and o.buyer_user_id = p_buyer_user_id
       and o.status = 'completed'
  ) and not exists (select 1 from public.reviews r where r.order_id = p_order_id);
$$;
comment on function public.can_review_order(uuid, uuid) is
  'Whether this buyer may still review this order: it is theirs, it is completed, and it has not been reviewed. Everything else answers false.';

create or replace function public.review_publication_block(p_order_id uuid) returns text
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select case
    when exists (select 1 from public.orders o where o.id = p_order_id and o.status = 'refunded')
      then 'order_refunded'
    when exists (
      select 1
        from public.orders o
        join public.payments p on p.checkout_id = o.checkout_id
       where o.id = p_order_id and public.payment_has_open_dispute(p.id)
    ) then 'payment_disputed'
  end;
$$;
comment on function public.review_publication_block(uuid) is
  'Why a review of this order should not be shown right now, or NULL when there is no reason. Refunds and chargebacks are what the specification names.';

create or replace function app_private.reassess_review_publication(p_order_id uuid) returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  review public.reviews;
  block_reason text;
begin
  select * into review from public.reviews r where r.order_id = p_order_id for update;
  if review.id is null then
    return 0;
  end if;

  -- A moderator's decision is the last word: automatic reassessment never overrides it.
  if review.moderated_at is not null then
    return 0;
  end if;

  block_reason := public.review_publication_block(p_order_id);

  if block_reason is not null and review.status = 'published' then
    update public.reviews
       set status = 'hidden', auto_hidden_reason = block_reason
     where id = review.id;
    return 1;
  elsif block_reason is null and review.status = 'hidden' and review.auto_hidden_reason is not null then
    update public.reviews
       set status = 'published', auto_hidden_reason = null, published_at = now()
     where id = review.id;
    return 1;
  end if;

  return 0;
end;
$$;
comment on function app_private.reassess_review_publication(uuid) is
  'Hides a review whose order was refunded or whose payment is disputed, and shows it again when that reason goes away. It never touches a review a moderator has ruled on, and never deletes anything.';

create or replace function app_private.create_review(
  p_order_id uuid,
  p_buyer_user_id uuid,
  p_rating smallint,
  p_title text default null,
  p_body text default null
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  order_row public.orders;
  existing_id uuid;
  new_review_id uuid;
  block_reason text;
begin
  -- C10: the same order reviewed twice returns the review already written.
  select r.id into existing_id from public.reviews r where r.order_id = p_order_id;
  if existing_id is not null then
    return existing_id;
  end if;

  select * into order_row from public.orders o where o.id = p_order_id;
  if order_row.id is null then
    raise exception 'order % does not exist', p_order_id using errcode = 'no_data_found';
  end if;
  if order_row.buyer_user_id <> p_buyer_user_id then
    raise exception 'only the buyer of an order may review it' using errcode = 'insufficient_privilege';
  end if;

  block_reason := public.review_publication_block(p_order_id);

  insert into public.reviews (
    order_id, seller_user_id, buyer_user_id, rating, title, body, status, auto_hidden_reason
  )
  values (
    p_order_id, order_row.seller_user_id, p_buyer_user_id, p_rating, p_title, p_body,
    case when block_reason is null then 'published' else 'hidden' end,
    block_reason
  )
  returning id into new_review_id;

  perform public.enqueue_outbox_event(
    'review', new_review_id::text, 'review.created',
    jsonb_build_object('review_id', new_review_id, 'order_id', p_order_id,
                       'seller_user_id', order_row.seller_user_id, 'rating', p_rating)
  );
  return new_review_id;
end;
$$;
comment on function app_private.create_review(uuid, uuid, smallint, text, text) is
  'Writes the one review an order is allowed, already hidden if a refund or a dispute says it should not be shown yet. The keys and the eligibility trigger do the refusing.';

create or replace function app_private.reply_to_review(
  p_review_id uuid,
  p_seller_user_id uuid,
  p_body text
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  existing_id uuid;
  new_reply_id uuid;
begin
  select r.id into existing_id from public.review_replies r where r.review_id = p_review_id;
  if existing_id is not null then
    return existing_id; -- a seller answers once (C10)
  end if;

  insert into public.review_replies (review_id, seller_user_id, body)
  values (p_review_id, p_seller_user_id, p_body)
  returning id into new_reply_id;

  perform public.enqueue_outbox_event(
    'review', p_review_id::text, 'review.replied',
    jsonb_build_object('review_id', p_review_id, 'review_reply_id', new_reply_id,
                       'seller_user_id', p_seller_user_id)
  );
  return new_reply_id;
end;
$$;
comment on function app_private.reply_to_review(uuid, uuid, text) is
  'The seller''s single answer to a review about them. Replying again returns the reply already there.';

create or replace function app_private.moderate_review(
  p_review_id uuid,
  p_status text,
  p_moderator_user_id uuid,
  p_reason text
) returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  review public.reviews;
begin
  if p_status not in ('published', 'pending_moderation', 'hidden', 'removed') then
    raise exception 'unknown review status %', p_status using errcode = 'invalid_parameter_value';
  end if;
  if length(btrim(coalesce(p_reason, ''))) = 0 then
    raise exception 'a moderation decision is always recorded with its reason' using errcode = 'check_violation';
  end if;

  select * into review from public.reviews r where r.id = p_review_id for update;
  if review.id is null then
    raise exception 'review % does not exist', p_review_id using errcode = 'no_data_found';
  end if;
  if review.buyer_user_id = p_moderator_user_id or review.seller_user_id = p_moderator_user_id then
    raise exception 'nobody moderates a review they are a party to' using errcode = 'insufficient_privilege';
  end if;

  update public.reviews
     set status = p_status,
         moderation_reason = p_reason,
         moderated_at = now(),
         moderated_by = p_moderator_user_id,
         auto_hidden_reason = null,
         published_at = case when p_status = 'published' then now() else published_at end
   where id = p_review_id;

  perform public.enqueue_outbox_event(
    'review', p_review_id::text, 'review.moderated',
    jsonb_build_object('review_id', p_review_id, 'status', p_status)
  );
  return p_status;
end;
$$;
comment on function app_private.moderate_review(uuid, text, uuid, text) is
  'Records a moderator decision with who made it and why, and refuses a moderator who is a party to the review. From then on the automatic reassessment leaves that review alone.';

create view public.seller_ratings
with (security_invoker = true) as
select
  r.seller_user_id,
  count(*)::bigint as review_count,
  -- Half-up, in basis points, so the aggregate stays an integer like every other computed figure here.
  ((sum(r.rating)::bigint * 10000 + count(*) / 2) / count(*))::integer as average_rating_basis_points,
  count(*) filter (where r.rating = 5)::bigint as five_star_count,
  count(*) filter (where r.rating = 4)::bigint as four_star_count,
  count(*) filter (where r.rating = 3)::bigint as three_star_count,
  count(*) filter (where r.rating = 2)::bigint as two_star_count,
  count(*) filter (where r.rating = 1)::bigint as one_star_count,
  max(r.published_at) as latest_review_at
  from public.reviews r
 where r.status = 'published'
 group by r.seller_user_id;
comment on view public.seller_ratings is
  'The seller rating, derived from published reviews only. A view rather than a table, so the aggregate can never drift from the rows it summarises.';

-- ---------------------------------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------------------------------
alter table public.reviews enable row level security;
alter table public.review_replies enable row level security;

-- Anyone signed in reads published reviews of a seller who is publicly visible.
create policy reviews_public_read on public.reviews for select to authenticated
  using (status = 'published' and public.is_seller_publicly_visible(seller_user_id));
create policy reviews_author_read on public.reviews for select to authenticated
  using (buyer_user_id = public.current_user_id());
create policy reviews_seller_read on public.reviews for select to authenticated
  using (seller_user_id = public.current_user_id());
create policy reviews_staff_read on public.reviews for select to authenticated
  using (public.has_permission('reviews.review.read'));
create policy reviews_staff_moderate on public.reviews for update to authenticated
  using (public.has_permission('reviews.review.moderate') and public.is_aal2())
  with check (public.has_permission('reviews.review.moderate') and public.is_aal2());

create policy review_replies_public_read on public.review_replies for select to authenticated
  using (
    status = 'published'
    and exists (
      select 1 from public.reviews r
       where r.id = review_id and r.status = 'published'
         and public.is_seller_publicly_visible(r.seller_user_id)
    )
  );
create policy review_replies_seller_read on public.review_replies for select to authenticated
  using (seller_user_id = public.current_user_id());
create policy review_replies_buyer_read on public.review_replies for select to authenticated
  using (exists (
    select 1 from public.reviews r where r.id = review_id and r.buyer_user_id = public.current_user_id()
  ));
create policy review_replies_staff_read on public.review_replies for select to authenticated
  using (public.has_permission('reviews.review.read'));
create policy review_replies_staff_moderate on public.review_replies for update to authenticated
  using (public.has_permission('reviews.review.moderate') and public.is_aal2())
  with check (public.has_permission('reviews.review.moderate') and public.is_aal2());

-- Writes go through the SECURITY DEFINER functions, which is why nobody holds INSERT.
grant select, update on public.reviews to authenticated;
grant select, update on public.review_replies to authenticated;
grant select on public.seller_ratings to authenticated;

-- ---------------------------------------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema app_private from public;

grant execute on function
  public.can_review_order(uuid, uuid),
  public.review_publication_block(uuid)
  to authenticated;

grant execute on function
  public.can_review_order(uuid, uuid),
  public.review_publication_block(uuid),
  app_private.create_review(uuid, uuid, smallint, text, text),
  app_private.reply_to_review(uuid, uuid, text),
  app_private.moderate_review(uuid, text, uuid, text),
  app_private.reassess_review_publication(uuid)
  to app_system, app_worker;
