#!/usr/bin/env node
import { spawn } from 'node:child_process';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  buildAdversaryLiveSafetyPlan,
  validateAdversaryLiveSafetyPlan
} from './adversary-live-safety.mjs';

export const BLOCKED_EXIT = 20;
const DEFAULT_TIMEOUT_MS = 30_000;

export function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
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
        stdout: stdout.trim(),
        stderr: stderr.trim()
      });
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
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
        stdout,
        stderr: error.message
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
        stdout: stdout.trim(),
        stderr: stderr.trim()
      });
    });
  });
}

export function redact(text) {
  return String(text).replace(
    /(Token|Authorization|Bearer)\s+[A-Za-z0-9._~+/=-]+/g,
    '$1 [REDACTED]'
  );
}

function buildContainerSmokeArgs(safety) {
  return [
    'run',
    '--rm',
    '--pull=never',
    '--network',
    'none',
    safety.m2.image,
    'node',
    '-e',
    'console.log(JSON.stringify({ok:true,network:"none"}))'
  ];
}

export async function buildAdversaryLivePreflightReport(options = {}) {
  const runCommand = options.runCommand ?? run;
  const safety =
    options.safety ??
    buildAdversaryLiveSafetyPlan({
      image: options.image,
      timeoutMs: options.timeoutMs
    });
  const safetyCheck = validateAdversaryLiveSafetyPlan(safety);

  if (!safetyCheck.ok) {
    return {
      status: 'fail',
      scenario: 'adversary-live-preflight',
      reason: 'ADVERSARY_LIVE_SAFETY_INVARIANT_FAILED',
      required_failures: [],
      safety,
      safety_check: safetyCheck,
      checks: {},
      next_step:
        'Fix the adversary live safety plan before rerunning P4 live adversary UAT.'
    };
  }

  const docker = await runCommand('docker', [
    'info',
    '--format',
    '{{json .ServerVersion}}'
  ]);
  const checks = {
    container_runtime: {
      ok: docker.ok,
      required:
        'docker-compatible daemon reachable for R1 isolated M2/M4 execution',
      status: docker.status,
      exit_code: docker.exit_code,
      stdout: redact(docker.stdout),
      stderr: redact(docker.stderr)
    }
  };

  if (!docker.ok) {
    return {
      status: 'blocked',
      scenario: 'adversary-live-preflight',
      reason: 'CONTAINER_RUNTIME_UNAVAILABLE',
      required_failures: ['container_runtime'],
      safety,
      safety_check: safetyCheck,
      checks,
      next_step:
        'Install/start a Docker-compatible runtime, then rerun corepack pnpm uat:adversary-live-preflight before P4 live adversary UAT.'
    };
  }

  const smoke = await runCommand('docker', buildContainerSmokeArgs(safety), {
    timeoutMs: safety.m2.timeout_ms
  });
  checks.container_smoke = {
    ok: smoke.ok,
    required:
      'R1 smoke container starts with --network none using the configured image',
    image: safety.m2.image,
    network: 'none',
    status: smoke.status,
    exit_code: smoke.exit_code,
    stdout: redact(smoke.stdout),
    stderr: redact(smoke.stderr)
  };

  if (!smoke.ok) {
    return {
      status: 'blocked',
      scenario: 'adversary-live-preflight',
      reason: 'CONTAINER_SMOKE_UNAVAILABLE',
      required_failures: ['container_smoke'],
      safety,
      safety_check: safetyCheck,
      checks,
      next_step:
        'Preload the configured image and verify docker run --rm --network none works, then rerun corepack pnpm uat:adversary-live-preflight before P4 live adversary UAT.'
    };
  }

  return {
    status: 'pass',
    scenario: 'adversary-live-preflight',
    required_failures: [],
    safety,
    safety_check: safetyCheck,
    checks
  };
}

export function adversaryLivePreflightExitCode(report) {
  if (report.status === 'fail') return 1;
  return report.status === 'blocked' ? BLOCKED_EXIT : 0;
}

async function main() {
  const output = await buildAdversaryLivePreflightReport();
  console.log(JSON.stringify(output, null, 2));
  process.exit(adversaryLivePreflightExitCode(output));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
