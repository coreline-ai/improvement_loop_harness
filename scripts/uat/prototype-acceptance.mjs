#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  defaultUatEvidenceDir,
  writeUatEvidenceBundle,
  writeUatEvidenceLedger
} from './evidence-bundle.mjs';

const scenario = 'prototype-acceptance-uat';
const passStatus = 'PROTOTYPE_ACCEPTANCE_UAT_PASS';
const failStatus = 'PROTOTYPE_ACCEPTANCE_UAT_FAIL';

function parseArgs(argv) {
  return {
    githubAutoDiscovery:
      argv.includes('--github-auto-discovery') ||
      process.env.VIBELOOP_PROTOTYPE_ACCEPTANCE_GITHUB_AUTO_DISCOVERY === '1'
  };
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolve({ code, signal, stdout, stderr, ok: code === 0 });
    });
  });
}

async function runStep({ id, command, args, env, logDir }) {
  const startedAt = Date.now();
  const result = await run(command, args, { env });
  const stdoutPath = path.join(logDir, `${id}.stdout.log`);
  const stderrPath = path.join(logDir, `${id}.stderr.log`);
  await writeFile(stdoutPath, result.stdout);
  await writeFile(stderrPath, result.stderr);
  return {
    id,
    command: [command, ...args].join(' '),
    exit_code: result.code,
    signal: result.signal,
    pass: result.ok,
    elapsed_ms: Date.now() - startedAt,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    stdout_tail: result.stdout.trim().slice(-2000),
    stderr_tail: result.stderr.trim().slice(-2000)
  };
}

function stepDefinitions({ githubAutoDiscovery, evidenceRoot }) {
  const durableEnv = {
    ...process.env,
    VIBELOOP_UAT_EVIDENCE_DIR: evidenceRoot,
    VIBELOOP_UAT_KEEP_TMP: process.env.VIBELOOP_UAT_KEEP_TMP ?? '1',
    VIBELOOP_UAT_DURABLE_EVIDENCE: '1'
  };
  const steps = [
    {
      id: 'gitea_preflight',
      command: 'corepack',
      args: ['pnpm', 'uat:gitea:preflight'],
      env: durableEnv
    },
    {
      id: 'p1_gitea_pr',
      command: 'corepack',
      args: ['pnpm', 'uat:skill-loop:p1-gitea-pr'],
      env: durableEnv
    },
    {
      id: 'prototype_failure_retry',
      command: 'corepack',
      args: ['pnpm', 'uat:prototype-retry-loop'],
      env: durableEnv
    },
    {
      id: 'gitea_local_pr_like_evidence_audit',
      command: 'corepack',
      args: [
        'pnpm',
        'uat:release-evidence-audit',
        '--',
        '--scenario',
        'skill-real-user-prompt-corpus-live-uat',
        '--require-skill-prompt-corpus-local-pr-like',
        '--allow-skill-prompt-corpus-targeted'
      ],
      env: durableEnv
    }
  ];
  if (githubAutoDiscovery) {
    steps.push(
      {
        id: 'github_auto_discovery_smoke',
        command: 'corepack',
        args: [
          'pnpm',
          'uat:skill-loop:codex-skill-prompt:auto:real-builder:github'
        ],
        env: {
          ...durableEnv,
          VIBELOOP_UAT_KEEP_REMOTE: process.env.VIBELOOP_UAT_KEEP_REMOTE ?? '1'
        }
      },
      {
        id: 'github_skill_prompt_evidence_audit',
        command: 'corepack',
        args: [
          'pnpm',
          'uat:release-evidence-audit',
          '--',
          '--scenario',
          'skill-real-user-codex-skill-prompt-github-draft-pr-uat'
        ],
        env: durableEnv
      }
    );
  }
  return steps;
}

export async function runPrototypeAcceptance(options = {}) {
  const evidenceRoot = defaultUatEvidenceDir();
  const runId = `prototype-acceptance-${process.pid}-${Date.now()}`;
  const logDir = path.join(evidenceRoot, scenario, runId, 'step-logs');
  await mkdir(logDir, { recursive: true });

  const steps = [];
  for (const definition of stepDefinitions({
    githubAutoDiscovery: options.githubAutoDiscovery === true,
    evidenceRoot
  })) {
    const step = await runStep({ ...definition, logDir });
    steps.push(step);
    if (!step.pass) break;
  }

  const pass = steps.length > 0 && steps.every((step) => step.pass === true);
  const summaryPath = path.join(logDir, 'prototype-acceptance-summary.json');
  const summary = {
    scenario,
    status: pass ? passStatus : failStatus,
    github_auto_discovery_requested: options.githubAutoDiscovery === true,
    evidence_root: evidenceRoot,
    steps
  };
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);

  const ledger = {
    status: summary.status,
    scenario,
    proof_scope: 'prototype_acceptance_command',
    github_auto_discovery_requested: options.githubAutoDiscovery === true,
    evidence_root: evidenceRoot,
    total_steps: steps.length,
    passed_steps: steps.filter((step) => step.pass).length,
    failed_steps: steps.filter((step) => !step.pass).length,
    steps,
    failure_reasons: steps
      .filter((step) => !step.pass)
      .map((step) => `${step.id}:exit_${step.exit_code ?? 'signal'}`),
    false_pass: pass ? 0 : 1,
    leak: 0,
    limitations: [
      'prototype acceptance command only',
      'default path excludes GitHub draft PR creation',
      'does not prove production-grade arbitrary-repo safety'
    ],
    evidence: {
      summary: summaryPath
    }
  };

  const extraFiles = [
    { label: 'prototype_acceptance_summary', path: summaryPath, kind: 'report' }
  ];
  for (const step of steps) {
    extraFiles.push({ label: `${step.id}_stdout`, path: step.stdout_path });
    extraFiles.push({ label: `${step.id}_stderr`, path: step.stderr_path });
  }
  const evidenceBundle = await writeUatEvidenceBundle({
    scenario,
    runId,
    tmpRoot: logDir,
    dataDir: logDir,
    outputs: [ledger],
    output: ledger,
    extraFiles,
    extraJson: {
      acceptance_summary: summary
    },
    evidenceDir: evidenceRoot
  });
  ledger.evidence = {
    ...ledger.evidence,
    evidence_bundle: evidenceBundle.bundle_dir,
    evidence_manifest: evidenceBundle.manifest_path,
    evidence_ledger: path.join(evidenceBundle.bundle_dir, 'ledger.json'),
    evidence_copied_count: evidenceBundle.copied_count,
    evidence_missing_count: evidenceBundle.missing_count
  };
  await writeUatEvidenceLedger(evidenceBundle, ledger);
  return ledger;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const ledger = await runPrototypeAcceptance(options);
  console.log(JSON.stringify(ledger, null, 2));
  if (ledger.status !== passStatus) process.exitCode = 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
