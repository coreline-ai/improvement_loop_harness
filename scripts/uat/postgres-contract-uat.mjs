#!/usr/bin/env node
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  defaultUatEvidenceDir,
  writeUatEvidenceBundle,
  writeUatEvidenceLedger
} from './evidence-bundle.mjs';

export const BLOCKED_EXIT = 20;
export const SCENARIO = 'postgres-contract-uat';
export const PASS_STATUS = 'POSTGRES_CONTRACT_PASS';
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_CONNECTION_TIMEOUT_MS = 15_000;
const TEST_ARGS = [
  'pnpm',
  'exec',
  'vitest',
  'run',
  'apps/server/src/store-contract.test.ts',
  'apps/server/src/routes/candidates.test.ts',
  'apps/server/src/app.test.ts'
];
const CONNECTION_ARGS = [
  'pnpm',
  '--filter',
  '@vibeloop/server',
  'exec',
  'node',
  'scripts/postgres-connection-check.mjs'
];
const CONNECTION_COMMAND_LABEL =
  'corepack pnpm --filter @vibeloop/server exec node scripts/postgres-connection-check.mjs';
const PRISMA_STORE_SMOKE_ARGS = [
  'pnpm',
  '--filter',
  '@vibeloop/server',
  'exec',
  'node',
  'scripts/prisma-store-contract-smoke.mjs'
];
const PRISMA_STORE_SMOKE_COMMAND_LABEL =
  'corepack pnpm --filter @vibeloop/server exec node scripts/prisma-store-contract-smoke.mjs';

function trimOutput(value) {
  return String(value).trim().slice(0, 4_000);
}

export function redactDatabaseUrl(value) {
  if (!value) {
    return '';
  }
  try {
    const parsed = new URL(value);
    if (parsed.password) {
      parsed.password = 'REDACTED';
    }
    if (parsed.username) {
      parsed.username = 'REDACTED';
    }
    return parsed.toString();
  } catch {
    return '[invalid-url-redacted]';
  }
}

export function redactDatabaseOutput(value, databaseUrl) {
  let output = trimOutput(value);
  if (!databaseUrl) {
    return output;
  }
  output = output.split(databaseUrl).join(redactDatabaseUrl(databaseUrl));
  try {
    const parsed = new URL(databaseUrl);
    for (const secret of [parsed.username, parsed.password]) {
      if (secret) {
        output = output.split(decodeURIComponent(secret)).join('[REDACTED]');
        output = output.split(secret).join('[REDACTED]');
      }
    }
  } catch {
    // Invalid URLs are handled by databaseUrlCheck before command execution.
  }
  return output;
}

