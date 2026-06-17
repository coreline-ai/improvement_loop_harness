#!/usr/bin/env node
import pg from 'pg';

const timeout = Number.parseInt(
  process.env.VIBELOOP_POSTGRES_PREFLIGHT_TIMEOUT_MS ?? '5000',
  10
);
const client = new pg.Client({
  connectionString: process.env.TEST_DATABASE_URL,
  connectionTimeoutMillis: Number.isFinite(timeout) ? timeout : 5000
});

try {
  await client.connect();
  const result = await client.query('SELECT 1 AS ok');
  if (result.rows?.[0]?.ok !== 1) {
    throw new Error('unexpected SELECT 1 result');
  }
  console.log(JSON.stringify({ ok: true }));
} finally {
  await client.end().catch(() => undefined);
}
