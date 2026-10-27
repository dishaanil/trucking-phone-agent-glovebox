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
