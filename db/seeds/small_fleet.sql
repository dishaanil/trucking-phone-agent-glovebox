-- Seed template: small fleet scenario (Cedar Fork Hauling LLC, grain hauling, western Kentucky).
-- All names, numbers and amounts are fictional.
-- Applied with `create or replace` on every db/migrate.sh run; called by the API as
--   select seed_small_fleet($1)
-- Dates are relative to `p_now` (default: now) in America/Chicago, so the demo always looks current.
-- Every timestamp falls this week, between Monday 00:00 and now (see seed_this_week).
-- Late October is harvest: each truck runs several short grain loads. The week's story:
--   Truck 1 (Ray) does best; Truck 3 (Luis) is weakest because of a $780 repair; Truck 2 (Tommy)
--   is slightly negative until his 7712 scale ticket is confirmed, then positive. The business
--   is clearly profitable. 7705 (delivered), 7706 (invoiced) and 7712 (no ticket) are unpaid.

drop function if exists seed_small_fleet(uuid);

create or replace function seed_small_fleet(p_sandbox_id uuid, p_now timestamptz default now())
returns void
language plpgsql as $$
declare
  tz constant text := 'America/Chicago';
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
  v_7701 uuid;
  v_7702 uuid;
  v_7703 uuid;
  v_7704 uuid;
  v_7706 uuid;
  v_7707 uuid;
