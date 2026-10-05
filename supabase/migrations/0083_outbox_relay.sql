-- 0083 — Outbox relay infrastructure: a handler-scoped claim and a worker-side event read (Phase 8-A).
--
-- Phase 8-A builds the relay, sweeper and dead-letter mechanics that F-1 makes a prerequisite of every
-- Phase 8 financial mutation. It builds no handler: the handler registry is deliberately empty, and the
-- owner's rule for an unregistered event type is absolute — **do not claim, do not complete, do not
-- repeatedly claim/sweep/dead-letter**.
--
-- 0007 already owns the outbox. Nothing here replaces it:
--
--     app_private.claim_outbox_events(integer)          the unfiltered claim, unchanged
--     app_private.complete_outbox_event(uuid)           completion by event id, unchanged
--     app_private.sweep_outbox_events(interval, integer) the 5-minute sweep, unchanged
--     app_private.dead_letter_outbox_event(uuid, text)  the poison stop, unchanged
--     app_private.start_job_run(text, timestamptz)      run recording, unchanged
--     app_private.finish_job_run(uuid, text, ...)       run recording, unchanged
--
-- ---------------------------------------------------------------------------------------------------
-- WHY THIS MIGRATION EXISTS AT ALL
-- ---------------------------------------------------------------------------------------------------
-- **`claim_outbox_events(p_limit)` cannot express "only what a handler exists for".** It takes a batch
-- size and nothing else, so it claims whatever is pending — and a claim is not a read: it sets
-- `published_at` and increments `attempts`. Calling it with an empty or partial registry would publish
-- events nobody can process, and then exactly one of two things would follow, both of them wrong:
--
--   * the relay completes them, and a business side effect that never happened is recorded as done; or
--   * nothing completes them, the sweeper returns them to pending every five minutes, `attempts` climbs
--     on each re-claim, and the platform's whole event history eventually dead-letters.
--
-- So the claim has to take the registry with it. `claim_outbox_events_for(p_event_types, p_limit)` is
-- the same statement as 0007's claim with one extra predicate — `event_type = any(p_event_types)` — and
-- it **refuses a null or empty array**, so an empty registry cannot claim anything even by mistake.
-- An unregistered event keeps `published_at is null`, which is precisely the column `sweep_outbox_events`
-- requires to be non-null: an unclaimed event is structurally unreachable by the sweeper. That is why
-- 8-A needs no sweeper change and adds none.
--
-- **A handler cannot act on an event it cannot read.** Queue payloads carry identifiers only, and
-- `assertIdPayload` admits `<name>Id` keys with UUID values — `outbox_events.aggregate_id` is `text` and
-- is literally `'batch'` for four of the existing event types, so it cannot travel in a job. The job
-- therefore carries `{ eventId }`, and the handler needs the row back. 0007 returns the row only at
-- claim time, so `outbox_event_for_worker(p_id)` reads one event by id. It is the read that makes
-- completion safe: a handler that completes an event it never read is the false-completion hazard this
-- whole increment exists to prevent, and the three settlement columns come back with the row so the
-- wrapper can skip an event another worker already finished.
--
-- Both functions are `app_worker` only. `app_system` reaches `job_runs` and `outbox_events` through
-- 0081's admin readers and needs neither of these; widening the grant would put a claim — a write — in
-- reach of the request path.
--
-- Nothing here touches a financial table, a provider, a webhook or a domain writer. No event type is
-- mapped to a queue: the mapping is the registering increment's, and 8-A ships none.

-- ---------------------------------------------------------------------------------------------------
-- The handler-scoped claim
-- ---------------------------------------------------------------------------------------------------
create or replace function app_private.claim_outbox_events_for(
  p_event_types text[],
  p_limit integer default 100
)
returns table (
  id uuid,
  aggregate_type text,
  aggregate_id text,
  event_type text,
  payload jsonb,
  occurred_at timestamptz,
  attempts integer
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  -- An empty registry claims nothing. This is the rule, stated where it cannot be bypassed.
  if p_event_types is null or cardinality(p_event_types) = 0 then
    raise exception 'p_event_types must name at least one registered event type';
  end if;
  if array_position(p_event_types, null) is not null then
    raise exception 'p_event_types must not contain nulls';
  end if;
  -- The same bound 0007's claim applies, for the same reason.
  if p_limit < 1 or p_limit > 1000 then
    raise exception 'p_limit must be between 1 and 1000';
  end if;

  return query
  with claimed as (
    select e.id
    from public.outbox_events e
    where e.published_at is null
      and e.dead_lettered_at is null
      and e.available_at <= now()
      and e.event_type = any(p_event_types)
    order by e.available_at, e.id
    limit p_limit
    for update skip locked
  )
  update public.outbox_events e
     set published_at = now(),
         attempts = e.attempts + 1
    from claimed
   where e.id = claimed.id
  returning e.id, e.aggregate_type, e.aggregate_id, e.event_type, e.payload, e.occurred_at, e.attempts;
end;
$$;
comment on function app_private.claim_outbox_events_for(text[], integer) is
  'Relay step, scoped to the event types a handler is registered for. Identical to claim_outbox_events apart from that predicate; refuses an empty list, so an empty registry claims nothing. SKIP LOCKED keeps concurrent relays disjoint.';

-- ---------------------------------------------------------------------------------------------------
-- The worker-side read
-- ---------------------------------------------------------------------------------------------------
create or replace function app_private.outbox_event_for_worker(p_id uuid)
returns table (
  id uuid,
  aggregate_type text,
  aggregate_id text,
  event_type text,
  payload jsonb,
  occurred_at timestamptz,
  attempts integer,
  published_at timestamptz,
  completed_at timestamptz,
  dead_lettered_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select e.id,
         e.aggregate_type,
         e.aggregate_id,
         e.event_type,
         e.payload,
         e.occurred_at,
         e.attempts,
         e.published_at,
         e.completed_at,
         e.dead_lettered_at
    from public.outbox_events e
   where e.id = p_id;
$$;
comment on function app_private.outbox_event_for_worker(uuid) is
  'Reads one outbox event for the worker that was handed its id. Returns the settlement columns too, so a handler can skip an event another worker already completed or dead-lettered. Read-only: it claims nothing and settles nothing.';

-- ---------------------------------------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on all functions in schema app_private from public;

grant execute on function
  app_private.claim_outbox_events_for(text[], integer),
  app_private.outbox_event_for_worker(uuid)
  to app_worker;

select app_private.assert_security_contract();
