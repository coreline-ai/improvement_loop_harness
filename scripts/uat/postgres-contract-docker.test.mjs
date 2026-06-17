import { describe, expect, it } from 'vitest';
import {
  BLOCKED_EXIT,
  buildPostgresDockerContractReport,
  parseJsonTail,
  postgresDockerContractExitCode
} from './postgres-contract-docker.mjs';

describe('postgres docker contract UAT helper', () => {
  it('blocks when Docker Compose is unavailable', async () => {
    const report = await buildPostgresDockerContractReport({
      databaseUrl: 'postgresql://test:secret@127.0.0.1:54329/vibeloop',
      runCommand: async () => ({
        ok: false,
        status: 'spawn_error',
        exit_code: null,
        stdout: '',
        stderr: 'spawn docker ENOENT postgresql://test:secret@127.0.0.1:54329/vibeloop'
      })
    });

    expect(report).toMatchObject({
      status: 'blocked',
      scenario: 'postgres-contract-docker',
      reason: 'POSTGRES_DOCKER_UNAVAILABLE',
      required_failures: ['docker_compose']
    });
    expect(report.database_url).toContain('REDACTED');
    expect(report.checks.docker_compose.stderr).not.toContain('secret');
    expect(postgresDockerContractExitCode(report)).toBe(BLOCKED_EXIT);
  });

  it('starts postgres, waits for SELECT 1, migrates, and runs the contract', async () => {
    const calls = [];
    const databaseUrl = 'postgresql://test:secret@127.0.0.1:54329/vibeloop';
    const report = await buildPostgresDockerContractReport({
      databaseUrl,
      connectionAttempts: 1,
      connectionDelayMs: 0,
      runCommand: async (command, args, options = {}) => {
        calls.push({ command, args, env: options.env });
        if (command === 'docker' && args.join(' ') === 'compose version') {
          return {
            ok: true,
            status: 'pass',
            exit_code: 0,
            stdout: 'Docker Compose version v2.0.0',
            stderr: ''
          };
        }
        if (command === 'docker' && args.join(' ') === 'compose up -d postgres') {
          return {
            ok: true,
            status: 'pass',
            exit_code: 0,
            stdout: 'postgres started',
            stderr: ''
          };
        }
        if (args.includes('--filter')) {
          return {
            ok: true,
            status: 'pass',
            exit_code: 0,
            stdout: '{"ok":true}',
            stderr: ''
          };
        }
        if (args.join(' ') === 'pnpm exec prisma migrate deploy') {
          return {
            ok: true,
            status: 'pass',
            exit_code: 0,
            stdout: 'migrations applied',
            stderr: ''
          };
        }
        if (args.join(' ') === 'pnpm uat:postgres-contract') {
          return {
            ok: true,
            status: 'pass',
            exit_code: 0,
            stdout: `contract passed
{
  "status": "pass",
  "scenario": "postgres-contract",
  "database_url": "postgresql://test:secret@127.0.0.1:54329/vibeloop",
  "evidence_bundle": "/tmp/evidence/postgres-contract-uat/run-1",
  "evidence_manifest": "/tmp/evidence/postgres-contract-uat/run-1/uat-evidence-manifest.json",
  "ledger": "/tmp/evidence/postgres-contract-uat/run-1/ledger.json",
  "evidence_copied_count": 2,
  "evidence_missing_count": 0
}`,
            stderr: ''
          };
        }
        throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
      }
    });

    expect(report).toMatchObject({
      status: 'pass',
      scenario: 'postgres-contract-docker',
      checks: {
        docker_compose: { ok: true },
        docker_compose_up: { ok: true },
        database_connection: { ok: true, attempts: 1 },
        prisma_migrate: { ok: true }
      },
      contract_result: {
        status: 'pass',
        exit_code: 0,
        report_status: 'pass',
        report_scenario: 'postgres-contract',
        evidence_bundle: '/tmp/evidence/postgres-contract-uat/run-1',
        evidence_manifest:
          '/tmp/evidence/postgres-contract-uat/run-1/uat-evidence-manifest.json',
        ledger: '/tmp/evidence/postgres-contract-uat/run-1/ledger.json',
        evidence_copied_count: 2,
        evidence_missing_count: 0
      }
    });
    expect(report.contract_result.stdout).not.toContain('secret');
    expect(calls.map((call) => `${call.command} ${call.args.join(' ')}`)).toEqual([
      'docker compose version',
      'docker compose up -d postgres',
      'corepack pnpm --filter @vibeloop/server exec node scripts/postgres-connection-check.mjs',
      'corepack pnpm exec prisma migrate deploy',
      'corepack pnpm uat:postgres-contract'
    ]);
    expect(calls.at(-1).env.TEST_DATABASE_URL).toBe(databaseUrl);
    expect(postgresDockerContractExitCode(report)).toBe(0);
  });

  it('extracts a trailing contract JSON object from noisy stdout', () => {
    expect(
      parseJsonTail(`noise { not json }
still noise
{"status":"pass","nested":{"brace":"} inside string"}}`)
    ).toEqual({
      status: 'pass',
      nested: { brace: '} inside string' }
    });
  });

  it('fails when migrations do not apply to the isolated database', async () => {
    const report = await buildPostgresDockerContractReport({
      connectionAttempts: 1,
      connectionDelayMs: 0,
      runCommand: async (command, args) => {
        if (command === 'docker') {
          return { ok: true, status: 'pass', exit_code: 0, stdout: '', stderr: '' };
        }
        if (args.includes('--filter')) {
          return { ok: true, status: 'pass', exit_code: 0, stdout: '', stderr: '' };
        }
        return {
          ok: false,
          status: 'fail',
          exit_code: 1,
          stdout: '',
          stderr: 'migration failed'
        };
      }
    });

    expect(report).toMatchObject({
      status: 'fail',
      reason: 'PRISMA_MIGRATION_FAILED',
      checks: {
        prisma_migrate: {
          ok: false,
          status: 'fail'
        }
      }
    });
    expect(postgresDockerContractExitCode(report)).toBe(1);
  });
});