export function databaseUrlCheck(env = process.env) {
  const value = env.TEST_DATABASE_URL?.trim() ?? '';
  if (!value) {
    return {
      ok: false,
      status: 'missing',
      required: 'TEST_DATABASE_URL points at an isolated PostgreSQL database',
      value: ''
    };
  }

  try {
    const parsed = new URL(value);
    const ok = ['postgres:', 'postgresql:'].includes(parsed.protocol);
    return {
      ok,
      status: ok ? 'pass' : 'invalid_protocol',
      required: 'postgres:// or postgresql:// TEST_DATABASE_URL',
      value: redactDatabaseUrl(value)
    };
  } catch (error) {
    return {
      ok: false,
      status: 'invalid_url',
      required: 'parseable PostgreSQL TEST_DATABASE_URL',
      value: redactDatabaseUrl(value),
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function postgresConnectionCheck(options = {}) {
  const env = options.env ?? process.env;
  const runCommand = options.runCommand ?? run;
  const result = await runCommand('corepack', CONNECTION_ARGS, {
    env,
    timeoutMs: options.timeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS
  });
  return {
    ok: result.ok,
    status: result.ok ? 'pass' : result.status,
    required: 'reachable isolated PostgreSQL database via TEST_DATABASE_URL',
    command: CONNECTION_COMMAND_LABEL,
    exit_code: result.exit_code,
    stdout: redactDatabaseOutput(result.stdout, env.TEST_DATABASE_URL),
    stderr: redactDatabaseOutput(result.stderr, env.TEST_DATABASE_URL)
  };
}

export async function prismaStoreSmokeCheck(options = {}) {
  const env = options.env ?? process.env;
  const runCommand = options.runCommand ?? run;
  const result = await runCommand('corepack', PRISMA_STORE_SMOKE_ARGS, {
    env,
    timeoutMs: options.timeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS
  });
  const parsed = result.ok ? parseJsonTail(result.stdout) : null;
  return {
    ok: result.ok && parsed?.ok === true,
    status: result.ok && parsed?.ok === true ? 'pass' : result.status,
    required:
      'PrismaStore persists security metadata and rejects duplicate fingerprints on TEST_DATABASE_URL',
    command: PRISMA_STORE_SMOKE_COMMAND_LABEL,
    exit_code: result.exit_code,
    stdout: redactDatabaseOutput(result.stdout, env.TEST_DATABASE_URL),
    stderr: redactDatabaseOutput(result.stderr, env.TEST_DATABASE_URL),
    checks: parsed?.checks ?? null
  };
}

export function parseJsonTail(text) {
  const input = String(text);
  let lastParsed = null;
  let lastEnd = -1;
  for (
    let start = input.indexOf('{');
    start >= 0;
    start = input.indexOf('{', start + 1)
  ) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < input.length; index += 1) {
      const char = input[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (char === '{') {
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(input.slice(start, index + 1));
            if (index >= lastEnd) {
              lastParsed = parsed;
              lastEnd = index;
            }
          } catch {
            break;
          }
          break;
        }
      }
    }
  }
  return lastParsed;
}

export function run(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      resolve({
        ok: false,
        status: 'timeout',
        exit_code: null,
        stdout: trimOutput(stdout),
        stderr: trimOutput(stderr)
      });
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        status: 'spawn_error',
        exit_code: null,
        stdout: trimOutput(stdout),
        stderr: trimOutput(`${stderr}\n${error.message}`)
      });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        status: code === 0 ? 'pass' : 'fail',
        exit_code: code,
        stdout: trimOutput(stdout),
        stderr: trimOutput(stderr)
      });
    });
  });
}

export function buildBlockedReport(checks) {
  const missingUrl = checks.test_database_url?.ok === false;
  return {
    status: 'blocked',
    scenario: 'postgres-contract',
    reason: missingUrl
      ? 'TEST_DATABASE_URL_UNAVAILABLE'
      : 'TEST_DATABASE_CONNECTION_UNAVAILABLE',
    required_failures: missingUrl
      ? ['test_database_url']
      : ['database_connection'],
    checks,
    next_step:
      'Start an isolated PostgreSQL database and set TEST_DATABASE_URL, or run corepack pnpm uat:postgres-contract:docker when Docker Compose is available, then rerun corepack pnpm uat:postgres-contract before closing P2.'
  };
}

export async function buildPostgresContractReport(options = {}) {
  const checkEnv = options.env ?? process.env;
  const commandEnv = options.env ? { ...process.env, ...options.env } : process.env;
  const preflightOnly = options.preflightOnly ?? false;
  const runCommand = options.runCommand ?? run;
  const checks = {
    test_database_url: databaseUrlCheck(checkEnv)
  };

  if (!checks.test_database_url.ok) {
    return buildBlockedReport(checks);
  }

  checks.database_connection = await postgresConnectionCheck({
    env: commandEnv,
    runCommand,
    timeoutMs: options.connectionTimeoutMs
  });

  if (!checks.database_connection.ok) {
    return buildBlockedReport(checks);
  }

  if (!preflightOnly) {
    checks.prisma_store_smoke = await prismaStoreSmokeCheck({
      env: commandEnv,
      runCommand,
      timeoutMs: options.connectionTimeoutMs
    });
    if (!checks.prisma_store_smoke.ok) {
      return {
        status: 'fail',
        scenario: 'postgres-contract',
        reason: 'PRISMA_STORE_SMOKE_FAILED',
        checks,
        next_step:
          'Build the server package, apply migrations, and fix PrismaStore Postgres contract behavior before closing P2.'
      };
    }
  }

  if (preflightOnly) {
    return {
      status: 'pass',
      scenario: 'postgres-contract-preflight',
      required_failures: [],
      checks
    };
  }

  const result = await runCommand('corepack', TEST_ARGS, { env: commandEnv });
  const stdout = redactDatabaseOutput(result.stdout, commandEnv.TEST_DATABASE_URL);
  const stderr = redactDatabaseOutput(result.stderr, commandEnv.TEST_DATABASE_URL);
  return {
    status: result.ok ? 'pass' : 'fail',
    scenario: 'postgres-contract',
    command: ['corepack', ...TEST_ARGS].join(' '),
    checks,
    stdout,
    stderr,
    test_result: {
      status: result.status,
      exit_code: result.exit_code
    }
  };
}

