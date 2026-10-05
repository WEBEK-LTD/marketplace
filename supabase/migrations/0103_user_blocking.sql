-- 0103 — User blocking: the writer for `public.user_blocks`, which six closed increments already enforce.
--
-- `public.user_blocks` has existed since 0005 with its own RLS policy, its self-block constraint and its
-- reason bound. `public.is_blocked_between(uuid, uuid)` has existed alongside it and is consulted by **six**
-- things:
--
--   * `app_private.messaging_start_conversation` — refuses with `blocked`;
--   * `app_private.offer_create` and `app_private.offer_counter`;
--   * `app_private.service_request_create` and `app_private.service_quote_create`;
--   * `app_private.tg_messages_block_rule`, a `before insert` trigger on `public.messages`, so even a message
--     into a conversation that already exists is refused.
--
-- **Nothing could ever create a block.** No function in either schema wrote the table, no API route reached
-- it, and the only reference anywhere in the repository was the generated Kysely type. So
-- `MESSAGING_BLOCKED`, `OFFER_BLOCKED` and `SERVICE_REQUEST_BLOCKED` were three refusals that existed, were
-- tested and could not happen, and somebody being harassed had no way to stop it. This migration adds the
-- writer and the list, and changes none of the six enforcers.
--
-- ---------------------------------------------------------------------------------------------------
-- THE OWNER DECISIONS THIS MIGRATION ENFORCES
-- ---------------------------------------------------------------------------------------------------
--
-- **1. A person is named by a conversation or by a seller slug, never by an account identifier.** Both are
-- handles the caller already holds. The conversation arm requires the caller to be a live participant of it
-- and blocks the other participant; the slug arm follows 0053's own precedent exactly — *"the surface that
-- offers 'message this seller' has no user id to send and must not be given one. Resolving the slug here
-- means the identifier is read and used inside one SECURITY DEFINER function and never crosses a boundary in
-- either direction."* The same sentence is true of this function.
--
-- **2. The list names a person by their display name and, when they have a storefront, its slug.** No account
-- identifier is returned. The API turns `blocked_user_id` into an opaque reference for the unblock, the way it
-- turns a row position into a cursor; this function returns the identifier because a definer function is
-- inside the boundary, not across it.
--
-- **3. The effect is symmetric, and that is 0005's predicate rather than a choice made here.**
-- `is_blocked_between` tests both directions, so blocking somebody also stops them reaching the blocker. It is
-- **not modified**.
--
-- **4. A reason is optional.** 0005 allows null and bounds it at 500 characters. Somebody protecting
-- themselves should not have to justify it. The bound is 0005's and is left to it.
--
-- **5. Nothing historical is touched.** No conversation is deleted, hidden, archived, closed or muted; no
-- message is altered. An existing thread stays readable and takes no new message, which is the trigger's
-- doing and not this migration's.
--
-- **6. No offer and no service request is mutated.** Their state machines are 7-H's and 7-I's and stay
-- authoritative; a block refuses the *next* action through the enforcers that already exist.
--
-- **7. There is no staff surface and no reverse lookup.** `user_blocks` has exactly one policy —
-- `user_blocks_self_all`, scoped to `blocker_id = current_user_id()` — and this migration adds none. Nothing
-- here answers "who has blocked me": the `user_blocks_by_blocked` index exists for the predicate, and turning
-- it into a reader would tell somebody exactly whom they have upset. **No permission key is added**, because
-- the table's own policy already says who may write it: its owner.
--
-- The same reasoning rules out the quieter routes to the same disclosure. Blocking writes **no audit row, no
-- outbox event, no security event and no notification** — each of those is a durable record of who blocked
-- whom, two of them are already read by staff consoles, and one of them is a relay that would reach the
-- blocked person. `user_blocks` is deliberately outside the audit triggers, and the pgTAP suite asserts all
-- four counts are zero, because this is a boundary a later increment could cross by accident while meaning
-- to improve observability.
--
-- **8. There is no cap.** 0005 sets none and none is invented.
--
-- **9. No AAL2.** Blocking is a self-service safety action, not a privileged one. Requiring a second factor to
-- stop harassment would be the wrong trade, and no other 7-E account operation requires one.
--
-- **10. The public catalogue is untouched.** Visibility is `listing_is_visible()`'s decision; filtering it per
-- viewer would change a closed read surface and its caching. A blocked seller's listings stay visible and
-- simply cannot be contacted.
--
-- ---------------------------------------------------------------------------------------------------
-- WHAT IS NOT HERE
-- ---------------------------------------------------------------------------------------------------
--
-- No change to `public.is_blocked_between`, to any of the six enforcers, or to `tg_messages_block_rule`. No
-- change to `public.user_blocks` itself — not a column, not a constraint, not an index, not its policy. No
-- moderation, report, suspension or ban path: a block is a private action and a sanction is 7-M/7-N's. No
-- notification to the blocked person. No reverse lookup. No conversation deletion, muting or closing. No
-- catalogue filtering. No new permission key. No new problem code for the enforcers, which already have
-- theirs. Nothing financial: no payment, payout, settlement, refund, seller-balance, provider or
-- financial-setting table or function is read or written here.

