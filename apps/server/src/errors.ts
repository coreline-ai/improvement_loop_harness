import type { FastifyReply } from 'fastify';

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof ApiError) {
    const body: { error: { code: string; message: string; details?: unknown } } = {
      error: { code: error.code, message: error.message }
    };
    if (error.details !== undefined) {
      body.error.details = error.details;
    }
    return reply.code(error.statusCode).send(body);
  }
  const message = error instanceof Error ? error.message : String(error);
  return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message } });
}

export function requireRecord<T>(record: T | null, code: string, message: string): T {
  if (!record) {
    throw new ApiError(404, code, message);
  }
  return record;
}
