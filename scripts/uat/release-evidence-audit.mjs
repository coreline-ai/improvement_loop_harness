#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  ADVERSARY_REAL_REVIEWER_EVIDENCE_SCENARIO,
  EVIDENCE_SCENARIOS,
  PRODUCT_100_EVIDENCE_SCENARIO,
  REAL_PROJECT_BUSINESS_REPAIR_CORPUS_EVIDENCE_SCENARIO,
  REAL_PROJECT_BUSINESS_SOURCE_REPAIR_CORPUS_EVIDENCE_SCENARIO,
  REAL_PROJECT_CODEX_COPY_CORPUS_EVIDENCE_SCENARIO,
  REAL_PROJECT_CODEX_REPAIR_CORPUS_EVIDENCE_SCENARIO,
  REAL_PROJECT_EXISTING_SOURCE_REPAIR_CORPUS_EVIDENCE_SCENARIO,
  REAL_PROJECT_EXISTING_SOURCE_REPAIR_PR_CORPUS_EVIDENCE_SCENARIO,
  REAL_PROJECT_SEMANTIC_SOURCE_REPAIR_CORPUS_EVIDENCE_SCENARIO,
  REAL_PROJECT_MODIFIABLE_CORPUS_EVIDENCE_SCENARIO,
  REAL_PROJECT_CORPUS_EVIDENCE_SCENARIO,
  SKILL_FULL_UAT_EVIDENCE_SCENARIO,
  SKILL_PROMPT_CORPUS_CHUNK_AGGREGATE_AUDIT_EVIDENCE_SCENARIO,
  SKILL_PROMPT_CORPUS_LIVE_EVIDENCE_SCENARIO,
  SKILL_PROMPT_GITHUB_DRAFT_PR_EVIDENCE_SCENARIO,
  SKILL_PROMPT_JOURNEY_EVIDENCE_SCENARIO,
  SKILL_PROMPT_LIVE_EVIDENCE_SCENARIO,
  SKILL_PROMPT_MATRIX_EVIDENCE_SCENARIO,
  latestEvidenceBundle
} from './release-gates-preflight.mjs';

const DEFAULT_AUDIT_SCENARIO_NAMES = [
  'postgres-contract-uat',
  'adversary-live-uat',
  'repo-matrix-uat'
];

const DEFAULT_AUDIT_SCENARIOS = new Set(DEFAULT_AUDIT_SCENARIO_NAMES);

export const RELEASE_EVIDENCE_AUDIT_SCENARIOS = EVIDENCE_SCENARIOS.filter(
  (scenario) => DEFAULT_AUDIT_SCENARIOS.has(scenario.scenario)
);

export const SELECTABLE_RELEASE_EVIDENCE_AUDIT_SCENARIOS = [
  ...EVIDENCE_SCENARIOS,
  SKILL_FULL_UAT_EVIDENCE_SCENARIO,
  SKILL_PROMPT_MATRIX_EVIDENCE_SCENARIO,
  SKILL_PROMPT_JOURNEY_EVIDENCE_SCENARIO,
  SKILL_PROMPT_CORPUS_CHUNK_AGGREGATE_AUDIT_EVIDENCE_SCENARIO,
  SKILL_PROMPT_CORPUS_LIVE_EVIDENCE_SCENARIO,
  SKILL_PROMPT_LIVE_EVIDENCE_SCENARIO,
  SKILL_PROMPT_GITHUB_DRAFT_PR_EVIDENCE_SCENARIO,
  ADVERSARY_REAL_REVIEWER_EVIDENCE_SCENARIO,
  REAL_PROJECT_CORPUS_EVIDENCE_SCENARIO,
  REAL_PROJECT_MODIFIABLE_CORPUS_EVIDENCE_SCENARIO,
  REAL_PROJECT_CODEX_COPY_CORPUS_EVIDENCE_SCENARIO,
  REAL_PROJECT_CODEX_REPAIR_CORPUS_EVIDENCE_SCENARIO,
  REAL_PROJECT_BUSINESS_REPAIR_CORPUS_EVIDENCE_SCENARIO,
  REAL_PROJECT_BUSINESS_SOURCE_REPAIR_CORPUS_EVIDENCE_SCENARIO,
  REAL_PROJECT_EXISTING_SOURCE_REPAIR_CORPUS_EVIDENCE_SCENARIO,
  REAL_PROJECT_SEMANTIC_SOURCE_REPAIR_CORPUS_EVIDENCE_SCENARIO,
  REAL_PROJECT_EXISTING_SOURCE_REPAIR_PR_CORPUS_EVIDENCE_SCENARIO,
  PRODUCT_100_EVIDENCE_SCENARIO
];

