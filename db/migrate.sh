#!/bin/sh
# Apply pending migrations in order, then (re)create the seed functions.
# Usage: DATABASE_URL=postgresql://... sh db/migrate.sh
set -eu

: "${DATABASE_URL:?DATABASE_URL must be set}"
dir="$(cd "$(dirname "$0")" && pwd)"
psql_q() { PGOPTIONS="-c client_min_messages=warning" psql "$DATABASE_URL" -q -X -v ON_ERROR_STOP=1 "$@"; }

psql_q -c "create table if not exists schema_migrations (
  filename text primary key,
  applied_at timestamptz not null default now()
)"

for file in "$dir"/migrations/*.sql; do
  name="$(basename "$file")"
  applied="$(psql_q -At -v name="$name" <<'SQL'
select count(*) from schema_migrations where filename = :'name';
SQL
)"
  if [ "$applied" = "0" ]; then
    echo "applying $name"
    psql_q --single-transaction -v name="$name" -f "$file" -f - <<'SQL'
insert into schema_migrations (filename) values (:'name');
SQL
  fi
done

# Seed templates are `create or replace function` definitions, safe to re-run every time.
for file in "$dir"/seeds/*.sql; do
  psql_q -f "$file"
done
