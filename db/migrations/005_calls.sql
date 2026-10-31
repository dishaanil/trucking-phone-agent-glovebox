-- 005_calls.sql
-- One row per agent call, for the dashboard's live call panel. See docs/SPEC.md section 7.
-- A call that never reports its end (agent crash, dropped connection) is ended by a timeout.

create table calls (
  sandbox_id uuid not null references sandboxes(id) on delete cascade,
  call_id text not null,
  person_id uuid not null references people(id) on delete cascade,
  access text not null,                        -- 'phone' | 'demo_code'
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  end_reason text,                             -- completed | caller_hung_up | transferred | silence | error | timeout
  primary key (sandbox_id, call_id)
);

create index calls_open on calls (started_at) where ended_at is null;
