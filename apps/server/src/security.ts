import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiError } from './errors.js';

export interface SecurityOptions {
  rateLimitMax?: number | undefined;
  rateLimitWindowMs?: number | undefined;
  corsOrigin?: string | undefined;
}

interface RateLimitBucket {
  resetAt: number;
  count: number;
}

const DEFAULT_RATE_LIMIT_MAX = 600;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;

function requestKey(request: FastifyRequest): string {
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0]!.trim();
  }
  return request.ip;
}

export async function registerSecurity(
  app: FastifyInstance,
  options: SecurityOptions = {}
): Promise<void> {
  const buckets = new Map<string, RateLimitBucket>();
  const max = options.rateLimitMax ?? DEFAULT_RATE_LIMIT_MAX;
  const windowMs = options.rateLimitWindowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS;
  const corsOrigin = options.corsOrigin ?? process.env.VIBELOOP_CORS_ORIGIN;

  app.addHook('onRequest', async (request, reply) => {
    const now = Date.now();
    const key = requestKey(request);
    const current = buckets.get(key);
    const bucket =
      current && current.resetAt > now
        ? current
        : { resetAt: now + windowMs, count: 0 };
    bucket.count += 1;
    buckets.set(key, bucket);
    reply.header('x-ratelimit-limit', String(max));
    reply.header('x-ratelimit-remaining', String(Math.max(0, max - bucket.count)));
    reply.header('x-ratelimit-reset', String(Math.ceil(bucket.resetAt / 1000)));
    if (bucket.count > max) {
      throw new ApiError(429, 'RATE_LIMITED', 'too many requests');
    }
  });

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header(
      'content-security-policy',
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"
    );
    reply.header('vary', 'Origin');
    if (corsOrigin) {
      reply.header('access-control-allow-origin', corsOrigin);
    }
    return payload;
  });
}
