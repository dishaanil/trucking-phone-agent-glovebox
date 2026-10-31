-- 004_event_notify.sql
-- Wake the API's SSE listener when an event is committed. See docs/SPEC.md section 7.
-- The payload carries ids only (NOTIFY payloads are capped at 8 KB); the API reads the row.
-- NOTIFY is delivered at commit, so rolled-back events are never announced.

create function notify_event() returns trigger
language plpgsql as $$
begin
  perform pg_notify('glovebox_events', json_build_object('sandbox_id', new.sandbox_id, 'id', new.id)::text);
  return new;
end;
$$;

create trigger events_notify after insert on events
  for each row execute function notify_event();
