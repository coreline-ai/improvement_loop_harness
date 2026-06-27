#!/usr/bin/env node
// Natural-language Skill prompt matrix UAT.
//
// This is a product-UX guard for the Skill routing layer. It runs the copied
// Skill install from a clean CODEX_HOME and verifies real-user prompt variants
// route to safe VibeLoop modes. It does not prove builder quality, GitHub PR
// publication, or arbitrary-repo PASS; those remain covered by heavier live
// lanes.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
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
const sourceSkillRoot = path.join(repoRoot, 'skills/vibeloop-harness');
const sourceVendorCli = path.join(sourceSkillRoot, 'vendor/vibeloop.mjs');
const scenario = 'skill-real-user-prompt-matrix-uat';
const passStatus = 'SKILL_PROMPT_MATRIX_UAT_PASS';
const failStatus = 'SKILL_PROMPT_MATRIX_UAT_FAIL';
const pruneTmp = shouldPruneUatTmp();

const cases = [
  {
    id: 'ko-project-problem-find',
    prompt: '특정 프로젝트 문제점 찾아줘',
    expectedMode: 'auto_discovery',
    singleIssue: true,
    critical: true
  },
  {
    id: 'ko-bug-find-pr-candidate',
    prompt: '버그 찾아서 PR 후보 만들어줘',
    expectedMode: 'auto_discovery',
    singleIssue: true,
    critical: true
  },
  {
    id: 'ko-auto-fix-one-by-one',
    prompt: '자동으로 문제 찾아서 하나씩 수정하고 검증 PR 후보 만들어줘',
    expectedMode: 'auto_discovery',
    singleIssue: true,
    critical: true
  },
  {
    id: 'en-scan-repo-fix-one',
    prompt: 'scan this repo, discover one issue, and prepare a PR candidate',
    expectedMode: 'auto_discovery',
    singleIssue: true,
    critical: true
  },
  {
    id: 'ko-failing-tests-find-one',
    prompt: '테스트 실패 원인을 찾아서 문제 하나 고치고 PR 후보 만들어줘',
    expectedMode: 'auto_discovery',
    singleIssue: true,
    critical: true
  },
  {
    id: 'en-failing-behavior-find-one',
    prompt:
      'Find one failing behavior in this repo, fix it, verify it, and prepare a PR candidate',
    expectedMode: 'auto_discovery',
    singleIssue: true,
    critical: true
  },
  {
    id: 'ko-project-review-fix-one',
    prompt: '프로젝트 문제점 하나 찾아서 원인 설명하고 고친 뒤 PR 후보까지 만들어줘',
    expectedMode: 'auto_discovery',
    singleIssue: true,
    critical: true
  },
  {
    id: 'en-user-repo-review-fix-one',
    prompt:
      'Review this project like a user repo, find one concrete bug, fix it, verify it, and stage a PR candidate.',
    expectedMode: 'auto_discovery',
    singleIssue: true,
    critical: true
  },
  {
    id: 'ko-user-project-failing-test-bug',
    prompt: '사용자 프로젝트 기준으로 버그 찾아서 하나 고치고 PR 후보 만들어줘',
    expectedMode: 'auto_discovery',
    singleIssue: true,
    critical: true
  },
  {
    id: 'ko-scan-project-one-regression',
    prompt:
      '프로젝트를 스캔해서 재현 가능한 문제 하나 찾아 고치고 검증 가능한 PR 후보로 정리해줘',
    expectedMode: 'auto_discovery',
    singleIssue: true,
    critical: true
  },
  {
    id: 'en-scan-one-regression-pr-candidate',
    prompt:
      'Scan the project, find one regression, fix it, verify it, and prepare a PR candidate.',
    expectedMode: 'auto_discovery',
    singleIssue: true,
    critical: true
  },
  {
    id: 'ko-scan-customer-flow-one-fix',
    prompt:
      '프로젝트 스캔으로 고객 결제 흐름에서 재현 가능한 문제 하나 찾아 고치고 검증 가능한 PR 후보로 정리해줘',
    expectedMode: 'auto_discovery',
    singleIssue: true,
    critical: true
  },
  {
    id: 'en-scan-customer-facing-regression',
    prompt:
      'Find one reproducible customer-facing regression by scanning this repo, fix it, verify it, and prepare a PR-ready result.',
    expectedMode: 'auto_discovery',
    singleIssue: true,
    critical: true
  },
  {
    id: 'ko-operator-audit-one-undercharge',
    prompt:
      '운영자 감사처럼 프로젝트를 스캔해서 재현 가능한 과소청구 문제 하나를 찾아 고치고 검증 가능한 PR 후보로 정리해줘',
    expectedMode: 'auto_discovery',
    singleIssue: true,
    critical: true
  },
  {
    id: 'en-operator-audit-one-undercharge',
    prompt:
      'Audit this repo like an operator, discover one reproducible undercharge bug, fix it, verify it, and prepare a PR-ready result.',
    expectedMode: 'auto_discovery',
    singleIssue: true,
    critical: true
  },
  {
    id: 'ko-specific-cart-bug',
    prompt: 'src/cart.cjs quantity 버그 고쳐줘. 테스트도 추가해.',
    expectedMode: 'user_issue',
    singleIssue: true,
    critical: true
  },
  {
    id: 'ko-cart-natural-quantity-total',
    prompt:
      '장바구니 총액이 수량을 반영하지 않는 것 같아. cart quantity 처리 고치고 회귀 테스트 추가해줘',
    expectedMode: 'user_issue',
    singleIssue: true,
    critical: true
  },
  {
    id: 'en-cart-natural-quantity-total',
    prompt:
      'The cart total ignores item quantity. Fix the quantity calculation and add a regression test.',
    expectedMode: 'user_issue',
    singleIssue: true,
    critical: true
  },
  {
    id: 'ko-user-repo-cart-pr-candidate',
    prompt:
      '실제 사용자 repo처럼 장바구니 수량 계산이 이상한 문제를 고치고 검증한 다음 PR 후보 만들어줘',
    expectedMode: 'user_issue',
    singleIssue: true,
    critical: true
  },
  {
    id: 'en-user-repo-cart-pr-candidate',
    prompt:
      'In this project, the cart total looks wrong when quantity is greater than one. Fix it, verify it, and prepare a PR candidate.',
    expectedMode: 'user_issue',
    singleIssue: true,
    critical: true
  },
  {
    id: 'ko-cart-two-items-total-low',
    prompt:
      '상품을 두 개 담으면 장바구니 합계가 낮게 나와. 수량 계산 문제를 고치고 테스트 추가해줘',
    expectedMode: 'user_issue',
    singleIssue: true,
    critical: true
  },
  {
    id: 'ko-checkout-quantity-line-total',
    prompt:
      '결제 직전 장바구니 합계가 단가만 쓰는 것 같아. quantity가 3인 항목도 정확히 계산하게 고치고 PR 후보 만들어줘',
    expectedMode: 'user_issue',
    singleIssue: true,
    critical: true
  },
  {
    id: 'en-checkout-quantity-regression',
    prompt:
      'Checkout totals only use the unit price when a line has quantity 3. Fix the cart total regression and add a test.',
    expectedMode: 'user_issue',
    singleIssue: true,
    critical: true
  },
  {
    id: 'ko-ops-cart-quantity-undercharge',
    prompt:
      '운영자가 확인한 cart quantity 과소청구 문제가 있어. 여러 개 담은 장바구니 총액을 고치고 회귀 테스트를 추가해줘',
    expectedMode: 'user_issue',
    singleIssue: true,
    critical: true
  },
  {
    id: 'en-customer-cart-quantity-undercharge',
    prompt:
      'Customer carts with quantity 4 are undercharged as one item. Fix the cart quantity total and leave regression coverage.',
    expectedMode: 'user_issue',
    singleIssue: true,
    critical: true
  },
  {
    id: 'ko-subtotal-quantity-mismatch',
    prompt:
      '장바구니 subtotal이 여러 개 담은 상품 수량을 무시해. 수량 반영 버그를 고치고 회귀 테스트와 검증 결과를 남겨줘',
    expectedMode: 'user_issue',
    singleIssue: true,
    critical: true
  },
  {
    id: 'en-retail-cart-three-unit-undercharge',
    prompt:
      'A retail cart with three units still charges one unit. Fix the quantity-aware subtotal and add regression coverage.',
    expectedMode: 'user_issue',
    singleIssue: true,
    critical: true
  },
  {
    id: 'ko-login-timeout-bug',
    prompt: '로그인 timeout 버그 고쳐줘. 회귀 테스트도 추가해.',
    expectedMode: 'user_issue',
    singleIssue: true,
    critical: true
  },
  {
    id: 'ko-live-env-test',
    prompt: '실환경 테스트 진행해줘',
    expectedMode: 'codex_live_uat',
    singleIssue: true,
    critical: true
  },
  {
    id: 'ko-real-codex-github-pr',
    prompt: '실제 Codex와 GitHub draft PR로 UAT 돌려줘',
    expectedMode: 'codex_live_uat',
    singleIssue: true,
    critical: true
  },
  {
    id: 'en-real-codex-github-pr',
    prompt: 'run real Codex GitHub draft PR UAT',
    expectedMode: 'codex_live_uat',
    singleIssue: true,
    critical: true
  },
  {
    id: 'en-skill-prompt-live',
    prompt: 'Skill prompt live UAT 돌려줘',
    expectedMode: 'codex_skill_prompt_uat',
    singleIssue: true,
    critical: true
  },
  {
    id: 'ko-skill-prompt-live',
    prompt: '스킬 프롬프트 실환경 호출 검증해줘',
    expectedMode: 'codex_skill_prompt_uat',
    singleIssue: true,
    critical: true
  },
  {
    id: 'ko-natural-skill-full-live',
    prompt: '일반 사용자가 자연어로 스킬을 끝까지 쓰는 full live UAT를 검증해줘',
    expectedMode: 'codex_skill_prompt_uat',
    singleIssue: true,
    critical: true
  },
  {
    id: 'en-natural-language-skill-live',
    prompt: 'verify the natural-language Skill UX full live path',
    expectedMode: 'codex_skill_prompt_uat',
    singleIssue: true,
    critical: true
  },
  {
    id: 'ko-skill-md-call',
    prompt: 'SKILL.md 호출 검증하고 prompt runner가 실행되는지 테스트해줘',
    expectedMode: 'codex_skill_prompt_uat',
    singleIssue: true,
    critical: true
  },
  {
    id: 'ko-verify-only',
    prompt: '이 candidate.patch는 수정하지 말고 검증만 해줘',
    expectedMode: 'verify_only',
    singleIssue: true,
    critical: true
  },
  {
    id: 'ko-existing-patch-final-reverify',
    prompt: '기존 패치 수정하지 말고 final reverify만 해줘',
    expectedMode: 'verify_only',
    singleIssue: true,
    critical: true
  },
  {
    id: 'ko-adversarial-hidden-leak',
    prompt: '적대적 실패 케이스 UAT로 hidden leak과 tamper를 깨보기',
    expectedMode: 'adversarial_uat',
    singleIssue: false,
    critical: true
  },
  {
    id: 'ko-full-uat-fixture',
    prompt: 'FULL UAT fixture baseline 한번 실행',
    expectedMode: 'fixture_full_uat',
    singleIssue: false,
    critical: true
  },
  {
    id: 'ko-self-improvement-loop',
    prompt: '자가개선 루프 UAT로 challenger가 더 나은 후보인지 검증',
    expectedMode: 'self_improvement_uat',
    singleIssue: false,
    critical: true
  },
  {
    id: 'ko-self-improvement-flow-natural',
    prompt: '자가개선 루프가 후보 만들고 검증하고 선택하는지 UAT로 확인해줘',
    expectedMode: 'self_improvement_uat',
    singleIssue: false,
    critical: true
  },
  {
    id: 'ko-report-summary',
    prompt: 'eval-report.json 보고서 요약해줘',
    expectedMode: 'report',
    singleIssue: false,
    critical: false
  },
  {
    id: 'ko-selection-eval-report-summary',
    prompt: 'selection-report.json와 eval-report.json 결과만 요약해줘',
    expectedMode: 'report',
    singleIssue: false,
    critical: false
  },
  {
    id: 'unknown-needs-clarification',
    prompt: '이거 괜찮게 처리해줘',
    expectedMode: 'unknown',
    singleIssue: true,
    critical: true
  },
  {
    id: 'unknown-project-look-around',
    prompt: '프로젝트 좀 봐줘',
    expectedMode: 'unknown',
    singleIssue: true,
    critical: true
  }
];

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
      resolve({ code, signal, stdout: redact(stdout), stderr: redact(stderr) });
    });
  });
}

