import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { createIntegrations } from './integrations/index.js';

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
const app = buildApp({ pool, config, integrations: createIntegrations(config.INTEGRATIONS) });

const shutdown = async (): Promise<void> => {
  await app.close();
  await pool.end();
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

await app.listen({ port: config.PORT, host: config.HOST });
