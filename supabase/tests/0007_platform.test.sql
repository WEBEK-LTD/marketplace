-- pgTAP — migration 0007: outbox lifecycle, idempotency keys and job runs.
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(19);

-- Outbox ---------------------------------------------------------------------------------------------
select ok(
  public.enqueue_outbox_event('order', 'order-1', 'order.placed', '{"order_id":"order-1"}'::jsonb) is not null,
  'an outbox event can be appended inside a transaction'
);
select is((select count(*) from public.outbox_events where published_at is null), 1::bigint,
  'the new event starts unpublished');

select throws_ok(
  $$select public.enqueue_outbox_event('order', 'order-2', 'badtype', '{}'::jsonb)$$,
  '23514',
  null,
  'an event type without a dotted suffix is rejected'
);
select throws_ok(
  $$select public.enqueue_outbox_event('order', 'order-2', 'order.placed', '[]'::jsonb)$$,
  '23514',
  null,
  'a payload that is not an object is rejected'
);

create temp table claimed as select * from app_private.claim_outbox_events(10);
select is((select count(*) from claimed), 1::bigint, 'the relay claims the pending event');
select is((select attempts from claimed), 1, 'claiming counts an attempt');
select is((select count(*) from app_private.claim_outbox_events(10)), 0::bigint,
  'a claimed event is not handed out twice');

select ok(app_private.complete_outbox_event((select id from claimed)), 'completion is recorded by event id');
select ok(not app_private.complete_outbox_event((select id from claimed)),
  'completing the same event again is a no-op, so handlers stay idempotent');
select is((select count(*) from public.outbox_events where completed_at is not null), 1::bigint,
  'the event is marked completed');

-- Sweeper --------------------------------------------------------------------------------------------
create temp table stale as
select public.enqueue_outbox_event('order', 'order-3', 'order.paid', '{"order_id":"order-3"}'::jsonb) as id;
update public.outbox_events set published_at = now() - interval '1 hour' where aggregate_id = 'order-3';

select is(app_private.sweep_outbox_events(interval '5 minutes', 10), 1,
  'the sweeper returns an uncompleted published event to the pending state');
select is((select count(*) from app_private.claim_outbox_events(10)), 1::bigint,
  'the swept event is published again');

-- Dead letter ----------------------------------------------------------------------------------------
select ok(app_private.dead_letter_outbox_event((select id from stale), 'HandlerError'), 'a poison event can be dead-lettered');
select is((select count(*) from app_private.claim_outbox_events(10)), 0::bigint,
  'a dead-lettered event is never claimed again');

-- Idempotency ----------------------------------------------------------------------------------------
select is(
  (select claimed from public.claim_idempotency_key('orders.create', 'key-0000001', '\x01'::bytea)),
  true,
  'the first request claims the key'
);
select is(
  (select claimed from public.claim_idempotency_key('orders.create', 'key-0000001', '\x01'::bytea)),
  false,
  'a repeat of the same request replays instead of claiming'
);
select throws_ok(
  $$select * from public.claim_idempotency_key('orders.create', 'key-0000001', '\x02'::bytea)$$,
  '23505',
  null,
  'the same key with a different request is rejected'
);

-- Job runs -------------------------------------------------------------------------------------------
select ok(
  app_private.start_job_run('outbox.sweep', timestamptz '2026-01-01 00:00:00+00') is not null,
  'a scheduled job run can start'
);
select is(
  app_private.start_job_run('outbox.sweep', timestamptz '2026-01-01 00:00:00+00'),
  null,
  'the same scheduled run cannot start twice'
);

select * from finish();
rollback;
