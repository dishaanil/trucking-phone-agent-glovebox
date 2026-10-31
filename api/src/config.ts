import { z } from 'zod';

const ConfigSchema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(3001),
  HOST: z.string().default('0.0.0.0'),
  SERVICE_TOKEN: z.string().min(16),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  // Which implementations back the external-system interfaces. Only mocks exist.
  INTEGRATIONS: z.enum(['mock']).default('mock'),
  // The SSE listener needs a direct (non-pooled) connection; LISTEN fails through a transaction pooler.
  DIRECT_DATABASE_URL: z.string().min(1).optional(),
  SSE_HEARTBEAT_MS: z.coerce.number().int().positive().default(20_000),
  // Calls still open after this long are ended with reason 'timeout'.
  CALL_TIMEOUT_MINUTES: z.coerce.number().int().positive().default(30),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return ConfigSchema.parse(env);
}
