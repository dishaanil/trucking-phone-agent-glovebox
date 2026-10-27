import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { ApiError } from '../errors.js';

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

/** Guard for agent-only endpoints: requires `Authorization: Bearer <SERVICE_TOKEN>`. */
export function requireServiceToken(token: string) {
  const expected = digest(token);
  return async (req: FastifyRequest): Promise<void> => {
    const header = req.headers.authorization ?? '';
    const given = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    if (!given || !timingSafeEqual(digest(given), expected)) {
      throw new ApiError(401, 'unauthorized', 'Not authorized.');
    }
  };
}
