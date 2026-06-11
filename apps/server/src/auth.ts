import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiError } from './errors.js';

export interface AuthOptions {
  token?: string | undefined;
}

export async function registerAuth(app: FastifyInstance, options: AuthOptions): Promise<void> {
  const token = options.token ?? process.env.VIBELOOP_API_TOKEN;
  if (!token) {
    throw new Error('VIBELOOP_API_TOKEN is required for API auth');
  }

  app.decorateRequest('reviewerId', null);
  app.addHook('preHandler', async (request: FastifyRequest) => {
    const authorization = request.headers.authorization;
    if (authorization !== `Bearer ${token}`) {
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
