#!/usr/bin/env node
// Natural-language Skill prompt journey UAT.
//
// This local product-UX lane runs a copied Skill from a clean CODEX_HOME and
// executes a small user journey through scripts/run-from-prompt.mjs:
// user_issue -> auto_discovery -> report summary. It intentionally uses
// deterministic command agents, not a real LLM builder; pair it with the
// real-builder Skill prompt lanes before making live Codex claims.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile
} from 'node:fs/promises';
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
const cartScenarioRoot = path.join(
  repoRoot,
  'tests/e2e/user-scenarios/cart-quantity'
);
const cartTargetTemplate = path.join(cartScenarioRoot, 'target-template');
const cartAgent = path.join(cartScenarioRoot, 'agent-fix.cjs');
const scenario = 'skill-real-user-prompt-journey-uat';
const passStatus = 'SKILL_PROMPT_JOURNEY_UAT_PASS';
const failStatus = 'SKILL_PROMPT_JOURNEY_UAT_FAIL';
const pruneTmp = shouldPruneUatTmp();

const prompts = {
  userIssue:
    '장바구니 총액이 수량을 반영하지 않는 것 같아. cart quantity 처리 고치고 회귀 테스트 추가해줘',
  autoDiscovery: '테스트 실패 원인을 찾아서 문제 하나 고치고 PR 후보 만들어줘',
  report: 'selection-report.json와 eval-report.json 결과만 요약해줘'
};

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

async function mustRun(command, args, options = {}) {
  const result = await run(command, args, options);
  if (result.code !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.code})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    );
  }
  return result.stdout;
}

async function git(cwd, args) {
  return mustRun('git', args, { cwd });
}

