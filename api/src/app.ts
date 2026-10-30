import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import type { Config } from './config.js';
import type { Pool } from './db.js';
import { ApiError } from './errors.js';
import { callerRoutes } from './routes/callers.js';
import { ledgerRoutes } from './routes/ledger.js';
import { loadRoutes } from './routes/loads.js';
import { sandboxRoutes } from './routes/sandboxes.js';

export function buildApp(opts: { pool: Pool; config: Pick<Config, 'SERVICE_TOKEN' | 'LOG_LEVEL'> }): FastifyInstance {
  // Request bodies are never logged: they can carry visitor phone numbers.
  const app = Fastify({
    logger: { level: opts.config.LOG_LEVEL, redact: ['req.headers.authorization'] },
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) {
      return reply.code(err.statusCode).send({ error: err.code, message: err.message, ...err.details });
    }
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: 'invalid_request',
        message: 'Some of that request was invalid.',
        issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: 'bad_request', message: 'That request was invalid.' });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: 'internal', message: 'Something went wrong on our end.' });
  });

  app.get('/health', async () => ({ ok: true }));
  sandboxRoutes(app, opts.pool);
  callerRoutes(app, opts.pool, opts.config.SERVICE_TOKEN);
  ledgerRoutes(app, opts.pool, opts.config.SERVICE_TOKEN);
  loadRoutes(app, opts.pool, opts.config.SERVICE_TOKEN);
  return app;
}
