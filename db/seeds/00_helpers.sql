-- Helpers shared by the seed templates. Applied before them (files run in name order).

-- Monday 00:00 of the week containing `p_now`, in `p_tz`. "This week" starts here.
create or replace function seed_week_start(p_now timestamptz, p_tz text) returns timestamptz
language sql immutable as $$
  select date_trunc('week', p_now at time zone p_tz) at time zone p_tz
$$;

-- A timestamp "this week": a realistic `p_ago` before `p_now`, but never before the week start.
-- Early in the week the realistic offset would fall into last week, so the time is placed at
-- `p_fraction` (0 to 1) of the way from the week start to `p_now` instead.
-- Larger fractions paired with smaller offsets keep events in the same order either way.
create or replace function seed_this_week(
  p_now timestamptz, p_tz text, p_fraction double precision, p_ago interval
) returns timestamptz
language sql immutable as $$
  select greatest(p_now - p_ago, w.start + (p_now - w.start) * p_fraction)
    from (select seed_week_start(p_now, p_tz) as start) w
$$;
