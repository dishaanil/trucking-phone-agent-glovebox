-- 002_ledger.sql
-- Idempotency keys, ticket ownership, and one active scale ticket per load. See docs/SPEC.md section 7.

-- Single source of idempotency for every agent write. The key row is inserted in the same
-- transaction as the write, so a key never exists without its result.
create table idempotency_keys (
  sandbox_id uuid not null references sandboxes(id) on delete cascade,
  key text not null,                           -- {call_id}:{turn_index}:{tool_call_index}:{tool_name}
  request_hash text not null,                  -- same key with a different request is a conflict
  status_code int,
  response jsonb,
  created_at timestamptz not null default now(),
  primary key (sandbox_id, key)
);

alter table expenses drop column idempotency_key;
alter table scale_tickets drop column idempotency_key;

-- Who logged the ticket (voids and role checks). Null for seed data.
alter table scale_tickets add column person_id uuid references people(id);
alter table scale_tickets add column updated_at timestamptz not null default now();

-- Corrections update the existing ticket; a load never has two active tickets.
create unique index scale_tickets_one_active_per_load
  on scale_tickets (sandbox_id, load_id)
  where status in ('pending', 'confirmed');
