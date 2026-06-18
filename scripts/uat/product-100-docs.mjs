#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PRODUCT_100_PASS_STATUS } from './product-100-contract.mjs';

export const PRODUCT_100_DOCS_VERSION = 'product-100.docs.v1';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

const DEFAULT_DOCS = Object.freeze({
  readme: 'README.md',
  runbook: 'docs/SELF_IMPROVEMENT_LOOP_RUNBOOK.md',
  runLedger: 'docs/SKILL_REAL_USER_SCENARIO.md',
  devPlan: 'dev-plan/implement_20260617_211537.md'
});

function containsAny(text, needles) {
  return needles.some((needle) => text.includes(needle));
}

function missingRequirementNeedles(requirement) {
  const aliases = {
    github_draft_prs_open: ['github_draft_prs_open', 'GitHub draft PR', 'draft PR'],
    release_evidence_audit_pass: [
      'release_evidence_audit_pass',
      'release evidence audit',
      'evidence audit'
    ],
    docs_run_ledger_readme_truthful: [
      'docs_run_ledger_readme_truthful',
      'Run Ledger',
      'README'
    ],
    m2_confirmed_under_r1: ['m2_confirmed_under_r1', 'M2'],
    m4_replay_safe_under_r1: ['m4_replay_safe_under_r1', 'M4'],
    frozen_rulepack_semantic_gate_passed_next_loop: [
      'frozen_rulepack_semantic_gate_passed_next_loop',
      'N+1',
      'semantic gate'
    ],
    strict_score_improvement_every_issue: [
      'strict_score_improvement_every_issue',
      'strict-best',
      'strict score'
    ],
    real_codex_builder_used_every_issue: [
      'real_codex_builder_used_every_issue',
      'real Codex Builder'
    ],
    real_codex_challenger_used_every_issue: [
      'real_codex_challenger_used_every_issue',
      'real Codex Challenger'
    ]
  };
  return aliases[requirement] ?? [requirement];
}

async function readDocSet(docPaths = DEFAULT_DOCS, root = repoRoot) {
  const docs = {};
  for (const [key, relPath] of Object.entries(docPaths)) {
    const absPath = path.isAbsolute(relPath) ? relPath : path.join(root, relPath);
    docs[key] = {
      path: absPath,
      text: await readFile(absPath, 'utf8')
    };
  }
  return docs;
}

export function evaluateProduct100DocsTruth({
  ledger = {},
  docs = {},
  requiredDocKeys = ['readme', 'runbook', 'runLedger'],
  requireRunIdInDocs = false
} = {}) {
  const failures = [];
  const warnings = [];
  const status = ledger.status ?? null;
  const runId = ledger.run_id ?? null;
  const missingRequirements =
    ledger.evaluation?.missing_requirements ?? ledger.missing_requirements ?? [];
  const isPass = status === PRODUCT_100_PASS_STATUS;

  for (const key of requiredDocKeys) {
    const text = docs[key]?.text ?? '';
    if (!text) {
      failures.push(`doc.${key}.missing`);
      continue;
    }
    if (!text.includes('Product-100')) failures.push(`doc.${key}.product100_missing`);
  }

  const allText = Object.values(docs)
    .map((doc) => doc?.text ?? '')
    .join('\n');
  if (status && !allText.includes(status)) {
    failures.push('docs.status_missing');
  }
  if (requireRunIdInDocs && runId && !allText.includes(runId)) {
    failures.push('docs.run_id_missing');
  }

  if (isPass) {
    if (!containsAny(allText, ['PRODUCT_100_CODEX_LIVE_PASS', 'Product-100 PASS'])) {
      failures.push('docs.pass_status_missing');
    }
  } else {
    if (!containsAny(allText, ['PASS 아님', 'PASS가 아니다', 'not a Product-100 live PASS', 'Product-100 PASS evidence 아님'])) {
      failures.push('docs.non_pass_disclaimer_missing');
    }
    const coveredMissing = missingRequirements.filter((requirement) =>
      containsAny(allText, missingRequirementNeedles(requirement))
    );
    if (missingRequirements.length > 0 && coveredMissing.length === 0) {
      failures.push('docs.missing_requirements_not_mentioned');
    }
    if (coveredMissing.length < missingRequirements.length) {
      warnings.push(
        `docs.partial_missing_requirement_coverage:${coveredMissing.length}/${missingRequirements.length}`
      );
    }
  }

  if (/제품 전체\s*100%\s*PASS(?![^\n]{0,80}(아님|금지|아니다|not))/i.test(allText)) {
    failures.push('docs.overclaims_product_100_pass');
  }

  return {
    version: PRODUCT_100_DOCS_VERSION,
    docs_run_ledger_readme_truthful: failures.length === 0,
    phase7_pass: failures.length === 0,
    status_checked: status,
    run_id_checked: runId,
    missing_requirement_count: missingRequirements.length,
    failures,
    warnings,
    checked_docs: Object.fromEntries(
      Object.entries(docs).map(([key, doc]) => [key, doc?.path ?? null])
    )
  };
}

export async function runProduct100Phase7DocsCheck({
  ledger,
  ledgerFile,
  docPaths = DEFAULT_DOCS,
  root = repoRoot,
  requireRunIdInDocs = false
} = {}) {
  const sourceLedger = ledger ?? (ledgerFile
    ? JSON.parse(await readFile(ledgerFile, 'utf8'))
    : null);
  if (!sourceLedger) throw new Error('ledger or ledgerFile is required');
  const docs = await readDocSet(docPaths, root);
  return evaluateProduct100DocsTruth({
    ledger: sourceLedger,
    docs,
    requireRunIdInDocs
  });
}

async function readStdinJson() {
  if (process.stdin.isTTY) return {};
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  return input.trim() ? JSON.parse(input) : {};
}

async function main() {
  const input = await readStdinJson();
  const report = await runProduct100Phase7DocsCheck(input);
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.phase7_pass ? 0 : 1);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