-- ---------------------------------------------------------------------------------------------------
-- Resolving the other party
-- ---------------------------------------------------------------------------------------------------
-- The one place a handle becomes an account, used by the two writers below and by nothing else.
--
-- Exactly one handle is accepted per call: a conversation **or** a slug, never both and never neither. Two
-- handles in one call is a malformed request rather than a precedence puzzle, and answering it would mean
-- choosing which one the caller meant.
--
-- Returns null for every failure, and the callers turn that into one outcome. The reasons are deliberately
-- indistinguishable: a conversation that does not exist, one the caller is not in, one they have left, one
-- with nobody else in it, a slug nobody holds, and a storefront that is not publicly visible all answer the
-- same way. Telling them apart would make this an oracle over conversations and storefronts.
create or replace function app_private.block_target(
  p_user_id uuid,
  p_conversation_id uuid,
  p_seller_slug text
) returns uuid
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_target uuid;
begin
  if p_user_id is null then
    return null;
  end if;
  -- Exactly one handle.
  if (p_conversation_id is null) = (nullif(btrim(coalesce(p_seller_slug, ''), E' \t\r\n'), '') is null) then
    return null;
  end if;

  if p_conversation_id is not null then
    -- The caller must be a live participant, and there must be exactly one other live participant. A
    -- conversation with support in it, or one the caller has left, resolves to nothing.
    if not exists (
      select 1 from public.conversation_participants cp
       where cp.conversation_id = p_conversation_id
         and cp.user_id = p_user_id
         and cp.left_at is null
    ) then
      return null;
    end if;

    select cp.user_id into v_target
      from public.conversation_participants cp
     where cp.conversation_id = p_conversation_id
       and cp.user_id <> p_user_id
       and cp.left_at is null
       and cp.role <> 'support';
    -- More than one other participant, or none, is not a two-party conversation to block somebody in.
    if not found or (
      select count(*) from public.conversation_participants cp
       where cp.conversation_id = p_conversation_id
         and cp.user_id <> p_user_id
         and cp.left_at is null
         and cp.role <> 'support'
    ) <> 1 then
      return null;
    end if;
  else
    -- 0053's own rule, applied to the same kind of surface: the slug is resolved here and the identifier
    -- never crosses a boundary. A slug nobody holds and a storefront that is not publicly visible are one
    -- answer, which is what 0050 decided about reading a profile.
    select sp.user_id into v_target
      from public.seller_profiles sp
     where sp.slug = nullif(btrim(coalesce(p_seller_slug, ''), E' \t\r\n'), '');
    if v_target is null or not public.is_seller_publicly_visible(v_target) then
      return null;
    end if;
  end if;

  -- Nobody blocks themselves. 0005's `user_blocks_not_self` would refuse the insert; this returns the
  -- caller's own outcome instead of raising, and it is also how a one-person conversation resolves.
  if v_target is null or v_target = p_user_id then
    return null;
  end if;
  return v_target;
end;
$$;
comment on function app_private.block_target(uuid, uuid, text) is
  'Resolves a conversation the caller participates in, or a public seller slug, to the account on the other side. Exactly one handle per call. Every failure answers null so that a missing conversation, a conversation the caller is not in, an unknown slug and an invisible storefront cannot be told apart.';

-- ---------------------------------------------------------------------------------------------------
-- Creating a block
-- ---------------------------------------------------------------------------------------------------
-- Outcomes: `blocked` for a new row, `exists` for one that was already there, `not_found` for a handle that
-- resolves to nobody. Idempotent on purpose — somebody pressing Block twice is not an error, and the second
-- press must not report a failure that would make them wonder whether the first worked.
--
-- A later block of the same person **refreshes the reason** rather than keeping the first one, because the
-- reason describes why the block stands now.
create or replace function app_private.buyer_block_add(
  p_user_id uuid,
  p_conversation_id uuid default null,
  p_seller_slug text default null,
  p_reason text default null
) returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_target uuid;
  v_reason text := nullif(btrim(coalesce(p_reason, ''), E' \t\r\n'), '');
  v_inserted boolean;
begin
  if p_user_id is null then
    raise exception 'buyer_block_add requires an account' using errcode = '22023';
  end if;

  v_target := app_private.block_target(p_user_id, p_conversation_id, p_seller_slug);
  if v_target is null then
    return 'not_found';
  end if;

  -- `row_count` is 1 for an insert and for an `on conflict do update` alike, so it cannot tell the two
  -- apart. `xmax` can: it is zero on a tuple this statement inserted and carries the updating transaction's
  -- id on one it replaced. Reading it in the statement's own `returning` makes the answer exact — there is no
  -- second lookup to race, and no comparison against a clock. The first thing tried here was
  -- `created_at = now()`, which *looks* exact and is not: `now()` is the transaction's start, so two blocks
  -- in one transaction both matched it and the repeat claimed to be new.
  insert into public.user_blocks (blocker_id, blocked_id, reason)
  values (p_user_id, v_target, v_reason)
  on conflict on constraint user_blocks_pkey do update
    set reason = excluded.reason
  returning (xmax = 0) into v_inserted;

  return case when v_inserted then 'blocked' else 'exists' end;
