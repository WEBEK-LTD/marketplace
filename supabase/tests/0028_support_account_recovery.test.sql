-- pgTAP — migration 0028: support tickets, their thread, attachments, internal notes, event history and
-- Realtime topic; account recovery, its two-person rule, the OTP integration, the generic status and
-- the post-recovery hold on withdrawals and payout details.
-- Everything runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;

select plan(62);

-- Fixtures ------------------------------------------------------------------------------------------
insert into public.locales (code, name_en, name_native, direction, is_active, is_default)
values ('zz', 'Test locale', 'Test locale', 'ltr', true, false);
insert into public.currencies (code, numeric_code, symbol, decimal_places, is_enabled, is_default, is_pricing_enabled, is_checkout_enabled)
values ('XTS', '963', 'T', 2, true, false, true, true);
insert into public.countries (code, iso3, numeric_code, name_en, name_ar, phone_code, default_currency_code, is_marketplace_enabled)
values ('ZZ', 'ZZZ', '999', 'Enabled', 'Enabled', '999', 'XTS', true);
-- listing_types (`product`, `service`) are seeded reference data in 0033.

insert into auth.users (id, email) values
  ('aaaaaaaa-1111-4111-8111-111111111111', 'seller@example.test'),
  ('bbbbbbbb-2222-4222-8222-222222222222', 'buyer@example.test'),
  ('eeeeeeee-5555-4555-8555-555555555555', 'stranger@example.test'),
  ('dddddddd-4444-4444-8444-444444444444', 'agent@example.test'),
  ('ffffffff-6666-4666-8666-666666666666', 'approver@example.test');
insert into public.seller_profiles (user_id, slug, display_name, country_code, verification_status, verified_at, status)
values ('aaaaaaaa-1111-4111-8111-111111111111', 'test-seller', 'Test Seller', 'ZZ', 'verified', now(), 'active');

insert into public.checkouts (id, currency_code, buyer_user_id, subtotal_minor, grand_total_minor,
                              commission_snapshot, cancellation_policy_snapshot, status)
values ('bbbb0001-aaaa-4aaa-8aaa-bbbb00000001', 'XTS', 'bbbbbbbb-2222-4222-8222-222222222222', 20000, 20000,
        '{"components":[]}'::jsonb, '{"buyer_window_hours":24}'::jsonb, 'paid');
insert into public.orders (id, currency_code, checkout_id, seller_user_id, buyer_user_id, order_type, status,
                           subtotal_minor, grand_total_minor, paid_at)
values ('01110001-aaaa-4aaa-8aaa-011100000001', 'XTS', 'bbbb0001-aaaa-4aaa-8aaa-bbbb00000001',
        'aaaaaaaa-1111-4111-8111-111111111111', 'bbbbbbbb-2222-4222-8222-222222222222', 'product', 'paid',
        20000, 20000, now());

-- Support: opening --------------------------------------------------------------------------------------
select throws_ok(
  $$select app_private.open_support_ticket(null, 'No account', 'account', 'Help')$$,
  '42501',
  null,
  'support tickets require a signed-in requester'
);
select throws_ok(
  $$select app_private.open_support_ticket('eeeeeeee-5555-4555-8555-555555555555', 'Not mine', 'orders',
      'About this order', '01110001-aaaa-4aaa-8aaa-011100000001')$$,
  '42501',
  null,
  'a ticket can only point at an order the requester was part of'
);
select throws_ok(
  $$insert into public.support_tickets (requester_user_id, subject, category)
    values ('bbbbbbbb-2222-4222-8222-222222222222', 'Bad category', 'weather')$$,
  '23514',
  null,
  'and only the listed categories exist'
);

select lives_ok(
  $$select app_private.open_support_ticket('bbbbbbbb-2222-4222-8222-222222222222',
      'Where is my order?', 'orders', 'It has not arrived.', '01110001-aaaa-4aaa-8aaa-011100000001', 'high')$$,
  'a signed-in buyer opens a ticket about their own order'
);
select matches(
  (select reference from public.support_tickets),
  '^SP-[0-9]{2}-000001$',
  'which gets a ticket reference from the D12 generator'
);
select is(
  (select format('%s/%s/%s', status, priority, message_count) from public.support_tickets),
  'pending_agent/high/1',
  'and opens with its first message, waiting on an agent');
select is(
  (select count(*) from public.support_ticket_events where event_type in ('created', 'message_posted')),
  2::bigint,
  'the event history records both the creation and the message'
);