begin
  insert into businesses (sandbox_id, name, demo_dot, timezone)
  values (p_sandbox_id, 'Cedar Fork Hauling LLC', 'DEMO-0002', tz)
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

  -- 7708, Truck 1 (Ray): fertilizer backhaul, flat, Prairie Run Brokerage, delivered and paid.
  insert into loads (sandbox_id, business_id, truck_id, driver_id, payer_id, load_number, commodity,
                     rate_type, rate_cents, loaded_miles, status, invoiced_at, paid_at)
  values (p_sandbox_id, v_business, v_truck1, v_ray, v_prairie, '7708', 'fertilizer',
          'flat', 78000, 140, 'paid',
          seed_this_week(p_now, tz, 0.14, interval '2 days 18 hours'),
          seed_this_week(p_now, tz, 0.56, interval '1 day 4 hours'))
  returning id into v_7708;
  insert into stops (sandbox_id, load_id, type, sequence, facility_name, city, state, timezone, arrived_at, departed_at)
  values
    (p_sandbox_id, v_7708, 'pickup', 1, 'Ostrander Fertilizer Depot', 'Cairo', 'IL', tz,
     seed_this_week(p_now, tz, 0.05, interval '3 days 2 hours'),
     seed_this_week(p_now, tz, 0.06, interval '3 days 1 hour 10 minutes')),
    (p_sandbox_id, v_7708, 'delivery', 2, 'Halvern Farm Co-op', 'Mayfield', 'KY', tz,
     seed_this_week(p_now, tz, 0.10, interval '2 days 22 hours'),
     seed_this_week(p_now, tz, 0.11, interval '2 days 21 hours'));

  -- 7710, Truck 3 (Luis): corn, per ton, delivered and paid.
  insert into loads (sandbox_id, business_id, truck_id, driver_id, payer_id, load_number, commodity,
                     rate_type, rate_cents, loaded_miles, status, invoiced_at, paid_at)
  values (p_sandbox_id, v_business, v_truck3, v_luis, v_millbrook, '7710', 'corn',
          'per_ton', 1400, 78, 'paid',
          seed_this_week(p_now, tz, 0.40, interval '1 day 20 hours'),
          seed_this_week(p_now, tz, 0.55, interval '1 day 6 hours'))
  returning id into v_7710;
  insert into stops (sandbox_id, load_id, type, sequence, facility_name, city, state, timezone, arrived_at, departed_at)
  values
    (p_sandbox_id, v_7710, 'pickup', 1, 'Dellacourt Farm', 'Princeton', 'KY', tz,
     seed_this_week(p_now, tz, 0.22, interval '2 days 5 hours'),
     seed_this_week(p_now, tz, 0.23, interval '2 days 4 hours 25 minutes')),
    (p_sandbox_id, v_7710, 'delivery', 2, 'Millbrook Grain Co. river terminal', 'Paducah', 'KY', tz,
     seed_this_week(p_now, tz, 0.31, interval '2 days 2 hours 45 minutes'),
     seed_this_week(p_now, tz, 0.32, interval '2 days 2 hours 15 minutes'));
  insert into scale_tickets (sandbox_id, load_id, ticket_number, net_weight_lbs, location, status, created_at)
  values (p_sandbox_id, v_7710, 'MB-20431', 53100, 'Paducah, KY', 'confirmed',
          seed_this_week(p_now, tz, 0.32, interval '2 days 2 hours 15 minutes'));

  -- 7705, Truck 2 (Tommy): soybeans, per ton, delivered, ticket confirmed, unpaid.
  insert into loads (sandbox_id, business_id, truck_id, driver_id, payer_id, load_number, commodity,
                     rate_type, rate_cents, loaded_miles, status)
  values (p_sandbox_id, v_business, v_truck2, v_tommy, v_millbrook, '7705', 'soybeans',
          'per_ton', 1500, 92, 'delivered')
  returning id into v_7705;
  insert into stops (sandbox_id, load_id, type, sequence, facility_name, city, state, timezone, arrived_at, departed_at)
  values
    (p_sandbox_id, v_7705, 'pickup', 1, 'Sutter Ridge Farm', 'Marion', 'KY', tz,
     seed_this_week(p_now, tz, 0.28, interval '2 days 3 hours 30 minutes'),
     seed_this_week(p_now, tz, 0.29, interval '2 days 2 hours 55 minutes')),
    (p_sandbox_id, v_7705, 'delivery', 2, 'Millbrook Grain Co. river terminal', 'Paducah', 'KY', tz,
     seed_this_week(p_now, tz, 0.34, interval '2 days 1 hour'),
     seed_this_week(p_now, tz, 0.35, interval '2 days 30 minutes'));
  insert into scale_tickets (sandbox_id, load_id, ticket_number, net_weight_lbs, location, status, created_at)
  values (p_sandbox_id, v_7705, 'MB-20418', 51240, 'Paducah, KY', 'confirmed',
          seed_this_week(p_now, tz, 0.35, interval '2 days 30 minutes'));

  -- 7712, Truck 2 (Tommy): corn, per ton, delivered within the last hour or so,
  -- no scale ticket yet (demo fills it).
  insert into loads (sandbox_id, business_id, truck_id, driver_id, payer_id, load_number, commodity,
                     rate_type, rate_cents, loaded_miles, status)
  values (p_sandbox_id, v_business, v_truck2, v_tommy, v_millbrook, '7712', 'corn',
          'per_ton', 1400, 85, 'delivered')
  returning id into v_7712;
  insert into stops (sandbox_id, load_id, type, sequence, facility_name, city, state, timezone, arrived_at, departed_at)
  values
    (p_sandbox_id, v_7712, 'pickup', 1, 'Sutter Ridge Farm', 'Marion', 'KY', tz,
     seed_this_week(p_now, tz, 0.86, interval '4 hours'),
     seed_this_week(p_now, tz, 0.89, interval '3 hours 30 minutes')),
    (p_sandbox_id, v_7712, 'delivery', 2, 'Millbrook Grain Co. river terminal', 'Paducah', 'KY', tz,
     seed_this_week(p_now, tz, 0.94, interval '90 minutes'),
     seed_this_week(p_now, tz, 0.97, interval '60 minutes'));

  -- Harvest week: short per-ton grain runs to the Millbrook river terminal, several per truck.
  -- 7702, Truck 3: corn, per ton, delivered and paid.
  insert into loads (sandbox_id, business_id, truck_id, driver_id, payer_id, load_number, commodity,
                     rate_type, rate_cents, loaded_miles, status, invoiced_at, paid_at)
  values (p_sandbox_id, v_business, v_truck3, v_luis, v_millbrook, '7702', 'corn',
          'per_ton', 1400, 78, 'paid',
          seed_this_week(p_now, tz, 0.40, interval '1 day 20 hours'),
          seed_this_week(p_now, tz, 0.55, interval '1 day 6 hours'))
  returning id into v_7702;
  insert into stops (sandbox_id, load_id, type, sequence, facility_name, city, state, timezone, arrived_at, departed_at)
  values
    (p_sandbox_id, v_7702, 'pickup', 1, 'Dellacourt Farm', 'Princeton', 'KY', tz,
     seed_this_week(p_now, tz, 0.06, interval '3 days 1 hour'),
     seed_this_week(p_now, tz, 0.07, interval '3 days 20 minutes')),
    (p_sandbox_id, v_7702, 'delivery', 2, 'Millbrook Grain Co. river terminal', 'Paducah', 'KY', tz,
     seed_this_week(p_now, tz, 0.11, interval '2 days 23 hours'),
     seed_this_week(p_now, tz, 0.12, interval '2 days 22 hours 20 minutes'));
  insert into scale_tickets (sandbox_id, load_id, ticket_number, net_weight_lbs, location, status, created_at)
  values (p_sandbox_id, v_7702, 'MB-20402', 52000, 'Paducah, KY', 'confirmed', seed_this_week(p_now, tz, 0.12, interval '2 days 22 hours 20 minutes'));

  -- 7704, Truck 2: corn, per ton, delivered and paid.
  insert into loads (sandbox_id, business_id, truck_id, driver_id, payer_id, load_number, commodity,
                     rate_type, rate_cents, loaded_miles, status, invoiced_at, paid_at)
  values (p_sandbox_id, v_business, v_truck2, v_tommy, v_millbrook, '7704', 'corn',
          'per_ton', 1400, 85, 'paid',
          seed_this_week(p_now, tz, 0.40, interval '1 day 20 hours'),
          seed_this_week(p_now, tz, 0.55, interval '1 day 6 hours'))
  returning id into v_7704;
  insert into stops (sandbox_id, load_id, type, sequence, facility_name, city, state, timezone, arrived_at, departed_at)
  values
    (p_sandbox_id, v_7704, 'pickup', 1, 'Sutter Ridge Farm', 'Marion', 'KY', tz,
     seed_this_week(p_now, tz, 0.12, interval '2 days 20 hours'),
     seed_this_week(p_now, tz, 0.13, interval '2 days 19 hours 20 minutes')),
    (p_sandbox_id, v_7704, 'delivery', 2, 'Millbrook Grain Co. river terminal', 'Paducah', 'KY', tz,
     seed_this_week(p_now, tz, 0.17, interval '2 days 17 hours 40 minutes'),
     seed_this_week(p_now, tz, 0.18, interval '2 days 17 hours'));
  insert into scale_tickets (sandbox_id, load_id, ticket_number, net_weight_lbs, location, status, created_at)
  values (p_sandbox_id, v_7704, 'MB-20409', 51800, 'Paducah, KY', 'confirmed', seed_this_week(p_now, tz, 0.18, interval '2 days 17 hours'));

  -- 7701, Truck 1: corn, per ton, delivered and paid.
  insert into loads (sandbox_id, business_id, truck_id, driver_id, payer_id, load_number, commodity,
                     rate_type, rate_cents, loaded_miles, status, invoiced_at, paid_at)
  values (p_sandbox_id, v_business, v_truck1, v_ray, v_millbrook, '7701', 'corn',
          'per_ton', 1400, 78, 'paid',
          seed_this_week(p_now, tz, 0.40, interval '1 day 20 hours'),
          seed_this_week(p_now, tz, 0.55, interval '1 day 6 hours'))
  returning id into v_7701;
  insert into stops (sandbox_id, load_id, type, sequence, facility_name, city, state, timezone, arrived_at, departed_at)
  values
    (p_sandbox_id, v_7701, 'pickup', 1, 'Dellacourt Farm', 'Princeton', 'KY', tz,
     seed_this_week(p_now, tz, 0.15, interval '2 days 17 hours'),
     seed_this_week(p_now, tz, 0.16, interval '2 days 16 hours 20 minutes')),
    (p_sandbox_id, v_7701, 'delivery', 2, 'Millbrook Grain Co. river terminal', 'Paducah', 'KY', tz,
     seed_this_week(p_now, tz, 0.19, interval '2 days 14 hours 40 minutes'),
     seed_this_week(p_now, tz, 0.20, interval '2 days 14 hours'));
  insert into scale_tickets (sandbox_id, load_id, ticket_number, net_weight_lbs, location, status, created_at)
  values (p_sandbox_id, v_7701, 'MB-20411', 52400, 'Paducah, KY', 'confirmed', seed_this_week(p_now, tz, 0.20, interval '2 days 14 hours'));

  -- 7703, Truck 1: soybeans, per ton, delivered and paid.
  insert into loads (sandbox_id, business_id, truck_id, driver_id, payer_id, load_number, commodity,
                     rate_type, rate_cents, loaded_miles, status, invoiced_at, paid_at)
  values (p_sandbox_id, v_business, v_truck1, v_ray, v_millbrook, '7703', 'soybeans',
          'per_ton', 1500, 92, 'paid',
          seed_this_week(p_now, tz, 0.52, interval '1 day 12 hours'),
          seed_this_week(p_now, tz, 0.60, interval '1 day 2 hours'))
  returning id into v_7703;
  insert into stops (sandbox_id, load_id, type, sequence, facility_name, city, state, timezone, arrived_at, departed_at)
  values
    (p_sandbox_id, v_7703, 'pickup', 1, 'Sutter Ridge Farm', 'Marion', 'KY', tz,
     seed_this_week(p_now, tz, 0.45, interval '1 day 18 hours'),
     seed_this_week(p_now, tz, 0.46, interval '1 day 17 hours 20 minutes')),
    (p_sandbox_id, v_7703, 'delivery', 2, 'Millbrook Grain Co. river terminal', 'Paducah', 'KY', tz,
     seed_this_week(p_now, tz, 0.49, interval '1 day 15 hours 40 minutes'),
     seed_this_week(p_now, tz, 0.50, interval '1 day 15 hours'));
  insert into scale_tickets (sandbox_id, load_id, ticket_number, net_weight_lbs, location, status, created_at)
  values (p_sandbox_id, v_7703, 'MB-20425', 50800, 'Paducah, KY', 'confirmed', seed_this_week(p_now, tz, 0.50, interval '1 day 15 hours'));

  -- 7706, Truck 3: corn, per ton, delivered and invoiced, unpaid.
  insert into loads (sandbox_id, business_id, truck_id, driver_id, payer_id, load_number, commodity,
                     rate_type, rate_cents, loaded_miles, status, invoiced_at)
  values (p_sandbox_id, v_business, v_truck3, v_luis, v_millbrook, '7706', 'corn',
          'per_ton', 1400, 78, 'invoiced',
          seed_this_week(p_now, tz, 0.66, interval '1 day'))
  returning id into v_7706;
  insert into stops (sandbox_id, load_id, type, sequence, facility_name, city, state, timezone, arrived_at, departed_at)
  values
    (p_sandbox_id, v_7706, 'pickup', 1, 'Dellacourt Farm', 'Princeton', 'KY', tz,
     seed_this_week(p_now, tz, 0.50, interval '1 day 14 hours'),
     seed_this_week(p_now, tz, 0.51, interval '1 day 13 hours 20 minutes')),
    (p_sandbox_id, v_7706, 'delivery', 2, 'Millbrook Grain Co. river terminal', 'Paducah', 'KY', tz,
     seed_this_week(p_now, tz, 0.54, interval '1 day 11 hours 40 minutes'),
     seed_this_week(p_now, tz, 0.55, interval '1 day 11 hours'));
  insert into scale_tickets (sandbox_id, load_id, ticket_number, net_weight_lbs, location, status, created_at)
  values (p_sandbox_id, v_7706, 'MB-20436', 53600, 'Paducah, KY', 'confirmed', seed_this_week(p_now, tz, 0.55, interval '1 day 11 hours'));

  -- 7707, Truck 1: corn, per ton, delivered and paid.
  insert into loads (sandbox_id, business_id, truck_id, driver_id, payer_id, load_number, commodity,
                     rate_type, rate_cents, loaded_miles, status, invoiced_at, paid_at)
  values (p_sandbox_id, v_business, v_truck1, v_ray, v_millbrook, '7707', 'corn',
          'per_ton', 1400, 78, 'paid',
          seed_this_week(p_now, tz, 0.82, interval '12 hours'),
          seed_this_week(p_now, tz, 0.84, interval '8 hours'))
  returning id into v_7707;
  insert into stops (sandbox_id, load_id, type, sequence, facility_name, city, state, timezone, arrived_at, departed_at)
  values
    (p_sandbox_id, v_7707, 'pickup', 1, 'Dellacourt Farm', 'Princeton', 'KY', tz,
     seed_this_week(p_now, tz, 0.74, interval '20 hours'),
     seed_this_week(p_now, tz, 0.75, interval '19 hours 20 minutes')),
    (p_sandbox_id, v_7707, 'delivery', 2, 'Millbrook Grain Co. river terminal', 'Paducah', 'KY', tz,
     seed_this_week(p_now, tz, 0.78, interval '17 hours 40 minutes'),
     seed_this_week(p_now, tz, 0.79, interval '17 hours'));
  insert into scale_tickets (sandbox_id, load_id, ticket_number, net_weight_lbs, location, status, created_at)
  values (p_sandbox_id, v_7707, 'MB-20447', 53200, 'Paducah, KY', 'confirmed', seed_this_week(p_now, tz, 0.79, interval '17 hours'));

  -- Existing confirmed expenses: fuel across KY, TN, IL and IN (for the fuel-by-state stretch),
  -- plus one repair on Truck 3.
  insert into expenses (sandbox_id, business_id, truck_id, person_id, load_id, category, amount_cents,
                        city, state, gallons, payment_method, occurred_at, status, receipt_status, source)
  values
    (p_sandbox_id, v_business, v_truck1, v_ray, v_7708, 'fuel', 53900, 'Calvert City', 'KY', 140,
     'fuel_card', seed_this_week(p_now, tz, 0.03, interval '3 days 4 hours'), 'confirmed', 'attached', 'seed'),
    (p_sandbox_id, v_business, v_truck3, v_luis, v_7710, 'fuel', 48250, 'Metropolis', 'IL', 125,
     'fuel_card', seed_this_week(p_now, tz, 0.20, interval '2 days 6 hours'), 'confirmed', 'attached', 'seed'),
    (p_sandbox_id, v_business, v_truck2, v_tommy, v_7705, 'fuel', 44840, 'Union City', 'TN', 118,
     'fuel_card', seed_this_week(p_now, tz, 0.26, interval '2 days 4 hours'), 'confirmed', 'attached', 'seed'),
    (p_sandbox_id, v_business, v_truck1, v_ray, null, 'fuel', 37152, 'Evansville', 'IN', 96,
     'fuel_card', seed_this_week(p_now, tz, 0.70, interval '22 hours'), 'confirmed', 'attached', 'seed'),
    (p_sandbox_id, v_business, v_truck2, v_tommy, null, 'fuel', 33880, 'Paducah', 'KY', 88,
     'fuel_card', seed_this_week(p_now, tz, 0.80, interval '14 hours'), 'confirmed', 'attached', 'seed');

  insert into expenses (sandbox_id, business_id, truck_id, person_id, load_id, category, amount_cents,
                        vendor, city, state, payment_method, occurred_at, status, receipt_status, source)
  values
    (p_sandbox_id, v_business, v_truck3, v_luis, null, 'repair', 78000, 'Benton Truck and Trailer Repair',
     'Benton', 'KY', 'card', seed_this_week(p_now, tz, 0.62, interval '1 day 2 hours'),
     'confirmed', 'attached', 'seed');
end;
$$;
