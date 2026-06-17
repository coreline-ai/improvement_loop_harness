#!/usr/bin/env node
import { spawn } from 'node:child_process';
import process from 'node:process';

const DEFAULT_TIMEOUT_MS = 20_000;

function trimOutput(value) {
  return value.trim().slice(0, 4_000);
}

function run(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: process.env,
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

function checkNode() {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  return {
    ok: major >= 22,
    status: major >= 22 ? 'pass' : 'fail',
    required: '>=22',
    version: process.versions.node
  };
}

function summarizeResult(name, result, required = true) {
  const status = result.ok ? 'PASS' : required ? 'FAIL' : 'WARN';
  const detail = result.stdout || result.stderr || result.status;
  console.log(`[${status}] ${name}${detail ? `: ${detail.split('\n')[0]}` : ''}`);
}

async function main() {
  const checks = {
    node: checkNode(),
    corepack_pnpm: await run('corepack', ['pnpm', '--version']),
    pnpm_shim: await run('pnpm', ['--version']),
    gh_auth: await run('gh', ['auth', 'status']),
    codex_version: await run('codex', ['--version']),
    codex_login: await run('codex', [
      '-c',
      'service_tier=fast',
      'login',
      'status'
    ])
  };

  summarizeResult('node >=22', checks.node);
  summarizeResult('corepack pnpm', checks.corepack_pnpm);
  summarizeResult('pnpm shim on PATH', checks.pnpm_shim, false);
  summarizeResult('GitHub auth', checks.gh_auth);
  summarizeResult('Codex CLI', checks.codex_version);
  summarizeResult('Codex ChatGPT login', checks.codex_login);

  const requiredFailures = [
    ['node', checks.node.ok],
    ['corepack_pnpm', checks.corepack_pnpm.ok],
    ['gh_auth', checks.gh_auth.ok],
    ['codex_version', checks.codex_version.ok],
    ['codex_login', checks.codex_login.ok]
  ].filter(([, ok]) => !ok);

  const report = {
    status: requiredFailures.length === 0 ? 'pass' : 'fail',
    required_failures: requiredFailures.map(([name]) => name),
    warnings: checks.pnpm_shim.ok ? [] : ['pnpm_shim'],
    checks
  };

  console.log(JSON.stringify(report, null, 2));
  if (requiredFailures.length > 0) {
    process.exitCode = 20;
  }
}

await main();
