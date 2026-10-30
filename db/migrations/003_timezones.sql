-- 003_timezones.sql
-- Business and stop timezones. See docs/SPEC.md sections 5 and 8.

-- "This week" ranges are computed in the business's timezone.
alter table businesses add column timezone text not null default 'America/Chicago';

-- Local stop times ("got there 7:50") resolve in the facility's timezone,
-- falling back to the business timezone when null.
alter table stops add column timezone text;
