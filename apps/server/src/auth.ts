import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiError } from './errors.js';

export interface AuthOptions {
  token?: string | undefined;
}

function bearerToken(authorization: string | string[] | undefined): string | null {
  if (typeof authorization !== 'string') return null;
  const match = authorization.match(/^Bearer\s+(.+)$/);
  return match?.[1] ?? null;
}

function tokenEquals(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const actual = Buffer.from(provided);
  const target = Buffer.from(expected);
  if (actual.length !== target.length) {
    timingSafeEqual(target, target);
    return false;
  }
  return timingSafeEqual(actual, target);
}

export async function registerAuth(app: FastifyInstance, options: AuthOptions): Promise<void> {
  const token = options.token ?? process.env.VIBELOOP_API_TOKEN;
  if (!token) {
    throw new Error('VIBELOOP_API_TOKEN is required for API auth');
  }

  app.decorateRequest('reviewerId', null);
  app.addHook('preHandler', async (request: FastifyRequest) => {
    if (!tokenEquals(bearerToken(request.headers.authorization), token)) {
      throw new ApiError(401, 'UNAUTHORIZED', 'Authorization: Bearer token is required');
    }
    request.reviewerId = 'mvp-user';
  });
}

declare module 'fastify' {
  interface FastifyRequest {
    reviewerId: string | null;
  }
}
