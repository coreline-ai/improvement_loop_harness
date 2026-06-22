#!/usr/bin/env node
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
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

export const PRODUCT_100_RELEASE_VERSION = 'product-100.release.v1';
export const PRODUCT_100_SCENARIO = 'product-100-codex-live-uat';
const DEFAULT_HIDDEN_MARKERS = [
  'HIDDEN_PRODUCT_100',
  'SECRET_HIDDEN_EXPECTATION'
];

function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
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
    child.on('error', (error) => {
      resolve({
        ok: false,
        exit_code: null,
        stdout,
        stderr: `${stderr}\n${error.message}`.trim()
      });
    });
    child.on('close', (code) => {
      resolve({ ok: code === 0, exit_code: code, stdout, stderr });
    });
  });
}

export function parseGhPrCreateUrl(stdout) {
  const match = String(stdout).match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/);
  return match?.[0] ?? null;
}

function draftPrHead(issue = {}) {
  return (
    issue.head ??
    issue.head_branch ??
    issue.pr_branch ??
    issue.branch ??
    issue.integration_branch ??
    null
  );
}

function phase5IssueFor(phase5, issue = {}) {
  const issueId = issue.issue_id ?? issue.id ?? null;
  const repoId = issue.repo_id ?? null;
  return (phase5?.issues ?? []).find(
    (candidate) =>
      candidate.issue_id === issueId &&
      (repoId === null || candidate.repo_id === repoId)
  );
}

export function containsProduct100Leak(value, hiddenMarkers = DEFAULT_HIDDEN_MARKERS) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  if (hiddenMarkers.some((marker) => text.includes(marker))) return true;
  if (/Bearer\s+[A-Za-z0-9._~+/=-]+/.test(text)) return true;
  if (/sk-[A-Za-z0-9_-]{8,}/.test(text)) return true;
  return false;
}

export function buildProduct100DraftPrBody({
  issue,
  phase4Issue,
  phase5,
  evidenceRef
} = {}) {
  const phase5Issue = phase5IssueFor(phase5, phase4Issue ?? issue);
  const proposalIds = (
    phase5Issue?.report?.review_report?.accepted_proposals ??
    phase5?.review_report?.accepted_proposals ??
    []
  ).map(
    (proposal) => proposal.id
  );
  const body = [
    '## Product-100 VibeLoop candidate',
    '',
    `- Issue: ${issue?.issue_id ?? issue?.id ?? phase4Issue?.issue_id ?? 'unknown'}`,
    `- Repo: ${issue?.repo_id ?? phase4Issue?.repo_id ?? 'unknown'}`,
    `- Draft only: true`,
    `- Selected candidate: ${phase4Issue?.selected_candidate_id ?? 'pending'}`,
    `- Hidden acceptance: ${phase4Issue?.hidden_eval_passed === true ? 'passed' : 'pending'}`,
    `- Strict score improvement: ${phase4Issue?.strict_score_improvement === true ? 'true' : 'pending'}`,
    `- Rediscovery after fix: ${phase4Issue?.rediscovery_after_fix === true ? 'true' : 'pending'}`,
    `- Adversary proposals accepted: ${proposalIds.length}`,
    proposalIds.length > 0 ? `- Proposal IDs: ${proposalIds.join(', ')}` : '- Proposal IDs: none',
    `- Evidence: ${evidenceRef ?? 'pending'}`,
    '',
    'Hidden tests, hidden sentinels, raw reviewer prompts, OAuth tokens, and API keys are intentionally omitted.',
    '',
    '<!-- Product-100 generated draft PR body. No automatic merge. -->'
  ].join('\n');
  if (containsProduct100Leak(body)) {
    throw new Error('Product-100 draft PR body leak detected');
  }
  return body;
}