async function copySkillInstall(root) {
  if (!existsSync(sourceVendorCli)) {
    throw new Error(
      `missing bundled Skill vendor CLI at ${sourceVendorCli}; run pnpm bundle:skill before this UAT`
    );
  }
  const codexHome = path.join(root, 'codex-home');
  const skillsRoot = path.join(codexHome, 'skills');
  const skillRoot = path.join(skillsRoot, 'vibeloop-harness');
  await mkdir(skillsRoot, { recursive: true, mode: 0o700 });
  await cp(sourceSkillRoot, skillRoot, { recursive: true });
  const classifier = path.join(skillRoot, 'scripts/classify-intent.mjs');
  const skillFile = path.join(skillRoot, 'SKILL.md');
  const vendorCli = path.join(skillRoot, 'vendor/vibeloop.mjs');
  if (
    !existsSync(classifier) ||
    !existsSync(skillFile) ||
    !existsSync(vendorCli)
  ) {
    throw new Error(
      'copied Skill install is missing classifier, SKILL.md, or vendor CLI'
    );
  }
  const skillEntries = (await readdir(skillsRoot)).sort();
  if (JSON.stringify(skillEntries) !== JSON.stringify(['vibeloop-harness'])) {
    throw new Error(
      `clean CODEX_HOME skills directory contains unexpected entries: ${skillEntries.join(', ')}`
    );
  }
  return {
    codexHome,
    skillRoot,
    classifier,
    skillEntries
  };
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} did not emit JSON: ${text.slice(0, 500)}`);
  }
}

async function classifyCase(skill, testCase) {
  const result = await run(
    process.execPath,
    [skill.classifier, '--prompt', testCase.prompt],
    {
      cwd: skill.codexHome,
      env: {
        ...process.env,
        CODEX_HOME: skill.codexHome
      }
    }
  );
  const parsed =
    result.code === 0 ? parseJson(result.stdout, testCase.id) : null;
  const actualMode = parsed?.mode ?? null;
  const actualSingleIssue = parsed?.single_issue_policy ?? null;
  const passed =
    result.code === 0 &&
    actualMode === testCase.expectedMode &&
    actualSingleIssue === testCase.singleIssue &&
    parsed?.accept_authority === 'deterministic_harness_only' &&
    String(parsed?.full_improvement_pass_rule ?? '').includes(
      'never call FULL autonomous improvement PASS'
    );
  return {
    id: testCase.id,
    prompt: testCase.prompt,
    expected_mode: testCase.expectedMode,
    actual_mode: actualMode,
    expected_single_issue_policy: testCase.singleIssue,
    actual_single_issue_policy: actualSingleIssue,
    critical: testCase.critical,
    passed,
    reason_codes: parsed?.reason_codes ?? [],
    confidence: parsed?.confidence ?? null,
    command_hint: parsed?.command_hint ?? null,
    limitations: parsed?.limitations ?? [],
    exit_code: result.code,
    stderr: result.stderr.trim()
  };
}

async function main() {
  const tmpRoot = await mkdtemp(
    path.join(os.tmpdir(), 'vibeloop-skill-prompt-matrix-')
  );
  let pass = false;
  try {
    const skill = await copySkillInstall(tmpRoot);
    const results = [];
    for (const testCase of cases) {
      results.push(await classifyCase(skill, testCase));
    }
    const failed = results.filter((item) => !item.passed);
    const unexpectedUnknown = results.filter(
      (item) =>
        item.expected_mode !== 'unknown' && item.actual_mode === 'unknown'
    );
    const criticalFailures = failed.filter((item) => item.critical);
    pass = failed.length === 0;

    const matrixPath = path.join(tmpRoot, 'prompt-matrix-results.json');
    const matrix = {
      scenario,
      total_cases: results.length,
      passed_cases: results.filter((item) => item.passed).length,
      failed_cases: failed.length,
      critical_failures: criticalFailures.length,
      unexpected_unknown: unexpectedUnknown.length,
      cases: results
    };
    await writeFile(matrixPath, `${JSON.stringify(matrix, null, 2)}\n`);

    const ledger = {
      status: pass ? passStatus : failStatus,
      scenario,
      proof_scope: 'copied_skill_prompt_routing_matrix',
      not_live_codex_or_github_pass: true,
      actual_user_environment: {
        copied_skill_install: true,
        clean_codex_home: true,
        codex_home_skills_entries: skill.skillEntries,
        copied_skill_path: skill.skillRoot,
        classifier:
          'CODEX_HOME/skills/vibeloop-harness/scripts/classify-intent.mjs'
      },
      total_cases: matrix.total_cases,
      passed_cases: matrix.passed_cases,
      failed_cases: matrix.failed_cases,
      critical_failures: matrix.critical_failures,
      unexpected_unknown: matrix.unexpected_unknown,
      false_pass: criticalFailures.length,
      leak: 0,
      limitations: [
        'proves copied Skill classifier routes representative natural-language prompts',
        'does not execute a builder, publish GitHub draft PRs, or prove arbitrary-repo PASS',
        'must be combined with full/live Skill prompt lanes before claiming end-to-end Skill product evidence'
      ],
      evidence: {
        tmp_root: tmpRoot,
        matrix_results: matrixPath
      }
    };

    const evidenceBundle = await writeUatEvidenceBundle({
      scenario,
      runId: `skill-prompt-matrix-${process.pid}-${Date.now()}`,
      tmpRoot,
      dataDir: tmpRoot,
      output: ledger,
      extraFiles: [
        {
          label: 'prompt_matrix_results',
          path: matrixPath,
          kind: 'report'
        }
      ],
      extraJson: {
        prompt_matrix_summary: {
          proof_scope: ledger.proof_scope,
          not_live_codex_or_github_pass: ledger.not_live_codex_or_github_pass,
          actual_user_environment: ledger.actual_user_environment,
          total_cases: ledger.total_cases,
          passed_cases: ledger.passed_cases,
          failed_cases: ledger.failed_cases,
          critical_failures: ledger.critical_failures,
          unexpected_unknown: ledger.unexpected_unknown
        }
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
    if (!pass) process.exitCode = 1;
  } finally {
    if (pruneTmp && pass) {
      await rm(tmpRoot, { recursive: true, force: true }).catch(
        () => undefined
      );
    }
  }
}

main().catch((error) => {
  console.error(
    redact(
      error instanceof Error ? error.stack || error.message : String(error)
    )
  );
  process.exitCode = 1;
});
