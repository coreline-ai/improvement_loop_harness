#!/usr/bin/env node
// Natural-language Skill prompt corpus live UAT.
//
// This P1 product-UX lane widens the existing single-prompt Skill live UAT by
// running several built-in user_issue and auto_discovery prompt variants through
// the real Codex Skill orchestrator and real Codex builder. It is still bounded
// to controlled fixtures; it does not prove arbitrary-repo product PASS.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  shouldPruneUatTmp,
  writeUatEvidenceBundle,
  writeUatEvidenceLedger
} from './evidence-bundle.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const childScript = path.join(
  repoRoot,
  'scripts/uat/skill-real-user-codex-skill-prompt-uat.mjs'
);
const scenario = 'skill-real-user-prompt-corpus-live-uat';
const passStatus = 'SKILL_PROMPT_CORPUS_LIVE_UAT_PASS';
const failStatus = 'SKILL_PROMPT_CORPUS_LIVE_UAT_FAIL';
const pruneTmp = shouldPruneUatTmp();

const defaultCorpus = [
  {
    id: 'user-ko-default-cart-path',
    mode: 'user_issue',
    variant: 'ko-default-cart-path',
    language: 'ko'
  },
  {
    id: 'user-ko-cart-natural-quantity-total',
    mode: 'user_issue',
    variant: 'ko-cart-natural-quantity-total',
    language: 'ko'
  },
  {
    id: 'user-en-cart-natural-quantity-total',
    mode: 'user_issue',
    variant: 'en-cart-natural-quantity-total',
    language: 'en'
  },
  {
    id: 'user-ko-user-repo-cart-pr-candidate',
    mode: 'user_issue',
    variant: 'ko-user-repo-cart-pr-candidate',
    language: 'ko'
  },
  {
    id: 'user-en-user-repo-cart-pr-candidate',
    mode: 'user_issue',
    variant: 'en-user-repo-cart-pr-candidate',
    language: 'en'
  },
  {
    id: 'user-ko-cart-two-items-total-low',
    mode: 'user_issue',
    variant: 'ko-cart-two-items-total-low',
    language: 'ko'
  },
  {
    id: 'user-ko-checkout-quantity-line-total',
    mode: 'user_issue',
    variant: 'ko-checkout-quantity-line-total',
    language: 'ko'
  },
  {
    id: 'user-en-checkout-quantity-regression',
    mode: 'user_issue',
    variant: 'en-checkout-quantity-regression',
    language: 'en'
  },
  {
    id: 'user-ko-real-user-total-too-low',
    mode: 'user_issue',
    variant: 'ko-real-user-total-too-low',
    language: 'ko'
  },
  {
    id: 'user-en-shopper-quantity-total',
    mode: 'user_issue',
    variant: 'en-shopper-quantity-total',
    language: 'en'
  },
  {
    id: 'auto-ko-default-auto-pr-candidate',
    mode: 'auto_discovery',
    variant: 'ko-default-auto-pr-candidate',
    language: 'ko'
  },
  {
    id: 'auto-ko-failing-tests-find-one',
    mode: 'auto_discovery',
    variant: 'ko-failing-tests-find-one',
    language: 'ko'
  },
  {
    id: 'auto-en-failing-behavior-find-one',
    mode: 'auto_discovery',
    variant: 'en-failing-behavior-find-one',
    language: 'en'
  },
  {
    id: 'auto-ko-project-review-fix-one',
    mode: 'auto_discovery',
    variant: 'ko-project-review-fix-one',
    language: 'ko'
  },
  {
    id: 'auto-en-user-repo-review-fix-one',
    mode: 'auto_discovery',
    variant: 'en-user-repo-review-fix-one',
    language: 'en'
  },
  {
    id: 'auto-ko-user-project-failing-test-bug',
    mode: 'auto_discovery',
    variant: 'ko-user-project-failing-test-bug',
    language: 'ko'
  },
  {
    id: 'auto-ko-scan-project-one-regression',
    mode: 'auto_discovery',
    variant: 'ko-scan-project-one-regression',
    language: 'ko'
  },
  {
    id: 'auto-en-scan-one-regression-pr-candidate',
    mode: 'auto_discovery',
    variant: 'en-scan-one-regression-pr-candidate',
    language: 'en'
  },
  {
    id: 'auto-ko-user-like-review-one-fix',
    mode: 'auto_discovery',
    variant: 'ko-user-like-review-one-fix',
    language: 'ko'
  },
  {
    id: 'auto-en-product-ux-one-bug',
    mode: 'auto_discovery',
    variant: 'en-product-ux-one-bug',
    language: 'en'
  }
];