-- Support: the thread ---------------------------------------------------------------------------------------
select throws_ok(
  $$select app_private.post_support_message((select id from public.support_tickets),
      'eeeeeeee-5555-4555-8555-555555555555', 'Butting in')$$,
  '42501',
  null,
  'a stranger cannot post on somebody else''s ticket'
);
select throws_ok(
  $$select app_private.post_support_message((select id from public.support_tickets),
      'dddddddd-4444-4444-8444-444444444444', 'Looking into it')$$,
  '42501',
  null,
  'and neither can an agent the ticket is not assigned to'
);

select throws_ok(
  $$select app_private.assign_support_ticket((select id from public.support_tickets),
      'bbbbbbbb-2222-4222-8222-222222222222')$$,
  '42501',
  null,
  'a requester cannot be assigned their own ticket'
);

select lives_ok(
  $$select app_private.assign_support_ticket((select id from public.support_tickets),
      'dddddddd-4444-4444-8444-444444444444')$$,
  'the ticket is assigned to an agent'
);
select is(
  (select membership_version from public.support_tickets),
  2,
  'which moves the Realtime membership version'
);
select matches(
  public.support_ticket_topic((select id from public.support_tickets)),
  '^support_ticket:[0-9a-f-]+:v2$',
  'so the topic is a new topic'
);
select ok(
  (select count(*) > 0 from public.outbox_events where event_type = 'support_ticket.membership_changed'),
  'and the membership change is published in the same transaction (UB6)'
);
select is(
  (select count(*) from public.support_ticket_events where event_type = 'assigned'),
  1::bigint,
  'the assignment is in the event history'
);
select is(
  app_private.assign_support_ticket((select id from public.support_tickets),
    'dddddddd-4444-4444-8444-444444444444'),
  (select id from public.support_tickets),
  'assigning the same agent again changes nothing (C10)'
);
select is((select membership_version from public.support_tickets), 2,
  'so the version does not move either');

select lives_ok(
  $$select app_private.post_support_message((select id from public.support_tickets),
      'dddddddd-4444-4444-8444-444444444444', 'Chasing the courier now.')$$,
  'the assigned agent replies'
);
select is(
  (select format('%s/%s', status, author_role) from public.support_tickets t
     join public.support_messages m on m.support_ticket_id = t.id
    where m.body like 'Chasing%'),
  'pending_requester/agent',
  'the ticket now waits on the requester, and the role came from the ticket');
select isnt(
  (select first_response_at from public.support_tickets),
  null,
  'and the first agent response is stamped'
);

-- Support: authorization boundaries ---------------------------------------------------------------------------
select ok(
  public.can_access_support_ticket((select id from public.support_tickets), 'bbbbbbbb-2222-4222-8222-222222222222'),
  'the requester may work on their ticket'
);
select ok(
  public.can_access_support_ticket((select id from public.support_tickets), 'dddddddd-4444-4444-8444-444444444444'),
  'so may the assigned agent'
);
select ok(
  not public.can_access_support_ticket((select id from public.support_tickets), 'eeeeeeee-5555-4555-8555-555555555555'),
  'and nobody else does'
);

-- Support: internal notes are staff-only by table ---------------------------------------------------------------
select throws_ok(
  $$select app_private.add_support_internal_note((select id from public.support_tickets),
      'bbbbbbbb-2222-4222-8222-222222222222', 'Let me in')$$,
  '42501',
  null,
  'the requester can never write an internal note'
);
select lives_ok(
  $$select app_private.add_support_internal_note((select id from public.support_tickets),
      'dddddddd-4444-4444-8444-444444444444', 'Courier claims delivery was attempted.')$$,
  'the assigned agent can'
);
select is((select count(*) from public.support_messages where body like 'Courier%'), 0::bigint,
  'and the note never appears in the message thread');

-- Support: append-only and attachment placement -------------------------------------------------------------------
select throws_ok(
  $$update public.support_messages set body = 'edited'$$,
  '23001',
  null,
  'support messages are append-only'
);
select throws_ok(
  $$update public.support_ticket_events set event_type = 'reopened'$$,
  '23001',
  null,
  'and so is the event history'
);
select throws_ok(
  $$insert into public.support_attachments (support_message_id, object_path)
    values ((select id from public.support_messages limit 1), 'public/photo.jpg')$$,
  '23514',
  null,
  'an attachment never lands outside the private bucket'
);

select is(
  app_private.close_support_ticket((select id from public.support_tickets), 'resolved',
    'dddddddd-4444-4444-8444-444444444444'),
  'resolved',
  'the agent resolves the ticket'
);
-- A resolved ticket still takes a reply; only a closed one does not.
do $$
begin
  perform app_private.close_support_ticket((select id from public.support_tickets), 'closed',
    'dddddddd-4444-4444-8444-444444444444');
end;
$$;

