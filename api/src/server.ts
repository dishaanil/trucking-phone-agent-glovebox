import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { createIntegrations } from './integrations/index.js';
import { EventHub } from './lib/event-hub.js';

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
const app = buildApp({
  pool,
  config,
  integrations: createIntegrations(config.INTEGRATIONS),
  eventHub: new EventHub(config.DIRECT_DATABASE_URL ?? config.DATABASE_URL),
  sseHeartbeatMs: config.SSE_HEARTBEAT_MS,
});

const shutdown = async (): Promise<void> => {
  await app.close();
  await pool.end();
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

await app.listen({ port: config.PORT, host: config.HOST });