export const ALL_RELEASE_EVIDENCE_AUDIT_SCENARIOS = [...EVIDENCE_SCENARIOS];

export function selectReleaseEvidenceAuditScenarios(options = {}) {
  if (options.allReleaseEvidence && options.scenarioNames?.length > 0) {
    throw new Error(
      '--all-release-evidence cannot be combined with --scenario'
    );
  }
  if (options.allReleaseEvidence) {
    return ALL_RELEASE_EVIDENCE_AUDIT_SCENARIOS;
  }
  if (!options.scenarioNames || options.scenarioNames.length === 0) {
    return RELEASE_EVIDENCE_AUDIT_SCENARIOS;
  }

  const scenarioByName = new Map(
    SELECTABLE_RELEASE_EVIDENCE_AUDIT_SCENARIOS.map((scenario) => [
      scenario.scenario,
      scenario
    ])
  );
  return options.scenarioNames.map((scenarioName) => {
    const scenario = scenarioByName.get(scenarioName);
    if (!scenario) {
      const known = SELECTABLE_RELEASE_EVIDENCE_AUDIT_SCENARIOS.map(
        (item) => item.scenario
      ).join(', ');
      throw new Error(`unknown scenario: ${scenarioName}; known: ${known}`);
    }
    return scenario;
  });
}

function applyAuditRequirementOverrides(evidenceScenarios, options = {}) {
  if (
    !options.requireSkillPromptCorpusGithubPr &&
    !options.requireSkillPromptCorpusLivePrState
  ) {
    return evidenceScenarios;
  }

  const hasPromptCorpus = evidenceScenarios.some(
    (scenario) => scenario.scenario === 'skill-real-user-prompt-corpus-live-uat'
  );
  if (!hasPromptCorpus) {
    throw new Error(
      '--require-skill-prompt-corpus-github-pr and --require-skill-prompt-corpus-live-pr-state require --scenario skill-real-user-prompt-corpus-live-uat'
    );
  }

  return evidenceScenarios.map((scenario) => {
    if (scenario.scenario !== 'skill-real-user-prompt-corpus-live-uat') {
      return scenario;
    }
    return {
      ...scenario,
      name: 'Skill natural-language prompt corpus GitHub draft PR evidence',
      expected_ledger: {
        ...(scenario.expected_ledger ?? {}),
        required_skill_prompt_corpus_github_draft_pr: true
      }
    };
  });
}

async function readJsonFile(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

function execFileJson(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
        ...options
      },
      (error, stdout, stderr) => {
        if (error) {
          error.stderr = stderr;
          reject(error);
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (parseError) {
          reject(parseError);
        }
      }
    );
  });
}

async function defaultGithubPrView({ repo, number }) {
  return execFileJson(process.env.GH_BIN ?? 'gh', [
    'pr',
    'view',
    String(number),
    '--repo',
    repo,
    '--json',
    'number,state,isDraft,headRefName,headRefOid,baseRefName,body,url,autoMergeRequest'
  ]);
}

function sha256Text(value) {
  return createHash('sha256')
    .update(value ?? '', 'utf8')
    .digest('hex');
}

function resolveEvidencePath(filePath, ledgerPath) {
  if (!filePath) return null;
  return path.isAbsolute(filePath)
    ? filePath
    : path.resolve(path.dirname(ledgerPath), filePath);
}

