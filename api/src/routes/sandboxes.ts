import type { FastifyInstance } from 'fastify';
import { withTransaction, type Pool } from '../db.js';
import type { Integrations } from '../integrations/index.js';
import {
  CreateSandboxBody,
  RegisterPhoneBody,
  RegisterPhoneResponse,
  SandboxClaimParams,
  SandboxIdParams,
  SandboxLoadParams,
  SandboxView,
  SendClaimResponse,
  SetRoleBody,
  SimulatePaymentResponse,
} from '../schemas.js';
import { createSandbox, getLiveSandbox, registerPhone, resetSandbox, setRole } from '../services/sandboxes.js';

export function sandboxRoutes(app: FastifyInstance, pool: Pool, integrations: Integrations): void {
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

  // Demo controls. Public by sandbox id like the routes above; each record must belong to the sandbox.
  app.post('/sandboxes/:id/loads/:loadId/simulate-payment', async (req) => {
    const { id, loadId } = SandboxLoadParams.parse(req.params);
    const result = await withTransaction(pool, async (db) => {
      await getLiveSandbox(db, id);
      return integrations.payments.markPaid(db, id, loadId);
    });
    return SimulatePaymentResponse.parse(result);
  });

  app.post('/sandboxes/:id/detention-claims/:claimId/send', async (req) => {
    const { id, claimId } = SandboxClaimParams.parse(req.params);
    const result = await withTransaction(pool, async (db) => {
      await getLiveSandbox(db, id);
      return integrations.detentionSubmitter.send(db, id, claimId);
    });
    return SendClaimResponse.parse(result);
  });
}
