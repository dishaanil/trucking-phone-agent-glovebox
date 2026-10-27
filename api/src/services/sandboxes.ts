import { randomInt } from 'node:crypto';
import type { z } from 'zod';
import { withTransaction, type Pool, type Queryable } from '../db.js';
import { ApiError } from '../errors.js';
import { recordEvent } from '../lib/events.js';
import { last4, toE164 } from '../lib/phone.js';
import type { CreateSandboxBody, SandboxView } from '../schemas.js';

type Scenario = z.infer<typeof CreateSandboxBody>['scenario'];

// Fixed statements per scenario; the sandbox id is always a bound parameter.
const SEED_SQL: Record<Scenario, string> = {
  owner_operator: 'select seed_owner_operator($1)',
  small_fleet: 'select seed_small_fleet($1)',
};

// Who the visitor plays by default. Small fleet has no default: the visitor or caller picks.
const DEFAULT_PERSON: Record<Scenario, string | null> = {
  owner_operator: 'mike',
  small_fleet: null,
};

const DEMO_CODE_ATTEMPTS = 20;

// Children before parents, since some foreign keys don't cascade.
const RESET_DELETES = [
  'delete from events where sandbox_id = $1',
  'delete from detention_claims where sandbox_id = $1',
  'delete from scale_tickets where sandbox_id = $1',
  'delete from expenses where sandbox_id = $1',
  'delete from stops where sandbox_id = $1',
  'delete from loads where sandbox_id = $1',
  'delete from trucks where sandbox_id = $1',
  'delete from sandbox_phones where sandbox_id = $1',
  'delete from people where sandbox_id = $1',
  'delete from payers where sandbox_id = $1',
  'delete from businesses where sandbox_id = $1',
] as const;

const SANDBOX_SELECT = `select id, scenario, access_mode, demo_code, active_person_seed_key, is_recording, expires_at,
          (not is_recording and expires_at <= now()) as expired
     from sandboxes where id = $1`;

interface SandboxRow {
  id: string;
  scenario: Scenario;
  access_mode: 'phone' | 'code';
  demo_code: string;
  active_person_seed_key: string | null;
  is_recording: boolean;
  expires_at: Date;
}

/** Load a sandbox that exists and has not expired, or throw. */
export async function getLiveSandbox(db: Queryable, id: string, forUpdate = false): Promise<SandboxRow> {
  const { rows } = await db.query<SandboxRow & { expired: boolean }>(
    forUpdate ? `${SANDBOX_SELECT} for update` : SANDBOX_SELECT,
    [id],
  );
  const row = rows[0];
  if (!row) throw new ApiError(404, 'sandbox_not_found', "That demo doesn't exist. Start a new one.");
  if (row.expired) throw new ApiError(410, 'sandbox_expired', 'That demo has expired. Start a new one.');
  return row;
}

export async function getSandboxView(db: Queryable, id: string): Promise<SandboxView> {
  const sandbox = await getLiveSandbox(db, id);
  const business = await db.query<{ name: string; demo_dot: string }>(
    'select name, demo_dot from businesses where sandbox_id = $1 limit 1',
    [id],
  );
  const people = await db.query<SandboxView['people'][number]>(
    `select p.seed_key, p.full_name, p.is_owner, p.is_driver,
            (select t.unit_number from trucks t
              where t.sandbox_id = p.sandbox_id and t.assigned_person_id = p.id
              order by t.unit_number limit 1) as truck_unit
       from people p
      where p.sandbox_id = $1
      order by p.is_owner desc, p.full_name`,
    [id],
  );
  const businessRow = business.rows[0];
  if (!businessRow) throw new Error(`sandbox ${id} has no business row`);
  return {
    id: sandbox.id,
    scenario: sandbox.scenario,
    access_mode: sandbox.access_mode,
    demo_code: sandbox.demo_code,
    active_person_seed_key: sandbox.active_person_seed_key,
    is_recording: sandbox.is_recording,
    expires_at: sandbox.expires_at.toISOString(),
    business: businessRow,
    people: people.rows,
  };
}