export async function createProduct100DraftPrs({
  issueResults = [],
  expectedIssueCount,
  phase5 = null,
  evidenceRef = null,
  repository = null,
  baseBranch = 'main',
  tmpRoot = null,
  ghCommand = 'gh',
  run = runCommand,
  hiddenMarkers,
  pushBranches = true
} = {}) {
  const workingRoot =
    tmpRoot ?? (await mkdtemp(path.join(os.tmpdir(), 'product-100-pr-')));
  await mkdir(workingRoot, { recursive: true });
  const draftPrs = [];
  for (const issue of issueResults) {
    const issueId = issue.issue_id ?? issue.id ?? 'unknown';
    const repo = issue.github_repo ?? issue.repository ?? repository;
    const head = draftPrHead(issue);
    const body = buildProduct100DraftPrBody({
      issue,
      phase4Issue: issue,
      phase5,
      evidenceRef
    });
    const bodyFile = path.join(
      workingRoot,
      `${issueId.replace(/[^A-Za-z0-9._-]+/g, '-')}.pr-body.md`
    );
    await writeFile(bodyFile, `${body}\n`);
    if (!repo || !head) {
      draftPrs.push({
        issue_id: issueId,
        ok: false,
        state: 'not_created',
        draft: false,
        url: null,
        body,
        error: !repo ? 'missing_repository' : 'missing_head_branch'
      });
      continue;
    }
    const title = `Product-100 ${issueId}: ${
      issue.title ?? issue.summary ?? 'candidate fix'
    }`;
    let pushResult = null;
    if (pushBranches && issue.repo_path) {
      const remoteUrl = `https://github.com/${repo}.git`;
      await run('git', ['remote', 'remove', 'product100-origin'], {
        cwd: issue.repo_path
      });
      await run('git', ['remote', 'add', 'product100-origin', remoteUrl], {
        cwd: issue.repo_path
      });
      pushResult = await run(
        'git',
        [
          'push',
          'product100-origin',
          `refs/heads/${head}:refs/heads/${head}`,
          '--force-with-lease'
        ],
        { cwd: issue.repo_path }
      );
      if (!pushResult.ok) {
        draftPrs.push({
          issue_id: issueId,
          ok: false,
          state: 'branch_push_failed',
          draft: false,
          url: null,
          body,
          error: 'branch_push_failed',
          push_exit_code: pushResult.exit_code,
          push_stdout: String(pushResult.stdout ?? '').trim(),
          push_stderr: String(pushResult.stderr ?? '').trim()
        });
        continue;
      }
    }
    const args = [
      'pr',
      'create',
      '--draft',
      '--repo',
      repo,
      '--base',
      baseBranch,
      '--head',
      head,
      '--title',
      title,
      '--body-file',
      bodyFile
    ];
    const result = await run(ghCommand, args, {
      cwd: issue.repo_path ?? process.cwd()
    });
    const url = result.ok ? parseGhPrCreateUrl(result.stdout) : null;
    draftPrs.push({
      issue_id: issueId,
      ok: result.ok && Boolean(url),
      state: result.ok && url ? 'open' : 'create_failed',
      draft: result.ok && Boolean(url),
      url,
      body,
      command: [ghCommand, ...args].join(' '),
      exit_code: result.exit_code,
      stdout: String(result.stdout ?? '').trim(),
      stderr: String(result.stderr ?? '').trim(),
      ...(pushResult
        ? {
            branch_pushed: true,
            push_exit_code: pushResult.exit_code
          }
        : {})
    });
  }
  const validation = validateProduct100DraftPrs({
    issueResults,
    draftPrs,
    expectedIssueCount,
    hiddenMarkers
  });
  return {
    ok: validation.ok,
    draft_prs: draftPrs,
    validation,
    pr_body_dir: workingRoot
  };
}

