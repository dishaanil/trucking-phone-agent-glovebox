import type { Queryable } from '../db.js';
import { toE164 } from '../lib/phone.js';
import type { ResolveCallerResponse } from '../schemas.js';

type Resolved = Extract<ResolveCallerResponse, { status: 'resolved' }>;
type ChoosePerson = Extract<ResolveCallerResponse, { status: 'choose_person' }>;

type StopView = Resolved['active_loads'][number]['stops'][number];
type StopRow = Omit<StopView, 'appointment_at'> & { load_id: string; appointment_at: Date | null };

interface SandboxRow {
  id: string;
  scenario: Resolved['sandbox']['scenario'];
  access_mode: Resolved['sandbox']['access_mode'];
  active_person_seed_key: string | null;
}

/**
 * Agent call start: turn a caller ID or a demo code into sandbox, person, roles and context.
 * Expired sandboxes never resolve.
 */
export async function resolveCaller(
  db: Queryable,
  input: { phone: string } | { demo_code: string; seed_key?: string | undefined },
): Promise<ResolveCallerResponse> {
  if ('phone' in input) {
    const phone = toE164(input.phone);
    if (!phone) return { status: 'not_found' };
    const { rows } = await db.query<SandboxRow & { person_id: string }>(
      `select s.id, s.scenario, s.access_mode, s.active_person_seed_key, sp.person_id
         from sandbox_phones sp
         join sandboxes s on s.id = sp.sandbox_id
        where sp.phone_e164 = $1 and (s.is_recording or s.expires_at > now())
        order by s.created_at desc
        limit 1`,
      [phone],
    );
    const row = rows[0];
    if (!row) return { status: 'not_found' };
    return loadContext(db, row, row.person_id);
  }

  const { rows } = await db.query<SandboxRow>(
    `select s.id, s.scenario, s.access_mode, s.active_person_seed_key
       from sandboxes s
      where s.demo_code = $1 and (s.is_recording or s.expires_at > now())`,
    [input.demo_code],
  );
  const sandbox = rows[0];
  if (!sandbox) return { status: 'not_found' };

  const people = await db.query<ChoosePerson['people'][number] & { id: string }>(
    `select p.id, p.seed_key, p.full_name, p.is_owner, p.is_driver,
            (select t.unit_number from trucks t
              where t.sandbox_id = p.sandbox_id and t.assigned_person_id = p.id
              order by t.unit_number limit 1) as truck_unit
       from people p
      where p.sandbox_id = $1
      order by p.is_owner desc, p.full_name`,
    [sandbox.id],
  );

  const wanted = input.seed_key ?? sandbox.active_person_seed_key;
  const person =
    people.rows.find((p) => p.seed_key === wanted) ?? (people.rows.length === 1 ? people.rows[0] : undefined);
  if (person) return loadContext(db, sandbox, person.id);

  return {
    status: 'choose_person',
    sandbox: { id: sandbox.id, scenario: sandbox.scenario, access_mode: sandbox.access_mode },
    people: people.rows.map((p) => ({
      seed_key: p.seed_key,
      full_name: p.full_name,
      is_owner: p.is_owner,
      is_driver: p.is_driver,
      truck_unit: p.truck_unit,
    })),
  };
}

async function loadContext(db: Queryable, sandbox: SandboxRow, personId: string): Promise<Resolved> {
  const personResult = await db.query<
    Resolved['person'] & { business_id: string; business_name: string }
  >(
    `select p.id, p.seed_key, p.full_name, split_part(p.full_name, ' ', 1) as first_name,
            p.is_owner, p.is_driver, p.timezone, b.id as business_id, b.name as business_name
       from people p
       join businesses b on b.id = p.business_id and b.sandbox_id = p.sandbox_id
      where p.sandbox_id = $1 and p.id = $2`,
    [sandbox.id, personId],
  );
  const person = personResult.rows[0];
  if (!person) throw new Error(`person ${personId} not found in sandbox ${sandbox.id}`);

  // Owners see every truck in the business; drivers see only trucks assigned to them.
  const trucks = await db.query<Resolved['trucks'][number]>(
    `select t.id, t.unit_number, t.trailer_type, p.seed_key as assigned_seed_key
       from trucks t
       left join people p on p.id = t.assigned_person_id and p.sandbox_id = t.sandbox_id
      where t.sandbox_id = $1 and t.business_id = $2 and ($3::boolean or t.assigned_person_id = $4)
      order by t.unit_number`,
    [sandbox.id, person.business_id, person.is_owner, person.id],
  );

  // Active loads are the caller's own: booked, in transit, or delivered per-ton loads still
  // waiting on a confirmed scale ticket. Fleet-wide numbers come from the owner summary tools.
  const loads = await db.query<Omit<Resolved['active_loads'][number], 'stops'>>(
    `select * from (
       select l.id, l.load_number, l.status, l.commodity, l.rate_type,
              t.unit_number as truck_unit, py.name as payer_name,
              (l.rate_type = 'per_ton' and not exists (
                 select 1 from scale_tickets st
                  where st.sandbox_id = l.sandbox_id and st.load_id = l.id and st.status = 'confirmed'
              )) as needs_scale_ticket
         from loads l
         join trucks t on t.id = l.truck_id and t.sandbox_id = l.sandbox_id
         join payers py on py.id = l.payer_id and py.sandbox_id = l.sandbox_id
        where l.sandbox_id = $1 and l.driver_id = $2
     ) x
     where x.status in ('booked', 'in_transit') or (x.status = 'delivered' and x.needs_scale_ticket)
     order by case x.status when 'in_transit' then 0 when 'delivered' then 1 else 2 end, x.load_number`,
    [sandbox.id, person.id],
  );

  const stops = await db.query<StopRow>(
    `select id, load_id, type, sequence, facility_name, city, state, appointment_at
       from stops
      where sandbox_id = $1 and load_id = any($2::uuid[])
      order by sequence`,
    [sandbox.id, loads.rows.map((l) => l.id)],
  );

  return {
    status: 'resolved',
    sandbox: { id: sandbox.id, scenario: sandbox.scenario, access_mode: sandbox.access_mode },
    business: { id: person.business_id, name: person.business_name },
    person: {
      id: person.id,
      seed_key: person.seed_key,
      full_name: person.full_name,
      first_name: person.first_name,
      is_owner: person.is_owner,
      is_driver: person.is_driver,
      timezone: person.timezone,
    },
    trucks: trucks.rows,
    active_loads: loads.rows.map((load) => ({
      ...load,
      stops: stops.rows
        .filter((s) => s.load_id === load.id)
        .map((s) => ({
          id: s.id,
          type: s.type,
          sequence: s.sequence,
          facility_name: s.facility_name,
          city: s.city,
          state: s.state,
          appointment_at: s.appointment_at ? s.appointment_at.toISOString() : null,
        })),
    })),
  };
}
