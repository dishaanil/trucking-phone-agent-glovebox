import type { FastifyInstance } from 'fastify';
import type { Pool } from '../db.js';
import type { EventHub } from '../lib/event-hub.js';
import { SandboxIdParams } from '../schemas.js';
import { getLiveSandbox } from '../services/sandboxes.js';

interface EventRow {
  id: string; // bigint comes back as a string
  type: string;
  call_id: string | null;
  actor_person_id: string | null;
  payload: Record<string, unknown>;
  created_at: Date;
}

const BATCH = 500;

/**
 * Dashboard live feed: Server-Sent Events for one sandbox. Public by sandbox id, like the other
 * sandbox routes; payloads never contain phone numbers. Without `Last-Event-ID` the stream starts
 * at the newest event; with it, everything after that id is replayed first.
 */
export function eventRoutes(app: FastifyInstance, pool: Pool, hub: EventHub, heartbeatMs: number): void {
  const open = new Set<() => void>();
  // Fastify waits for open requests on close; SSE streams never finish on their own.
  app.addHook('preClose', async () => {
    for (const end of open) end();
  });
  app.addHook('onClose', async () => {
    await hub.close();
  });

  app.get('/sandboxes/:id/events', async (req, reply) => {
    const { id } = SandboxIdParams.parse(req.params);
    await getLiveSandbox(pool, id);

    const lastEventId = req.headers['last-event-id'];
    let cursor: string;
    if (typeof lastEventId === 'string' && /^\d{1,18}$/.test(lastEventId)) {
      cursor = lastEventId;
    } else {
      const { rows } = await pool.query<{ max: string }>(
        'select coalesce(max(id), 0)::text as max from events where sandbox_id = $1',
        [id],
      );
      cursor = rows[0]?.max ?? '0';
    }

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    raw.write('retry: 2000\n\n');

    let closed = false;
    let running = false;
    let again = false;

    // Read and send everything after the cursor. Wakes that arrive mid-read run once more after.
    const flush = async (): Promise<void> => {
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        do {
          again = false;
          const { rows } = await pool.query<EventRow>(
            `select id::text as id, type, call_id, actor_person_id, payload, created_at
               from events where sandbox_id = $1 and id > $2::bigint order by id limit 500`, // BATCH
            [id, cursor],
          );
          for (const e of rows) {
            if (closed) return;
            const data = { ...e, created_at: e.created_at.toISOString() };
            raw.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(data)}\n\n`);
            cursor = e.id;
          }
          if (rows.length === BATCH) again = true;
        } while (again && !closed);
      } catch (err) {
        req.log.error({ err }, 'event stream read failed');
      } finally {
        running = false;
      }
    };

    const heartbeat = setInterval(() => raw.write(': ping\n\n'), heartbeatMs);
    let unsubscribe = (): void => undefined;
    const end = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      open.delete(end);
      raw.end();
    };
    open.add(end);
    raw.on('close', end);

    try {
      unsubscribe = await hub.subscribe(id, () => void flush());
    } catch (err) {
      req.log.error({ err }, 'event listener unavailable');
      end();
      return;
    }
    if (closed) unsubscribe();
    // Subscribe first, then catch up, so nothing committed in between is missed.
    await flush();
  });
}
