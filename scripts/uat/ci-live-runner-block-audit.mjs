#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

function parseArgs(argv) {
  const options = {
    preflightFile: '',
    output: '',
    workflowName: '',
    evidenceScenario: '',
    runId: process.env.GITHUB_RUN_ID || '',
    runAttempt: process.env.GITHUB_RUN_ATTEMPT || ''
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--preflight-file') {
      options.preflightFile = argv[index + 1] ?? '';
      index += 1;
      continue;
    }
    if (arg === '--output') {
      options.output = argv[index + 1] ?? '';
      index += 1;
      continue;
    }
    if (arg === '--workflow-name') {
      options.workflowName = argv[index + 1] ?? '';
      index += 1;
      continue;
    }
    if (arg === '--evidence-scenario') {
      options.evidenceScenario = argv[index + 1] ?? '';
      index += 1;
      continue;
    }
    if (arg === '--run-id') {
      options.runId = argv[index + 1] ?? '';
      index += 1;
      continue;
    }
    if (arg === '--run-attempt') {
      options.runAttempt = argv[index + 1] ?? '';
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

function buildLiveRunnerBlockAuditReport({
  preflight,
  workflowName,
  evidenceScenario,
  runId,
  runAttempt
}) {
  const reason = preflight?.reason || 'LIVE_RUNNER_PREFLIGHT_BLOCKED';
  return {
    status: 'blocked',
    scenario: 'ci-live-runner-block-audit',
    mode: 'runner-preflight-evidence-only',
    workflow_name: workflowName || null,
    evidence_scenario: evidenceScenario || null,
    github: {
      run_id: runId || null,
      run_attempt: runAttempt || null
    },
    reason,
    ok: false,
    live_evidence_required: true,
    live_evidence_ran: false,
    live_evidence_pass: false,
    runner_preflight: preflight,
    next_step:
      reason === 'SELF_HOSTED_RUNNER_UNAVAILABLE'
        ? 'Register an online self-hosted runner with the requested label, then rerun the live evidence workflow.'
        : 'Resolve the live runner preflight blocker, then rerun the live evidence workflow before claiming live artifact reproducibility.'
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.preflightFile) {
    throw new Error('--preflight-file is required');
  }
  if (!options.output) {
    throw new Error('--output is required');
  }
  const preflight = await readJson(options.preflightFile);
  const report = buildLiveRunnerBlockAuditReport({
    preflight,
    workflowName: options.workflowName,
    evidenceScenario: options.evidenceScenario,
    runId: options.runId,
    runAttempt: options.runAttempt
  });
  await mkdir(path.dirname(options.output), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = 20;
}

export { buildLiveRunnerBlockAuditReport, parseArgs };

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
