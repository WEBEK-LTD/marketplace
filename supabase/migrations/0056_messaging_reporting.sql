-- 0056 — Reporting a message or a conversation (Phase 5-H).
--
-- One function, and it exists for exactly one reason: **authorization**. 0027 already owns reporting —
-- the table, the reason vocabulary, the one-open-report-per-reporter-per-subject index, the outbox event
-- and the `file_report()` entry point. What 0027 does not do, and correctly does not do, is decide
-- whether a particular reporter may see a particular message: a report is polymorphic, its subject may be
-- a listing or a review or a person, and `file_report()` is deliberately ignorant of each subject's own
-- access rules.
--
-- Messaging's access rules live in 0014 and 0053 and cannot be checked from the application layer:
-- `app_system` holds no table privileges, so nothing outside a SECURITY DEFINER function can ask whether
-- a message belongs to a conversation the caller is in. Hence this wrapper — a gate in front of
-- `file_report()`, not a second reporting system. No new table, no new reason, no new dedupe mechanism,
-- no moderation action, and nothing that touches the message, the conversation or the membership.
--
-- **What it refuses, and how.** A message or conversation the caller cannot read, and one that does not
-- exist, produce the same `not_found` from the same branch — the same indistinguishability 0053 and 0054
-- already keep. There is no "it exists but you may not report it" outcome, because that sentence is the
-- leak.
--
-- **Who may report.** Anybody who has *ever* been a participant. That is 0053's own rule for reading a
-- thread: leaving a conversation does not unsee what was said in it, and somebody who left because of
-- what was said in it is precisely the person most likely to report it.
--
-- **What it does not do.** Filing a report changes nothing else. The message stays readable, the
-- conversation stays open, membership, mute state and read markers are untouched, nobody is blocked, and
-- no moderation action is created — moderation is a decision, and this is a request for a look.

-- ---------------------------------------------------------------------------------------------------
-- Reporting from inside a conversation
-- ---------------------------------------------------------------------------------------------------
-- Outcomes:
--
--   * `filed`     — a report is open for this reporter and this subject. Either it was just created or
--                   it already existed; `file_report()` returns the same id for both, which is 0027's
--                   C10 guarantee and the whole of the dedupe behaviour. This function adds none of its
--                   own.
--   * `not_found` — the subject is not one the caller may report, or is not there at all. One branch,
--                   one answer.
--   * `invalid`   — a subject type this path does not own. A message and a conversation are reportable
--                   from a conversation; a seller, a listing or a user is somebody else's surface.
create or replace function app_private.messaging_file_report(
  p_user_id uuid,
  p_subject_type text,
  p_subject_id uuid,
  p_reason_code text,
  p_details text default null
) returns table (
  outcome text,
  report_id uuid
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_readable boolean;
  v_report uuid;
begin
  if p_subject_type not in ('message', 'conversation') or p_subject_id is null then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;

  if p_subject_type = 'conversation' then
    -- Ever a participant, exactly as 0053's message reader admits one: `left_at` is history, not a
    -- revocation of what they already saw.
    select exists (
      select 1 from public.conversation_participants p
       where p.conversation_id = p_subject_id
         and p.user_id = p_user_id
    ) into v_readable;
  else
    -- A message is reportable when it exists *and* it is in a conversation the caller is a participant
    -- of. The two conditions are one query, so "no such message" and "not your message" cannot diverge.
    select exists (
      select 1
        from public.messages m
        join public.conversation_participants p
          on p.conversation_id = m.conversation_id
         and p.user_id = p_user_id
       where m.id = p_subject_id
    ) into v_readable;
  end if;

  if not v_readable then
    return query select 'not_found'::text, null::uuid;
    return;
  end if;

  -- 0027's own entry point, unchanged: it owns the reason vocabulary, the one-open-report index, the
  -- C10 early return that makes a repeat land on the report already open, and the `report.filed` outbox
  -- event. Nothing is re-implemented here and no second event is emitted.
  v_report := app_private.file_report(p_user_id, p_subject_type, p_subject_id, p_reason_code, p_details);

  return query select 'filed'::text, v_report;
end;
$$;
comment on function app_private.messaging_file_report(uuid, text, uuid, text, text) is
  'Files a report about a message or a conversation the caller can actually read, through 0027''s file_report. Authorization is the only thing this adds: a subject the caller may not read and one that does not exist answer identically, and any other subject type is refused as invalid. Creates no moderation action and changes nothing about the message, the conversation, the membership, the mute state or the read markers.';

-- ---------------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------------
-- S8 unchanged: one named function, PUBLIC revoked, `app_system` only. `authenticated` gains nothing and
-- no table privilege is granted anywhere.
revoke execute on function app_private.messaging_file_report(uuid, text, uuid, text, text) from public;
grant execute on function app_private.messaging_file_report(uuid, text, uuid, text, text) to app_system;

-- ---------------------------------------------------------------------------------------------------
-- The security contract still holds
-- ---------------------------------------------------------------------------------------------------
do $$
begin
  perform app_private.assert_security_contract();
end;
$$;