export async function createSandbox(
  pool: Pool,
  input: { scenario: Scenario; access_mode: 'phone' | 'code' },
): Promise<SandboxView> {
  // Expired visitor sandboxes (and, by cascade, their phone numbers) are removed here,
  // which also keeps the 4-digit code space from filling up.
  await pool.query('delete from sandboxes where not is_recording and expires_at <= now()');

  return withTransaction(pool, async (client) => {
    let sandboxId: string | undefined;
    for (let attempt = 0; attempt < DEMO_CODE_ATTEMPTS && !sandboxId; attempt++) {
      const code = String(randomInt(0, 10_000)).padStart(4, '0');
      const { rows } = await client.query<{ id: string }>(
        `insert into sandboxes (scenario, access_mode, demo_code, active_person_seed_key)
         values ($1, $2, $3, $4)
         on conflict (demo_code) do nothing
         returning id`,
        [input.scenario, input.access_mode, code, DEFAULT_PERSON[input.scenario]],
      );
      sandboxId = rows[0]?.id;
    }
    if (!sandboxId) {
      throw new ApiError(503, 'no_demo_codes', 'All demo codes are in use right now. Try again shortly.');
    }

    await client.query(SEED_SQL[input.scenario], [sandboxId]);
    await recordEvent(client, {
      sandboxId,
      type: 'sandbox.created',
      payload: { scenario: input.scenario, access_mode: input.access_mode },
    });
    return getSandboxView(client, sandboxId);
  });
}

/**
 * Delete this sandbox's data and re-copy its seed template. The sandbox row, demo code,
 * expiry, active role and registered phones are kept; phones are re-attached by seed_key
 * because re-seeding creates new person ids.
 */
export async function resetSandbox(pool: Pool, id: string): Promise<SandboxView> {
  return withTransaction(pool, async (client) => {
    const sandbox = await getLiveSandbox(client, id, true);

    const phones = await client.query<{ phone_e164: string; seed_key: string }>(
      `select sp.phone_e164, p.seed_key
         from sandbox_phones sp
         join people p on p.id = sp.person_id and p.sandbox_id = sp.sandbox_id
        where sp.sandbox_id = $1`,
      [id],
    );

    for (const sql of RESET_DELETES) {
      await client.query(sql, [id]);
    }

    await client.query(SEED_SQL[sandbox.scenario], [id]);

    await client.query(
      `insert into sandbox_phones (sandbox_id, phone_e164, person_id)
       select $1, x.phone_e164, p.id
         from unnest($2::text[], $3::text[]) as x(phone_e164, seed_key)
         join people p on p.sandbox_id = $1 and p.seed_key = x.seed_key`,
      [id, phones.rows.map((r) => r.phone_e164), phones.rows.map((r) => r.seed_key)],
    );

    await recordEvent(client, { sandboxId: id, type: 'sandbox.reset', payload: { scenario: sandbox.scenario } });
    return getSandboxView(client, id);
  });
}

async function findPersonId(db: Queryable, sandboxId: string, seedKey: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    'select id from people where sandbox_id = $1 and seed_key = $2',
    [sandboxId, seedKey],
  );
  const row = rows[0];
  if (!row) throw new ApiError(404, 'person_not_found', "There's nobody by that name in this demo.");
  return row.id;
}

/**
 * Map a visitor's phone to a seeded person. A phone is active in only one sandbox at a time:
 * registering it here removes it from any other sandbox, so the newest demo wins.
 */
export async function registerPhone(
  pool: Pool,
  sandboxId: string,
  input: { phone: string; seed_key: string },
): Promise<{ seed_key: string; phone_last4: string; moved_from_other_sandbox: boolean }> {
  const phone = toE164(input.phone);
  if (!phone) throw new ApiError(400, 'invalid_phone', "That doesn't look like a valid phone number.");

  return withTransaction(pool, async (client) => {
    await getLiveSandbox(client, sandboxId);
    const personId = await findPersonId(client, sandboxId, input.seed_key);

    // Serialize registrations of the same number across sandboxes.
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [phone]);
    const moved = await client.query(
      'delete from sandbox_phones where phone_e164 = $1 and sandbox_id <> $2',
      [phone, sandboxId],
    );
    await client.query(
      `insert into sandbox_phones (sandbox_id, phone_e164, person_id) values ($1, $2, $3)
       on conflict (sandbox_id, phone_e164) do update set person_id = excluded.person_id`,
      [sandboxId, phone, personId],
    );
    await recordEvent(client, {
      sandboxId,
      type: 'phone.registered',
      actorPersonId: personId,
      payload: { seed_key: input.seed_key, phone_last4: last4(phone) },
    });
    return {
      seed_key: input.seed_key,
      phone_last4: last4(phone),
      moved_from_other_sandbox: (moved.rowCount ?? 0) > 0,
    };
  });
}

/** Switch which seeded person the visitor plays (used by demo-code calls and the dashboard). */
export async function setRole(pool: Pool, sandboxId: string, seedKey: string): Promise<SandboxView> {
  return withTransaction(pool, async (client) => {
    await getLiveSandbox(client, sandboxId, true);
    const personId = await findPersonId(client, sandboxId, seedKey);
    await client.query('update sandboxes set active_person_seed_key = $2 where id = $1', [sandboxId, seedKey]);
    await recordEvent(client, {
      sandboxId,
      type: 'role.switched',
      actorPersonId: personId,
      payload: { seed_key: seedKey },
    });
    return getSandboxView(client, sandboxId);
  });
}