const builderMode =
  process.env.VIBELOOP_SKILL_PROMPT_CORPUS_BUILDER ?? 'codex';
const githubDraftPrRequested =
  process.env.VIBELOOP_SKILL_PROMPT_CORPUS_GITHUB_DRAFT_PR === '1';
const keepRemote = process.env.VIBELOOP_UAT_KEEP_REMOTE === '1';
const childTimeoutMs = Number(
  process.env.VIBELOOP_SKILL_PROMPT_CORPUS_CHILD_TIMEOUT_MS ??
    process.env.VIBELOOP_SKILL_PROMPT_UAT_TIMEOUT_MS ??
    12 * 60 * 1000
);

function redact(text) {
  return String(text)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [REDACTED]')
    .replace(
      /(access_token|refresh_token|api_key|OPENAI_API_KEY|GITHUB_TOKEN|password)\s*[:=]\s*[^\s"']+/gi,
      '$1=[REDACTED]'
    );
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
    }, options.timeoutMs ?? childTimeoutMs);
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
      resolve({ code, signal, stdout: redact(stdout), stderr: redact(stderr) });
    });
  });
}

function parseJsonTail(text) {
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
      if (inString) continue;
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

function selectedCorpus() {
  const raw = process.env.VIBELOOP_SKILL_PROMPT_CORPUS_VARIANTS;
  if (!raw || raw.trim() === '' || raw.trim() === 'default') {
    return defaultCorpus;
  }
  const byKey = new Map(
    defaultCorpus.map((item) => [`${item.mode}:${item.variant}`, item])
  );
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((key) => {
      const selected = byKey.get(key);
      if (!selected) {
        throw new Error(
          `unsupported VIBELOOP_SKILL_PROMPT_CORPUS_VARIANTS entry=${key}; expected one of ${[
            ...byKey.keys()
          ].join(',')}`
        );
      }
      return selected;
    });
}

async function githubCleanupBlocker() {
  if (!githubDraftPrRequested || keepRemote) return null;
  const result = await run('gh', ['auth', 'status'], { timeoutMs: 30_000 });
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.code !== 0) {
    return {
      reason: 'GH_AUTH_STATUS_FAILED',
      gh_exit_code: result.code,
      stderr: result.stderr.trim()
    };
  }
  if (!/\bdelete_repo\b/.test(output)) {
    return {
      reason: 'GITHUB_DRAFT_PR_CORPUS_REQUIRES_DELETE_REPO_OR_KEEP_REMOTE',
      required_scope: 'delete_repo',
      keep_remote: keepRemote,
      next_step:
        'Run gh auth refresh -h github.com -s delete_repo for cleanup-capable ephemeral repos, or rerun with VIBELOOP_UAT_KEEP_REMOTE=1 to intentionally preserve UAT repos.'
    };
  }
  return null;
}

function expectedStatus(testCase) {
  if (githubDraftPrRequested) {
    return testCase.mode === 'auto_discovery'
      ? 'SKILL_PROMPT_AUTO_DISCOVERY_GITHUB_DRAFT_PR_LIVE_UAT_PASS'
      : 'SKILL_PROMPT_GITHUB_DRAFT_PR_LIVE_UAT_PASS';
  }
  return testCase.mode === 'auto_discovery'
    ? 'SKILL_PROMPT_AUTO_DISCOVERY_LIVE_UAT_PASS'
    : 'SKILL_PROMPT_LIVE_UAT_PASS';
}

function modeStats(results) {
  const stats = {};
  for (const result of results) {
    const current =
      stats[result.mode] ??
      (stats[result.mode] = {
        variant_count: 0,
        passed_count: 0,
        failed_count: 0
      });
    current.variant_count += 1;
    if (result.pass) current.passed_count += 1;
    else current.failed_count += 1;
  }
  return stats;
}

function childFailures(testCase, ledger, result) {
  const failures = [];
  if (result.code !== 0) failures.push(`exit_${result.code ?? 'signal'}`);
  if (!ledger) {
    failures.push('ledger_missing');
    return failures;
  }
  if (ledger.status !== expectedStatus(testCase)) failures.push('status');
  if (ledger.requested_mode !== testCase.mode) failures.push('requested_mode');
  if (ledger.prompt_ux?.variant_id !== testCase.variant) {
    failures.push('prompt_variant');
  }
  if (ledger.prompt_ux?.matched_expected_mode !== true) {
    failures.push('prompt_ux_match');
  }
  if (ledger.orchestrator?.real_llm !== true) {
    failures.push('orchestrator.real_llm');
  }
  if (
    builderMode === 'codex' &&
    (ledger.builder?.real_llm !== true ||
      ledger.builder?.via !== 'chatgpt-oauth-proxy')
  ) {
    failures.push('builder.real_llm');
  }
  if (ledger.pr_candidate !== true) failures.push('pr_candidate');
  if (ledger.final_verification?.passed !== true) {
    failures.push('final_verification');
  }
  if (ledger.false_pass !== 0) failures.push('false_pass');
  if (ledger.leak !== 0) failures.push('leak');
  if (Array.isArray(ledger.failure_reasons) && ledger.failure_reasons.length > 0) {
    failures.push('failure_reasons');
  }
  if (
    githubDraftPrRequested &&
    (ledger.github_draft_pr !== true ||
      ledger.github_draft_pr_verified !== true)
  ) {
    failures.push('github_draft_pr');
  }
  return failures;
}

