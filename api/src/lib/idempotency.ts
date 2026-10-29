import { createHash } from 'node:crypto';
import type pg from 'pg';
import { withTransaction, type Pool } from '../db.js';
import { ApiError } from '../errors.js';

export interface WriteResult<T> {
  statusCode: number;
  body: T;
}

/** JSON with object keys sorted, so equal requests hash equally regardless of key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function requestHash(request: unknown): string {
  return createHash('sha256').update(canonical(request)).digest('hex');
}

/**
 * Run a write at most once per (sandbox, key). The key row is inserted in the same transaction
 * as the write: if the write fails, the key is rolled back with it and a retry runs again.
 * A replay with the same request returns the stored response; a different request is a 409.
 * Concurrent requests with the same key wait on the key row, then see the stored response.
 */
export async function idempotentWrite<T>(
  pool: Pool,
  opts: { sandboxId: string; key: string; request: unknown },
  write: (client: pg.PoolClient) => Promise<WriteResult<T>>,
): Promise<WriteResult<T> & { replayed: boolean }> {
  const hash = requestHash(opts.request);
  return withTransaction(pool, async (client) => {
    const inserted = await client.query(
      `insert into idempotency_keys (sandbox_id, key, request_hash) values ($1, $2, $3)
       on conflict (sandbox_id, key) do nothing`,
      [opts.sandboxId, opts.key, hash],
    );
    if (inserted.rowCount === 0) {
      const { rows } = await client.query<{ request_hash: string; status_code: number; response: T }>(
        'select request_hash, status_code, response from idempotency_keys where sandbox_id = $1 and key = $2',
        [opts.sandboxId, opts.key],
      );
      const stored = rows[0];
      if (!stored) throw new Error('idempotency key vanished after conflict');
      if (stored.request_hash !== hash) {
        throw new ApiError(409, 'idempotency_conflict', 'That request id was already used for something else.');
      }
      return { statusCode: stored.status_code, body: stored.response, replayed: true };
    }

    const result = await write(client);
    await client.query(
      'update idempotency_keys set status_code = $3, response = $4 where sandbox_id = $1 and key = $2',
      [opts.sandboxId, opts.key, result.statusCode, JSON.stringify(result.body)],
    );
    return { ...result, replayed: false };
  });
}