export function postgresContractExitCode(report) {
  if (report.status === 'blocked') return BLOCKED_EXIT;
  if (report.status === 'pass') return 0;
  return report.test_result?.exit_code ?? 1;
}

export async function writePostgresContractEvidence(report, options = {}) {
  const runId =
    options.runId ?? `postgres-contract-${process.pid}-${Date.now()}`;
  const evidenceDir = options.evidenceDir ?? defaultUatEvidenceDir();
  const tmpRoot =
    options.tmpRoot ??
    (await mkdtemp(path.join(os.tmpdir(), 'vibeloop-postgres-contract-')));
  const reportDir = path.join(tmpRoot, 'reports');
  const reportPath = path.join(reportDir, 'postgres-contract-report.json');
  await mkdir(reportDir, { recursive: true });
  const reportJson = { ...report };
  delete reportJson.stdout;
  delete reportJson.stderr;
  await writeFile(reportPath, `${JSON.stringify(reportJson, null, 2)}\n`);

  const ledger = {
    status: PASS_STATUS,
    scenario: SCENARIO,
    run_id: runId,
    mode: 'PrismaStore Postgres contract',
    command: report.command,
    database_url: report.checks?.test_database_url?.value ?? null,
    checks: report.checks,
    test_result: report.test_result
  };
  const bundle = await writeUatEvidenceBundle({
    scenario: SCENARIO,
    runId,
    tmpRoot,
    output: ledger,
    extraFiles: [
      {
        kind: 'report',
        label: 'postgres-contract-report',
        path: reportPath
      }
    ],
    extraJson: {
      checks: report.checks,
      test_result: report.test_result
    },
    evidenceDir
  });
  ledger.evidence_bundle = bundle.bundle_dir;
  ledger.evidence_manifest = bundle.manifest_path;
  ledger.evidence_copied_count = bundle.copied_count + 1;
  ledger.evidence_missing_count = bundle.missing_count;
  const ledgerFile = await writeUatEvidenceLedger(bundle, ledger);
  if (!options.keepTmp) {
    await rm(tmpRoot, { recursive: true, force: true });
  }
  return { ledger, ledgerFile, bundle };
}

async function main() {
  const report = await buildPostgresContractReport({
    preflightOnly: process.argv.includes('--preflight')
  });

  if (report.stdout) {
    console.log(report.stdout);
  }
  if (report.stderr) {
    console.error(report.stderr);
  }

  const jsonReport = { ...report };
  delete jsonReport.stdout;
  delete jsonReport.stderr;
  if (report.status === 'pass' && jsonReport.scenario === 'postgres-contract') {
    const evidence = await writePostgresContractEvidence(report, {
      keepTmp: process.env.VIBELOOP_UAT_KEEP_TMP === '1'
    });
    jsonReport.evidence_bundle = evidence.bundle.bundle_dir;
    jsonReport.evidence_manifest = evidence.bundle.manifest_path;
    jsonReport.ledger = evidence.ledgerFile;
    jsonReport.evidence_copied_count = evidence.ledger.evidence_copied_count;
    jsonReport.evidence_missing_count = evidence.ledger.evidence_missing_count;
  }
  console.log(JSON.stringify(jsonReport, null, 2));
  process.exit(postgresContractExitCode(report));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
