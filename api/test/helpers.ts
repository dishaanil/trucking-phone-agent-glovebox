import { randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createPool, type Pool } from '../src/db.js';
import type { SandboxView } from '../src/schemas.js';

try {
  process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
} catch {
  // No .env: rely on the environment (CI).
}

export const SERVICE_TOKEN = 'test-service-token-0123456789';

export interface TestContext {
  app: FastifyInstance;
  pool: Pool;
}

export function makeContext(): TestContext {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL must be set to run tests');
  const pool = createPool(url);
  const app = buildApp({ pool, config: { SERVICE_TOKEN, LOG_LEVEL: 'silent' } });
  return { app, pool };
}

export async function closeContext(ctx: TestContext): Promise<void> {
  await ctx.app.close();
  await ctx.pool.end();
}

/** A random fictional number in the reserved NXX-555-01xx range. */
export function fakePhone(): string {
  return `+1${randomInt(200, 1000)}55501${String(randomInt(0, 100)).padStart(2, '0')}`;
}

export async function newSandbox(
  ctx: TestContext,
  scenario: 'owner_operator' | 'small_fleet',
  access_mode: 'phone' | 'code' = 'code',
): Promise<SandboxView> {
  const res = await ctx.app.inject({ method: 'POST', url: '/sandboxes', payload: { scenario, access_mode } });
  if (res.statusCode !== 201) throw new Error(`create sandbox failed: ${res.statusCode} ${res.body}`);
  return res.json<SandboxView>();
}

export async function resolve(ctx: TestContext, payload: Record<string, unknown>) {
  return ctx.app.inject({
    method: 'POST',
    url: '/callers/resolve',
    headers: { authorization: `Bearer ${SERVICE_TOKEN}` },
    payload,
  });
}

export async function expireSandbox(ctx: TestContext, id: string): Promise<void> {
  await ctx.pool.query("update sandboxes set expires_at = now() - interval '1 minute' where id = $1", [id]);
}

/** The first element, or fail the test if there is none. */
export function first<T>(items: readonly T[]): T {
  const item = items[0];
  if (item === undefined) throw new Error('expected at least one item');
  return item;
}

// ---------- Agent requests (ledger) ----------

/** A seeded person making agent requests during one call. */
export interface Actor {
  sandboxId: string;
  personId: string;
  callId: string;
  turn: number;
}

export async function actor(ctx: TestContext, sandboxId: string, seedKey: string, callId?: string): Promise<Actor> {
  const { rows } = await ctx.pool.query<{ id: string }>('select id from people where sandbox_id = $1 and seed_key = $2', [
    sandboxId,
    seedKey,
  ]);
  return { sandboxId, personId: first(rows).id, callId: callId ?? `call_${randomInt(1e9)}`, turn: 0 };
}

/** A fresh idempotency key for one tool call: {call_id}:{turn_index}:{tool_call_index}:{tool_name}. */
export function nextKey(a: Actor, tool: string, toolCallIndex = 0): string {
  a.turn += 1;
  return `${a.callId}:${a.turn}:${toolCallIndex}:${tool}`;
}

export async function agent(
  ctx: TestContext,
  a: Actor,
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  payload?: Record<string, unknown>,
) {
  return ctx.app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${SERVICE_TOKEN}`,
      'x-sandbox-id': a.sandboxId,
      'x-person-id': a.personId,
    },
    ...(payload ? { payload } : {}),
  });
}

/** A write with call_id and a fresh idempotency key filled in. */
export async function agentWrite(
  ctx: TestContext,
  a: Actor,
  method: 'POST' | 'PATCH',
  url: string,
  tool: string,
  payload: Record<string, unknown>,
) {
  return agent(ctx, a, method, url, { ...payload, call_id: a.callId, idempotency_key: nextKey(a, tool) });
}

export async function loadId(ctx: TestContext, sandboxId: string, loadNumber: string): Promise<string> {
  const { rows } = await ctx.pool.query<{ id: string }>(
    'select id from loads where sandbox_id = $1 and load_number = $2',
    [sandboxId, loadNumber],
  );
  return first(rows).id;
}

export async function truckId(ctx: TestContext, sandboxId: string, unit: string): Promise<string> {
  const { rows } = await ctx.pool.query<{ id: string }>(
    'select id from trucks where sandbox_id = $1 and unit_number = $2',
    [sandboxId, unit],
  );
  return first(rows).id;
}

export async function eventsOfType(ctx: TestContext, sandboxId: string, type: string) {
  const { rows } = await ctx.pool.query<{ payload: Record<string, unknown>; call_id: string | null }>(
    'select payload, call_id from events where sandbox_id = $1 and type = $2 order by id',
    [sandboxId, type],
  );
  return rows;
}