end;
$$;
comment on function app_private.buyer_block_add(uuid, uuid, text, text) is
  'Blocks the person on the other side of a conversation the caller participates in, or of a public seller slug. Idempotent; a repeat refreshes the reason. Takes no account identifier, adds no permission key, and changes nothing about any conversation, offer or service request.';

-- ---------------------------------------------------------------------------------------------------
-- Removing a block
-- ---------------------------------------------------------------------------------------------------
-- The account identifier is a parameter here because this function is **inside** the boundary: the API
-- decodes the opaque reference it issued and passes the account in, exactly as it decodes a cursor into a
-- position. The scope is still the caller's own rows — `blocker_id = p_user_id` is in the predicate, so a
-- reference belonging to somebody else's list removes nothing.
--
-- Returns false for a block that was not there, which is also the answer for a reference that names somebody
-- the caller never blocked. An unblock that finds nothing is not an error worth a refusal: the state the
-- caller asked for is the state they have.
create or replace function app_private.buyer_block_remove(p_user_id uuid, p_blocked_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_removed integer;
begin
  if p_user_id is null or p_blocked_user_id is null then
    return false;
  end if;

  delete from public.user_blocks b
   where b.blocker_id = p_user_id
     and b.blocked_id = p_blocked_user_id;
  get diagnostics v_removed = row_count;
  return v_removed = 1;
end;
$$;
comment on function app_private.buyer_block_remove(uuid, uuid) is
  'Removes one of the caller''s own blocks. Scoped by blocker_id, so a reference from another account''s list removes nothing. A block that was not there answers false rather than refusing.';

-- ---------------------------------------------------------------------------------------------------
-- The caller's own list
-- ---------------------------------------------------------------------------------------------------
-- Newest first, cursor-paged over `(created_at, blocked_id)`, which is total within one blocker because
-- `(blocker_id, blocked_id)` is the primary key.
--
-- `blocked_user_id` is returned for the API to turn into an opaque reference. `display_name` comes from the
-- profile and may be null; `seller_slug` is present when the blocked account has a storefront, visible or
-- not, because the caller already held that slug if they blocked by it. Nothing else about the person is
-- returned: no contact detail, no status, no account state, and nothing about what they have done.
create or replace function app_private.buyer_blocks(
  p_user_id uuid,
  p_limit integer default 20,
  p_cursor_created_at timestamptz default null,
  p_cursor_blocked_id uuid default null
) returns table (
  blocked_user_id uuid,
  display_name text,
  seller_slug text,
  reason text,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select b.blocked_id,
         p.display_name,
         sp.slug,
         b.reason,
         b.created_at
    from public.user_blocks b
    left join public.profiles p on p.id = b.blocked_id
    left join public.seller_profiles sp on sp.user_id = b.blocked_id
   where b.blocker_id = p_user_id
     and (
       p_cursor_created_at is null
       or p_cursor_blocked_id is null
       or (b.created_at, b.blocked_id) < (p_cursor_created_at, p_cursor_blocked_id)
     )
   order by b.created_at desc, b.blocked_id desc
   limit least(greatest(coalesce(p_limit, 20), 1), 50);
$$;
comment on function app_private.buyer_blocks(uuid, integer, timestamptz, uuid) is
  'The caller''s own block list, newest first. Returns a display name and a storefront slug where they exist and nothing else about the person. Scoped by blocker_id; there is no reverse lookup anywhere in this schema.';

-- ---------------------------------------------------------------------------------------------------
-- Execution
-- ---------------------------------------------------------------------------------------------------
revoke execute on all functions in schema app_private from public;

revoke execute on function app_private.block_target(uuid, uuid, text) from public, app_worker;
revoke execute on function app_private.buyer_block_add(uuid, uuid, text, text) from public, app_worker;
revoke execute on function app_private.buyer_block_remove(uuid, uuid) from public, app_worker;
revoke execute on function app_private.buyer_blocks(uuid, integer, timestamptz, uuid) from public, app_worker;

-- `app_system` only. The worker blocks nobody: no schedule and no event in this platform decides who may
-- contact whom, and the one process that runs unattended is the one that should least be able to.
grant execute on function app_private.block_target(uuid, uuid, text) to app_system;
grant execute on function app_private.buyer_block_add(uuid, uuid, text, text) to app_system;
grant execute on function app_private.buyer_block_remove(uuid, uuid) to app_system;
grant execute on function app_private.buyer_blocks(uuid, integer, timestamptz, uuid) to app_system;

-- The contract this repository will not ship without.
select app_private.assert_security_contract();
