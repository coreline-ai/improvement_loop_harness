import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BLOCKED_EXIT,
  PASS_STATUS,
  buildPostgresContractReport,
  databaseUrlCheck,
  parseJsonTail,
  postgresContractExitCode,
  postgresConnectionCheck,
  prismaStoreSmokeCheck,
  redactDatabaseOutput,
  redactDatabaseUrl,
  writePostgresContractEvidence
} from './postgres-contract-uat.mjs';

describe('postgres contract UAT preflight', () => {
  it('blocks without TEST_DATABASE_URL', async () => {
    const report = await buildPostgresContractReport({
      env: {},
      preflightOnly: true
    });

    expect(report).toMatchObject({
      status: 'blocked',
      scenario: 'postgres-contract',
      reason: 'TEST_DATABASE_URL_UNAVAILABLE',
      required_failures: ['test_database_url']
    });
    expect(report.checks.test_database_url.status).toBe('missing');
    expect(postgresContractExitCode(report)).toBe(BLOCKED_EXIT);
  });

  it('rejects non-Postgres URLs and redacts credentials', () => {
    expect(
      databaseUrlCheck({
        TEST_DATABASE_URL: 'mysql://user:secret@127.0.0.1:3306/db'
      })
    ).toMatchObject({
      ok: false,
      status: 'invalid_protocol'
    });

    const redacted = redactDatabaseUrl(
      'postgresql://user:secret@127.0.0.1:5432/db'
    );
    expect(redacted).toContain('REDACTED');
    expect(redacted).not.toContain('user');
    expect(redacted).not.toContain('secret');
  });

  it('blocks when TEST_DATABASE_URL is valid but unreachable', async () => {
    const report = await buildPostgresContractReport({
      env: {
        TEST_DATABASE_URL: 'postgresql://test:secret@127.0.0.1:5432/vibeloop'
      },
      preflightOnly: true,
      runCommand: async () => ({
        ok: false,
        status: 'fail',
        exit_code: 1,
        stdout: '',
        stderr:
          'connect ECONNREFUSED postgresql://test:secret@127.0.0.1:5432/vibeloop'
      })
    });

    expect(report).toMatchObject({
      status: 'blocked',
      scenario: 'postgres-contract',
      reason: 'TEST_DATABASE_CONNECTION_UNAVAILABLE',
      required_failures: ['database_connection']
    });
    expect(report.checks.database_connection.status).toBe('fail');
    expect(report.checks.database_connection.stderr).toContain('REDACTED');
    expect(report.checks.database_connection.stderr).not.toContain('secret');
    expect(postgresContractExitCode(report)).toBe(BLOCKED_EXIT);
  });

  it('passes preflight with a reachable isolated Postgres URL', async () => {
    const report = await buildPostgresContractReport({
      env: {
        TEST_DATABASE_URL: 'postgresql://test:test@127.0.0.1:5432/vibeloop'
      },
      preflightOnly: true,
      runCommand: async (command, args) => ({
        ok: true,
        status: 'pass',
        exit_code: 0,
        stdout: `${command} ${args.slice(0, 3).join(' ')} {"ok":true}`,
        stderr: ''
      })
    });

    expect(report).toMatchObject({
      status: 'pass',
      scenario: 'postgres-contract-preflight',
      required_failures: [],
      checks: {
        database_connection: {
          ok: true,
          status: 'pass'
        }
      }
    });
    expect(report.checks.test_database_url.value).not.toContain('test:test');
    expect(postgresContractExitCode(report)).toBe(0);
  });

  it('redacts connection command output without leaking credentials', async () => {
    const output = redactDatabaseOutput(
      'failed for postgresql://alice:s3cr3t@127.0.0.1:5432/vibeloop as alice',
      'postgresql://alice:s3cr3t@127.0.0.1:5432/vibeloop'
    );
    expect(output).toContain('REDACTED');
    expect(output).not.toContain('alice');
    expect(output).not.toContain('s3cr3t');

    const check = await postgresConnectionCheck({
      env: {
        TEST_DATABASE_URL:
          'postgresql://alice:s3cr3t@127.0.0.1:5432/vibeloop'
      },
      runCommand: async () => ({
        ok: false,
        status: 'spawn_error',
        exit_code: null,
        stdout: '',
        stderr: 'postgresql://alice:s3cr3t@127.0.0.1:5432/vibeloop'
      })
    });

    expect(check.stderr).not.toContain('alice');
    expect(check.stderr).not.toContain('s3cr3t');
  });

  it('parses the final JSON object from command output', () => {
    expect(
      parseJsonTail('noise\n{"ok":false}\n{"ok":true,"checks":{"a":"pass"}}')
    ).toEqual({
      ok: true,
      checks: { a: 'pass' }
    });
  });

  it('requires a PrismaStore DB smoke round-trip for full contract runs', async () => {
    const check = await prismaStoreSmokeCheck({
      env: {
        TEST_DATABASE_URL: 'postgresql://test:secret@127.0.0.1:5432/vibeloop'
      },
      runCommand: async (_command, args) => {
        expect(args.join(' ')).toContain('prisma-store-contract-smoke.mjs');
        return {
          ok: true,
          status: 'pass',
          exit_code: 0,
          stdout: [
            'smoke output',
            JSON.stringify({
              ok: true,
              checks: {
                candidate_roundtrip: 'pass',
                security_metadata_roundtrip: 'pass',
                duplicate_fingerprint_rejected: 'pass'
              }
            })
          ].join('\n'),
          stderr: ''
        };
      }
    });

    expect(check).toMatchObject({
      ok: true,
      status: 'pass',
      checks: {
        candidate_roundtrip: 'pass',
        security_metadata_roundtrip: 'pass',
        duplicate_fingerprint_rejected: 'pass'
      }
    });
    expect(check.stdout).not.toContain('secret');
  });

  it('returns the underlying test exit code for full contract failures', async () => {
    const report = await buildPostgresContractReport({
      env: {
        TEST_DATABASE_URL: 'postgres://test:test@127.0.0.1:5432/vibeloop'
      },
      runCommand: async (command, args) => {
        if (args.includes('scripts/prisma-store-contract-smoke.mjs')) {
          return {
            ok: true,
            status: 'pass',
            exit_code: 0,
            stdout: '{"ok":true}',
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
        return {
          ok: false,
          status: 'fail',
          exit_code: 7,
          stdout: `${command} ${args.slice(0, 3).join(' ')} failed`,
          stderr: 'contract failure'
        };
      }
    });

    expect(report).toMatchObject({
      status: 'fail',
      scenario: 'postgres-contract',
      test_result: {
        status: 'fail',
        exit_code: 7
      }
    });
    expect(postgresContractExitCode(report)).toBe(7);
  });

  it('fails full contract runs when the PrismaStore DB smoke fails', async () => {
    const report = await buildPostgresContractReport({
      env: {
        TEST_DATABASE_URL: 'postgres://test:test@127.0.0.1:5432/vibeloop'
      },
      runCommand: async (_command, args) => {
        if (args.includes('scripts/prisma-store-contract-smoke.mjs')) {
          return {
            ok: false,
            status: 'fail',
            exit_code: 9,
            stdout: '{"ok":false}',
            stderr: 'smoke failed'
          };
        }
        return {
          ok: true,
          status: 'pass',
          exit_code: 0,
          stdout: '{"ok":true}',
          stderr: ''
        };
      }
    });

    expect(report).toMatchObject({
      status: 'fail',
      scenario: 'postgres-contract',
      reason: 'PRISMA_STORE_SMOKE_FAILED',
      checks: {
        prisma_store_smoke: {
          ok: false,
          status: 'fail',
          exit_code: 9
        }
      }
    });
    expect(postgresContractExitCode(report)).toBe(1);
  });

  it('writes manifest-backed evidence for a passing full contract', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'vibeloop-postgres-evidence-')
    );
    try {
      const report = await buildPostgresContractReport({
        env: {
          TEST_DATABASE_URL: 'postgresql://test:secret@127.0.0.1:5432/vibeloop'
        },
        runCommand: async (_command, args) => {
          if (args.includes('scripts/prisma-store-contract-smoke.mjs')) {
            return {
              ok: true,
              status: 'pass',
              exit_code: 0,
              stdout: JSON.stringify({
                ok: true,
                checks: {
                  candidate_roundtrip: 'pass',
                  security_metadata_roundtrip: 'pass',
                  duplicate_fingerprint_rejected: 'pass'
                }
              }),
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
          return {
            ok: true,
            status: 'pass',
            exit_code: 0,
            stdout: 'contract passed',
            stderr: ''
          };
        }
      });

      const evidence = await writePostgresContractEvidence(report, {
        evidenceDir: root,
        runId: 'postgres-contract-fixture'
      });
      const ledger = JSON.parse(await readFile(evidence.ledgerFile, 'utf8'));
      const manifest = JSON.parse(
        await readFile(evidence.bundle.manifest_path, 'utf8')
      );

      expect(ledger).toMatchObject({
        status: PASS_STATUS,
        scenario: 'postgres-contract-uat',
        run_id: 'postgres-contract-fixture',
        checks: {
          test_database_url: { ok: true, status: 'pass' },
          database_connection: { ok: true, status: 'pass' },
          prisma_store_smoke: {
            ok: true,
            status: 'pass',
            checks: {
              candidate_roundtrip: 'pass',
              security_metadata_roundtrip: 'pass',
              duplicate_fingerprint_rejected: 'pass'
            }
          }
        },
        test_result: {
          status: 'pass',
          exit_code: 0
        },
        evidence_missing_count: 0
      });
      expect(ledger.database_url).not.toContain('secret');
      expect(manifest).toMatchObject({
        schema_version: '1.0',
        scenario: 'postgres-contract-uat',
        run_id: 'postgres-contract-fixture',
        ledger_ref: 'ledger.json',
        missing: []
      });
      expect(
        manifest.copied.some((entry) => entry.label === 'postgres-contract-report')
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
