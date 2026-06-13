#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(skillRoot, '..', '..');

// Resolve the vibeloop CLI in priority order so the Skill works both inside the
// monorepo (development) and as a self-contained product copy. The CLI is the
// sole decision authority; this wrapper only forwards argv.
//
// IMPORTANT: the success path must NOT write to stderr — UATs assert the run
// produced empty stderr. Only emit on the terminal not-found error.
function resolveCli() {
  // 1. Explicit override (node script path). Always wins.
  const override = process.env.VIBELOOP_CLI;
  if (override) {
    return { runner: process.execPath, prefix: [override], source: 'env' };
  }
  // 2. Monorepo dev bin — freshest source when working in-repo.
  const devBin = path.join(repoRoot, 'packages/cli/bin/vibeloop');
  if (existsSync(devBin)) {
    return { runner: process.execPath, prefix: [devBin], source: 'monorepo' };
  }
  // 3. Bundled CLI shipped inside the skill (product copy).
  const vendor = path.join(skillRoot, 'vendor/vibeloop.mjs');
  if (existsSync(vendor)) {
    return { runner: process.execPath, prefix: [vendor], source: 'vendor' };
  }
  // 4. Globally installed CLI on PATH — attempted last.
  return { runner: 'vibeloop', prefix: [], source: 'path' };
}

const cli = resolveCli();
const child = spawn(cli.runner, [...cli.prefix, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit'
});

child.on('error', (error) => {
  if (error && error.code === 'ENOENT' && cli.source === 'path') {
    console.error(
      [
        'vibeloop CLI not found.',
        'Resolution order: VIBELOOP_CLI env → monorepo packages/cli/bin/vibeloop → skill vendor/vibeloop.mjs → PATH `vibeloop`.',
        'Fix one of:',
        '  - set VIBELOOP_CLI to the CLI entry (node script), or',
        '  - run `pnpm bundle:skill` in the harness repo to produce vendor/vibeloop.mjs, or',
        '  - install the vibeloop CLI on PATH.'
      ].join('\n')
    );
    process.exitCode = 127;
    return;
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

child.on('close', (code) => {
  process.exitCode = code ?? 1;
});