select throws_ok(
  $$select app_private.post_support_message((select id from public.support_tickets),
      'bbbbbbbb-2222-4222-8222-222222222222', 'One more thing')$$,
  '23001',
  null,
  'and a closed ticket takes no more messages'
);

-- Realtime topics stay fail-closed --------------------------------------------------------------------------------
select ok(not public.can_join_realtime_topic('support_ticket:not-a-uuid:v1'),
  'an unparsable ticket topic joins nothing');
select ok(not public.can_join_realtime_topic('support_ticket'),
  'and neither does a malformed one');
select ok(not public.can_join_realtime_topic(null), 'nor a missing one');

-- Account recovery: the generic response ---------------------------------------------------------------------------
do $$
begin
  perform app_private.open_recovery_request('email', extensions.digest('locked@example.test', 'sha256'),
    'aaaaaaaa-1111-4111-8111-111111111111');
  perform app_private.open_recovery_request('email', extensions.digest('nobody@example.test', 'sha256'), null);
end;
$$;

select is((select count(*) from public.account_recovery_requests), 2::bigint,
  'a request is recorded whether or not the contact matched an account');
select is(
  (select count(distinct public.recovery_request_status(id)) from public.account_recovery_requests),
  1::bigint,
  'and both read back with the same neutral status, so the response cannot reveal a match'
);
select is(
  (select public.recovery_request_status(id) from public.account_recovery_requests where user_id is null),
  'in_progress',
  'which is in_progress while it is moving'
);
select hasnt_column('public', 'account_recovery_requests', 'claimed_contact',
  'there is no column a contact address could be written to in the clear');

-- Account recovery: two people, neither of them the account ----------------------------------------------------------
select throws_ok(
  $$select app_private.review_recovery_request(
      (select id from public.account_recovery_requests where user_id is not null),
      'aaaaaaaa-1111-4111-8111-111111111111')$$,
  '42501',
  null,
  'nobody reviews their own recovery'
);
select lives_ok(
  $$select app_private.review_recovery_request(
      (select id from public.account_recovery_requests where user_id is not null),
      'dddddddd-4444-4444-8444-444444444444', 'Identity documents match the account')$$,
  'a reviewer records the identity review'
);
select throws_ok(
  $$select app_private.decide_recovery_request(
      (select id from public.account_recovery_requests where user_id is not null),
      'dddddddd-4444-4444-8444-444444444444', 'approved')$$,
  '42501',
  null,
  'the reviewer can never approve their own review'
);
select throws_ok(
  $$select app_private.decide_recovery_request(
      (select id from public.account_recovery_requests where user_id is not null),
      'aaaaaaaa-1111-4111-8111-111111111111', 'approved')$$,
  '42501',
  null,
  'and nobody approves their own recovery'
);
select throws_ok(
  $$select app_private.decide_recovery_request(
      (select id from public.account_recovery_requests where user_id is not null),
      'ffffffff-6666-4666-8666-666666666666', 'rejected')$$,
  '23514',
  null,
  'a rejection is always recorded with its reason'
);

select is(
  app_private.decide_recovery_request(
    (select id from public.account_recovery_requests where user_id is not null),
    'ffffffff-6666-4666-8666-666666666666', 'approved', 'Second approver satisfied'),
  'approved',
  'a second approver who is not the reviewer approves it'
);
select is(
  (select status from public.account_recovery_requests where user_id is not null),
  'contact_verification',
  'and the request moves on to verifying the new contact'
);
select throws_ok(
  $$update public.account_recovery_approvals set decision = 'rejected'$$,
  '23001',
  null,
  'the approval record is append-only'
);

-- Account recovery: the contact is proved by 0004's own one-time code ----------------------------------------------------
insert into app_private.otp_challenges (id, user_id, purpose, channel, destination_hash, code_hash, expires_at) values
  ('c0000001-aaaa-4aaa-8aaa-c00000000001', 'aaaaaaaa-1111-4111-8111-111111111111', 'recovery', 'email',
   extensions.digest('new@example.test', 'sha256'), extensions.digest('123456', 'sha256'), now() + interval '10 minutes'),
  ('c0000002-aaaa-4aaa-8aaa-c00000000002', 'aaaaaaaa-1111-4111-8111-111111111111', 'step_up', 'email',
   extensions.digest('new@example.test', 'sha256'), extensions.digest('654321', 'sha256'), now() + interval '10 minutes');

select throws_ok(
  $$select app_private.verify_recovery_contact(
      (select id from public.account_recovery_requests where user_id is not null),
      'c0000001-aaaa-4aaa-8aaa-c00000000001', 'email', extensions.digest('new@example.test', 'sha256'))$$,
  '42501',
  null,
  'an unconsumed challenge proves nothing'
);

