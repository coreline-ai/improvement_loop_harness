#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  shouldPruneUatTmp,
  writeUatEvidenceBundle,
  writeUatEvidenceLedger
} from './evidence-bundle.mjs';
import { promptVariants } from './skill-real-user-codex-skill-prompt-uat.mjs';
import { defaultCorpus } from './skill-real-user-prompt-corpus-live-uat.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const promptRunner = path.join(
  repoRoot,
  'skills/vibeloop-harness/scripts/run-from-prompt.mjs'
);
const scenario = 'skill-prompt-routing-corpus-dry-run';
const passStatus = 'SKILL_PROMPT_ROUTING_CORPUS_DRY_RUN_PASS';
const failStatus = 'SKILL_PROMPT_ROUTING_CORPUS_DRY_RUN_FAIL';
const pruneTmp = shouldPruneUatTmp();

function sha256Text(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function countBy(items, keyFn) {
  const counts = {};
  for (const item of items) {
    const key = keyFn(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function safeSegment(value) {
  return String(value ?? 'case')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

export function findPromptVariant(testCase, registry = promptVariants) {
  const variants = registry[testCase.mode] ?? [];
  return variants.find((variant) => variant.id === testCase.variant) ?? null;
}

function parseJson(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2500).unref();
    }, options.timeoutMs ?? 30_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function expectedCommandKind(mode) {
  return mode === 'user_issue'
    ? 'vibeloop_improve'
    : mode === 'auto_discovery'
      ? 'vibeloop_orchestrate'
      : null;
}

function buildPromptRunnerArgs(testCase, variant, caseDir, targetRepo) {
  const args = [
    promptRunner,
    '--prompt',
    variant.prompt,
    '--repo',
    targetRepo,
    '--project-id',
    'skill-prompt-routing-corpus',
    '--loop-id',
    `routing-${safeSegment(testCase.id)}`,
    '--data-dir',
    path.join(caseDir, 'data'),
    '--test-command',
    'npm test'
  ];
  if (testCase.mode === 'user_issue') {
    args.push(
      '--out',
      path.join(caseDir, 'task-eval'),
      '--id',
      testCase.id,
      '--title',
      `Routing dry-run ${testCase.id}`,
      '--max-candidates',
      '1',
      '--promote-branch',
      'pr-candidate/skill-prompt-routing-dry-run',
      '--promote-commit-message',
      'vibeloop: skill prompt routing dry-run'
    );
  }
  if (testCase.mode === 'auto_discovery') {
    args.push(
      '--max-issues',
      '1',
      '--max-candidates',
      '1',
      '--promote-branch',
      'pr-candidate/skill-prompt-routing-auto-dry-run',
      '--promote-commit-message-prefix',
      'vibeloop skill prompt routing dry-run'
    );
  }
  return args;
}

export function validateRoutingParsed(testCase, variant, parsed, result = {}) {
  const failures = [];
  const expectedKind = expectedCommandKind(testCase.mode);
  const commandArgv = Array.isArray(parsed?.command?.argv)
    ? parsed.command.argv
    : [];
  const commandText = commandArgv.join(' ');

  if (result.code !== 0) failures.push('runner_exit_code');
  if (!parsed) failures.push('runner_json');
  if (parsed?.execute_requested !== false) failures.push('execute_requested');
  if (parsed?.executed !== false) failures.push('executed');
  if (parsed?.mode !== testCase.mode) failures.push('mode');
  if (parsed?.classification?.mode !== testCase.mode) {
    failures.push('classification.mode');
  }
  if (parsed?.accept_authority !== 'deterministic_harness_only') {
    failures.push('accept_authority');
  }
  if (parsed?.command?.kind !== expectedKind) failures.push('command.kind');
  if (testCase.mode === 'user_issue') {
    if (!parsed?.generated?.task || !parsed?.generated?.eval) {
      failures.push('generated.task_eval');
    }
    if (!commandArgv.includes('improve')) failures.push('command.improve');
  }
  if (
    testCase.mode === 'auto_discovery' &&
    !commandArgv.includes('orchestrate')
  ) {
    failures.push('command.orchestrate');
  }
  if (commandArgv.includes('--github-draft-pr')) {
    failures.push('github_draft_pr_arg');
  }
  if (/--execute\b/.test(commandText)) failures.push('execute_arg');
  if (!variant?.prompt) failures.push('prompt_variant');

  return failures;
}

async function runCase(testCase, index, tmpRoot, targetRepo, logDir) {
  const variant = findPromptVariant(testCase);
  const caseDir = path.join(
    tmpRoot,
    'cases',
    `${String(index).padStart(2, '0')}-${safeSegment(testCase.id)}`
  );
  await mkdir(caseDir, { recursive: true });
  const stdoutPath = path.join(logDir, `${index}-${testCase.id}.stdout.log`);
  const stderrPath = path.join(logDir, `${index}-${testCase.id}.stderr.log`);
  if (!variant) {
    await writeFile(stdoutPath, '');
    await writeFile(stderrPath, 'prompt variant not found\n');
    return {
      id: testCase.id,
      mode: testCase.mode,
      variant_id: testCase.variant,
      language: testCase.language,
      pass: false,
      failures: ['prompt_variant'],
      stdout_path: stdoutPath,
      stderr_path: stderrPath
    };
  }

  const args = buildPromptRunnerArgs(testCase, variant, caseDir, targetRepo);
  const result = await run(process.execPath, args);
  await writeFile(stdoutPath, result.stdout);
  await writeFile(stderrPath, result.stderr);
  const parsed = parseJson(result.stdout);
  const failures = validateRoutingParsed(testCase, variant, parsed, result);
  return {
    id: testCase.id,
    mode: testCase.mode,
    variant_id: testCase.variant,
    language: testCase.language,
    pass: failures.length === 0,
    failures,
    exit_code: result.code,
    signal: result.signal,
    prompt_ux: {
      variant_id: variant.id,
      variant_source: 'built-in',
      language: variant.language,
      prompt_present: String(variant.prompt).trim().length > 0,
      prompt_sha256: sha256Text(variant.prompt),
      prompt_char_count: [...String(variant.prompt)].length,
      classification: parsed?.classification
        ? {
            mode: parsed.classification.mode ?? null,
            confidence: parsed.classification.confidence ?? null,
            reason_codes: parsed.classification.reason_codes ?? []
          }
        : null,
      expected_mode: testCase.mode,
      matched_expected_mode: parsed?.classification?.mode === testCase.mode
    },
    generated: parsed?.generated
      ? {
          task: parsed.generated.task ?? null,
          eval: parsed.generated.eval ?? null
        }
      : null,
    command: parsed?.command
      ? {
          kind: parsed.command.kind ?? null,
          argv: parsed.command.argv ?? [],
          printable: parsed.command.printable ?? null
        }
      : null,
    execute_requested: parsed?.execute_requested ?? null,
    executed: parsed?.executed ?? null,
    stdout_path: stdoutPath,
    stderr_path: stderrPath
  };
}

function modeSummary(rows) {
  const counts = {};
  for (const [mode, modeRows] of Object.entries(
    Object.groupBy(rows, (row) => row.mode)
  )) {
    counts[mode] = {
      variant_count: modeRows.length,
      passed_count: modeRows.filter((row) => row.pass).length,
      failed_count: modeRows.filter((row) => !row.pass).length
    };
  }
  return counts;
}

export function buildRoutingCorpusLedger(rows, options = {}) {
  const failed = rows.filter((row) => !row.pass);
  const pass = failed.length === 0 && rows.length === defaultCorpus.length;
  return {
    status: pass ? passStatus : failStatus,
    scenario,
    proof_scope: 'natural_language_skill_prompt_routing_corpus_dry_run',
    not_live_codex_or_github_pass: true,
    builder_executed: false,
    github_draft_pr_verified: false,
    github_draft_pr: false,
    draft_pr: false,
    local_pr_like: false,
    exact_pre_codex_coverage: pass,
    corpus_count: defaultCorpus.length,
    requested_variant_count: defaultCorpus.length,
    executed_variant_count: rows.length,
    passed_variant_count: rows.filter((row) => row.pass).length,
    failed_variant_count: failed.length,
    modes: modeSummary(rows),
    rows,
    failures: failed.map((row) => ({
      id: row.id,
      mode: row.mode,
      variant_id: row.variant_id,
      failures: row.failures
    })),
    false_pass: 0,
    leak: 0,
    limitations: [
      'pre-Codex routing dry-run only',
      'does not execute a builder, final reverify, Gitea PR-like publication, or GitHub draft PR',
      'must not be counted as live loop PASS or GitHub draft PR evidence'
    ],
    evidence: options.evidence ?? {}
  };
}

async function main() {
  const startedAt = Date.now();
  const tmpRoot = await mkdtemp(
    path.join(os.tmpdir(), 'vibeloop-skill-routing-corpus-')
  );
  const targetRepo = path.join(tmpRoot, 'target-repo-placeholder');
  const logDir = path.join(tmpRoot, 'logs');
  let pass = false;
  try {
    await mkdir(targetRepo, { recursive: true });
    await mkdir(logDir, { recursive: true });
    const rows = [];
    for (let index = 0; index < defaultCorpus.length; index += 1) {
      rows.push(
        await runCase(
          defaultCorpus[index],
          index + 1,
          tmpRoot,
          targetRepo,
          logDir
        )
      );
    }
    const reportPath = path.join(tmpRoot, 'routing-corpus-report.json');
    let ledger = buildRoutingCorpusLedger(rows, {
      evidence: {
        tmp_root: tmpRoot,
        routing_corpus_report: reportPath
      }
    });
    ledger.timing = {
      total_ms: Date.now() - startedAt
    };
    await writeFile(reportPath, `${JSON.stringify(ledger, null, 2)}\n`);

    const evidenceBundle = await writeUatEvidenceBundle({
      scenario,
      runId: `skill-routing-corpus-${process.pid}-${Date.now()}`,
      tmpRoot,
      dataDir: tmpRoot,
      output: ledger,
      extraFiles: [
        {
          label: 'routing_corpus_report',
          path: reportPath,
          kind: 'report'
        },
        ...rows.flatMap((row) => [
          { label: `${row.id}_stdout`, path: row.stdout_path },
          { label: `${row.id}_stderr`, path: row.stderr_path }
        ])
      ],
      extraJson: {
        routing_corpus_summary: {
          status: ledger.status,
          proof_scope: ledger.proof_scope,
          requested_variant_count: ledger.requested_variant_count,
          passed_variant_count: ledger.passed_variant_count,
          failed_variant_count: ledger.failed_variant_count,
          not_live_codex_or_github_pass: ledger.not_live_codex_or_github_pass,
          builder_executed: ledger.builder_executed,
          github_draft_pr_verified: ledger.github_draft_pr_verified,
          local_pr_like: ledger.local_pr_like
        }
      }
    });
    ledger = {
      ...ledger,
      evidence: {
        ...ledger.evidence,
        evidence_bundle: evidenceBundle.bundle_dir,
        evidence_manifest: evidenceBundle.manifest_path,
        evidence_ledger: path.join(evidenceBundle.bundle_dir, 'ledger.json'),
        evidence_copied_count: evidenceBundle.copied_count,
        evidence_missing_count: evidenceBundle.missing_count,
        tmp_prune_requested: pruneTmp
      }
    };
    await writeUatEvidenceLedger(evidenceBundle, ledger);
    pass = ledger.status === passStatus;
    console.log(JSON.stringify(ledger, null, 2));
    if (!pass) process.exitCode = 1;
  } finally {
    if (pruneTmp && pass) {
      await rm(tmpRoot, { recursive: true, force: true }).catch(
        () => undefined
      );
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
