import type { FastifyInstance } from 'fastify';
import type { Pool } from '../db.js';
import {
  CreateSandboxBody,
  RegisterPhoneBody,
  RegisterPhoneResponse,
  SandboxIdParams,
  SandboxView,
  SetRoleBody,
} from '../schemas.js';
import { createSandbox, registerPhone, resetSandbox, setRole } from '../services/sandboxes.js';

export function sandboxRoutes(app: FastifyInstance, pool: Pool): void {
  app.post('/sandboxes', async (req, reply) => {
    const body = CreateSandboxBody.parse(req.body);
    const view = await createSandbox(pool, body);
    return reply.code(201).send(SandboxView.parse(view));
  });

  app.post('/sandboxes/:id/phones', async (req) => {
    const { id } = SandboxIdParams.parse(req.params);
    const body = RegisterPhoneBody.parse(req.body);
    return RegisterPhoneResponse.parse(await registerPhone(pool, id, body));
  });

  app.post('/sandboxes/:id/role', async (req) => {
    const { id } = SandboxIdParams.parse(req.params);
    const { seed_key } = SetRoleBody.parse(req.body);
    return SandboxView.parse(await setRole(pool, id, seed_key));
  });

  app.post('/sandboxes/:id/reset', async (req) => {
    const { id } = SandboxIdParams.parse(req.params);
    return SandboxView.parse(await resetSandbox(pool, id));
  });
}
