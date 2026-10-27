-- Seed template: owner-operator scenario (Kestrel Line Freight LLC).
-- All names, numbers and amounts are fictional.
-- Applied with `create or replace` on every db/migrate.sh run; called by the API as
--   select seed_owner_operator($1)
-- Dates are relative to `p_now` (default: now) in America/Chicago, so the demo always looks current.
-- Activity "this week" falls between Monday 00:00 and now; load 4390 falls in the previous week.

drop function if exists seed_owner_operator(uuid);

create or replace function seed_owner_operator(p_sandbox_id uuid, p_now timestamptz default now())
returns void
language plpgsql as $$
declare
  tz constant text := 'America/Chicago';
  v_today date := (p_now at time zone tz)::date;
  v_monday date := (seed_week_start(p_now, tz) at time zone tz)::date;
  v_business uuid;
  v_mike uuid;
  v_truck uuid;
  v_bluegate uuid;
  v_4471 uuid;
  v_4502 uuid;
  v_4390 uuid;
begin
  insert into businesses (sandbox_id, name, demo_dot)
  values (p_sandbox_id, 'Kestrel Line Freight LLC', 'DEMO-0001')
  returning id into v_business;

  insert into people (sandbox_id, business_id, seed_key, full_name, is_owner, is_driver, seed_phone, timezone)
  values (p_sandbox_id, v_business, 'mike', 'Mike Delgren', true, true, '+12705550101', tz)
  returning id into v_mike;

  insert into trucks (sandbox_id, business_id, unit_number, assigned_person_id, trailer_type)
  values (p_sandbox_id, v_business, '1', v_mike, 'dry_van')
  returning id into v_truck;

  insert into payers (sandbox_id, name, type, pays_detention, detention_free_minutes,
                      detention_rate_cents_per_hour, detention_increment_minutes,
                      detention_requires_on_time, late_grace_minutes)
  values (p_sandbox_id, 'Bluegate Freight Partners', 'broker', true, 120, 5000, 15, true, 15)
  returning id into v_bluegate;

  -- Load 4471: in transit, Chicago to Atlanta. Stop times are left empty for the demo to fill.
  insert into loads (sandbox_id, business_id, truck_id, driver_id, payer_id, load_number, commodity,
                     rate_type, rate_cents, loaded_miles, status)
  values (p_sandbox_id, v_business, v_truck, v_mike, v_bluegate, '4471', 'general freight',
          'flat', 240000, 715, 'in_transit')
  returning id into v_4471;

  insert into stops (sandbox_id, load_id, type, sequence, facility_name, city, state, appointment_at)
  values
    (p_sandbox_id, v_4471, 'pickup', 1, 'Harlan Point Cold Storage', 'Chicago', 'IL',
     (v_today + time '08:00') at time zone tz),
    (p_sandbox_id, v_4471, 'delivery', 2, 'Southmere Distribution', 'Atlanta', 'GA',
     (v_today + 1 + time '14:00') at time zone tz);

  -- Load 4502: booked for later this week (gives the "which load?" question).
  insert into loads (sandbox_id, business_id, truck_id, driver_id, payer_id, load_number, commodity,
                     rate_type, rate_cents, loaded_miles, status)
  values (p_sandbox_id, v_business, v_truck, v_mike, v_bluegate, '4502', 'general freight',
          'flat', 165000, 390, 'booked')
  returning id into v_4502;

  insert into stops (sandbox_id, load_id, type, sequence, facility_name, city, state, appointment_at)
  values
    (p_sandbox_id, v_4502, 'pickup', 1, 'Corliss Packaging', 'Atlanta', 'GA',
     (v_today + 2 + time '09:00') at time zone tz),
    (p_sandbox_id, v_4502, 'delivery', 2, 'Tamsin Foods Warehouse', 'Memphis', 'TN',
     (v_today + 3 + time '07:00') at time zone tz);

  -- Load 4390: delivered last week (Thursday to Friday), invoiced Saturday, unpaid.
  insert into loads (sandbox_id, business_id, truck_id, driver_id, payer_id, load_number, commodity,
                     rate_type, rate_cents, loaded_miles, status, invoiced_at)
  values (p_sandbox_id, v_business, v_truck, v_mike, v_bluegate, '4390', 'general freight',
          'flat', 210000, 640, 'invoiced', (v_monday - 2 + time '10:00') at time zone tz)
  returning id into v_4390;

  insert into stops (sandbox_id, load_id, type, sequence, facility_name, city, state,
                     appointment_at, arrived_at, departed_at)
  values
    (p_sandbox_id, v_4390, 'pickup', 1, 'Orrin Valley Foods', 'Indianapolis', 'IN',
     (v_monday - 4 + time '07:00') at time zone tz,
     (v_monday - 4 + time '06:45') at time zone tz,
     (v_monday - 4 + time '08:30') at time zone tz),
    (p_sandbox_id, v_4390, 'delivery', 2, 'Lakemont Grocery DC', 'Joliet', 'IL',
     (v_monday - 3 + time '13:00') at time zone tz,
     (v_monday - 3 + time '12:40') at time zone tz,
     (v_monday - 3 + time '14:10') at time zone tz);

  -- Existing confirmed expenses on 4471: one toll, one scale fee.
  insert into expenses (sandbox_id, business_id, truck_id, person_id, load_id, category, amount_cents,
                        city, state, payment_method, occurred_at, status, receipt_status, source)
  values
    (p_sandbox_id, v_business, v_truck, v_mike, v_4471, 'toll', 1675,
     'Gary', 'IN', 'card', seed_this_week(p_now, tz, 0.90, interval '90 minutes'), 'confirmed', 'attached', 'seed'),
    (p_sandbox_id, v_business, v_truck, v_mike, v_4471, 'scale_fee', 1500,
     'Merrillville', 'IN', 'card', seed_this_week(p_now, tz, 0.95, interval '60 minutes'), 'confirmed', 'attached', 'seed');
end;
$$;