async function runCase(testCase, index, logDir) {
  const stdoutPath = path.join(logDir, `${index}-${testCase.id}.stdout.log`);
  const stderrPath = path.join(logDir, `${index}-${testCase.id}.stderr.log`);
  const result = await run(process.execPath, [childScript], {
    cwd: repoRoot,
    timeoutMs: childTimeoutMs,
    env: {
      ...process.env,
      VIBELOOP_SKILL_PROMPT_UAT_MODE: testCase.mode,
      VIBELOOP_SKILL_PROMPT_UAT_PROMPT_VARIANT: testCase.variant,
      VIBELOOP_SKILL_PROMPT_UAT_BUILDER: builderMode,
      VIBELOOP_SKILL_PROMPT_UAT_TIMEOUT_MS: String(childTimeoutMs),
      ...(githubDraftPrRequested
        ? { VIBELOOP_SKILL_PROMPT_UAT_GITHUB_DRAFT_PR: '1' }
        : {})
    }
  });
  await writeFile(stdoutPath, result.stdout);
  await writeFile(stderrPath, result.stderr);
  const ledger = parseJsonTail(result.stdout);
  const failures = childFailures(testCase, ledger, result);
  return {
    id: testCase.id,
    mode: testCase.mode,
    variant_id: testCase.variant,
    language: testCase.language,
    expected_status: expectedStatus(testCase),
    status: ledger?.status ?? null,
    pass: failures.length === 0,
    exit_code: result.code,
    signal: result.signal ?? null,
    failures,
    orchestrator: ledger?.orchestrator ?? null,
    builder: ledger?.builder ?? null,
    prompt_ux: ledger?.prompt_ux ?? null,
    helper: ledger?.helper ?? null,
    pr_candidate: ledger?.pr_candidate ?? null,
    final_verification: ledger?.final_verification ?? null,
    promotion: ledger?.promotion ?? null,
    github_draft_pr: ledger?.github_draft_pr ?? false,
    github_draft_pr_verified: ledger?.github_draft_pr_verified ?? false,
    leak: ledger?.leak ?? null,
    evidence_ledger: ledger?.evidence?.evidence_ledger ?? null,
    evidence_manifest: ledger?.evidence?.evidence_manifest ?? null,
    evidence_bundle: ledger?.evidence?.evidence_bundle ?? null,
    stdout_path: stdoutPath,
    stderr_path: stderrPath
  };
}