export function validateProduct100DraftPrs({
  issueResults = [],
  draftPrs = [],
  expectedIssueCount,
  hiddenMarkers
} = {}) {
  const failures = [];
  if (
    Number.isInteger(expectedIssueCount) &&
    expectedIssueCount >= 0 &&
    issueResults.length !== expectedIssueCount
  ) {
    failures.push('draft_pr.issue_result_count');
  }
  const byIssue = new Map(draftPrs.map((pr) => [pr.issue_id, pr]));
  for (const issue of issueResults) {
    const pr = byIssue.get(issue.issue_id);
    if (!pr) {
      failures.push(`draft_pr.${issue.issue_id}.missing`);
      continue;
    }
    if (pr.draft !== true) failures.push(`draft_pr.${issue.issue_id}.draft`);
    if (pr.state !== 'open') failures.push(`draft_pr.${issue.issue_id}.state`);
    if (typeof pr.url !== 'string' || !/^https?:\/\//.test(pr.url)) {
      failures.push(`draft_pr.${issue.issue_id}.url`);
    }
    if (containsProduct100Leak(pr.body ?? '', hiddenMarkers)) {
      failures.push(`draft_pr.${issue.issue_id}.body_leak`);
    }
  }
  const duplicateIssues = draftPrs
    .map((pr) => pr.issue_id)
    .filter((issueId, index, all) => all.indexOf(issueId) !== index);
  if (duplicateIssues.length > 0) failures.push('draft_pr.duplicate_issue');
  return {
    ok: failures.length === 0,
    failures,
    expected_issue_count: Number.isInteger(expectedIssueCount)
      ? expectedIssueCount
      : issueResults.length,
    issue_result_count: issueResults.length,
    draft_pr_count: draftPrs.length
  };
}

export function evaluateProduct100Phase6({
  issueResults = [],
  draftPrs = [],
  expectedIssueCount,
  evidenceBundle = null,
  releaseAudit = null,
  hiddenMarkers
} = {}) {
  const draftPrValidation = validateProduct100DraftPrs({
    issueResults,
    draftPrs,
    expectedIssueCount,
    hiddenMarkers
  });
  const evidenceMissingCount =
    evidenceBundle?.missing_count ??
    evidenceBundle?.missingCount ??
    evidenceBundle?.evidence_missing_count ??
    null;
  const evidenceCopiedCount =
    evidenceBundle?.copied_count ??
    evidenceBundle?.copiedCount ??
    evidenceBundle?.evidence_copied_count ??
    null;
  const releaseEvidenceAuditPass =
    releaseAudit?.status === 'pass' || releaseAudit?.ok === true;
  const hasIssueResults = issueResults.length > 0;
  const draftPrsComplete =
    hasIssueResults &&
    draftPrValidation.ok &&
    draftPrValidation.draft_pr_count === draftPrValidation.expected_issue_count;
  return {
    version: PRODUCT_100_RELEASE_VERSION,
    github_draft_prs_open: draftPrsComplete,
    evidence_missing_count_zero: evidenceMissingCount === 0,
    evidence_copied_count_positive:
      typeof evidenceCopiedCount === 'number' && evidenceCopiedCount > 0,
    release_evidence_audit_pass: releaseEvidenceAuditPass,
    phase6_pass:
      draftPrsComplete &&
      evidenceMissingCount === 0 &&
      typeof evidenceCopiedCount === 'number' &&
      evidenceCopiedCount > 0 &&
      releaseEvidenceAuditPass,
    draft_pr_validation: draftPrValidation,
    evidence_bundle: evidenceBundle,
    release_audit: releaseAudit
  };
}

export function buildProduct100Phase6IssueResults({
  phase4 = {},
  repository = null
} = {}) {
  return (phase4.issues ?? [])
    .filter((issue) => issue?.pr_candidate === true)
    .map((issue) => ({
      ...issue,
      github_repo: issue.github_repo ?? issue.repository ?? repository ?? null,
      head_branch: draftPrHead(issue)
    }));
}

