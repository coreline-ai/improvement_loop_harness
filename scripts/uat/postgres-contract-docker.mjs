#!/usr/bin/env node
import { spawn } from 'node:child_process';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import {
  BLOCKED_EXIT,
  postgresConnectionCheck,
  redactDatabaseOutput,
  redactDatabaseUrl
} from './postgres-contract-uat.mjs';

export { BLOCKED_EXIT };

export const DEFAULT_TEST_DATABASE_URL =
  'postgresql://vibeloop:vibeloop@127.0.0.1:54329/vibeloop';

const DEFAULT_TIMEOUT_MS = 120_000;

function trimOutput(value) {
  return String(value).trim().slice(0, 4_000);
}

export function parseJsonTail(text) {
  const input = String(text);
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
      if (inString) {
        continue;
      }
      if (char === '{') {
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(input.slice(start, index + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}

function commandSummary(result, databaseUrl) {
  return {
    ok: result.ok,
    status: result.status,
    exit_code: result.exit_code,
    stdout: redactDatabaseOutput(result.stdout, databaseUrl),
    stderr: redactDatabaseOutput(result.stderr, databaseUrl)
  };
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

async function waitForPostgres(options) {
  let lastCheck = null;
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    lastCheck = await postgresConnectionCheck({
      env: options.env,
      runCommand: options.runCommand,
      timeoutMs: options.connectionTimeoutMs
    });
    if (lastCheck.ok) {
      return { ...lastCheck, attempts: attempt };
    }
    if (attempt < options.attempts && options.delayMs > 0) {
      await delay(options.delayMs);
    }
  }
  return {
    ...lastCheck,
    attempts: options.attempts
  };
}

export async function buildPostgresDockerContractReport(options = {}) {
  const databaseUrl =
    options.databaseUrl ??
    process.env.TEST_DATABASE_URL ??
    DEFAULT_TEST_DATABASE_URL;
  const env = {
    ...process.env,
    ...options.env,
    DATABASE_URL: databaseUrl,
    TEST_DATABASE_URL: databaseUrl
  };
  const runCommand = options.runCommand ?? run;
  const checks = {};

  const dockerCompose = await runCommand('docker', ['compose', 'version'], {
    env,
    timeoutMs: options.commandTimeoutMs
  });
  checks.docker_compose = {
    required: 'Docker Compose can start the isolated postgres service',
    ...commandSummary(dockerCompose, databaseUrl)
  };
  if (!dockerCompose.ok) {
    return {
      status: 'blocked',
      scenario: 'postgres-contract-docker',
      reason: 'POSTGRES_DOCKER_UNAVAILABLE',
      database_url: redactDatabaseUrl(databaseUrl),
      required_failures: ['docker_compose'],
      checks,
      next_step:
        'Install/start Docker Desktop or Colima, then rerun corepack pnpm uat:postgres-contract:docker.'
    };
  }

  const composeUp = await runCommand(
    'docker',
    ['compose', 'up', '-d', 'postgres'],
    { env, timeoutMs: options.commandTimeoutMs }
  );
  checks.docker_compose_up = {
    required: 'isolated postgres service starts from docker-compose.yml',
    ...commandSummary(composeUp, databaseUrl)
  };
  if (!composeUp.ok) {
    return {
      status: 'blocked',
      scenario: 'postgres-contract-docker',
      reason: 'POSTGRES_COMPOSE_UP_FAILED',
      database_url: redactDatabaseUrl(databaseUrl),
      required_failures: ['docker_compose_up'],
      checks,
      next_step:
        'Fix the local Docker Compose postgres service, then rerun corepack pnpm uat:postgres-contract:docker.'
    };
  }

  checks.database_connection = await waitForPostgres({
    env,
    runCommand,
    attempts: options.connectionAttempts ?? 30,
    delayMs: options.connectionDelayMs ?? 1_000,
    connectionTimeoutMs: options.connectionTimeoutMs
  });
  if (!checks.database_connection.ok) {
    return {
      status: 'blocked',
      scenario: 'postgres-contract-docker',
      reason: 'TEST_DATABASE_CONNECTION_UNAVAILABLE',
      database_url: redactDatabaseUrl(databaseUrl),
      required_failures: ['database_connection'],
      checks,
      next_step:
        'Verify the docker postgres service is healthy and reachable on 127.0.0.1:54329, then rerun corepack pnpm uat:postgres-contract:docker.'
    };
  }

  const migrate = await runCommand(
    'corepack',
    ['pnpm', 'exec', 'prisma', 'migrate', 'deploy'],
    { env, timeoutMs: options.commandTimeoutMs }
  );
  checks.prisma_migrate = {
    required: 'Prisma migrations apply cleanly to the isolated postgres DB',
    ...commandSummary(migrate, databaseUrl)
  };
  if (!migrate.ok) {
    return {
      status: 'fail',
      scenario: 'postgres-contract-docker',
      reason: 'PRISMA_MIGRATION_FAILED',
      database_url: redactDatabaseUrl(databaseUrl),
      checks
    };
  }

  const contract = await runCommand('corepack', ['pnpm', 'uat:postgres-contract'], {
    env,
    timeoutMs: options.commandTimeoutMs
  });
  const contractReport = parseJsonTail(contract.stdout);
  const contractEvidence =
    contract.ok && contractReport
      ? {
          report_status: contractReport.status,
          report_scenario: contractReport.scenario,
          evidence_bundle: contractReport.evidence_bundle,
          evidence_manifest: contractReport.evidence_manifest,
          ledger: contractReport.ledger,
          evidence_copied_count: contractReport.evidence_copied_count,
          evidence_missing_count: contractReport.evidence_missing_count
        }
      : {};
  return {
    status: contract.ok ? 'pass' : 'fail',
    scenario: 'postgres-contract-docker',
    command: 'corepack pnpm uat:postgres-contract',
    database_url: redactDatabaseUrl(databaseUrl),
    checks,
    contract_result: {
      status: contract.status,
      exit_code: contract.exit_code,
      stdout: redactDatabaseOutput(contract.stdout, databaseUrl),
      stderr: redactDatabaseOutput(contract.stderr, databaseUrl),
      ...contractEvidence
    }
  };
}

export function postgresDockerContractExitCode(report) {
  if (report.status === 'blocked') return BLOCKED_EXIT;
  return report.status === 'pass' ? 0 : report.contract_result?.exit_code ?? 1;
}

async function main() {
  const report = await buildPostgresDockerContractReport();
  console.log(JSON.stringify(report, null, 2));
  process.exit(postgresDockerContractExitCode(report));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