async function main() {
  if (!existsSync(childScript)) {
    console.log(
      JSON.stringify(
        {
          status: 'blocked',
          scenario,
          reason: 'CHILD_SKILL_PROMPT_UAT_SCRIPT_NOT_FOUND',
          child_script: childScript
        },
        null,
        2
      )
    );
    process.exitCode = 20;
    return;
  }
  if (!['fixture', 'codex'].includes(builderMode)) {
    throw new Error(
      `unsupported VIBELOOP_SKILL_PROMPT_CORPUS_BUILDER=${builderMode}; expected fixture or codex`
    );
  }
  const cleanupBlocker = await githubCleanupBlocker();
  if (cleanupBlocker) {
    console.log(
      JSON.stringify(
        {
          status: 'blocked',
          scenario,
          ...cleanupBlocker
        },
        null,
        2
      )
    );
    process.exitCode = 20;
    return;
  }

  const corpus = selectedCorpus();
  const tmpRoot = await mkdtemp(
    path.join(os.tmpdir(), 'vibeloop-skill-prompt-corpus-live-')
  );
  const logDir = path.join(tmpRoot, 'logs');
  await mkdir(logDir, { recursive: true });
  let pass = false;
  try {
    const results = [];
    for (const [index, testCase] of corpus.entries()) {
      results.push(await runCase(testCase, index + 1, logDir));
    }
    const failed = results.filter((result) => !result.pass);
    const blocked = results.filter((result) => result.exit_code === 20);
    pass = failed.length === 0;

    const corpusSummaryPath = path.join(tmpRoot, 'prompt-corpus-summary.json');
    const promptCorpus = {
      proof_scope: 'natural_language_skill_prompt_live_corpus',
      builder_mode: builderMode,
      github_draft_pr_requested: githubDraftPrRequested,
      requested_variant_count: corpus.length,
      executed_variant_count: results.length,
      passed_variant_count: results.length - failed.length,
      failed_variant_count: failed.length,
      blocked_variant_count: blocked.length,
      modes: modeStats(results),
      variants: results
    };
    await writeFile(
      corpusSummaryPath,
      `${JSON.stringify(promptCorpus, null, 2)}\n`
    );

    const ledger = {
      status: pass ? passStatus : failStatus,
      scenario,
      proof_scope: promptCorpus.proof_scope,
      prompt_corpus: promptCorpus,
      corpus: promptCorpus,
      orchestrator: {
        real_llm: true,
        codex_cli: true,
        required_child_skill_file_read: true
      },
      builder: {
        real_llm: builderMode === 'codex',
        provider: builderMode === 'codex' ? 'codex' : 'command-agent',
        via: builderMode === 'codex' ? 'chatgpt-oauth-proxy' : 'command fixture',
        model: builderMode === 'codex' ? process.env.VIBELOOP_UAT_MODEL || 'gpt-5.5' : null
      },
      github_draft_pr: githubDraftPrRequested,
      github_draft_pr_verified:
        githubDraftPrRequested &&
        results.every((result) => result.github_draft_pr_verified === true),
      draft_pr:
        githubDraftPrRequested &&
        results.every((result) => result.github_draft_pr === true),
      total_cases: results.length,
      passed_cases: results.length - failed.length,
      failed_cases: failed.length,
      false_pass: failed.length,
      leak: results.some((result) => result.leak === 1) ? 1 : 0,
      failure_reasons: failed.flatMap((result) =>
        result.failures.map((failure) => `${result.id}:${failure}`)
      ),
      limitations: [
        'proves multiple built-in natural-language Skill prompt variants execute through the live Codex Skill orchestrator',
        builderMode === 'codex'
          ? 'proves the child prompt runs used a real Codex builder through the ChatGPT OAuth proxy'
          : 'does not prove real builder model quality because this run used the fixture builder',
        githubDraftPrRequested
          ? 'proves GitHub draft PR publication for every selected prompt variant in this bounded corpus'
          : 'does not prove GitHub draft PR publication for every prompt variant because GitHub mode was not requested',
        'bounded fixture prompt corpus only; not arbitrary-repo full autonomous improvement PASS'
      ],
      evidence: {
        tmp_root: tmpRoot,
        prompt_corpus_summary: corpusSummaryPath
      }
    };

    const extraFiles = [
      {
        label: 'prompt_corpus_summary',
        path: corpusSummaryPath,
        kind: 'report'
      }
    ];
    for (const result of results) {
      extraFiles.push({ label: `${result.id}_stdout`, path: result.stdout_path });
      extraFiles.push({ label: `${result.id}_stderr`, path: result.stderr_path });
      if (result.evidence_ledger) {
        extraFiles.push({
          label: `${result.id}_child_ledger`,
          path: result.evidence_ledger,
          kind: 'ledger'
        });
      }
      if (result.evidence_manifest) {
        extraFiles.push({
          label: `${result.id}_child_manifest`,
          path: result.evidence_manifest,
          kind: 'manifest'
        });
      }
    }

    const evidenceBundle = await writeUatEvidenceBundle({
      scenario,
      runId: `skill-prompt-corpus-live-${process.pid}-${Date.now()}`,
      tmpRoot,
      dataDir: tmpRoot,
      outputs: results,
      output: ledger,
      extraFiles,
      extraJson: {
        prompt_corpus: promptCorpus
      }
    });
    ledger.evidence = {
      ...ledger.evidence,
      evidence_bundle: evidenceBundle.bundle_dir,
      evidence_manifest: evidenceBundle.manifest_path,
      evidence_ledger: path.join(evidenceBundle.bundle_dir, 'ledger.json'),
      evidence_copied_count: evidenceBundle.copied_count,
      evidence_missing_count: evidenceBundle.missing_count,
      tmp_prune_requested: pruneTmp
    };
    await writeUatEvidenceLedger(evidenceBundle, ledger);
    console.log(JSON.stringify(ledger, null, 2));
    if (!pass) process.exitCode = blocked.length > 0 ? 20 : 1;
  } finally {
    if (pruneTmp && pass) {
      await rm(tmpRoot, { recursive: true, force: true }).catch(
        () => undefined
      );
    }
  }
}

await main();