update app_private.otp_challenges set consumed_at = now() where id in (
  'c0000001-aaaa-4aaa-8aaa-c00000000001', 'c0000002-aaaa-4aaa-8aaa-c00000000002');

select throws_ok(
  $$select app_private.verify_recovery_contact(
      (select id from public.account_recovery_requests where user_id is not null),
      'c0000002-aaaa-4aaa-8aaa-c00000000002', 'email', extensions.digest('new@example.test', 'sha256'))$$,
  '42501',
  null,
  'and neither does a challenge issued for something other than recovery'
);
select throws_ok(
  $$select app_private.verify_recovery_contact(
      (select id from public.account_recovery_requests where user_id is not null),
      'c0000001-aaaa-4aaa-8aaa-c00000000001', 'email', extensions.digest('other@example.test', 'sha256'))$$,
  '42501',
  null,
  'nor one sent to a different contact'
);

select is(
  app_private.verify_recovery_contact(
    (select id from public.account_recovery_requests where user_id is not null),
    'c0000001-aaaa-4aaa-8aaa-c00000000001', 'email', extensions.digest('new@example.test', 'sha256')),
  'verified',
  'a consumed recovery challenge for the right contact does'
);

-- Account recovery: completing, and the 72-hour hold -----------------------------------------------------------------------
select throws_ok(
  $$select app_private.complete_recovery_request(
      (select id from public.account_recovery_requests where user_id is null),
      'dddddddd-4444-4444-8444-444444444444')$$,
  '23001',
  null,
  'a request that matched no account can never complete'
);

select isnt(
  app_private.complete_recovery_request(
    (select id from public.account_recovery_requests where user_id is not null),
    'dddddddd-4444-4444-8444-444444444444', true),
  null,
  'the recovery completes and returns when its hold ends'
);
select is(
  (select format('%s/%s', status,
                 case when sessions_revoked_at is not null then 'revoked' else 'not revoked' end)
     from public.account_recovery_requests where user_id is not null),
  'completed/revoked',
  'sessions are recorded as revoked');
select ok(
  (select hold_until between now() + interval '71 hours' and now() + interval '73 hours'
     from public.account_recovery_requests where user_id is not null),
  'and the configured 72-hour hold is set'
);
select ok(
  (select count(*) > 0 from public.security_events
    where user_id = 'aaaaaaaa-1111-4111-8111-111111111111' and event_type = 'account_recovery.completed'),
  'the account''s own security log carries the step'
);
select is(
  public.recovery_request_status((select id from public.account_recovery_requests where user_id is not null)),
  'completed',
  'and the requester is told only that it completed'
);

select ok(public.user_has_security_hold('aaaaaaaa-1111-4111-8111-111111111111', 'withdrawal'),
  'withdrawals are held');
select ok(public.user_has_security_hold('aaaaaaaa-1111-4111-8111-111111111111', 'payout_details'),
  'payout-detail changes are held');
select ok(
  not public.user_has_security_hold('aaaaaaaa-1111-4111-8111-111111111111', 'login'),
  'and the hold never spreads to anything else'
);
select ok(
  not public.user_has_security_hold('bbbbbbbb-2222-4222-8222-222222222222', 'withdrawal'),
  'nor to anybody else'
);

-- The hold is enforced where the specification says it is ------------------------------------------------------------------
insert into public.withdrawal_limits (currency_code, min_amount_minor) values ('XTS', 1000);
do $$
begin
  perform app_private.ensure_seller_balance('aaaaaaaa-1111-4111-8111-111111111111', 'XTS');
  perform app_private.post_ledger_journal('adjustment', 'XTS', jsonb_build_array(
    jsonb_build_object('account_type', 'provider_clearing', 'direction', 'debit', 'amount_minor', 50000),
    jsonb_build_object('account_type', 'seller_available', 'seller_user_id', 'aaaaaaaa-1111-4111-8111-111111111111',
                       'direction', 'credit', 'amount_minor', 50000)
  ), 'manual', 'opening', 'opening:1', 'Opening balance');
end;
$$;

select throws_ok(
  $$select app_private.request_withdrawal('aaaaaaaa-1111-4111-8111-111111111111', 'XTS', 20000, 'wd-held')$$,
  '23001',
  null,
  'a withdrawal is refused while the post-recovery hold is running'
);

update public.account_recovery_requests set hold_until = now() - interval '1 hour' where user_id is not null;
select lives_ok(
  $$select app_private.request_withdrawal('aaaaaaaa-1111-4111-8111-111111111111', 'XTS', 20000, 'wd-free')$$,
  'and allowed once the hold has passed, with every other 0021 rule still in force'
);

select * from finish();
rollback;
