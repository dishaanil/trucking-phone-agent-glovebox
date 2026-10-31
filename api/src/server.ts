import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool, withTransaction } from './db.js';
import { createIntegrations } from './integrations/index.js';
import { EventHub } from './lib/event-hub.js';
import { endStaleCalls } from './services/calls.js';

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
const app = buildApp({
  pool,
  config,
  integrations: createIntegrations(config.INTEGRATIONS),
  eventHub: new EventHub(config.DIRECT_DATABASE_URL ?? config.DATABASE_URL),
  sseHeartbeatMs: config.SSE_HEARTBEAT_MS,
});

// End calls whose agent never reported the end (crash, dropped connection).
const sweep = setInterval(() => {
  withTransaction(pool, (db) => endStaleCalls(db, config.CALL_TIMEOUT_MINUTES)).catch((err: unknown) =>
    app.log.error({ err }, 'call sweep failed'),
  );
}, 60_000);

const shutdown = async (): Promise<void> => {
  clearInterval(sweep);
  await app.close();
  await pool.end();
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

await app.listen({ port: config.PORT, host: config.HOST });
