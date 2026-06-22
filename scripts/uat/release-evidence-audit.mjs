#!/usr/bin/env node
import { readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  ADVERSARY_REAL_REVIEWER_EVIDENCE_SCENARIO,
  EVIDENCE_SCENARIOS,
  PRODUCT_100_EVIDENCE_SCENARIO,
  REAL_PROJECT_CODEX_COPY_CORPUS_EVIDENCE_SCENARIO,
  REAL_PROJECT_MODIFIABLE_CORPUS_EVIDENCE_SCENARIO,
  REAL_PROJECT_CORPUS_EVIDENCE_SCENARIO,
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
  ADVERSARY_REAL_REVIEWER_EVIDENCE_SCENARIO,
  REAL_PROJECT_CORPUS_EVIDENCE_SCENARIO,
  REAL_PROJECT_MODIFIABLE_CORPUS_EVIDENCE_SCENARIO,
  REAL_PROJECT_CODEX_COPY_CORPUS_EVIDENCE_SCENARIO,
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
    SELECTABLE_RELEASE_EVIDENCE_AUDIT_SCENARIOS.map((scenario) => [scenario.scenario, scenario])
  );
  return options.scenarioNames.map((scenarioName) => {
    const scenario = scenarioByName.get(scenarioName);
    if (!scenario) {
      const known = SELECTABLE_RELEASE_EVIDENCE_AUDIT_SCENARIOS.map((item) => item.scenario).join(', ');
      throw new Error(`unknown scenario: ${scenarioName}; known: ${known}`);
    }
    return scenario;
  });
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
  const evidenceScenarios =
    options.evidenceScenarios ?? selectReleaseEvidenceAuditScenarios(options);
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
    mode: 'ci-artifact-evidence-only',
    scope,
    requested_evidence_roots: requestedRoots,
    evidence_roots: evidenceRoots,
    required_scenarios: evidenceScenarios.map((scenario) => ({
      gate: scenario.gate,
      scenario: scenario.scenario,
      expected_status: scenario.expected_status
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
        ? 'Download or merge the CI evidence artifacts, then rerun corepack pnpm uat:release-evidence-audit before claiming artifact-backed release evidence.'
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
    throw new Error(`unknown argument: ${arg}`);
  }
  return {
    evidenceRoots: evidenceRoots.length > 0 ? evidenceRoots : undefined,
    scenarioNames: scenarioNames.length > 0 ? scenarioNames : undefined,
    allReleaseEvidence
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
