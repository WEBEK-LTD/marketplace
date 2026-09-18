-- 0006 — Append-only audit log with monthly partitions and a generic audit trigger (v5.2 migration plan).
--
-- `audit.audit_logs` is partitioned by month (v5.2 "Monthly partitions"), append-only (updates and
-- deletes are rejected by a trigger) and reachable only through a permission-gated read policy.
-- `audit.ensure_partitions()` is idempotent and is called by the pg_cron job added in 0032.

create table audit.audit_logs (
  id bigint generated always as identity,
  occurred_at timestamptz not null default now(),
  actor_id uuid,
  actor_type text not null default 'user',
  action text not null,
  table_schema name,
  table_name name,
  record_id text,
  changed_columns text[],
  old_values jsonb,
  new_values jsonb,
  request_id text,
  request_ip inet,
  details jsonb not null default '{}'::jsonb,
  primary key (id, occurred_at),
  constraint audit_logs_actor_type_allowed check (actor_type in ('user', 'system', 'worker', 'anonymous')),
  constraint audit_logs_action_format check (action ~ '^[a-z][a-z0-9_.]*$'),
  constraint audit_logs_details_is_object check (jsonb_typeof(details) = 'object'),
  constraint audit_logs_values_are_objects check (
    (old_values is null or jsonb_typeof(old_values) = 'object')
    and (new_values is null or jsonb_typeof(new_values) = 'object')
  )
) partition by range (occurred_at);

comment on table audit.audit_logs is
  'Append-only audit trail, partitioned by month. Values are redacted by the calling trigger; credentials never reach this table.';

create index audit_logs_occurred_at on audit.audit_logs (occurred_at desc);
create index audit_logs_actor on audit.audit_logs (actor_id, occurred_at desc);
create index audit_logs_record on audit.audit_logs (table_schema, table_name, record_id, occurred_at desc);

create trigger audit_logs_append_only before update or delete on audit.audit_logs
  for each row execute function app_private.tg_reject_write();

-- ---------------------------------------------------------------------------------------------------
-- Partition management
-- ---------------------------------------------------------------------------------------------------
create or replace function audit.ensure_partition(p_month date) returns text
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  month_start date := date_trunc('month', p_month)::date;
  month_end date := (date_trunc('month', p_month) + interval '1 month')::date;
  partition_name text := format('audit_logs_%s', to_char(month_start, 'YYYYMM'));
begin
  if to_regclass(format('audit.%I', partition_name)) is null then
    execute format(
      'create table audit.%I partition of audit.audit_logs for values from (%L) to (%L)',
      partition_name, month_start, month_end
    );
    -- RLS is not inherited by partitions, and a partition is directly addressable. Without this, the
    -- 0031 guard migration ("fails if any table lacks RLS") would be the first thing to notice.
    execute format('alter table audit.%I enable row level security', partition_name);
    execute format('revoke all on audit.%I from public, anon, authenticated', partition_name);
  end if;
  return partition_name;
end;
$$;
comment on function audit.ensure_partition(date) is 'Creates the monthly partition covering the given date if it does not exist yet.';

create or replace function audit.ensure_partitions(p_months_ahead integer default 3) returns integer
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  offset_month integer;
  created integer := 0;
begin
  if p_months_ahead < 0 or p_months_ahead > 24 then
    raise exception 'p_months_ahead must be between 0 and 24';
  end if;
  for offset_month in -1 .. p_months_ahead loop
    perform audit.ensure_partition((date_trunc('month', now()) + make_interval(months => offset_month))::date);
    created := created + 1;
  end loop;
  return created;
end;
$$;
comment on function audit.ensure_partitions(integer) is
  'Keeps last month, this month and the next p_months_ahead months partitioned. Idempotent; scheduled by pg_cron in 0032.';

select audit.ensure_partitions(3);

-- ---------------------------------------------------------------------------------------------------
-- Generic audit trigger
-- ---------------------------------------------------------------------------------------------------
-- Attach with: create trigger <name> after insert or update or delete on <table>
--                for each row execute function audit.tg_record_change('col_a', 'col_b');
-- The trigger arguments name columns whose values must never be written to the log.
create or replace function audit.tg_record_change() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  redacted text[] := coalesce(tg_argv, '{}'::text[]);
  old_row jsonb;
  new_row jsonb;
  changed text[];
  key text;
  actor uuid := public.current_user_id();
begin
  if tg_op <> 'INSERT' then
    old_row := to_jsonb(old);
  end if;
  if tg_op <> 'DELETE' then
    new_row := to_jsonb(new);
  end if;

  foreach key in array redacted loop
    if old_row ? key then old_row := jsonb_set(old_row, array[key], '"[redacted]"'::jsonb); end if;
    if new_row ? key then new_row := jsonb_set(new_row, array[key], '"[redacted]"'::jsonb); end if;
  end loop;

  if tg_op = 'UPDATE' then
    select coalesce(array_agg(k order by k), '{}'::text[])
      into changed
      from jsonb_object_keys(new_row) as k
      where new_row -> k is distinct from old_row -> k;
    if array_length(changed, 1) is null then
      return null;
    end if;
  end if;

  insert into audit.audit_logs (
    actor_id, actor_type, action, table_schema, table_name, record_id, changed_columns, old_values, new_values
  )
  values (
    actor,
    case when actor is null then 'system' else 'user' end,
    lower(tg_op),
    tg_table_schema,
    tg_table_name,
    coalesce(new_row, old_row) ->> 'id',
    changed,
    old_row,
    new_row
  );
  return null;
end;
$$;
comment on function audit.tg_record_change() is
  'AFTER ROW trigger writing one audit entry per change. Trigger arguments name columns to redact.';

-- ---------------------------------------------------------------------------------------------------
-- Explicit audit entries
-- ---------------------------------------------------------------------------------------------------
create or replace function public.record_audit_event(
  p_action text,
  p_details jsonb default '{}'::jsonb,
  p_table_schema name default null,
  p_table_name name default null,
  p_record_id text default null
) returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor uuid := public.current_user_id();
  new_id bigint;
begin
  insert into audit.audit_logs (actor_id, actor_type, action, table_schema, table_name, record_id, details)
  values (actor, case when actor is null then 'system' else 'user' end, p_action, p_table_schema, p_table_name, p_record_id, coalesce(p_details, '{}'::jsonb))
  returning id into new_id;
  return new_id;
end;
$$;
comment on function public.record_audit_event(text, jsonb, name, name, text) is
  'Records an audit entry for an action that is not a single row change. The actor comes from the verified claims.';

-- ---------------------------------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------------------------------
alter table audit.audit_logs enable row level security;

create policy audit_logs_admin_read on audit.audit_logs for select to authenticated
  using (public.has_permission('audit.read') and public.is_aal2());

-- Reading the audit log needs USAGE on the schema as well as the policy above.
grant usage on schema audit to authenticated;
grant select on audit.audit_logs to authenticated;

-- ---------------------------------------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------------------------------------
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema audit from public;

grant execute on function public.record_audit_event(text, jsonb, name, name, text) to authenticated;
grant execute on function audit.ensure_partitions(integer), audit.ensure_partition(date) to app_system, app_worker;