export async function auditSkillPromptCorpusLivePrState(
  evidenceResult,
  options = {}
) {
  const failures = [];
  const prs = [];
  if (
    evidenceResult?.scenario !== 'skill-real-user-prompt-corpus-live-uat' ||
    !evidenceResult.ledger
  ) {
    return {
      ok: false,
      checked_count: 0,
      failures: ['skill_prompt_corpus.live_pr_state.ledger']
    };
  }

  let ledger;
  try {
    ledger = await readJsonFile(evidenceResult.ledger);
  } catch (error) {
    return {
      ok: false,
      checked_count: 0,
      failures: ['skill_prompt_corpus.live_pr_state.ledger_read'],
      error: error instanceof Error ? error.message : String(error)
    };
  }

  const variants = ledger.prompt_corpus?.variants;
  if (!Array.isArray(variants) || variants.length === 0) {
    return {
      ok: false,
      checked_count: 0,
      failures: ['skill_prompt_corpus.live_pr_state.variants']
    };
  }

  const githubPrView = options.githubPrView ?? defaultGithubPrView;
  for (const variant of variants) {
    const childLedgerPath = resolveEvidencePath(
      variant.evidence_ledger,
      evidenceResult.ledger
    );
    if (!childLedgerPath) {
      failures.push(`${variant.id}:missing_child_ledger`);
      continue;
    }

    let childLedger;
    try {
      childLedger = await readJsonFile(childLedgerPath);
    } catch {
      failures.push(`${variant.id}:child_ledger_read`);
      continue;
    }

    const repo = childLedger.github?.repo;
    const draftPr = childLedger.github?.draft_prs?.[0];
    const prNumber = draftPr?.pr_number;
    if (!repo || !prNumber) {
      failures.push(`${variant.id}:missing_pr_ref`);
      continue;
    }

    let live;
    try {
      live = await githubPrView({ repo, number: prNumber, variant });
    } catch (error) {
      failures.push(`${variant.id}:live_pr_view_error`);
      prs.push({
        id: variant.id,
        repo,
        number: prNumber,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
      continue;
    }

    const expectedHead = draftPr.live_pr_view?.head_ref ?? draftPr.branch_name;
    const expectedHeadSha =
      draftPr.live_pr_view?.expected_head_sha ??
      draftPr.live_pr_view?.head_sha ??
      draftPr.head_sha;
    const expectedBase = draftPr.live_pr_view?.base_ref ?? draftPr.base_ref;
    const expectedBodySha = draftPr.live_pr_view?.body_sha256;
    const expectedBodyChars = draftPr.live_pr_view?.body_char_count;
    const liveBody = typeof live.body === 'string' ? live.body : '';
    const bodyShaMatches =
      typeof expectedBodySha === 'string'
        ? sha256Text(liveBody) === expectedBodySha
        : true;
    const bodyLengthMatches =
      typeof expectedBodyChars === 'number'
        ? liveBody.length === expectedBodyChars
        : true;
    const checks = {
      state_open: live.state === 'OPEN',
      is_draft: live.isDraft === true,
      auto_merge_disabled: live.autoMergeRequest == null,
      base_ref_matches: !expectedBase || live.baseRefName === expectedBase,
      head_ref_matches: !expectedHead || live.headRefName === expectedHead,
      head_sha_matches: !expectedHeadSha || live.headRefOid === expectedHeadSha,
      body_sha_matches: bodyShaMatches,
      body_length_matches: bodyLengthMatches
    };
    const ok = Object.values(checks).every(Boolean);
    if (!ok) {
      failures.push(`${variant.id}:live_pr_state`);
    }
    prs.push({
      id: variant.id,
      repo,
      number: prNumber,
      url: live.url ?? draftPr.pr_url ?? null,
      ok,
      state: live.state ?? null,
      is_draft: live.isDraft ?? null,
      base_ref: live.baseRefName ?? null,
      head_ref: live.headRefName ?? null,
      head_sha: live.headRefOid ?? null,
      checks
    });
  }

  return {
    ok: failures.length === 0,
    checked_count: prs.length,
    expected_count: variants.length,
    failures,
    prs
  };
}

function defaultEvidenceRoot(env = process.env) {
  return (
    env.VIBELOOP_UAT_EVIDENCE_DIR ??
    path.join(os.homedir(), '.vibeloop', 'uat-evidence')
  );
}

async function isDirectory(filePath) {
  try {
    return (await stat(filePath)).isDirectory();
  } catch {
    return false;
  }
}

async function rootHasAnyScenario(root, scenarioNames) {
  for (const scenario of scenarioNames) {
    if (await isDirectory(path.join(root, scenario))) return true;
  }
  return false;
}

export async function discoverEvidenceRoots(
  inputRoots,
  evidenceScenarios = RELEASE_EVIDENCE_AUDIT_SCENARIOS
) {
  const scenarioNames = evidenceScenarios.map((scenario) => scenario.scenario);
  const discovered = new Map();

  for (const inputRoot of inputRoots) {
    const resolvedRoot = path.resolve(inputRoot);
    if (await rootHasAnyScenario(resolvedRoot, scenarioNames)) {
      discovered.set(resolvedRoot, resolvedRoot);
    }

    let entries = [];
    try {
      entries = await readdir(resolvedRoot, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const childRoot = path.join(resolvedRoot, entry.name);
      if (await rootHasAnyScenario(childRoot, scenarioNames)) {
        discovered.set(childRoot, childRoot);
      }
    }
  }

  if (discovered.size === 0) {
    for (const inputRoot of inputRoots) {
      const resolvedRoot = path.resolve(inputRoot);
      discovered.set(resolvedRoot, resolvedRoot);
    }
  }

  return [...discovered.values()].sort();
}

async function latestEvidenceBundleAcrossRoots(evidence, evidenceRoots) {
  const results = [];
  for (const evidenceRoot of evidenceRoots) {
    const result = await latestEvidenceBundle(evidence.scenario, evidenceRoot, {
      requireManifest: evidence.require_manifest === true,
      expectedStatus: evidence.expected_status,
      expectedStatuses: evidence.expected_statuses,
      requiredStatuses: evidence.required_statuses,
      expectedLedger: evidence.expected_ledger
    });
    if (!['missing', 'missing_ledger'].includes(result.status)) {
      results.push({
        ...result,
        evidence_root: evidenceRoot
      });
    }
  }

  if (results.length === 0) {
    return {
      ok: false,
      status: 'missing',
      scenario: evidence.scenario,
      checked_evidence_roots: evidenceRoots
    };
  }

  results.sort((a, b) => (b.ledger_mtime_ms ?? 0) - (a.ledger_mtime_ms ?? 0));
  return {
    ...results[0],
    checked_evidence_roots: evidenceRoots
  };
}

export async function buildReleaseEvidenceAuditReport(options = {}) {
  const requestedRoots = (options.evidenceRoots ?? [defaultEvidenceRoot()]).map(
    (root) => path.resolve(root)
  );
  const selectedEvidenceScenarios =
    options.evidenceScenarios ?? selectReleaseEvidenceAuditScenarios(options);
  const evidenceScenarios = applyAuditRequirementOverrides(
    selectedEvidenceScenarios,
    options
  );
  const evidenceRoots =
    options.discoverRoots === false
      ? requestedRoots
      : await discoverEvidenceRoots(requestedRoots, evidenceScenarios);

  const evidence = [];
  for (const scenario of evidenceScenarios) {
    evidence.push({
      gate: scenario.gate,
      name: scenario.name,
      ...(await latestEvidenceBundleAcrossRoots(scenario, evidenceRoots))
    });
  }

  if (options.requireSkillPromptCorpusLivePrState) {
    for (const result of evidence) {
      if (result.scenario !== 'skill-real-user-prompt-corpus-live-uat') {
        continue;
      }
      const livePrStateAudit = await auditSkillPromptCorpusLivePrState(
        result,
        options
      );
      result.live_pr_state_audit = livePrStateAudit;
      if (!livePrStateAudit.ok) {
        result.ok = false;
        result.status = 'invalid_live_pr_state';
        result.ledger_failures = [
          ...(result.ledger_failures ?? []),
          'skill_prompt_corpus.live_pr_state'
        ];
      }
    }
  }

  const failed = evidence.filter((result) => !result.ok);
  const copiedIntegrityCheckedCount = evidence.reduce(
    (total, result) =>
      total + (result.manifest_summary?.copied_integrity_checked_count ?? 0),
    0
  );
  const scope = options.evidenceScenarios
    ? 'custom'
    : options.allReleaseEvidence
      ? 'all-release-evidence'
      : options.scenarioNames?.length > 0
        ? 'custom'
        : 'default-release-gates';
  return {
    status: failed.length > 0 ? 'fail' : 'pass',
    scenario: 'release-evidence-audit',
    mode: 'local-or-artifact-evidence-audit',
    scope,
    requested_evidence_roots: requestedRoots,
    evidence_roots: evidenceRoots,
    required_scenarios: evidenceScenarios.map((scenario) => ({
      gate: scenario.gate,
      scenario: scenario.scenario,
      expected_status: scenario.expected_status,
      expected_statuses: scenario.expected_statuses,
      required_statuses: scenario.required_statuses,
      require_live_pr_state:
        options.requireSkillPromptCorpusLivePrState === true &&
        scenario.scenario === 'skill-real-user-prompt-corpus-live-uat'
    })),
    audit_summary: {
      required_count: evidence.length,
      passed_count: evidence.length - failed.length,
      failed_count: failed.length,
      copied_integrity_checked_count: copiedIntegrityCheckedCount,
      scenarios: evidence.map((result) => ({
        gate: result.gate,
        scenario: result.scenario,
        ok: result.ok,
        status: result.status,
        run_id: result.run_id ?? null
      }))
    },
    failed_gates: failed.map((result) => result.gate),
    evidence,
    next_step:
      failed.length > 0
        ? 'Provide the missing local or downloaded evidence artifacts, then rerun corepack pnpm uat:release-evidence-audit before claiming evidence-backed product status.'
        : undefined
  };
}

export function releaseEvidenceAuditExitCode(report) {
  return report.failed_gates.length > 0 ? 1 : 0;
}

function parseArgs(argv) {
  const evidenceRoots = [];
  const scenarioNames = [];
  let allReleaseEvidence = false;
  let requireSkillPromptCorpusGithubPr = false;
  let requireSkillPromptCorpusLivePrState = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      continue;
    }
    if (arg === '--evidence-root') {
      const value = argv[index + 1];
      if (!value) throw new Error('--evidence-root requires a path');
      evidenceRoots.push(value);
      index += 1;
      continue;
    }
    if (arg === '--scenario') {
      const value = argv[index + 1];
      if (!value) throw new Error('--scenario requires a scenario name');
      scenarioNames.push(
        ...value
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)
      );
      index += 1;
      continue;
    }
    if (arg === '--all-release-evidence') {
      allReleaseEvidence = true;
      continue;
    }
    if (arg === '--require-skill-prompt-corpus-github-pr') {
      requireSkillPromptCorpusGithubPr = true;
      continue;
    }
    if (arg === '--require-skill-prompt-corpus-live-pr-state') {
      requireSkillPromptCorpusGithubPr = true;
      requireSkillPromptCorpusLivePrState = true;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return {
    evidenceRoots: evidenceRoots.length > 0 ? evidenceRoots : undefined,
    scenarioNames: scenarioNames.length > 0 ? scenarioNames : undefined,
    allReleaseEvidence,
    requireSkillPromptCorpusGithubPr,
    requireSkillPromptCorpusLivePrState
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await buildReleaseEvidenceAuditReport(options);
  console.log(JSON.stringify(report, null, 2));
  process.exit(releaseEvidenceAuditExitCode(report));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