export async function runProduct100Phase6Release({
  phase4 = {},
  phase5 = null,
  runId,
  repository = process.env.VIBELOOP_PRODUCT_100_GITHUB_REPO ?? null,
  baseBranch = process.env.VIBELOOP_PRODUCT_100_GITHUB_BASE ?? 'main',
  evidenceRef = null,
  evidenceBundle = null,
  releaseAudit = null,
  draftPrs = null,
  tmpRoot = null,
  ghCommand = 'gh',
  run = runCommand
} = {}) {
  const expectedIssueCount =
    Number(phase4.expected_issue_count ?? phase4.issue_count ?? 0) || 0;
  const issueResults = buildProduct100Phase6IssueResults({
    phase4,
    repository
  });
  const draftPrResult = draftPrs
    ? {
        ok: true,
        draft_prs: draftPrs,
        validation: validateProduct100DraftPrs({
          issueResults,
          draftPrs,
          expectedIssueCount
        }),
        pr_body_dir: null
      }
    : await createProduct100DraftPrs({
        issueResults,
        expectedIssueCount,
        phase5,
        evidenceRef,
        repository,
        baseBranch,
        tmpRoot,
        ghCommand,
        run
      });
  const evaluation = evaluateProduct100Phase6({
    issueResults,
    expectedIssueCount,
    draftPrs: draftPrResult.draft_prs,
    evidenceBundle,
    releaseAudit
  });
  return {
    ...evaluation,
    kind: 'product_100_phase6_release',
    run_id: runId ?? null,
    issue_results: issueResults,
    draft_prs: draftPrResult.draft_prs,
    draft_pr_result: draftPrResult,
    expected_issue_count: expectedIssueCount,
    next_step: evaluation.phase6_pass
      ? 'complete_product_100_phase7_docs_run_ledger_truth'
      : 'complete_product_100_phase6_github_draft_pr_evidence_audit'
  };
}

export async function writeProduct100EvidenceBundle({
  ledger,
  runId,
  tmpRoot,
  dataDir,
  outputs = [],
  proxyStats = null,
  extraFiles = [],
  extraJson = {},
  evidenceDir = defaultUatEvidenceDir()
} = {}) {
  if (!ledger || typeof ledger !== 'object') {
    throw new Error('ledger is required');
  }
  const bundle = await writeUatEvidenceBundle({
    scenario: PRODUCT_100_SCENARIO,
    runId: runId ?? ledger.run_id ?? `product-100-${process.pid}-${Date.now()}`,
    tmpRoot: tmpRoot ?? process.cwd(),
    dataDir,
    outputs,
    output: ledger,
    proxyStats,
    extraFiles,
    extraJson: {
      product_100_release: { version: PRODUCT_100_RELEASE_VERSION },
      ...extraJson
    },
    evidenceDir
  });
  const ledgerFile = await writeUatEvidenceLedger(bundle, ledger);
  return {
    ...bundle,
    ledger_file: ledgerFile,
    evidence_missing_count: bundle.missing_count,
    evidence_copied_count: bundle.copied_count + 1
  };
}

async function sample() {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'product-100-release-sample-'));
  const reportFile = path.join(tmpRoot, 'phase-report.json');
  await mkdir(tmpRoot, { recursive: true });
  await writeFile(reportFile, `${JSON.stringify({ ok: true }, null, 2)}\n`);
  const issueResults = [{ repo_id: 'repo', issue_id: 'ISSUE-1', selected_candidate_id: 'c1', hidden_eval_passed: true, strict_score_improvement: true, rediscovery_after_fix: true }];
  const draftPrs = [{ issue_id: 'ISSUE-1', state: 'open', draft: true, url: 'https://github.com/coreline-ai/example/pull/1', body: buildProduct100DraftPrBody({ phase4Issue: issueResults[0], evidenceRef: 'sample' }) }];
  const ledger = {
    status: 'PRODUCT_100_CODEX_LIVE_FAIL',
    scenario: PRODUCT_100_SCENARIO,
    run_id: 'product-100-release-sample',
    note: 'contract sample only; not a Product-100 live PASS'
  };
  const bundle = await writeProduct100EvidenceBundle({
    ledger,
    runId: ledger.run_id,
    tmpRoot,
    evidenceDir: path.join(tmpRoot, 'evidence'),
    extraFiles: [{ label: 'phase-report', path: reportFile, kind: 'report' }]
  });
  const evaluation = evaluateProduct100Phase6({
    issueResults,
    draftPrs,
    evidenceBundle: bundle,
    releaseAudit: { status: 'pass' }
  });
  return {
    status: 'PRODUCT_100_PHASE6_CONTRACT_SAMPLE_PASS',
    scope: 'contract_sample_not_live',
    product_100_live_pass: false,
    evaluation
  };
}

async function main() {
  if (process.argv.includes('--sample')) {
    console.log(JSON.stringify(await sample(), null, 2));
    return;
  }
  console.log(JSON.stringify({ status: 'ok', version: PRODUCT_100_RELEASE_VERSION }, null, 2));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