function parseJson(result, label) {
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(
      `${label} did not emit JSON (exit=${result.code})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    );
  }
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

  const promptRunner = path.join(skillRoot, 'scripts/run-from-prompt.mjs');
  const summarizer = path.join(skillRoot, 'scripts/summarize-report.mjs');
  const classifier = path.join(skillRoot, 'scripts/classify-intent.mjs');
  const vendorCli = path.join(skillRoot, 'vendor/vibeloop.mjs');
  if (
    !existsSync(promptRunner) ||
    !existsSync(summarizer) ||
    !existsSync(classifier) ||
    !existsSync(vendorCli)
  ) {
    throw new Error(
      'copied Skill install is missing prompt runner, summarizer, classifier, or vendor CLI'
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
    promptRunner,
    summarizer,
    classifier,
    vendorCli,
    skillEntries
  };
}

async function createTargetRepo(root, suffix) {
  const repoPath = path.join(root, `prompt-journey-target-${suffix}`);
  await cp(cartTargetTemplate, repoPath, { recursive: true });
  await writeFile(
    path.join(repoPath, 'package.json'),
    `${JSON.stringify(
      {
        name: `skill-prompt-journey-${suffix}`,
        version: '1.0.0',
        private: true,
        type: 'commonjs',
        scripts: {
          test: 'for f in tests/*.test.cjs; do node "$f"; done'
        }
      },
      null,
      2
    )}\n`
  );
  await git(repoPath, ['init', '-b', 'main']);
  await git(repoPath, ['config', 'user.email', 'skill-journey-user@example.test']);
  await git(repoPath, ['config', 'user.name', 'Skill Journey UAT User']);
  await git(repoPath, ['add', '-A']);
  await git(repoPath, ['commit', '-m', 'initial prompt journey fixture']);
  const initialCommit = (await git(repoPath, ['rev-parse', 'HEAD'])).trim();
  await mustRun('npm', ['test'], { cwd: repoPath });
  return { repoPath, initialCommit };
}

async function runPrompt(skill, args, label) {
  const result = await run(process.execPath, [skill.promptRunner, ...args], {
    cwd: skill.codexHome,
    env: {
      ...process.env,
      CODEX_HOME: skill.codexHome
    }
  });
  const parsed = parseJson(result, label);
  return { result, parsed };
}

function reportPathFromImprove(parsed) {
  return (
    parsed?.execution?.parsed?.selected_report ??
    parsed?.execution?.parsed?.selection_report ??
    parsed?.execution?.parsed?.report ??
    null
  );
}

function summarizeStep({ id, prompt, expectedMode, expectedCommandKind, parsed }) {
  const executionParsed = parsed.execution?.parsed ?? null;
  const finalVerification =
    executionParsed?.final_verification ??
    executionParsed?.issues?.[0]?.final_verification ??
    null;
  const promotion =
    executionParsed?.promotion ??
    executionParsed?.cumulative_promotion ??
    executionParsed?.issues?.[0]?.promotion ??
    null;
  return {
    id,
    prompt,
    expected_mode: expectedMode,
    mode: parsed.mode ?? null,
    expected_command_kind: expectedCommandKind,
    command_kind: parsed.command?.kind ?? null,
    executed: parsed.executed === true,
    execution_code: parsed.execution?.code ?? null,
    generated_task_eval: Boolean(parsed.generated?.task && parsed.generated?.eval),
    pr_candidate: Boolean(
      executionParsed?.pr_candidate ??
        executionParsed?.issues?.[0]?.pr_candidate ??
        false
    ),
    processed: executionParsed?.processed ?? null,
    final_verification_passed: finalVerification?.passed === true,
    promotion_branch: promotion?.branch_name ?? null,
    promotion_pushed: promotion?.pushed ?? null,
    full_autonomous_improvement_eligible:
      executionParsed?.selection_quality?.full_autonomous_improvement_eligible ??
      executionParsed?.issues?.[0]?.selection_quality
        ?.full_autonomous_improvement_eligible ??
      null,
    report: reportPathFromImprove(parsed),
    artifact_root:
      executionParsed?.selected_artifact_root ??
      executionParsed?.artifact_root ??
      executionParsed?.issues?.[0]?.selected_artifact_root ??
      null
  };
}

function summarizeReportStep({ id, prompt, parsed }) {
  const summary = parsed.execution?.parsed ?? null;
  return {
    id,
    prompt,
    expected_mode: 'report',
    mode: parsed.mode ?? null,
    expected_command_kind: 'summarize_report',
    command_kind: parsed.command?.kind ?? null,
    executed: parsed.executed === true,
    execution_code: parsed.execution?.code ?? null,
    decision: summary?.decision ?? null,
    reason: summary?.reason ?? null,
    next_action: summary?.nextAction ?? null,
    pr_candidate: summary?.prCandidate ?? null,
    report: null,
    artifact_root: null
  };
}

function stepPassed(step) {
  if (step.id === 'report-summary') {
    return (
      step.mode === 'report' &&
      step.command_kind === 'summarize_report' &&
      step.executed === true &&
      step.execution_code === 0 &&
      step.decision === 'accept' &&
      step.reason === 'ALL_PASS' &&
      step.next_action === 'prepare_pr_candidate'
    );
  }
  return (
    step.mode === step.expected_mode &&
    step.command_kind === step.expected_command_kind &&
    step.executed === true &&
    step.execution_code === 0 &&
    step.pr_candidate === true &&
    step.final_verification_passed === true &&
    typeof step.promotion_branch === 'string' &&
    step.promotion_branch.length > 0 &&
    step.promotion_pushed === false &&
    step.full_autonomous_improvement_eligible === false
  );
}

async function main() {
  const tmpRoot = await mkdtemp(
    path.join(os.tmpdir(), 'vibeloop-skill-prompt-journey-')
  );
  let pass = false;
  try {
    const skill = await copySkillInstall(tmpRoot);
    const dataRoot = path.join(tmpRoot, 'data');
    const taskEvalRoot = path.join(tmpRoot, 'task-eval');
    await mkdir(dataRoot, { recursive: true });
    await mkdir(taskEvalRoot, { recursive: true });

    const userRepo = await createTargetRepo(tmpRoot, 'user-issue');
    const userRun = await runPrompt(
      skill,
      [
        '--execute',
        '--prompt',
        prompts.userIssue,
        '--template',
        'node',
        '--out',
        path.join(taskEvalRoot, 'user-issue'),
        '--repo',
        userRepo.repoPath,
        '--test-command',
        'node tests/cart-quantity.test.cjs',
        '--agent',
        `command:node ${cartAgent}`,
        '--data-dir',
        path.join(dataRoot, 'user-issue'),
        '--project-id',
        'skill-prompt-journey-user',
        '--loop-id',
        'skill-prompt-journey-user-loop',
        '--base-commit',
        userRepo.initialCommit,
        '--promote-branch',
        'pr-candidate/prompt-journey-user',
        '--promote-commit-message',
        'vibeloop prompt journey user issue',
        '--skip-dependency-install'
      ],
      'prompt journey user_issue'
    );
    const userStep = summarizeStep({
      id: 'user-issue',
      prompt: prompts.userIssue,
      expectedMode: 'user_issue',
      expectedCommandKind: 'vibeloop_improve',
      parsed: userRun.parsed
    });

    const reportPath = userStep.report;
    if (!reportPath || !existsSync(reportPath)) {
      throw new Error('user_issue prompt journey did not produce a report');
    }
    const reportRun = await runPrompt(
      skill,
      [
        '--execute',
        '--prompt',
        prompts.report,
        '--report',
        reportPath
      ],
      'prompt journey report'
    );
    const reportStep = summarizeReportStep({
      id: 'report-summary',
      prompt: prompts.report,
      parsed: reportRun.parsed
    });

    const autoRepo = await createTargetRepo(tmpRoot, 'auto-discovery');
    const autoRun = await runPrompt(
      skill,
      [
        '--execute',
        '--prompt',
        prompts.autoDiscovery,
        '--repo',
        autoRepo.repoPath,
        '--test-command',
        'node tests/cart-quantity.test.cjs',
        '--agent',
        `command:node ${cartAgent}`,
        '--data-dir',
        path.join(dataRoot, 'auto-discovery'),
        '--project-id',
        'skill-prompt-journey-auto',
        '--loop-id',
        'skill-prompt-journey-auto-loop',
        '--base-commit',
        autoRepo.initialCommit,
        '--max-issues',
        '1',
        '--max-candidates',
        '1',
        '--promote-branch',
        'pr-candidate/prompt-journey-auto',
        '--promote-commit-message-prefix',
        'vibeloop prompt journey auto',
        '--skip-dependency-install'
      ],
      'prompt journey auto_discovery'
    );
    const autoStep = summarizeStep({
      id: 'auto-discovery',
      prompt: prompts.autoDiscovery,
      expectedMode: 'auto_discovery',
      expectedCommandKind: 'vibeloop_orchestrate',
      parsed: autoRun.parsed
    });

    const steps = [userStep, autoStep, reportStep];
    const failedSteps = steps.filter((step) => !stepPassed(step));
    pass = failedSteps.length === 0;

    const journeyPath = path.join(tmpRoot, 'prompt-journey-results.json');
    const promptJourney = {
      deterministic_command_agent: true,
      step_count: steps.length,
      executed_step_count: steps.filter((step) => step.executed).length,
      passed_step_count: steps.length - failedSteps.length,
      pr_candidate_steps: steps.filter((step) => step.pr_candidate === true)
        .length,
      final_reverify_passed_steps: steps.filter(
        (step) => step.final_verification_passed === true
      ).length,
      promotion_branch_count: steps.filter((step) => step.promotion_branch)
        .length,
      generated_task_eval_count: steps.filter(
        (step) => step.generated_task_eval === true
      ).length,
      report_summary_steps: steps.filter((step) => step.mode === 'report')
        .length,
      user_issue: userStep,
      auto_discovery: autoStep,
      report_summary: reportStep,
      failed_steps: failedSteps.map((step) => step.id)
    };
    await writeFile(journeyPath, `${JSON.stringify(promptJourney, null, 2)}\n`);

    const ledger = {
      status: pass ? passStatus : failStatus,
      scenario,
      proof_scope: 'copied_skill_prompt_runner_end_to_end_journey',
      not_live_codex_or_github_pass: true,
      actual_user_environment: {
        copied_skill_install: true,
        clean_codex_home: true,
        codex_home_skills_entries: skill.skillEntries,
        copied_skill_path: 'CODEX_HOME/skills/vibeloop-harness',
        prompt_runner:
          'CODEX_HOME/skills/vibeloop-harness/scripts/run-from-prompt.mjs',
        classifier:
          'CODEX_HOME/skills/vibeloop-harness/scripts/classify-intent.mjs',
        vendor_cli: 'CODEX_HOME/skills/vibeloop-harness/vendor/vibeloop.mjs',
        external_user_repos: 2,
        command_agents: true
      },
      builder: {
        real_llm: false,
        provider: 'command-agent',
        via: 'copied-skill-prompt-runner'
      },
      prompt_journey: promptJourney,
      total_cases: steps.length,
      passed_cases: steps.length - failedSteps.length,
      failed_cases: failedSteps.length,
      false_pass: failedSteps.length,
      leak: 0,
      limitations: [
        'proves copied Skill prompt runner executes a representative local natural-language journey end to end',
        'uses deterministic command agents, not a real Codex builder',
        'does not publish GitHub draft PRs or prove arbitrary-repo PASS',
        'must be combined with real-builder Skill prompt evidence before claiming live Codex Skill product evidence'
      ],
      evidence: {
        tmp_root: tmpRoot,
        prompt_journey_results: journeyPath
      }
    };

    const evidenceBundle = await writeUatEvidenceBundle({
      scenario,
      runId: `skill-prompt-journey-${process.pid}-${Date.now()}`,
      tmpRoot,
      dataDir: tmpRoot,
      outputs: steps,
      output: ledger,
      extraFiles: [
        {
          label: 'prompt_journey_results',
          path: journeyPath,
          kind: 'report'
        }
      ],
      extraJson: {
        prompt_journey_summary: {
          proof_scope: ledger.proof_scope,
          not_live_codex_or_github_pass: ledger.not_live_codex_or_github_pass,
          actual_user_environment: ledger.actual_user_environment,
          prompt_journey: ledger.prompt_journey,
          total_cases: ledger.total_cases,
          passed_cases: ledger.passed_cases,
          failed_cases: ledger.failed_cases
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
  console.error(redact(error instanceof Error ? error.stack || error.message : String(error)));
  process.exitCode = 1;
});
