-- Seed template: small fleet scenario (Cedar Fork Hauling LLC, grain hauling, western Kentucky).
-- All names, numbers and amounts are fictional.
-- Applied with `create or replace` on every db/migrate.sh run; called by the API as
--   select seed_small_fleet($1)
-- Dates are relative to the moment of the call, in America/Chicago, so the demo always looks current.

create or replace function seed_small_fleet(p_sandbox_id uuid) returns void
language plpgsql as $$
declare
  tz constant text := 'America/Chicago';
  v_today date := (now() at time zone tz)::date;
  v_business uuid;
  v_ray uuid;
  v_tommy uuid;
  v_luis uuid;
  v_truck1 uuid;
  v_truck2 uuid;
  v_truck3 uuid;
  v_millbrook uuid;
  v_prairie uuid;
  v_7712 uuid;
  v_7705 uuid;
  v_7708 uuid;
  v_7710 uuid;
begin
  insert into businesses (sandbox_id, name, demo_dot)
  values (p_sandbox_id, 'Cedar Fork Hauling LLC', 'DEMO-0002')
  returning id into v_business;

  insert into people (sandbox_id, business_id, seed_key, full_name, is_owner, is_driver, seed_phone, timezone)
  values (p_sandbox_id, v_business, 'ray', 'Ray Whitlock', true, true, '+12705550111', tz)
  returning id into v_ray;
  insert into people (sandbox_id, business_id, seed_key, full_name, is_owner, is_driver, seed_phone, timezone)
  values (p_sandbox_id, v_business, 'tommy', 'Tommy Reece', false, true, '+12705550112', tz)
  returning id into v_tommy;
  insert into people (sandbox_id, business_id, seed_key, full_name, is_owner, is_driver, seed_phone, timezone)
  values (p_sandbox_id, v_business, 'luis', 'Luis Ortega', false, true, '+12705550113', tz)
  returning id into v_luis;

  insert into trucks (sandbox_id, business_id, unit_number, assigned_person_id, trailer_type)
  values (p_sandbox_id, v_business, '1', v_ray, 'hopper_bottom') returning id into v_truck1;
  insert into trucks (sandbox_id, business_id, unit_number, assigned_person_id, trailer_type)
  values (p_sandbox_id, v_business, '2', v_tommy, 'hopper_bottom') returning id into v_truck2;
  insert into trucks (sandbox_id, business_id, unit_number, assigned_person_id, trailer_type)
  values (p_sandbox_id, v_business, '3', v_luis, 'hopper_bottom') returning id into v_truck3;

  insert into payers (sandbox_id, name, type, pays_detention, detention_free_minutes,
                      detention_rate_cents_per_hour, detention_increment_minutes,
                      detention_requires_on_time, late_grace_minutes)
  values (p_sandbox_id, 'Millbrook Grain Co.', 'receiver', false, null, null, null, null, null)
  returning id into v_millbrook;
  insert into payers (sandbox_id, name, type, pays_detention, detention_free_minutes,
                      detention_rate_cents_per_hour, detention_increment_minutes,
                      detention_requires_on_time, late_grace_minutes)
  values (p_sandbox_id, 'Prairie Run Brokerage', 'broker', true, 120, 4000, 15, true, 15)
  returning id into v_prairie;

  -- 7712, Truck 2 (Tommy): corn, per ton, delivered this morning, no scale ticket yet (demo fills it).
  insert into loads (sandbox_id, business_id, truck_id, driver_id, payer_id, load_number, commodity,
                     rate_type, rate_cents, loaded_miles, status)
  values (p_sandbox_id, v_business, v_truck2, v_tommy, v_millbrook, '7712', 'corn',
          'per_ton', 1400, 85, 'delivered')
  returning id into v_7712;
  insert into stops (sandbox_id, load_id, type, sequence, facility_name, city, state, arrived_at, departed_at)
  values
    (p_sandbox_id, v_7712, 'pickup', 1, 'Sutter Ridge Farm', 'Marion', 'KY',
     now() - interval '4 hours', now() - interval '3 hours 30 minutes'),
    (p_sandbox_id, v_7712, 'delivery', 2, 'Millbrook Grain Co. river terminal', 'Paducah', 'KY',
     now() - interval '90 minutes', now() - interval '60 minutes');

  -- 7705, Truck 2: soybeans, per ton, delivered, ticket confirmed, unpaid.
  insert into loads (sandbox_id, business_id, truck_id, driver_id, payer_id, load_number, commodity,
                     rate_type, rate_cents, loaded_miles, status)
  values (p_sandbox_id, v_business, v_truck2, v_tommy, v_millbrook, '7705', 'soybeans',
          'per_ton', 1500, 92, 'delivered')
  returning id into v_7705;
  insert into stops (sandbox_id, load_id, type, sequence, facility_name, city, state, arrived_at, departed_at)
  values
    (p_sandbox_id, v_7705, 'pickup', 1, 'Sutter Ridge Farm', 'Marion', 'KY',
     (v_today - 2 + time '07:10') at time zone tz, (v_today - 2 + time '07:45') at time zone tz),
    (p_sandbox_id, v_7705, 'delivery', 2, 'Millbrook Grain Co. river terminal', 'Paducah', 'KY',
     (v_today - 2 + time '09:50') at time zone tz, (v_today - 2 + time '10:20') at time zone tz);
  insert into scale_tickets (sandbox_id, load_id, ticket_number, net_weight_lbs, location, status)
  values (p_sandbox_id, v_7705, 'MB-20418', 51240, 'Paducah, KY', 'confirmed');

  -- 7708, Truck 1 (Ray): fertilizer backhaul, flat, Prairie Run Brokerage, delivered and paid.
  insert into loads (sandbox_id, business_id, truck_id, driver_id, payer_id, load_number, commodity,
                     rate_type, rate_cents, loaded_miles, status, invoiced_at, paid_at)
  values (p_sandbox_id, v_business, v_truck1, v_ray, v_prairie, '7708', 'fertilizer',
          'flat', 78000, 140, 'paid',
          (v_today - 3 + time '16:00') at time zone tz, (v_today - 1 + time '11:00') at time zone tz)
  returning id into v_7708;
  insert into stops (sandbox_id, load_id, type, sequence, facility_name, city, state,
                     appointment_at, arrived_at, departed_at)
  values
    (p_sandbox_id, v_7708, 'pickup', 1, 'Ostrander Fertilizer Depot', 'Cairo', 'IL',
     (v_today - 3 + time '08:00') at time zone tz,
     (v_today - 3 + time '07:50') at time zone tz, (v_today - 3 + time '08:40') at time zone tz),
    (p_sandbox_id, v_7708, 'delivery', 2, 'Halvern Farm Co-op', 'Mayfield', 'KY',
     (v_today - 3 + time '12:00') at time zone tz,
     (v_today - 3 + time '11:35') at time zone tz, (v_today - 3 + time '12:30') at time zone tz);

  -- 7710, Truck 3 (Luis): corn, per ton, delivered and paid.
  insert into loads (sandbox_id, business_id, truck_id, driver_id, payer_id, load_number, commodity,
                     rate_type, rate_cents, loaded_miles, status, invoiced_at, paid_at)
  values (p_sandbox_id, v_business, v_truck3, v_luis, v_millbrook, '7710', 'corn',
          'per_ton', 1400, 78, 'paid',
          (v_today - 2 + time '15:00') at time zone tz, (v_today - 1 + time '09:30') at time zone tz)
  returning id into v_7710;
  insert into stops (sandbox_id, load_id, type, sequence, facility_name, city, state, arrived_at, departed_at)
  values
    (p_sandbox_id, v_7710, 'pickup', 1, 'Dellacourt Farm', 'Princeton', 'KY',
     (v_today - 2 + time '06:30') at time zone tz, (v_today - 2 + time '07:05') at time zone tz),
    (p_sandbox_id, v_7710, 'delivery', 2, 'Millbrook Grain Co. river terminal', 'Paducah', 'KY',
     (v_today - 2 + time '08:45') at time zone tz, (v_today - 2 + time '09:15') at time zone tz);
  insert into scale_tickets (sandbox_id, load_id, ticket_number, net_weight_lbs, location, status)
  values (p_sandbox_id, v_7710, 'MB-20431', 53100, 'Paducah, KY', 'confirmed');

  -- Existing confirmed expenses: fuel across KY, TN, IL and IN (for the fuel-by-state stretch),
  -- plus one repair on Truck 3.
  insert into expenses (sandbox_id, business_id, truck_id, person_id, load_id, category, amount_cents,
                        city, state, gallons, payment_method, occurred_at, status, receipt_status, source)
  values
    (p_sandbox_id, v_business, v_truck1, v_ray, v_7708, 'fuel', 53900, 'Calvert City', 'KY', 140,
     'fuel_card', (v_today - 3 + time '06:40') at time zone tz, 'confirmed', 'attached', 'seed'),
    (p_sandbox_id, v_business, v_truck2, v_tommy, v_7705, 'fuel', 44840, 'Union City', 'TN', 118,
     'fuel_card', (v_today - 2 + time '06:20') at time zone tz, 'confirmed', 'attached', 'seed'),
    (p_sandbox_id, v_business, v_truck3, v_luis, v_7710, 'fuel', 48250, 'Metropolis', 'IL', 125,
     'fuel_card', (v_today - 2 + time '05:50') at time zone tz, 'confirmed', 'attached', 'seed'),
    (p_sandbox_id, v_business, v_truck1, v_ray, null, 'fuel', 37152, 'Evansville', 'IN', 96,
     'fuel_card', (v_today - 1 + time '15:30') at time zone tz, 'confirmed', 'attached', 'seed');

  insert into expenses (sandbox_id, business_id, truck_id, person_id, load_id, category, amount_cents,
                        vendor, city, state, payment_method, occurred_at, status, receipt_status, source)
  values
    (p_sandbox_id, v_business, v_truck3, v_luis, null, 'repair', 61200, 'Benton Truck and Trailer Repair',
     'Benton', 'KY', 'card', (v_today - 1 + time '13:15') at time zone tz, 'confirmed', 'attached', 'seed');
end;
$$;
