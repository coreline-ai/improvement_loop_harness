#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import {
  defaultUatEvidenceDir,
  writeUatEvidenceBundle,
  writeUatEvidenceLedger
} from './evidence-bundle.mjs';
import { auditSkillPromptCorpusLivePrState } from './release-evidence-audit.mjs';

const sourceScenario = 'skill-real-user-prompt-corpus-live-uat';
const sourcePassStatus = 'SKILL_PROMPT_CORPUS_LIVE_UAT_PASS';
export const chunkAggregateAuditScenario =
  'skill-prompt-corpus-chunk-aggregate-audit';
export const chunkAggregateAuditPassStatus =
  'SKILL_PROMPT_CORPUS_CHUNK_AGGREGATE_AUDIT_PASS';
export const chunkAggregateAuditFailStatus =
  'SKILL_PROMPT_CORPUS_CHUNK_AGGREGATE_AUDIT_FAIL';

async function readJsonFile(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

function asNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} requires a non-negative integer`);
  }
  return parsed;
}

function variantKey(variant) {
  const mode = variant?.mode ?? variant?.prompt_ux?.expected_mode ?? 'unknown';
  const id =
    variant?.variant_id ??
    variant?.prompt_ux?.variant_id ??
    variant?.id ??
    'unknown';
  return `${mode}:${id}`;
}

function addModeCount(counts, mode) {
  const key = mode ?? 'unknown';
  counts[key] = (counts[key] ?? 0) + 1;
}

function isPassStatus(status) {
  return typeof status === 'string' && status.endsWith('_PASS');
}

function checkLedger({
  ledger,
  ledgerPath,
  index,
  options,
  seenVariantKeys,
  aggregate
}) {
  const failures = [];
  const variants = ledger?.prompt_corpus?.variants;
  const ledgerRef = ledgerPath ?? `ledger:${index + 1}`;
  if (ledger?.scenario !== sourceScenario) {
    failures.push(`${ledgerRef}:scenario`);
  }
  if (ledger?.status !== sourcePassStatus) {
    failures.push(`${ledgerRef}:status`);
  }
  if (!Array.isArray(variants) || variants.length === 0) {
    failures.push(`${ledgerRef}:variants`);
    return { failures, variant_count: 0 };
  }
  if (ledger.false_pass !== 0) failures.push(`${ledgerRef}:false_pass`);
  if (ledger.leak !== 0) failures.push(`${ledgerRef}:leak`);
  if (ledger.failed_cases !== 0) failures.push(`${ledgerRef}:failed_cases`);
  if (
    ledger.git_provider === 'gitea' &&
    (ledger.github_draft_pr === true ||
      ledger.github_draft_pr_verified === true ||
      ledger.draft_pr === true ||
      ledger.prompt_corpus?.github_draft_pr_requested === true)
  ) {
    failures.push(`${ledgerRef}:github_draft_pr_provider`);
  }
  if (options.requireGithubPr) {
    if (ledger.git_provider !== undefined && ledger.git_provider !== 'github') {
      failures.push(`${ledgerRef}:github_draft_pr_provider`);
    }
    if (ledger.github_draft_pr !== true) {
      failures.push(`${ledgerRef}:github_draft_pr`);
    }
    if (ledger.github_draft_pr_verified !== true) {
      failures.push(`${ledgerRef}:github_draft_pr_verified`);
    }
    if (ledger.prompt_corpus?.github_draft_pr_requested !== true) {
      failures.push(`${ledgerRef}:prompt_corpus.github_draft_pr_requested`);
    }
  }
  if (options.requireLocalPrLike) {
    if (ledger.git_provider !== 'gitea') {
      failures.push(`${ledgerRef}:local_pr_like_provider`);
    }
    if (ledger.local_pr_like !== true) {
      failures.push(`${ledgerRef}:local_pr_like`);
    }
    if (ledger.draft_supported !== false) {
      failures.push(`${ledgerRef}:draft_supported`);
    }
    if (
      ledger.prompt_corpus?.git_provider !== 'gitea' ||
      ledger.prompt_corpus?.local_pr_like !== true ||
      ledger.prompt_corpus?.draft_supported !== false
    ) {
      failures.push(`${ledgerRef}:prompt_corpus.local_pr_like`);
    }
    if (
      ledger.github_draft_pr === true ||
      ledger.github_draft_pr_verified === true ||
      ledger.draft_pr === true ||
      ledger.prompt_corpus?.github_draft_pr_requested === true
    ) {
      failures.push(`${ledgerRef}:local_pr_like_github_claim`);
    }
  }
  if (options.requireRealBuilder && ledger.builder?.real_llm !== true) {
    failures.push(`${ledgerRef}:builder.real_llm`);
  }
  if (options.requireSkillRead) {
    if (ledger.orchestrator?.real_llm !== true) {
      failures.push(`${ledgerRef}:orchestrator.real_llm`);
    }
    if (ledger.orchestrator?.required_child_skill_file_read !== true) {
      failures.push(`${ledgerRef}:orchestrator.required_child_skill_file_read`);
    }
  }

  for (const variant of variants) {
    const key = variantKey(variant);
    if (seenVariantKeys.has(key)) {
      failures.push(`${ledgerRef}:${key}:duplicate_variant`);
    } else {
      seenVariantKeys.add(key);
    }
    aggregate.variant_count += 1;
    if (variant.pass === true) aggregate.passed_variant_count += 1;
    addModeCount(aggregate.mode_counts, variant.mode);

    if (variant.pass !== true) failures.push(`${ledgerRef}:${key}:pass`);
    if (!isPassStatus(variant.status)) {
      failures.push(`${ledgerRef}:${key}:status`);
    }
    if (variant.timed_out === true) {
      failures.push(`${ledgerRef}:${key}:timed_out`);
    }
    if (Array.isArray(variant.failures) && variant.failures.length > 0) {
      failures.push(`${ledgerRef}:${key}:failures`);
    }
    if (variant.prompt_ux?.prompt_present !== true) {
      failures.push(`${ledgerRef}:${key}:prompt_ux.prompt_present`);
    }
    if (variant.prompt_ux?.matched_expected_mode !== true) {
      failures.push(`${ledgerRef}:${key}:prompt_ux.matched_expected_mode`);
    }
    if (variant.final_verification?.passed !== true) {
      failures.push(`${ledgerRef}:${key}:final_verification.passed`);
    }
    if (variant.final_verification?.reverified !== true) {
      failures.push(`${ledgerRef}:${key}:final_verification.reverified`);
    }
    if (variant.final_verification?.reverify_qualified !== true) {
      failures.push(
        `${ledgerRef}:${key}:final_verification.reverify_qualified`
      );
    }
    if (options.requireGithubPr) {
      if (variant.git_provider !== undefined && variant.git_provider !== 'github') {
        failures.push(`${ledgerRef}:${key}:github_draft_pr_provider`);
      }
      if (variant.github_draft_pr !== true) {
        failures.push(`${ledgerRef}:${key}:github_draft_pr`);
      }
      if (variant.github_draft_pr_verified !== true) {
        failures.push(`${ledgerRef}:${key}:github_draft_pr_verified`);
      }
      if (!variant.evidence_ledger) {
        failures.push(`${ledgerRef}:${key}:evidence_ledger`);
      }
    }
    if (options.requireLocalPrLike) {
      if (variant.git_provider !== 'gitea') {
        failures.push(`${ledgerRef}:${key}:local_pr_like_provider`);
      }
      if (variant.local_pr_like !== true) {
        failures.push(`${ledgerRef}:${key}:local_pr_like`);
      }
      if (variant.draft_supported !== false) {
        failures.push(`${ledgerRef}:${key}:draft_supported`);
      }
      if (
        variant.github_draft_pr === true ||
        variant.github_draft_pr_verified === true
      ) {
        failures.push(`${ledgerRef}:${key}:local_pr_like_github_claim`);
      }
    }
    if (options.requireRealBuilder) {
      if (variant.builder?.real_llm !== true) {
        failures.push(`${ledgerRef}:${key}:builder.real_llm`);
      }
      if (variant.builder?.proxy_auth_header_seen !== true) {
        failures.push(`${ledgerRef}:${key}:builder.proxy_auth_header_seen`);
      }
    }
    if (
      options.requireSkillRead &&
      variant.orchestrator?.reported_skill_file_read !== true
    ) {
      failures.push(
        `${ledgerRef}:${key}:orchestrator.reported_skill_file_read`
      );
    }
  }
  return { failures, variant_count: variants.length };
}

function checkExpectations(aggregate, expected) {
  const failures = [];
  if (
    expected.total !== undefined &&
    aggregate.variant_count !== expected.total
  ) {
    failures.push(
      `aggregate:expected_total:${expected.total}:actual:${aggregate.variant_count}`
    );
  }
  for (const [mode, count] of Object.entries(expected.modes ?? {})) {
    const actual = aggregate.mode_counts[mode] ?? 0;
    if (actual !== count) {
      failures.push(`aggregate:expected_${mode}:${count}:actual:${actual}`);
    }
  }
  if (aggregate.passed_variant_count !== aggregate.variant_count) {
    failures.push(
      `aggregate:passed_variant_count:${aggregate.passed_variant_count}:actual:${aggregate.variant_count}`
    );
  }
  return failures;
}

export async function buildSkillPromptCorpusChunkAggregateAudit(options = {}) {
  if (options.requireGithubPr && options.requireLocalPrLike) {
    throw new Error(
      'requireGithubPr cannot be combined with requireLocalPrLike'
    );
  }
  const ledgerPaths = options.ledgerPaths ?? [];
  const inlineLedgers = options.ledgers ?? [];
  if (ledgerPaths.length === 0 && inlineLedgers.length === 0) {
    throw new Error('at least one --ledger path is required');
  }

  const ledgerEntries = [
    ...(await Promise.all(
      ledgerPaths.map(async (ledgerPath) => ({
        ledgerPath,
        ledger: await readJsonFile(ledgerPath)
      }))
    )),
    ...inlineLedgers.map((ledger, index) => ({
      ledgerPath: ledger.ledgerPath ?? null,
      ledger: ledger.ledger ?? ledger,
      inlineIndex: index
    }))
  ];

  const aggregate = {
    ledger_count: ledgerEntries.length,
    variant_count: 0,
    passed_variant_count: 0,
    mode_counts: {}
  };
  const seenVariantKeys = new Set();
  const ledgerResults = [];
  const failures = [];

  for (const [index, entry] of ledgerEntries.entries()) {
    const result = checkLedger({
      ledger: entry.ledger,
      ledgerPath: entry.ledgerPath,
      index,
      options,
      seenVariantKeys,
      aggregate
    });
    ledgerResults.push({
      ledger: entry.ledgerPath,
      ok: result.failures.length === 0,
      variant_count: result.variant_count,
      failures: result.failures
    });
    failures.push(...result.failures);
  }

  failures.push(...checkExpectations(aggregate, options.expected ?? {}));

  const livePrStateAudits = [];
  if (options.requireLivePrState) {
    for (const entry of ledgerEntries) {
      if (!entry.ledgerPath) {
        failures.push('live_pr_state:inline_ledger_path_required');
        continue;
      }
      const liveAudit = await auditSkillPromptCorpusLivePrState(
        { scenario: sourceScenario, ledger: entry.ledgerPath },
        options
      );
      livePrStateAudits.push({
        ledger: entry.ledgerPath,
        ...liveAudit
      });
      if (!liveAudit.ok) {
        failures.push(`${entry.ledgerPath}:live_pr_state`);
      }
    }
  }

  const pass = failures.length === 0;
  return {
    run_id: options.runId ?? null,
    status: pass
      ? chunkAggregateAuditPassStatus
      : chunkAggregateAuditFailStatus,
    scenario: chunkAggregateAuditScenario,
    proof_scope: 'natural_language_skill_prompt_live_corpus_chunk_aggregate',
    source_scenario: sourceScenario,
    requirements: {
      require_github_pr: options.requireGithubPr === true,
      require_local_pr_like: options.requireLocalPrLike === true,
      require_live_pr_state: options.requireLivePrState === true,
      require_real_builder: options.requireRealBuilder === true,
      require_skill_read: options.requireSkillRead === true,
      expected_total: options.expected?.total ?? null,
      expected_modes: options.expected?.modes ?? {}
    },
    aggregate,
    ledger_results: ledgerResults,
    live_pr_state_audits: livePrStateAudits,
    failures,
    limitations: [
      'audits existing chunk ledgers; it does not execute missing prompt variants',
      'aggregate PASS is only as broad as the supplied ledger set and requested expectations',
      'does not prove arbitrary-repo full autonomous improvement PASS'
    ]
  };
}

export async function writeSkillPromptCorpusChunkAggregateAuditEvidence(
  report,
  options = {}
) {
  const runId =
    options.runId ??
    report.run_id ??
    `skill-prompt-corpus-chunk-audit-${process.pid}-${Date.now()}`;
  const ledgerPaths = options.ledgerPaths ?? [];
  const bundle = await writeUatEvidenceBundle({
    scenario: chunkAggregateAuditScenario,
    runId,
    tmpRoot: null,
    dataDir: null,
    output: report,
    extraFiles: ledgerPaths.map((ledgerPath, index) => ({
      kind: 'source_ledger',
      label: `source-ledger-${index + 1}`,
      path: ledgerPath
    })),
    extraJson: {
      source_ledgers: ledgerPaths.map((ledgerPath) => path.resolve(ledgerPath)),
      requirements: report.requirements,
      aggregate: report.aggregate
    },
    evidenceDir: options.evidenceDir ?? defaultUatEvidenceDir()
  });
  const ledger = {
    ...report,
    run_id: runId,
    evidence_bundle: bundle.bundle_dir,
    evidence_manifest: bundle.manifest_path,
    evidence_copied_count: bundle.copied_count + 1,
    evidence_missing_count: bundle.missing_count
  };
  const ledgerFile = await writeUatEvidenceLedger(bundle, ledger);
  return { ledger, ledgerFile, bundle };
}

export function skillPromptCorpusChunkAggregateAuditExitCode(report) {
  return report.failures.length > 0 ? 1 : 0;
}

function parseArgs(argv) {
  const ledgerPaths = [];
  const expected = { modes: {} };
  let requireGithubPr = false;
  let requireLocalPrLike = false;
  let requireLivePrState = false;
  let requireRealBuilder = false;
  let requireSkillRead = false;
  let writeEvidence = true;
  let evidenceDir = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--ledger') {
      const value = argv[index + 1];
      if (!value) throw new Error('--ledger requires a path');
      ledgerPaths.push(value);
      index += 1;
      continue;
    }
    if (arg === '--expect-total') {
      expected.total = asNumber(argv[index + 1], '--expect-total');
      index += 1;
      continue;
    }
    if (arg === '--expect-user-issue') {
      expected.modes.user_issue = asNumber(
        argv[index + 1],
        '--expect-user-issue'
      );
      index += 1;
      continue;
    }
    if (arg === '--expect-auto-discovery') {
      expected.modes.auto_discovery = asNumber(
        argv[index + 1],
        '--expect-auto-discovery'
      );
      index += 1;
      continue;
    }
    if (arg === '--require-github-pr') {
      requireGithubPr = true;
      continue;
    }
    if (arg === '--require-local-pr-like') {
      requireLocalPrLike = true;
      continue;
    }
    if (arg === '--require-live-pr-state') {
      requireGithubPr = true;
      requireLivePrState = true;
      continue;
    }
    if (arg === '--require-real-builder') {
      requireRealBuilder = true;
      continue;
    }
    if (arg === '--require-skill-read') {
      requireSkillRead = true;
      continue;
    }
    if (arg === '--write-evidence') {
      writeEvidence = true;
      continue;
    }
    if (arg === '--no-write-evidence') {
      writeEvidence = false;
      continue;
    }
    if (arg === '--evidence-dir') {
      const value = argv[index + 1];
      if (!value) throw new Error('--evidence-dir requires a path');
      evidenceDir = value;
      index += 1;
      continue;
    }
    if (!arg.startsWith('-')) {
      ledgerPaths.push(arg);
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return {
    ledgerPaths,
    expected,
    requireGithubPr,
    requireLocalPrLike,
    requireLivePrState,
    requireRealBuilder,
    requireSkillRead,
    writeEvidence,
    evidenceDir
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const runId = `skill-prompt-corpus-chunk-audit-${process.pid}-${Date.now()}`;
  const report = await buildSkillPromptCorpusChunkAggregateAudit({
    ...options,
    runId
  });
  let output = report;
  if (options.writeEvidence) {
    const evidence = await writeSkillPromptCorpusChunkAggregateAuditEvidence(
      report,
      {
        runId,
        ledgerPaths: options.ledgerPaths,
        evidenceDir: options.evidenceDir
      }
    );
    output = {
      ...evidence.ledger,
      evidence_ledger: evidence.ledgerFile
    };
  }
  console.log(JSON.stringify(output, null, 2));
  process.exit(skillPromptCorpusChunkAggregateAuditExitCode(report));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
